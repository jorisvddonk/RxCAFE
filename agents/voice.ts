/**
 * Voice Agent
 * Demonstrates the full voice pipeline: chat + markdown parsing + TTS generation.
 * 
 * Runtime config (send null chunk with 'config.type: 'runtime''):
 * {
 *   "config.voice": {
 *     "voices": { "text": "Robert.wav", "quote": "Robert.wav" },
 *     "generation": { "temperature": 0.8 },
 *     "ttsEndpoint": "http://localhost:8000/tts"
 *   }
 * }
 */

import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { annotateChunk } from '../lib/chunk.js';
import { EMPTY, filter, map, mergeMap, catchError } from '../lib/stream.js';
import { completeTurnWithLLM } from '../lib/evaluator-utils.js';
import { parseMarkdownForVoice } from '../evaluators/markdown-voice-parser.js';
import { generateVoice } from '../evaluators/voice.js';

export const voiceAgent: AgentDefinition = {
  name: 'voice',
  description: 'Chat agent with voice TTS generation for markdown text',
  configSchema: {
    type: 'object',
    properties: {
      backend: { type: 'string', description: 'LLM backend (kobold, ollama, or llamacpp)', default: 'ollama' },
      model: { type: 'string', description: 'Model name' },
      systemPrompt: { type: 'string', description: 'System prompt' },
      voice: {
        type: 'object',
        description: 'Voice TTS configuration',
        properties: {
          backend: { type: 'string', enum: ['coqui', 'voicebox'], default: 'voicebox' },
          voices: { type: 'object', description: 'Map of voice types to profile IDs' },
          ttsEndpoint: { type: 'string', description: 'TTS endpoint URL' },
          voicebox: {
            type: 'object',
            properties: {
              engine: { type: 'string', enum: ['qwen', 'luxtts', 'chatterbox', 'chatterbox_turbo'], default: 'qwen' },
              normalize: { type: 'boolean', default: true },
              maxChunkChars: { type: 'number', default: 800 },
              crossfadeMs: { type: 'number', default: 50 }
            }
          }
        }
      },
      llmParams: {
        type: 'object',
        properties: {
          temperature: { type: 'number', default: 0.7 },
          maxTokens: { type: 'number', default: 500 },
          topP: { type: 'number', default: 0.9 },
          topK: { type: 'number', default: 40 },
          repeatPenalty: { type: 'number', default: 1.1 },
          stop: { type: 'array', items: { type: 'string' }, default: [] },
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
        return completeTurnWithLLM(chunk, session.createLLMChunkEvaluator(), session);
      }),

      parseMarkdownForVoice(session),

      generateVoice(session),
      
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

export default voiceAgent;
