import type { AgentEvaluator, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { createTextChunk, createNullChunk, annotateChunk } from '../lib/chunk.js';
import { Observable } from '../lib/stream.js';
import { buildConversationContext } from '../core.js';

/**
 * Standard utility to process a chunk with an LLM evaluator and return a streaming response.
 * Handles context building, null chunk generation signals, token streaming, and history persistence.
 */
export function processWithEvaluator(
  chunk: Chunk,
  evaluator: AgentEvaluator,
  session: AgentSessionContext
): Observable<Chunk> {
  return new Observable(subscriber => {
    if (chunk.contentType !== 'text') {
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
    
    // Signal start of generation
    subscriber.next(createNullChunk('com.rxcafe.llm', {
      'llm.generation-started': true,
      'llm.backend': (session as any).runtimeConfig?.backend || session.config.backend,
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
          session.callbacks.onFinish();
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
