import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { createTextChunk } from '../lib/chunk.js';
import { filter } from '../lib/stream.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const tmuxBufferAgent: AgentDefinition = {
  name: 'tmux-buffer',
  description: 'Daily summary of tmux windows',
  startInBackground: true,
  configSchema: {
    type: 'object',
    properties: {},
    required: []
  },
  
  async initialize(session: AgentSessionContext) {
    console.log(`[TmuxBufferAgent] Initializing for session ${session.id}`);
    
    const tmuxSocket = process.env.TMUX?.split(',')[0] || '/tmp/tmux-501/default';
    const runTmux = async (cmd: string): Promise<string> => {
      try {
        const { stdout } = await execAsync(`tmux -S ${tmuxSocket} ${cmd}`, { timeout: 10000 });
        return stdout;
      } catch (err: any) {
        return err.stdout || err.message || '';
      }
    };

    const getWindowList = async (): Promise<string[]> => {
      const output = await runTmux('list-windows -F "#{window_index}:#{window_name}"');
      if (!output.trim()) return [];
      return output.trim().split('\n').filter(w => w);
    };

    const getWindowContent = async (windowIndex: string): Promise<string> => {
      return await runTmux(`capture-pane -t ${windowIndex} -p`);
    };

    const summarizeWindow = async (content: string, windowInfo: string): Promise<string> => {
      if (!content.trim()) {
        return `Window ${windowInfo}: (empty)`;
      }

      const evaluator = session.createLLMChunkEvaluator('ollama', 'gemma3:1b', {
        temperature: 0.3,
        maxTokens: 500
      });

      console.log(`[TmuxBufferAgent] Window ${windowInfo}: content length = ${content.length}`);

      // Turn 1: Identify which tool/agent is running
      const identifyPrompt = `What terminal tool is shown in this output? Look for tool names in the UI, prompts, or headers.
Output: ${content}
Answer with just the tool name:`;

      const identifyChunk = createTextChunk(identifyPrompt, 'com.rxcafe.tmux-buffer', {
        'llm.full-prompt': true
      });

      let toolName = 'unknown';
      try {
        let fullResponse = '';
        for await (const tokenChunk of evaluator.evaluateChunk(identifyChunk)) {
          if (tokenChunk.contentType === 'text') {
            fullResponse += tokenChunk.content;
          }
        }
        toolName = fullResponse.trim();
        console.log(`[TmuxBufferAgent] Window ${windowInfo}: detected tool = "${toolName}"`);
      } catch (err) {
        console.error('[TmuxBufferAgent] Tool identification failed:', err);
      }

      let summary = '';

      // Turn 2: If Kilo or opencode, summarize the agent response
      if (toolName.toLowerCase().includes('kilo') || toolName.toLowerCase().includes('opencode')) {
        const agentPrompt = `Summarize this Kilo/opencode session. What did the agent just do? Is it waiting for user?
Output: ${content}
Format: "Did X. Status: waiting/done."`;

        const agentChunk = createTextChunk(agentPrompt, 'com.rxcafe.tmux-buffer', {
          'llm.full-prompt': true
        });

        try {
          for await (const tokenChunk of evaluator.evaluateChunk(agentChunk)) {
            if (tokenChunk.contentType === 'text') {
              summary += tokenChunk.content;
            }
          }
        } catch (err) {
          console.error('[TmuxBufferAgent] Agent summary failed:', err);
          summary = '(summary failed)';
        }
      } else {
        // Regular summary for other tools
        const regularPrompt = `Summarize what this terminal window is showing in 1-2 sentences:
${content}`;

        const regularChunk = createTextChunk(regularPrompt, 'com.rxcafe.tmux-buffer', {
          'llm.full-prompt': true
        });

        try {
          for await (const tokenChunk of evaluator.evaluateChunk(regularChunk)) {
            if (tokenChunk.contentType === 'text') {
              summary += tokenChunk.content;
            }
          }
        } catch (err) {
          console.error('[TmuxBufferAgent] LLM summary failed:', err);
          summary = '(summary failed)';
        }
      }

      console.log(`[TmuxBufferAgent] Window ${windowInfo}: summary = "${summary.trim().slice(0, 100)}..."`);
      return `Window ${windowInfo} (${toolName}): ${summary.trim()}`;
    };

    const performSummarization = async (trigger: string) => {
      console.log(`[TmuxBufferAgent] Starting summarization triggered by: ${trigger}`);
      
      session.outputStream.next(createTextChunk(
        `📋 Starting tmux window summarization...`,
        'com.rxcafe.tmux-buffer',
        { 'chat.role': 'assistant' }
      ));

      const windows = await getWindowList();
      
      if (windows.length === 0) {
        session.outputStream.next(createTextChunk(
          `No tmux windows found.`,
          'com.rxcafe.tmux-buffer',
          { 'chat.role': 'assistant' }
        ));
        return;
      }

      session.outputStream.next(createTextChunk(
        `Found ${windows.length} window(s). Summarizing...`,
        'com.rxcafe.tmux-buffer',
        { 'chat.role': 'assistant' }
      ));

      const summaries: string[] = [];
      
      for (const windowInfo of windows) {
        const content = await getWindowContent(windowInfo.split(':')[0]);
        const summary = await summarizeWindow(content, windowInfo);
        summaries.push(summary);
      }

      const combinedSummary = `## Tmux Window Summary (${new Date().toLocaleDateString()})\n\n` + 
        summaries.join('\n\n');

      session.outputStream.next(createTextChunk(
        combinedSummary,
        'com.rxcafe.tmux-buffer',
        { 
          'chat.role': 'assistant',
          'parsers.markdown.enabled': true
        }
      ));
    };

    // Run immediately on startup, then schedule daily at 09:00
    performSummarization('startup').then(() => {
      if (session.callbacks?.onFinish) {
        session.callbacks.onFinish();
      }
    });
    session.schedule('0 9 * * *', () => {
      performSummarization('scheduled-task').then(() => {
        if (session.callbacks?.onFinish) {
          session.callbacks.onFinish();
        }
      });
    });

    // Handle interactive commands
    const sub = session.inputStream.pipe(
      filter((chunk: Chunk) => chunk.contentType === 'text' && chunk.annotations['chat.role'] === 'user')
    ).subscribe(async chunk => {
      const text = (chunk.content as string).trim();
      
      try {
        if (text === '!help') {
          session.outputStream.next(createTextChunk(
            `Available commands:
- \`!summarize\`: Summarize all tmux windows now
- \`!summarize-commands\`: Show tmux commands that would run (dry run)
- \`!windows\`: List all tmux windows
- \`!help\`: Show this message`,
            'com.rxcafe.tmux-buffer',
            { 'chat.role': 'assistant' }
          ));
        }
        else if (text === '!summarize') {
          await performSummarization('manual-trigger');
        }
        else if (text === '!summarize-commands') {
          const windows = await getWindowList();
          const commands = windows.map(w => `tmux -S ${tmuxSocket} capture-pane -t ${w.split(':')[0]} -p`).join('\n');
          session.outputStream.next(createTextChunk(
            `Would run:\n${commands || '(no windows)'}`,
            'com.rxcafe.tmux-buffer',
            { 'chat.role': 'assistant' }
          ));
        }
        else if (text === '!windows') {
          const windows = await getWindowList();
          const windowList = windows.length > 0 
            ? windows.map(w => `- ${w}`).join('\n')
            : 'No windows found';
          session.outputStream.next(createTextChunk(
            `Current tmux windows:\n${windowList}`,
            'com.rxcafe.tmux-buffer',
            { 'chat.role': 'assistant' }
          ));
        }
      } finally {
        if (session.callback) {
          session.callbacks.onFinish();
        }
      }
    });
    
    session.pipelineSubscription = sub;
  }
};

export default tmuxBufferAgent;
