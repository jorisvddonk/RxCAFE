/**
 * Readability Article Parser Evaluator
 * 
 * Parses URLs using Mozilla Readability to extract clean article content.
 * Annotates chunks with parsed text, paragraphs, and HTML content.
 * 
 * Expects text chunks containing valid URLs.
 * Results are emitted to both the pipeline and session output stream
 * for persistent storage.
 */

import type { AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { annotateChunk } from '../lib/chunk.js';
import { Observable } from '../lib/stream.js';
import { parse } from '../lib/util/readability/readability-parser.js';

/**
 * Result of readability parsing
 */
export interface ReadabilityResult {
  paragraphs: string[];
  text: string;
  content: string;
}

/**
 * Higher-order function that returns a readability parsing processor.
 * Automatically handles URL fetching and content extraction.
 */
export function parseArticle(session: AgentSessionContext) {
  return (chunk: Chunk): Observable<Chunk> => {
    return new Observable(subscriber => {
      if (chunk.contentType !== 'text') {
        subscriber.next(chunk);
        subscriber.complete();
        return;
      }

      const url = chunk.content as string;
      if (!url || typeof url !== 'string' || !url.startsWith('http')) {
        subscriber.next(chunk);
        subscriber.complete();
        return;
      }

      (async () => {
        try {
          const result = await parse(url);
          
          const annotated = annotateChunk(chunk, 'com.rxcafe.readability-parser', result);
          
          // Emit the annotated chunk to the persistent session stream
          session.outputStream.next(annotated);
          
          // Pass it down the pipeline
          subscriber.next(annotated);
        } catch (err) {
          console.error('[ReadabilityEvaluator] Parsing failed:', err);
          subscriber.next(chunk);
        } finally {
          subscriber.complete();
        }
      })();
    });
  };
}