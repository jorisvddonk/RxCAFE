/**
 * RXCAFE Reactive Stream Utilities
 * 
 * Unidirectional stream implementation for chunk processing.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 *                            STREAM DATA FLOW
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 *     ┌──────────────────────────────────────────────────────────────────────┐
 *     │                                                                      │
 *     │    emit(chunk)                                                       │
 *     │         │                                                            │
 *     │         ▼                                                            │
 *     │    ┌─────────────┐        pipe()         ┌─────────────┐            │
 *     │    │   Stream A  │ ─────────────────────►│   Stream B  │            │
 *     │    └─────────────┘                       └─────────────┘            │
 *     │         │                                     │                      │
 *     │         │                                     │                      │
 *     │    ┌────┴────┐                           ┌────┴────┐                │
 *     │    │listeners│                           │listeners│                │
 *     │    └─────────┘                           └─────────┘                │
 *     │                                                                      │
 *     └──────────────────────────────────────────────────────────────────────┘
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 *                              OPERATORS
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 *   pipe(evaluator)  - Transform chunks through an evaluator function
 *                      Each chunk: evaluator(chunk) → Chunk | Chunk[]
 * 
 *   filter(predicate) - Pass through only chunks matching predicate
 * 
 *   map(transform)    - Transform each chunk (shorthand for pipe)
 * 
 *   subscribe(fn)     - Listen to all emitted chunks
 * 
 *   mergeStreams(A, B, ...) - Combine multiple streams into one
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 *                              KEY RULE
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 *   Data flows DOWN only.
 *   NEVER emit to an upstream stream (prevents infinite loops).
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { Chunk, Evaluator } from './chunk.js';

export class ChunkStream {
  private listeners: Set<(chunk: Chunk) => void> = new Set();
  private evaluators: Array<{ evaluator: Evaluator; output: ChunkStream }> = [];

  subscribe(listener: (chunk: Chunk) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(chunk: Chunk): void {
    for (const listener of this.listeners) {
      listener(chunk);
    }

    this.processEvaluators(chunk);
  }

  private async processEvaluators(chunk: Chunk): Promise<void> {
    for (const { evaluator, output } of this.evaluators) {
      try {
        const result = await evaluator(chunk);
        if (Array.isArray(result)) {
          for (const r of result) {
            output.emit(r);
          }
        } else {
          output.emit(result);
        }
      } catch (error) {
        console.error('Evaluator error:', error);
      }
    }
  }

  pipe(evaluator: Evaluator): ChunkStream {
    const output = new ChunkStream();
    this.evaluators.push({ evaluator, output });
    return output;
  }

  filter(predicate: (chunk: Chunk) => boolean): ChunkStream {
    const output = new ChunkStream();
    this.subscribe((chunk) => {
      if (predicate(chunk)) {
        output.emit(chunk);
      }
    });
    return output;
  }

  map(transformer: (chunk: Chunk) => Chunk): ChunkStream {
    const output = new ChunkStream();
    this.subscribe((chunk) => {
      output.emit(transformer(chunk));
    });
    return output;
  }
}

export function mergeStreams(...streams: ChunkStream[]): ChunkStream {
  const output = new ChunkStream();
  
  for (const stream of streams) {
    stream.subscribe((chunk) => {
      output.emit(chunk);
    });
  }
  
  return output;
}
