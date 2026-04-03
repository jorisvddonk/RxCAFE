/**
 * Image Agent
 * Demonstrates the image generation pipeline: chat + LLM prompt generation + ComfyUI
 * 
 * Runtime config (send null chunk with 'config.type: 'runtime''):
 * {
 *   "config.comfyui": {
 *     "host": "localhost",
 *     "port": 8188,
 *     "outputFolder": "generated/images"
 *   }
 * }
 */

import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { annotateChunk } from '../lib/chunk.js';
import { EMPTY, filter, map, mergeMap, catchError, of } from '../lib/stream.js';
import { completeTurnWithLLM } from '../lib/evaluator-utils.js';
import { generateImage } from '../evaluators/image-generator.js';

export const imageAgent: AgentDefinition = {
  name: 'image',
  description: 'Chat agent with image generation via ComfyUI',
  configSchema: {
    type: 'object',
    properties: {
      backend: { type: 'string', description: 'LLM backend (kobold, ollama, or llamacpp)', default: 'ollama' },
      model: { type: 'string', description: 'Model name' },
      systemPrompt: { type: 'string', description: 'System prompt' },
      llmParams: {
        type: 'object',
        properties: {
          temperature: { type: 'number', default: 0.7 },
          maxTokens: { type: 'number', default: 500 },
          topP: { type: 'number', default: 0.9 },
          topK: { type: 'number', default: 40 },
          repeatPenalty: { type: 'number', default: 1.1 },
          stop: { type: 'array', items: { type: 'string' }, default: ['\nUser:', 'Assistant:'] },
          seed: { type: 'number' },
          maxContextLength: { type: 'number' },
          numCtx: { type: 'number' },
        },
        default: {
          temperature: 0.7,
          maxTokens: 500,
          topP: 0.9,
          topK: 40,
          repeatPenalty: 1.1
        }
      }
    },
    default: {
      backend: 'ollama',
      llmParams: {
        temperature: 0.7,
        maxTokens: 500,
        topP: 0.9,
        topK: 40,
        repeatPenalty: 1.1
      }
    },
    required: ['backend', 'model']
  },
  
  initialize(session: AgentSessionContext) {
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
        if (chunk.annotations['chat.role'] !== 'user') return [chunk];
        
        const text = (chunk.content as string || '').toLowerCase();
        const isImageRequest = text.includes('image') || text.includes('generate') || text.includes('draw') || text.includes('paint');
        
        if (isImageRequest) {
          // Route to image generator - it handles its own LLM calls for prompt generation
          return of(chunk).pipe(generateImage(session));
        } else {
          // Normal chat completion
          return completeTurnWithLLM(chunk, session.createLLMChunkEvaluator(), session);
        }
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

export default imageAgent;
