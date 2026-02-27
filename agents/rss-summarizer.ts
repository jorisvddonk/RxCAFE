import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { createTextChunk } from '../lib/chunk.js';
import { filter } from '../lib/stream.js';
import { summarizeRss } from '../evaluators/rss-processor.js';

/**
 * RSS Summarizer Agent
 * Fetches RSS feeds daily at 07:00 and summarizes them using an LLM.
 * Responds to commands for manual control.
 */
export const rssSummarizerAgent: AgentDefinition = {
  name: 'rss-summarizer',
  description: 'Daily RSS feed summarizer (runs at 07:00)',
  startInBackground: true,
  configSchema: {
    type: 'object',
    properties: {},
    required: []
  },
  
  async initialize(session: AgentSessionContext) {
    console.log(`[RssAgent] Initializing for session ${session.id}`);
    
    // Configuration
    const feeds = ['https://hnrss.org/frontpage'];
    const runSummarization = summarizeRss(session);

    const performBriefing = async (trigger: string) => {
      console.log(`[RssAgent] Starting briefing triggered by: ${trigger}`);
      session.outputStream.next(createTextChunk(
        `🗞️ Starting daily briefing for ${new Date().toLocaleDateString()}...`,
        'com.rxcafe.rss-agent',
        { 'chat.role': 'assistant' }
      ));

      for (const url of feeds) {
        const summary = await runSummarization(url);
        session.outputStream.next(createTextChunk(
          `### Summary for ${url}\n\n${summary}`,
          'com.rxcafe.rss-agent',
          { 
            'chat.role': 'assistant', 
            'rss.source': url,
            'parsers.markdown.enabled': true
          }
        ));
      }
    };

    // 1. Schedule daily task (07:00)
    session.schedule('0 7 * * *', () => performBriefing('scheduled-task'));

    // 2. Handle interactive commands
    const sub = session.inputStream.pipe(
      filter((chunk: Chunk) => chunk.contentType === 'text' && chunk.annotations['chat.role'] === 'user')
    ).subscribe(async chunk => {
      const text = (chunk.content as string).trim();
      
      try {
        if (text === '!help') {
          session.outputStream.next(createTextChunk(
            `Available commands:\n- \`!refresh\`: Trigger summarization now\n- \`!feeds\`: List tracked RSS feeds\n- \`!help\`: Show this message`,
            'com.rxcafe.rss-agent',
            { 'chat.role': 'assistant' }
          ));
        } 
        else if (text === '!refresh') {
          await performBriefing('manual-trigger');
        }
        else if (text === '!feeds') {
          const list = feeds.map(f => `- ${f}`).join('\n');
          session.outputStream.next(createTextChunk(
            `Currently tracked feeds:\n${list}`,
            'com.rxcafe.rss-agent',
            { 'chat.role': 'assistant' }
          ));
        }
      } finally {
        if (session.callbacks?.onFinish) {
          session.callbacks.onFinish();
        }
      }
    });
    
    session.pipelineSubscription = sub;
  }
};

export default rssSummarizerAgent;
