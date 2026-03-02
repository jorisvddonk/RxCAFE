import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { annotateChunk, createTextChunk } from '../lib/chunk.js';
import { EMPTY, filter, map, mergeMap, catchError, from } from '../lib/stream.js';
import { completeTurnWithLLM } from '../lib/evaluator-utils.js';
import { executeTools, getToolsSystemPrompt } from '../evaluators/tool-executor.js';
import { detectToolCalls } from '../evaluators/tool-call-detector.js';
import { SheetbotAPI, TaskStatusNames } from '../lib/sheetbot-api.js';

export interface SheetbotTaskCreatorConfig {
  baseUrl?: string;
  apiKey?: string;
  token?: string;
  backend?: string;
  model?: string;
  systemPrompt?: string;
  llmParams?: {
    temperature?: number;
    maxTokens?: number;
  };
}

const SHEETBOT_TOOLS = [
  'sheetbot_list_sheets',
  'sheetbot_get_sheet',
  'sheetbot_list_tasks',
  'sheetbot_get_task',
  'sheetbot_create_task',
  'sheetbot_delete_task',
  'sheetbot_list_agents',
  'sheetbot_list_library'
];

function parseCommand(text: string): { command: string; args: string[] } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('!')) return null;
  
  const parts = trimmed.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);
  
  return { command, args };
}

function createResponseChunk(content: string, isMarkdown: boolean = false): Chunk {
  const annotations: Record<string, any> = {
    'chat.role': 'assistant',
    'sheetbot.response': true
  };
  if (isMarkdown) {
    annotations['parsers.markdown.enabled'] = true;
  }
  return createTextChunk(content, 'com.rxcafe.sheetbot-agent', annotations);
}

function createErrorChunk(message: string): Chunk {
  return createTextChunk(message, 'com.rxcafe.sheetbot-agent', {
    'chat.role': 'assistant',
    'sheetbot.error': true
  });
}

export const sheetbotTaskCreatorAgent: AgentDefinition = {
  name: 'sheetbot',
  description: 'Create and manage SheetBot tasks via natural language. Use !commands for quick access or ask naturally.',
  configSchema: {
    type: 'object',
    properties: {
      baseUrl: { type: 'string', description: 'SheetBot server URL (default: from SHEETBOT_BASEURL env or http://localhost:3000)' },
      apiKey: { type: 'string', description: 'API key for authentication (default: from SHEETBOT_AUTH_APIKEY env)' },
      token: { type: 'string', description: 'JWT token for authentication (optional, will be obtained via login if apiKey provided)' },
      backend: { type: 'string', description: 'LLM backend (kobold or ollama)', default: 'ollama' },
      model: { type: 'string', description: 'Model name' },
      systemPrompt: { type: 'string', description: 'System prompt override' },
      llmParams: {
        type: 'object',
        properties: {
          temperature: { type: 'number' },
          maxTokens: { type: 'number' }
        }
      }
    },
    required: ['backend', 'model']
  },

  initialize(session: AgentSessionContext) {
    const config = session.config as SheetbotTaskCreatorConfig;
    
    const getAuthenticatedApi = async (): Promise<SheetbotAPI> => {
      const baseUrl = config.baseUrl || process.env.SHEETBOT_BASEURL || 'http://localhost:3000';
      const api = new SheetbotAPI(baseUrl);
      
      if (config.token) {
        api.setToken(config.token);
      } else {
        const apiKey = config.apiKey || process.env.SHEETBOT_AUTH_APIKEY;
        if (apiKey) {
          await api.loginWithApiKey(apiKey);
        }
      }
      
      return api;
    };
    
    const defaultSystemPrompt = `You are a helpful assistant that helps users create and manage SheetBot tasks.

SheetBot is a distributed task execution system where you can create tasks that run on remote agents.

When a user asks to create a task, help them:
1. Understand what script they want to run
2. Choose the appropriate execution type (deno, python, or bash)
3. Optionally add a name and data for the task

Available task statuses:
- AWAITING (0): Ready for execution
- RUNNING (1): Currently being executed  
- COMPLETED (2): Finished successfully
- FAILED (3): Finished with error
- PAUSED (4): Not ready for execution

Quick commands (use ! prefix for direct responses):
- !tasks - List all tasks
- !tasks <status> - Filter by status (0-4)
- !sheets - List all sheets
- !agents - List active agents
- !library - List script library
- !help - Show available commands

Or ask naturally and I'll use tools to help you manage tasks.

${getToolsSystemPrompt(SHEETBOT_TOOLS)}

Always confirm when you've created or modified a task, and provide the task ID to the user.`;

    session.systemPrompt = config.systemPrompt || defaultSystemPrompt;

    const sub = session.inputStream.pipe(
      filter((chunk: Chunk) => chunk.contentType === 'text'),
      
      map((chunk: Chunk) => {
        if (chunk.annotations['chat.role']) return chunk;
        return annotateChunk(chunk, 'chat.role', 'user');
      }),
      
      filter((chunk: Chunk) => {
        const trustLevel = chunk.annotations['security.trust-level'];
        return !trustLevel || trustLevel.trusted !== false;
      }),
      
      mergeMap((chunk: Chunk) => {
        if (chunk.annotations['chat.role'] !== 'user') return from([[chunk]]);
        
        const text = chunk.content as string;
        const parsed = parseCommand(text);
        
        if (parsed) {
          const callbacks = session.callbacks;
          return from((async () => {
            try {
              const api = await getAuthenticatedApi();
              let chunks: Chunk[];
              
              switch (parsed.command) {
                case '!help':
                  chunks = handleHelp();
                  break;
                
                case '!tasks':
                  chunks = await handleTasks(api, parsed.args);
                  break;
                
                case '!sheets':
                  chunks = await handleSheets(api);
                  break;
                
                case '!agents':
                  chunks = await handleAgents(api);
                  break;
                
                case '!library':
                  chunks = await handleLibrary(api);
                  break;
                
                default:
                  chunks = [createErrorChunk(`Unknown command: ${parsed.command}\n\nType !help for available commands.`)];
              }
              
              if (callbacks?.onFinish) {
                callbacks.onFinish();
              }
              
              return chunks;
            } catch (err) {
              const message = err instanceof Error ? err.message : 'Unknown error';
              const chunks = [createErrorChunk(`Error: ${message}`)];
              
              if (callbacks?.onFinish) {
                callbacks.onFinish();
              }
              
              return chunks;
            }
          })());
        }
        
        const backend = (config.backend || 'ollama') as 'ollama' | 'kobold';
        
        const evaluator = session.createLLMChunkEvaluator(
          backend,
          config.model,
          config.llmParams || { temperature: 0.7, maxTokens: 1000 }
        );
        
        return completeTurnWithLLM(chunk, evaluator, session).pipe(
          mergeMap(detectToolCalls()),
          mergeMap(executeTools({ tools: SHEETBOT_TOOLS }))
        );
      }),
      
      mergeMap((chunks: Chunk | Chunk[]) => Array.isArray(chunks) ? from(chunks) : [chunks]),
      
      catchError((error: Error) => {
        session.errorStream.next(error);
        return EMPTY;
      })
    ).subscribe({
      next: (chunk: Chunk) => session.outputStream.next(chunk),
      error: (error: Error) => session.errorStream.next(error)
    });
    
    session.pipelineSubscription = sub;
  }
};

function handleHelp(): Chunk[] {
  const lines = [
    'SheetBot Commands',
    '================',
    '',
    '| Command | Description |',
    '|---------|-------------|',
    '| `!tasks` | List all tasks |',
    '| `!tasks <status>` | Filter by status (0-4) |',
    '| `!sheets` | List all sheets |',
    '| `!agents` | List active agents |',
    '| `!library` | List script library |',
    '| `!help` | Show this help message |',
    '',
    'Or ask naturally like "create a task that does X"',
    '',
    '**Task Statuses:**',
    '| # | Status | Description |',
    '|--:|--------|-------------|',
    '| 0 | AWAITING | Ready for execution |',
    '| 1 | RUNNING | Currently being executed |',
    '| 2 | COMPLETED | Finished successfully |',
    '| 3 | FAILED | Finished with error |',
    '| 4 | PAUSED | Not ready for execution |',
  ];
  
  return [createResponseChunk(lines.join('\n'), true)];
}

async function handleTasks(api: SheetbotAPI, args: string[]): Promise<Chunk[]> {
  const tasks = await api.getTasks();
  
  let filtered = tasks;
  if (args.length > 0) {
    const statusFilter = parseInt(args[0]);
    if (!isNaN(statusFilter)) {
      filtered = tasks.filter(t => t.status === statusFilter);
    }
  }
  
  if (filtered.length === 0) {
    return [createResponseChunk('No tasks found.')];
  }
  
  const lines = [`**Tasks (${filtered.length}):**`, '', '| ID | Name | Status | Type |', '|----|------|--------|-----|'];
  for (const task of filtered.slice(0, 20)) {
    const id = task.id.slice(0, 8);
    const name = task.name || '(unnamed)';
    const status = `${task.status} (${TaskStatusNames[task.status]})`;
    lines.push(`| ${id} | ${name} | ${status} | ${task.type} |`);
  }
  
  if (filtered.length > 20) {
    lines.push('', `... and ${filtered.length - 20} more`);
  }
  
  return [createResponseChunk(lines.join('\n'), true)];
}

async function handleSheets(api: SheetbotAPI): Promise<Chunk[]> {
  const sheets = await api.listSheets();
  
  if (sheets.length === 0) {
    return [createResponseChunk('No sheets found.')];
  }
  
  const lines = [
    `**Sheets (${sheets.length}):**`,
    '',
    ...sheets.map(s => `- ${s}`)
  ];
  
  return [createResponseChunk(lines.join('\n'), true)];
}

async function handleAgents(api: SheetbotAPI): Promise<Chunk[]> {
  const stats = await api.getAgentTrackerStats(60);
  
  if (stats.agents.length === 0) {
    return [createResponseChunk('No active agents in the last 60 minutes.')];
  }
  
  const lines = [
    `**Active Agents (${stats.agents.length} in last ${stats.windowMinutes} min):**`,
    '',
    '| ID | Type | Last Seen |',
    '|----|------|-----------|'
  ];
  
  for (const agent of stats.agents) {
    const lastSeen = new Date(agent.lastSeen).toLocaleTimeString();
    const id = agent.id.slice(0, 8);
    lines.push(`| ${id} | ${agent.type} | ${lastSeen} |`);
  }
  
  return [createResponseChunk(lines.join('\n'), true)];
}

async function handleLibrary(api: SheetbotAPI): Promise<Chunk[]> {
  const library = await api.getLibrary();
  
  if (library.length === 0) {
    return [createResponseChunk('No library scripts found.')];
  }
  
  const lines = [`**Library (${library.length} scripts):**`, ''];
  
  for (const item of library.slice(0, 20)) {
    lines.push(`**${item.name}**`);
    lines.push(`  File: ${item.filename}`);
    if (item.comments) {
      lines.push(`  ${item.comments.split('\n')[0]}`);
    }
    lines.push('');
  }
  
  if (library.length > 20) {
    lines.push(`... and ${library.length - 20} more`);
  }
  
  return [createResponseChunk(lines.join('\n'), true)];
}

export default sheetbotTaskCreatorAgent;
