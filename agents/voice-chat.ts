/**
 * Voice Chat Agent
 * Accepts both text and audio input. Audio is transcribed to text,
 * then processed through an LLM like the default agent.
 */

import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { annotateChunk, createTextChunk } from '../lib/chunk.js';
import { EMPTY, filter, map, mergeMap, catchError } from '../lib/stream.js';
import { completeTurnWithLLM } from '../lib/evaluator-utils.js';
import { transcribeToUserChunk } from '../evaluators/handy-transcriber.js';
import { convertToMp3 } from '../evaluators/audio-converter.js';

export const voiceChatAgent: AgentDefinition = {
  name: 'voice-chat',
  description: 'Chat agent that accepts both text and audio input. Audio is transcribed and processed by LLM.',
  configSchema: {
    type: 'object',
    properties: {
      backend: { type: 'string', description: 'LLM backend (kobold or ollama)', default: 'ollama' },
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
      },
      handyConfig: {
        type: 'object',
        description: 'Configuration for Handy transcription service',
        properties: {
          baseUrl: { type: 'string', default: 'http://localhost:5500' },
          responseFormat: { type: 'string', enum: ['json', 'verbose_json'], default: 'json' }
        },
        default: {
          baseUrl: 'http://localhost:5500',
          responseFormat: 'json'
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
      },
      handyConfig: {
        baseUrl: 'http://localhost:5500',
        responseFormat: 'json'
      }
    },
    required: ['backend', 'model']
  },
  
  initialize(session: AgentSessionContext) {
    const handyConfig = session.sessionConfig.handyConfig || { baseUrl: 'http://localhost:5500' };
    const transcriber = transcribeToUserChunk(session, handyConfig);

    // Create audio converter for MP3 conversion (Handy API requires MP3)
    const audioConverter = convertToMp3({
      targetFormat: 'mp3',
      targetMimeType: 'audio/mpeg'
    });

    const sub = session.inputStream.pipe(
      // Handle both text and binary (audio) chunks
      filter((chunk: Chunk) => chunk.contentType === 'text' || chunk.contentType === 'binary'),
      
      // Convert audio chunks to MP3 format before transcription
      mergeMap((chunk: Chunk) => {
        if (chunk.contentType === 'binary') {
          const binaryContent = chunk.content as { data: Uint8Array; mimeType: string };
          if (binaryContent.mimeType?.startsWith('audio/')) {
            return audioConverter(chunk);
          }
        }
        return [chunk];
      }),
      
      // If it's an audio chunk, transcribe it to a user text chunk
      // If it's already text, pass it through
      mergeMap((chunk: Chunk) => {
        if (chunk.contentType === 'binary') {
          const binaryContent = chunk.content as { data: Uint8Array; mimeType: string };
          // Only process audio binaries
          if (binaryContent.mimeType?.startsWith('audio/')) {
            return transcriber(chunk);
          }
          // Non-audio binaries pass through but won't be processed by LLM
          return [chunk];
        }
        // Text chunks pass through
        return [chunk];
      }),
      
      // Ensure text chunks have a chat role
      map((chunk: Chunk) => {
        if (chunk.contentType !== 'text') return chunk;
        if (chunk.annotations['chat.role']) return chunk;
        return annotateChunk(chunk, 'chat.role', 'user');
      }),
      
      // Trust filtering (same as default agent)
      filter((chunk: Chunk) => {
        if (chunk.contentType !== 'text') return false; // Only process text chunks
        const trustLevel = chunk.annotations['security.trust-level'];
        return !trustLevel || trustLevel.trusted !== false;
      }),
      
      // Process user messages through LLM
      mergeMap((chunk: Chunk) => {
        if (chunk.contentType !== 'text') return [chunk];
        if (chunk.annotations['chat.role'] !== 'user') return [chunk];
        // Create fresh evaluator per message to pick up runtime config changes
        return completeTurnWithLLM(chunk, session.createLLMChunkEvaluator(), session);
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

export default voiceChatAgent;
