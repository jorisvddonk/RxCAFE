/**
 * Sentiment Analysis Evaluator
 * 
 * Analyzes text chunks for sentiment using an LLM.
 * Returns annotated chunks with score (-1.0 to 1.0) and explanation.
 * 
 * The analyzer uses temperature=0 for deterministic JSON extraction.
 * Results are emitted to both the pipeline and session output stream
 * for persistent storage.
 */

import type { AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { createTextChunk, annotateChunk } from '../lib/chunk.js';
import { Observable } from '../lib/stream.js';

/**
 * Result of sentiment analysis
 */
export interface SentimentAnalysis {
  score: number;
  explanation: string;
}

/**
 * Higher-order function that returns a sentiment analysis processor.
 * Automatically handles evaluator creation with optimal settings for JSON extraction.
 */
export function analyzeSentiment(session: AgentSessionContext) {
  // Encapsulate the specialized evaluator logic inside the helper
  // Use temperature=0 for deterministic JSON output
  const evaluator = session.createLLMChunkEvaluator({ 
    temperature: 0, 
    maxTokens: 150 
  });

  return (chunk: Chunk): Observable<Chunk> => {
    return new Observable(subscriber => {
      if (chunk.contentType !== 'text') {
        subscriber.next(chunk);
        subscriber.complete();
        return;
      }

      const text = chunk.content as string;
      const prompt = `You are a sentiment analysis expert. Analyze the sentiment of the following text.

Text to analyze: "${text}"

Return your analysis in the following JSON format:
{
  "score": <number from -1.0 to 1.0, where -1 is very negative, 0 is neutral, 1 is very positive>,
  "explanation": "<brief explanation of the sentiment>"
}

Only return the JSON, no other text.`;

      const promptChunk = createTextChunk(prompt, 'com.rxcafe.sentiment-analyzer', {
        'llm.full-prompt': true
      });

      let rawJson = '';
      
      (async () => {
        try {
          for await (const tokenChunk of evaluator.evaluateChunk(promptChunk)) {
            if (tokenChunk.contentType === 'text') {
              rawJson += tokenChunk.content;
            }
          }

          const start = rawJson.indexOf('{');
          const end = rawJson.lastIndexOf('}');
          if (start !== -1 && end !== -1) {
            const jsonStr = rawJson.substring(start, end + 1);
            const sentiment = JSON.parse(jsonStr) as SentimentAnalysis;
            
            const annotated = annotateChunk(chunk, 'com.rxcafe.example.sentiment', sentiment);
            
            // Emit the annotated chunk to the persistent session stream
            session.outputStream.next(annotated);
            
            // Pass it down the pipeline
            subscriber.next(annotated);
          } else {
            subscriber.next(chunk);
          }
        } catch (err) {
          console.error('[SentimentEvaluator] Analysis failed:', err);
          subscriber.next(chunk);
        } finally {
          subscriber.complete();
        }
      })();
    });
  };
}
