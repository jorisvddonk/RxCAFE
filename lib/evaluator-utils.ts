/**
 * Evaluator Utilities
 * 
 * Common patterns for processing chunks with LLM evaluators.
 * Provides higher-order functions that return RxJS operators.
 */

import type { AgentEvaluator, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { createTextChunk, createNullChunk, annotateChunk } from '../lib/chunk.js';
import { Observable } from '../lib/stream.js';
import { buildConversationContext } from '../core.js';

/**
 * Complete a chat turn by generating an LLM response.
 * 
 * This is the standard pattern for generating assistant responses:
 * 1. Builds conversation context from history (excluding current chunk)
 * 2. Creates a prompt with context + current message
 * 3. Streams tokens from LLM evaluator
 * 4. Emits chunks via subscriber and calls session callbacks
 * 
 * @param chunk - The user input chunk to respond to
 * @param evaluator - The LLM evaluator to generate with
 * @param session - The session context for history and callbacks
 * @returns Observable that emits the assistant response chunk
 */
export function completeTurnWithLLM(
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
    
    const assistantChunkId = crypto.randomUUID();
    let fullResponse = '';
    
    (async () => {
      try {
        for await (const tokenChunk of evaluator.evaluateChunk(contextChunk)) {
          if (tokenChunk.contentType === 'text') {
            const token = tokenChunk.content as string;
            fullResponse += token;
            if (session.callbacks?.onToken) {
              session.callbacks.onToken(token, assistantChunkId);
            }
          }
        }
        
        // Strip stop token from end if configured
        let strippedResponse = fullResponse;
        const stopSequences = (session.runtimeConfig as any).llmParams?.stop;
        const stripEnabled = (session.runtimeConfig as any).llmParams?.stopTokenStrip;
        if (stripEnabled && stopSequences && Array.isArray(stopSequences)) {
          for (const stopSeq of stopSequences) {
            if (typeof stopSeq === 'string' && strippedResponse.endsWith(stopSeq)) {
              strippedResponse = strippedResponse.slice(0, -stopSeq.length);
              break;
            }
          }
        }
        
        const assistantChunk = createTextChunk(strippedResponse, 'com.rxcafe.assistant', {
          'chat.role': 'assistant'
        });
        (assistantChunk as any).id = assistantChunkId;
        
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
