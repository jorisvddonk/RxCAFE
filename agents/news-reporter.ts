/**
 * News Reporter Agent (Example Background Agent)
 * 
 * A background agent that periodically generates news summaries.
 * This is an example of how to create a background agent with scheduled tasks.
 */

import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { createTextChunk, createNullChunk, annotateChunk } from '../lib/chunk.js';
import { Subject, EMPTY, Observable } from '../lib/stream.js';
import { filter, map, mergeMap, catchError, tap } from '../lib/stream.js';

export const newsReporterAgent: AgentDefinition = {
  name: 'news-reporter',
  description: 'Example background agent that demonstrates scheduled tasks. Reports hourly.',
  startInBackground: false,
  
  async initialize(session: AgentSessionContext) {
    const evaluator = session.createEvaluator(
      session.sessionConfig.backend || session.config.backend,
      session.sessionConfig.model,
      { temperature: 0.7, maxTokens: 200 }
    );
    
    await session.loadState();
    
    const sub = session.inputStream.pipe(
      filter((chunk: Chunk) => chunk.contentType === 'text'),
      map((chunk: Chunk) => {
        if (chunk.annotations['chat.role']) {
          return chunk;
        }
        return annotateChunk(chunk, 'chat.role', 'user');
      }),
      mergeMap((chunk: Chunk) => processWithEvaluator(chunk, evaluator, session)),
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

function processWithEvaluator(
  chunk: Chunk,
  evaluator: { evaluateChunk(chunk: Chunk): AsyncGenerator<Chunk> },
  session: AgentSessionContext
): Observable<Chunk> {
  return new Observable(subscriber => {
    if (chunk.contentType !== 'text') {
      subscriber.next(chunk);
      subscriber.complete();
      return;
    }
    
    if (chunk.annotations['chat.role'] !== 'user') {
      subscriber.next(chunk);
      subscriber.complete();
      return;
    }
    
    const context = buildConversationContext(session.history, chunk.id, session.systemPrompt);
    const currentMessage = chunk.content as string;
    
    const prompt = context
      ? `${context}\n\nUser: ${currentMessage}\nAssistant:`
      : `User: ${currentMessage}\nAssistant:`;
    
    subscriber.next(createNullChunk('com.rxcafe.llm', {
      'llm.generation-started': true,
      'llm.parent-chunk-id': chunk.id
    }));
    
    let fullResponse = '';
    
    (async () => {
      try {
        const contextChunk = createTextChunk(prompt, chunk.producer);
        
        for await (const tokenChunk of evaluator.evaluateChunk(contextChunk)) {
          if (tokenChunk.contentType === 'text') {
            const token = tokenChunk.content as string;
            fullResponse += token;
          }
        }
        
        const assistantChunk = createTextChunk(fullResponse, 'com.rxcafe.assistant', {
          'chat.role': 'assistant'
        });
        subscriber.next(assistantChunk);
        
        await session.persistState();
        
        subscriber.complete();
      } catch (error) {
        subscriber.next(createNullChunk('com.rxcafe.error', {
          'error.message': error instanceof Error ? error.message : 'LLM error',
          'error.source-chunk-id': chunk.id
        }));
        
        subscriber.error(error);
      }
    })();
  });
}

function buildConversationContext(
  history: Chunk[],
  excludeChunkId?: string,
  systemPrompt?: string | null
): string {
  const contextParts: string[] = [];
  
  if (systemPrompt) {
    contextParts.push(`System: ${systemPrompt}`);
  }
  
  for (const chunk of history) {
    if (chunk.id === excludeChunkId) continue;
    if (chunk.contentType !== 'text') continue;
    
    const role = chunk.annotations['chat.role'];
    const trustLevel = chunk.annotations['security.trust-level'];
    const isChunkTrusted = !trustLevel || trustLevel.trusted === true;
    
    if (!isChunkTrusted) continue;
    
    const content = chunk.content as string;
    
    if (role === 'user') {
      contextParts.push(`User: ${content}`);
    } else if (role === 'assistant') {
      contextParts.push(`Assistant: ${content}`);
    }
  }
  
  return contextParts.join('\n\n');
}

export default newsReporterAgent;
