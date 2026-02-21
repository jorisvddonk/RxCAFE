/**
 * Default Agent
 * Standard chat pipeline - same behavior as the original hardcoded pipeline
 */

import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { createTextChunk, createNullChunk, annotateChunk } from '../lib/chunk.js';
import { Subject, EMPTY, Observable } from '../lib/stream.js';
import { filter, map, mergeMap, catchError, tap } from '../lib/stream.js';

export const defaultAgent: AgentDefinition = {
  name: 'default',
  description: 'Standard chat pipeline with trust filtering',
  
  initialize(session: AgentSessionContext) {
    const config = session.sessionConfig;
    const backend = config.backend || session.config.backend;
    const model = config.model;
    const llmParams = config.llmParams || {};
    
    const evaluator = session.createEvaluator(backend, model, llmParams);
    
    const sub = session.inputStream.pipe(
      filter((chunk: Chunk) => chunk.contentType === 'text'),
      
      map((chunk: Chunk) => {
        if (chunk.annotations['chat.role']) {
          return chunk;
        }
        return annotateChunk(chunk, 'chat.role', 'user');
      }),
      
      filter((chunk: Chunk) => {
        const trustLevel = chunk.annotations['security.trust-level'];
        return !trustLevel || trustLevel.trusted !== false;
      }),
      
      mergeMap((chunk: Chunk) => processWithEvaluator(chunk, evaluator, session)),
      
      map((chunk: Chunk) => {
        if (chunk.contentType === 'text' &&
            (chunk.producer === 'com.rxcafe.kobold-evaluator' ||
             chunk.producer === 'com.rxcafe.ollama-evaluator' ||
             chunk.producer === 'com.rxcafe.assistant')) {
          return annotateChunk(chunk, 'chat.role', 'assistant');
        }
        return chunk;
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
    
    if (session.config.tracing) {
      console.log('\n═══════════════════════════════════════════════════════════');
      console.log('RXCAFE_TRACE: LLM Context');
      console.log('═══════════════════════════════════════════════════════════');
      console.log(`Chunk ID: ${chunk.id}`);
      console.log(`Context Length: ${context.length} chars`);
      console.log(`Total Prompt Length: ${prompt.length} chars`);
      console.log('\n--- FULL CONTEXT SENT TO LLM ---');
      console.log(prompt);
      console.log('--- END CONTEXT ---\n');
    }
    
    const contextChunk = annotateChunk(
      createTextChunk(prompt, chunk.producer),
      'llm.context-length',
      context.length
    );
    
    subscriber.next(createNullChunk('com.rxcafe.llm', {
      'llm.generation-started': true,
      'llm.backend': session.sessionConfig.backend || session.config.backend,
      'llm.parent-chunk-id': chunk.id
    }));
    
    let fullResponse = '';
    
    (async () => {
      try {
        for await (const tokenChunk of evaluator.evaluateChunk(contextChunk)) {
          if (tokenChunk.contentType === 'text') {
            const token = tokenChunk.content as string;
            fullResponse += token;
            if (session.callbacks?.onToken) {
              session.callbacks.onToken(token);
            }
          }
        }
        
        const assistantChunk = createTextChunk(fullResponse, 'com.rxcafe.assistant', {
          'chat.role': 'assistant'
        });
        subscriber.next(assistantChunk);
        
        if (session.callbacks?.onFinish) {
          session.callbacks.onFinish(fullResponse);
        }
        
        if (session.isBackground) {
          await session.persistState();
        }
        
        subscriber.complete();
      } catch (error) {
        subscriber.next(createNullChunk('com.rxcafe.error', {
          'error.message': error instanceof Error ? error.message : 'LLM error',
          'error.source-chunk-id': chunk.id
        }));
        
        if (session.callbacks?.onError) {
          session.callbacks.onError(error instanceof Error ? error : new Error('LLM error'));
        }
        
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
    } else if (chunk.producer === 'com.rxcafe.web-fetch' || chunk.annotations['web.source-url']) {
      const url = chunk.annotations['web.source-url'] || 'unknown';
      contextParts.push(`[Web content from ${url}]: ${content}`);
    }
  }
  
  return contextParts.join('\n\n');
}

export default defaultAgent;
