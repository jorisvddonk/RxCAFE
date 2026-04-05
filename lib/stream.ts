/**
 * RXCAFE Reactive Stream Utilities
 * 
 * Thin wrapper around RxJS for chunk processing.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 *                            STREAM DATA FLOW
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 *     inputStream (Subject) → operators → outputStream (Subject) → history
 *                                     │
 *                                     └── errorStream (Subject) → UI
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 *                              KEY RULE
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 *   Data flows DOWN only.
 *   NEVER call .next() on an upstream Subject (prevents infinite loops).
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { Subject, Observable, merge, EMPTY, from, of, type ObservableInput, Subscription } from 'rxjs';
import { filter, map, mergeMap, catchError, tap, debounceTime, startWith, endWith, type OperatorFunction } from 'rxjs/operators';
import type { Chunk, Evaluator } from './chunk.js';

export { Subject, Observable, merge, EMPTY, from, of, Subscription };
export { filter, map, mergeMap, catchError, tap, debounceTime, startWith, endWith };
export type { OperatorFunction };

export type ChunkSubject = Subject<Chunk>;
export type ChunkObservable = Observable<Chunk>;

export function observableToStream<T>(
  source: Observable<T>,
  serialize: (item: T) => string
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let subscription: ReturnType<typeof source.subscribe>;
      
      subscription = source.subscribe({
        next: item => {
          try {
            controller.enqueue(encoder.encode(serialize(item)));
          } catch (e) {
            subscription?.unsubscribe();
          }
        },
        error: err => {
          try {
            controller.enqueue(encoder.encode(serialize({ type: 'error', error: err.message } as any)));
          } catch {}
          controller.close();
        },
        complete: () => {
          controller.close();
        }
      });
      
      return () => subscription.unsubscribe();
    },
    cancel() {}
  });
}

export function evaluatorToOperator(evaluator: Evaluator): OperatorFunction<Chunk, Chunk> {
  return mergeMap(chunk => {
    const result = evaluator(chunk);
    
    if (result instanceof Observable) {
      return result;
    }
    
    if (result instanceof Promise) {
      return from(result.then(r => Array.isArray(r) ? r : [r]));
    }
    
    if (Array.isArray(result)) {
      return from(Promise.resolve(result));
    }
    
    return from(Promise.resolve([result]));
  }) as OperatorFunction<Chunk, Chunk>;
}

export function mergeObservables(...sources: Observable<Chunk>[]): Observable<Chunk> {
  return merge(...sources);
}
