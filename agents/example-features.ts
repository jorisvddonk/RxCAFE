import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { annotateChunk } from '../lib/chunk.js';
import { EMPTY, filter, mergeMap, catchError } from '../lib/stream.js';
import { analyzeSentiment } from '../evaluators/sentiment.js';
import { detectToolCalls } from '../evaluators/tool-call-detector.js';
import { executeTools, TOOLS_SYSTEM_PROMPT } from '../evaluators/tool-executor.js';
import { completeTurnWithLLM } from '../lib/evaluator-utils.js';

/**
 * ExampleFeaturesAgent
 * Demonstrates a high-level, modular RXCAFE pipeline.
 */
export const exampleFeaturesAgent: AgentDefinition = {
  name: 'example-features',
  description: 'Demonstrates modular evaluators with sentiment analysis',
  configSchema: {
    type: 'object',
    properties: {
      backend: { type: 'string', description: 'LLM backend (kobold or ollama)' },
      model: { type: 'string', description: 'Model name' },
    },
    required: ['backend', 'model']
  },
  
   initialize(session: AgentSessionContext) {
     // Set system prompt with tool information
     if (!session.systemPrompt) {
       session.systemPrompt = TOOLS_SYSTEM_PROMPT;
     } else if (!session.systemPrompt.includes('rollDice')) {
       session.systemPrompt += '\n\n' + TOOLS_SYSTEM_PROMPT;
     }

     const sub = session.inputStream.pipe(
       filter((chunk: Chunk) => chunk.contentType === 'text' && chunk.annotations['chat.role'] === 'user'),
       
       // Step 1: Add sentiment metadata (encapsulated one-liner)
       mergeMap(analyzeSentiment(session)),
       
       // Step 2: Detect tool calls in user input
       mergeMap(detectToolCalls()),
       
       // Step 3: Generate assistant response (fresh evaluator per message)
        mergeMap(chunk => completeTurnWithLLM(chunk, session.createLLMChunkEvaluator(), session)),
       
       // Step 4: Detect tool calls in assistant responses
       mergeMap(detectToolCalls()),
       
       // Step 5: Execute detected tool calls
       mergeMap(executeTools()),
       
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

export default exampleFeaturesAgent;
