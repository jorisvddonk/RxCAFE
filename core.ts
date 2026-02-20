/**
 * RXCAFE Core Business Logic
 * 
 * Reactive stream-based chat processing with unidirectional data flow.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 *                            STREAM ARCHITECTURE
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Unidirectional data flow prevents infinite loops:
 * 
 *     inputStream (Subject) → operators → outputStream (Subject) → history
 *                                   │
 *                                   └── errorStream (Subject) → UI
 * 
 * Pipeline (built once at session creation using RxJS):
 * 
 *     inputStream.pipe(
 *       filter(text only),
 *       map(add role annotation),
 *       filter(trusted only),
 *       mergeMap(processWithLLM)
 *     ) → outputStream
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 *                              KEY PRINCIPLES
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * 1. UNIDIRECTIONAL FLOW
 *    LLM responses flow through outputStream, never back to inputStream
 * 
 * 2. PIPELINE BUILT ONCE
 *    Pipeline is constructed at session creation using RxJS operators
 * 
 * 3. CALLBACKS STORED IN SESSION
 *    Each HTTP request updates session.callbacks
 *    LLM reads from session.callbacks (not closure)
 * 
 * 4. SEPARATE ERROR STREAM
 *    Errors go to errorStream, not mixed with data
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { 
  createTextChunk, 
  createNullChunk, 
  annotateChunk, 
  type Chunk,
  type Evaluator 
} from './lib/chunk.js';
import { Subject, Observable, merge, EMPTY, from, filter, map, mergeMap, catchError, tap } from './lib/stream.js';
import { KoboldEvaluator } from './lib/kobold-api.js';
import { OllamaEvaluator } from './lib/ollama-api.js';

// =============================================================================
// Configuration
// =============================================================================

export type LLMBackend = 'kobold' | 'ollama';

export interface CoreConfig {
  backend: LLMBackend;
  koboldBaseUrl: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  tracing: boolean;
}

export function getDefaultConfig(): CoreConfig {
  return {
    backend: (process.env.LLM_BACKEND as LLMBackend) || 'kobold',
    koboldBaseUrl: process.env.KOBOLD_URL || 'http://localhost:5001',
    ollamaBaseUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'gemma3:1b',
    tracing: process.env.RXCAFE_TRACE === '1'
  };
}

// =============================================================================
// Unified LLM Evaluator Interface
// =============================================================================

export interface LLMEvaluator {
  evaluateChunk(chunk: Chunk): AsyncGenerator<Chunk>;
  abort(): Promise<void>;
}

export function createEvaluator(
  backend: LLMBackend, 
  config: CoreConfig,
  model?: string
): LLMEvaluator {
  if (backend === 'ollama') {
    const ollama = new OllamaEvaluator(config.ollamaBaseUrl, model || config.ollamaModel);
    return {
      evaluateChunk: ollama.evaluateChunk.bind(ollama),
      abort: async () => {}
    };
  } else {
    const kobold = new KoboldEvaluator(config.koboldBaseUrl);
    return {
      evaluateChunk: kobold.evaluateChunk.bind(kobold),
      abort: async () => {
        await kobold.getAPI().abortGeneration();
      }
    };
  }
}

// =============================================================================
// Session Management
// =============================================================================

export interface Session {
  id: string;
  inputStream: Subject<Chunk>;
  outputStream: Subject<Chunk>;
  errorStream: Subject<Error>;
  history: Chunk[];
  llmEvaluator: LLMEvaluator;
  backend: LLMBackend;
  model?: string;
  abortController: AbortController | null;
  trustedChunks: Set<string>;
  callbacks: ChatCallbacks | null;
  systemPrompt: string | null;
  pipelineSubscription?: { unsubscribe: () => void };
}

const sessions = new Map<string, Session>();

export function createSession(
  config: CoreConfig,
  backend?: LLMBackend, 
  model?: string
): Session {
  const id = `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  const useBackend = backend || config.backend;
  
  const inputStream = new Subject<Chunk>();
  const outputStream = new Subject<Chunk>();
  const errorStream = new Subject<Error>();
  
  const llmEvaluator = createEvaluator(useBackend, config, model);
  
  const session: Session = {
    id,
    inputStream,
    outputStream,
    errorStream,
    history: [],
    llmEvaluator,
    backend: useBackend,
    model,
    abortController: null,
    trustedChunks: new Set(),
    callbacks: null,
    systemPrompt: null
  };
  
  outputStream.subscribe({
    next: (chunk) => {
      const existingIndex = session.history.findIndex(c => c.id === chunk.id);
      if (existingIndex !== -1) {
        session.history[existingIndex] = chunk;
      } else {
        session.history.push(chunk);
      }
    }
  });
  
  const pipeline$ = inputStream.pipe(
    filter((chunk: Chunk) => chunk.contentType === 'text'),
    
    map((chunk: Chunk) => {
      if (chunk.annotations['chat.role']) {
        return chunk;
      }
      return annotateChunk(chunk, 'chat.role', 'user');
    }),
    
    filter((chunk: Chunk) => {
      const trustLevel = chunk.annotations['security.trust-level'];
      return !trustLevel || trustLevel.trusted !== false;
    }),
    
    mergeMap((chunk: Chunk) => processWithLLM(chunk, session, config.tracing)),
    
    map((chunk: Chunk) => {
      if (chunk.contentType === 'text' && 
          (chunk.producer === 'com.rxcafe.kobold-evaluator' || 
           chunk.producer === 'com.rxcafe.ollama-evaluator' ||
           chunk.producer === 'com.rxcafe.assistant')) {
        return annotateChunk(chunk, 'chat.role', 'assistant');
      }
      return chunk;
    }),
    
    catchError((error: Error) => {
      session.errorStream.next(error);
      return EMPTY;
    })
  );
  
  const annotatedInput$ = inputStream.pipe(
    filter((chunk: Chunk) => chunk.contentType === 'text'),
    map((chunk: Chunk) => {
      if (chunk.annotations['chat.role']) {
        return chunk;
      }
      return annotateChunk(chunk, 'chat.role', 'user');
    })
  );
  
  const combined$ = merge(annotatedInput$, pipeline$);
  
  session.pipelineSubscription = combined$.subscribe({
    next: (chunk: Chunk) => {
      session.outputStream.next(chunk);
    },
    error: (error: Error) => {
      session.errorStream.next(error);
    }
  });
  
  sessions.set(id, session);
  return session;
}

function processWithLLM(chunk: Chunk, session: Session, tracing: boolean): Observable<Chunk> {
  return new Observable(subscriber => {
    if (chunk.contentType !== 'text') {
      subscriber.next(chunk);
      subscriber.complete();
      return;
    }
    
    if (chunk.annotations['chat.role'] !== 'user') {
      subscriber.next(chunk);
      subscriber.complete();
      return;
    }
    
    const context = buildConversationContext(session.history, chunk.id, session.systemPrompt);
    const currentMessage = chunk.content as string;
    
    const prompt = context 
      ? `${context}\n\nUser: ${currentMessage}\nAssistant:`
      : `User: ${currentMessage}\nAssistant:`;
    
    if (tracing) {
      console.log('\n═══════════════════════════════════════════════════════════');
      console.log('RXCAFE_TRACE: LLM Context');
      console.log('═══════════════════════════════════════════════════════════');
      console.log(`Chunk ID: ${chunk.id}`);
      console.log(`Context Length: ${context.length} chars`);
      console.log(`Total Prompt Length: ${prompt.length} chars`);
      console.log('\n--- FULL CONTEXT SENT TO LLM ---');
      console.log(prompt);
      console.log('--- END CONTEXT ---\n');
    }
    
    const contextChunk = createTextChunk(prompt, chunk.producer, {
      ...chunk.annotations,
      'llm.context-length': context.length,
      'llm.full-prompt': true
    });
    
    subscriber.next(createNullChunk('com.rxcafe.llm', {
      'llm.generation-started': true,
      'llm.backend': session.backend,
      'llm.parent-chunk-id': chunk.id
    }));
    
    let fullResponse = '';
    
    (async () => {
      try {
        for await (const tokenChunk of session.llmEvaluator.evaluateChunk(contextChunk)) {
          if (tokenChunk.contentType === 'text') {
            const token = tokenChunk.content as string;
            fullResponse += token;
            if (session.callbacks?.onToken) {
              session.callbacks.onToken(token);
            }
          }
        }
        
        const assistantChunk = createTextChunk(fullResponse, 'com.rxcafe.assistant', {
          'chat.role': 'assistant'
        });
        subscriber.next(assistantChunk);
        
        if (session.callbacks?.onFinish) {
          session.callbacks.onFinish(fullResponse);
        }
        
        subscriber.complete();
      } catch (error) {
        subscriber.next(createNullChunk('com.rxcafe.error', {
          'error.message': error instanceof Error ? error.message : 'LLM error',
          'error.source-chunk-id': chunk.id
        }));
        
        if (session.callbacks?.onError) {
          session.callbacks.onError(error instanceof Error ? error : new Error('LLM error'));
        }
        
        subscriber.error(error);
      }
    })();
  });
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

export function deleteSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (session?.pipelineSubscription) {
    session.pipelineSubscription.unsubscribe();
  }
  return sessions.delete(sessionId);
}

export function listSessions(): string[] {
  return Array.from(sessions.keys());
}

// =============================================================================
// Security and Trust Management
// =============================================================================

export function markUntrusted(chunk: Chunk, source: string): Chunk {
  return annotateChunk(chunk, 'security.trust-level', {
    trusted: false,
    source: source,
    requiresReview: true
  });
}

export function markTrusted(chunk: Chunk): Chunk {
  return annotateChunk(chunk, 'security.trust-level', {
    trusted: true,
    source: chunk.annotations['security.trust-level']?.source || 'manual',
    requiresReview: false
  });
}

export function isTrusted(chunk: Chunk): boolean {
  return chunk.annotations['security.trust-level']?.trusted === true;
}

export async function fetchWebContent(url: string): Promise<Chunk> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'RXCAFE-Bot/1.0'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const contentType = response.headers.get('content-type') || 'text/plain';
    
    if (contentType.includes('text/html')) {
      const html = await response.text();
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 10000);
      
      const chunk = createTextChunk(text, 'com.rxcafe.web-fetch', {
        'web.source-url': url,
        'web.content-type': contentType,
        'web.fetch-time': Date.now()
      });
      
      return markUntrusted(chunk, `web:${url}`);
    } else {
      const text = await response.text().then(t => t.slice(0, 10000));
      const chunk = createTextChunk(text, 'com.rxcafe.web-fetch', {
        'web.source-url': url,
        'web.content-type': contentType,
        'web.fetch-time': Date.now()
      });
      
      return markUntrusted(chunk, `web:${url}`);
    }
  } catch (error) {
    const errorChunk = createTextChunk(
      `Failed to fetch ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'com.rxcafe.web-fetch',
      {
        'web.source-url': url,
        'web.error': true
      }
    );
    return markUntrusted(errorChunk, `web:${url}`);
  }
}

export function toggleChunkTrust(
  session: Session, 
  chunkId: string, 
  trusted: boolean
): Chunk | null {
  const chunkIndex = session.history.findIndex(c => c.id === chunkId);
  if (chunkIndex === -1) {
    return null;
  }
  
  const chunk = session.history[chunkIndex];
  
  if (trusted) {
    session.trustedChunks.add(chunkId);
    const trustedChunk = markTrusted(chunk);
    session.history[chunkIndex] = trustedChunk;
    return trustedChunk;
  } else {
    session.trustedChunks.delete(chunkId);
    const untrustedChunk = markUntrusted(chunk, chunk.annotations['security.trust-level']?.source || 'manual');
    session.history[chunkIndex] = untrustedChunk;
    return untrustedChunk;
  }
}

export interface AddChunkOptions {
  content: string;
  producer?: string;
  annotations?: Record<string, any>;
  emit?: boolean;
}

export function addChunkToSession(session: Session, options: AddChunkOptions): Chunk {
  const chunk = createTextChunk(
    options.content,
    options.producer || 'com.rxcafe.user',
    options.annotations
  );
  
  if (options.emit) {
    session.inputStream.next(chunk);
  } else {
    session.history.push(chunk);
    
    if (options.annotations?.['chat.role'] === 'system') {
      session.systemPrompt = options.content;
    }
  }
  
  return chunk;
}

// =============================================================================
// Pipeline Evaluators (kept for backwards compatibility / external use)
// =============================================================================

export function createRoleAnnotator(role: string): Evaluator {
  return (chunk: Chunk) => {
    if (chunk.annotations['chat.role']) {
      return chunk;
    }
    return annotateChunk(chunk, 'chat.role', role);
  };
}

export function createTypeFilter(allowedTypes: string[]): Evaluator {
  return (chunk: Chunk) => {
    if (!allowedTypes.includes(chunk.contentType)) {
      return createNullChunk('com.rxcafe.filter', {
        'filter.rejected': true,
        'filter.reason': `Type ${chunk.contentType} not in [${allowedTypes.join(', ')}]`
      });
    }
    return chunk;
  };
}

export function createTrustFilter(): Evaluator {
  return (chunk: Chunk) => {
    const trustLevel = chunk.annotations['security.trust-level'];
    
    if (trustLevel && trustLevel.trusted === false) {
      return createNullChunk('com.rxcafe.security-filter', {
        'filter.rejected': true,
        'filter.reason': 'Untrusted content - requires user review',
        'filter.source-chunk-id': chunk.id
      });
    }
    
    return chunk;
  };
}

export function buildConversationContext(history: Chunk[], excludeChunkId?: string, systemPrompt?: string | null): string {
  const contextParts: string[] = [];
  
  if (systemPrompt) {
    contextParts.push(`System: ${systemPrompt}`);
  }
  
  for (const chunk of history) {
    if (chunk.id === excludeChunkId) continue;
    if (chunk.contentType !== 'text') continue;
    
    const role = chunk.annotations['chat.role'];
    const trustLevel = chunk.annotations['security.trust-level'];
    const isChunkTrusted = !trustLevel || trustLevel.trusted === true;
    
    if (!isChunkTrusted) continue;
    
    const content = chunk.content as string;
    
    if (role === 'user') {
      contextParts.push(`User: ${content}`);
    } else if (role === 'assistant') {
      contextParts.push(`Assistant: ${content}`);
    } else if (chunk.producer === 'com.rxcafe.web-fetch' || chunk.annotations['web.source-url']) {
      const url = chunk.annotations['web.source-url'] || 'unknown';
      contextParts.push(`[Web content from ${url}]: ${content}`);
    }
  }
  
  return contextParts.join('\n\n');
}

// =============================================================================
// Model Listing
// =============================================================================

export async function listModels(config: CoreConfig, backend?: string): Promise<{ models: string[]; backend: string }> {
  const targetBackend = backend || config.backend;
  
  if (targetBackend === 'ollama') {
    const { OllamaAPI } = await import('./lib/ollama-api.js');
    const api = new OllamaAPI(config.ollamaBaseUrl);
    const models = await api.listModels();
    return { models, backend: 'ollama' };
  } else {
    return { 
      models: [],
      backend: 'kobold'
    };
  }
}

// =============================================================================
// Chat Processing
// =============================================================================

export interface ChatCallbacks {
  onToken: (token: string) => void;
  onFinish: (fullResponse: string) => void;
  onError: (error: Error) => void;
}

export async function processChatMessage(
  session: Session,
  message: string,
  callbacks: ChatCallbacks,
  config: CoreConfig
): Promise<void> {
  const abortController = new AbortController();
  session.abortController = abortController;
  session.callbacks = callbacks;
  
  const userChunk = createTextChunk(message, 'com.rxcafe.user', {
    'chat.role': 'user'
  });
  
  session.inputStream.next(userChunk);
}

export async function abortGeneration(session: Session): Promise<void> {
  if (session.abortController) {
    session.abortController.abort();
    session.abortController = null;
  }
  
  await session.llmEvaluator.abort();
}
