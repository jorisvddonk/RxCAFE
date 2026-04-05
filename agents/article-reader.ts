/**
 * ArticleReader Agent
 * Reads articles from URLs and provides both text and voice output.
 * Uses Mozilla Readability to extract clean article content.
 * 
 * Accepts text chunks containing URLs, parses them to clean text,
 * emits the text chunk, then generates voice audio for the article.
 * 
 * Runtime config (send null chunk with 'config.type: 'runtime''):
 * {
 *   "config.voice": {
 *     "backend": "voicebox",
 *     "profile": "ArticleReader",
 *     "voicebox": { "engine": "qwen" }
 *   }
 * }
 */

import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { annotateChunk, createTextChunk } from '../lib/chunk.js';
import { EMPTY, filter, map, mergeMap, catchError } from '../lib/stream.js';
import { parseArticle } from '../evaluators/readability.js';
import { generateVoicePlain } from '../evaluators/voice-plain.js';

const ARTICLEREADER_SYSTEM_PROMPT = `You are ArticleReader, a helpful agent that reads articles aloud. You take URLs, extract clean article content, and provide both text and voice versions for easy consumption.`;

export const articleReaderAgent: AgentDefinition = {
  name: 'article-reader',
  description: 'Reads articles from URLs, extracts clean text, and generates voice audio. Accepts URLs in text chunks.',
  configSchema: {
    type: 'object',
    properties: {
      voice: {
        type: 'object',
        description: 'Voice TTS configuration',
        properties: {
          backend: { type: 'string', enum: ['coqui', 'voicebox'], default: 'voicebox' },
          profile: { type: 'string', description: 'Voicebox profile name', default: 'ArticleReader' },
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
        },
        default: {
          backend: 'voicebox',
          profile: 'ArticleReader',
          voicebox: { engine: 'qwen' }
        }
      }
    },
    default: {
      voice: {
        backend: 'voicebox',
        profile: 'ArticleReader',
        voicebox: { engine: 'qwen' }
      }
    }
  },

  initialize(session: AgentSessionContext) {
    const sub = session.inputStream.pipe(
      // Accept text chunks (URLs)
      filter((chunk: Chunk) => chunk.contentType === 'text'),

      // Annotate with user role if not present
      map((chunk: Chunk) => {
        if (chunk.annotations['chat.role']) return chunk;
        return annotateChunk(chunk, 'chat.role', 'user');
      }),

      // Trust filtering
      filter((chunk: Chunk) => {
        const trustLevel = chunk.annotations['security.trust-level'];
        return !trustLevel || trustLevel.trusted !== false;
      }),

      // Parse article using readability
      mergeMap(parseArticle(session)),

      // Extract the parsed text and create a new text chunk for output
      mergeMap((chunk: Chunk) => {
        const readabilityResult = chunk.annotations['com.rxcafe.readability-parser'];
        if (!readabilityResult) return [chunk];

        // Create text chunk with the article text
        const articleTextChunk = createTextChunk(readabilityResult.text, 'assistant', {
          'chat.role': 'assistant',
          'article.source-url': chunk.content,
          'article.paragraphs': readabilityResult.paragraphs.length
        });

        // Emit the text chunk first
        session.outputStream.next(articleTextChunk);

        // Annotate with voice config for TTS
        const voicedChunk = annotateChunk(articleTextChunk, 'voice.config', session.runtimeConfig.voice);

        return [voicedChunk];
      }),

      // Generate voice output
      generateVoicePlain(session),

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

export default articleReaderAgent;