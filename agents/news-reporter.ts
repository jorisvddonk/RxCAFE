/**
 * News Reporter Agent
 * A background agent that periodically generates news summaries.
 */

import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { createTextChunk, annotateChunk } from '../lib/chunk.js';
import { EMPTY, filter, map, mergeMap, catchError } from '../lib/stream.js';
import { completeTurnWithLLM } from '../lib/evaluator-utils.js';

export const newsReporterAgent: AgentDefinition = {
  name: 'news-reporter',
  description: 'Background agent that reports interesting tech news every hour.',
  startInBackground: false,
  configSchema: {
    type: 'object',
    properties: {
      backend: { type: 'string', description: 'LLM backend (kobold or ollama)' },
      model: { type: 'string', description: 'Model name' },
    },
    required: ['backend', 'model']
  },
  
  async initialize(session: AgentSessionContext) {
    await session.loadState();
    
    const sub = session.inputStream.pipe(
      filter((chunk: Chunk) => chunk.contentType === 'text'),
      map((chunk: Chunk) => {
        if (chunk.annotations['chat.role']) return chunk;
        return annotateChunk(chunk, 'chat.role', 'user');
      }),
      mergeMap((chunk: Chunk) => {
        if (chunk.annotations['chat.role'] !== 'user') return [chunk];
        // Create fresh evaluator per message to pick up runtime config changes
        return completeTurnWithLLM(chunk, session.createLLMChunkEvaluator({ temperature: 0.7, maxTokens: 200 }), session);
      }),
      catchError((error: Error) => {
        session.errorStream.next(error);
        return EMPTY;
      })
    ).subscribe({
      next: (chunk: Chunk) => session.outputStream.next(chunk),
      error: (error: Error) => session.errorStream.next(error)
    });
    
    session.pipelineSubscription = sub;
    
    session.schedule('0 * * * *', async () => {
      console.log(`[news-reporter] Scheduled task triggered at ${new Date().toISOString()}`);
      
      const scheduledChunk = createTextChunk(
        'What is the most interesting thing happening in technology right now? Give a brief summary.',
        'com.rxcafe.scheduler',
        { 'chat.role': 'user', 'scheduled': true, 'agent': 'news-reporter' }
      );
      
      session.inputStream.next(scheduledChunk);
    });
  }
};

export default newsReporterAgent;
