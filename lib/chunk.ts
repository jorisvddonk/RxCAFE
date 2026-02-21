/**
 * RXCAFE Core Types and Primitives
 * Following the RXCAFE spec v2.0
 */

export type ContentType = 'text' | 'binary' | 'null';

export interface BinaryContent {
  data: Uint8Array;
  mimeType: string;
}

export interface Chunk {
  id: string;
  timestamp: number;
  contentType: ContentType;
  content: string | BinaryContent | null;
  producer: string;
  annotations: Record<string, any>;
}

export interface CreateChunkOptions {
  contentType: ContentType;
  content: string | BinaryContent | null;
  producer: string;
  annotations?: Record<string, any>;
}

let idCounter = 0;

export function createChunk(options: CreateChunkOptions): Chunk {
  return {
    id: `chunk-${Date.now()}-${++idCounter}`,
    timestamp: Date.now(),
    contentType: options.contentType,
    content: options.content,
    producer: options.producer,
    annotations: {
      ...options.annotations,
      'system.created-at': Date.now()
    }
  };
}

export function createTextChunk(content: string, producer: string, annotations?: Record<string, any>): Chunk {
  return createChunk({
    contentType: 'text',
    content,
    producer,
    annotations
  });
}

export function createNullChunk(producer: string, annotations?: Record<string, any>): Chunk {
  return createChunk({
    contentType: 'null',
    content: null,
    producer,
    annotations
  });
}

export function createBinaryChunk(data: Uint8Array, mimeType: string, producer: string, annotations?: Record<string, any>): Chunk {
  return createChunk({
    contentType: 'binary',
    content: { data, mimeType },
    producer,
    annotations
  });
}

export function annotateChunk(chunk: Chunk, key: string, value: any): Chunk {
  return {
    ...chunk,
    annotations: {
      ...chunk.annotations,
      [key]: value
    }
  };
}

export type Evaluator = (chunk: Chunk) => Chunk | Chunk[] | Promise<Chunk | Chunk[]>;

export type EvaluatorStream = ReadableStream<Chunk>;

export async function* evaluateStream(
  source: AsyncIterable<Chunk>,
  evaluator: Evaluator
): AsyncGenerator<Chunk> {
  for await (const chunk of source) {
    const result = await evaluator(chunk);
    if (Array.isArray(result)) {
      for (const r of result) {
        yield r;
      }
    } else {
      yield result;
    }
  }
}
