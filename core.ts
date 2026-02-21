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
 * Pipeline is built by Agents, which subscribe to inputStream and emit to outputStream.
 * 
 * ═══════════════════════════════════════════════════════════════════════════════
 *                              KEY PRINCIPLES
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * 1. UNIDIRECTIONAL FLOW
 *    LLM responses flow through outputStream, never back to inputStream
 * 
 * 2. PIPELINE BUILT BY AGENTS
 *    Agents construct pipelines at session initialization using RxJS operators
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
import { 
  type AgentDefinition, 
  type AgentSessionContext, 
  type AgentEvaluator,
  type LLMParams,
  type SessionConfig,
  type ChatCallbacks 
} from './lib/agent.js';
import { getAgent, loadAgents, listAgents, listBackgroundAgents } from './lib/agent-loader.js';
import { SessionStore } from './lib/session-store.js';
import { schedule, clearAllScheduledJobs } from './lib/scheduler.js';

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
  sessionStore?: SessionStore;
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
  model?: string,
  llmParams?: LLMParams
): LLMEvaluator {
  if (backend === 'ollama') {
    const ollama = new OllamaEvaluator(config.ollamaBaseUrl, model || config.ollamaModel, '', llmParams);
    return {
      evaluateChunk: ollama.evaluateChunk.bind(ollama),
      abort: async () => {}
    };
  } else {
    const kobold = new KoboldEvaluator(config.koboldBaseUrl, '', llmParams);
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
  agentName: string;
  isBackground: boolean;
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
  sessionConfig: SessionConfig;
  pipelineSubscription?: { unsubscribe: () => void };
  _agentContext?: AgentSessionContext;
}

const sessions = new Map<string, Session>();
let sessionStore: SessionStore | null = null;

export function setSessionStore(store: SessionStore): void {
  sessionStore = store;
}

export function getSessionStore(): SessionStore | null {
  return sessionStore;
}

export interface CreateSessionOptions {
  backend?: LLMBackend;
  model?: string;
  agentId?: string;
  llmParams?: LLMParams;
  systemPrompt?: string;
  isBackground?: boolean;
  sessionId?: string;
}

export async function createSession(
  config: CoreConfig,
  options?: CreateSessionOptions
): Promise<Session> {
  const backend = options?.backend || config.backend;
  const model = options?.model;
  const agentId = options?.agentId || 'default';
  const isBackground = options?.isBackground || false;
  const id = options?.sessionId || `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  
  const inputStream = new Subject<Chunk>();
  const outputStream = new Subject<Chunk>();
  const errorStream = new Subject<Error>();
  
  const sessionConfig: SessionConfig = {
    backend,
    model,
    llmParams: options?.llmParams,
    systemPrompt: options?.systemPrompt,
  };
  
  const agent = getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  
  const llmEvaluator = createEvaluator(backend, config, model, options?.llmParams);
  
  const session: Session = {
    id,
    agentName: agentId,
    isBackground,
    inputStream,
    outputStream,
    errorStream,
    history: [],
    llmEvaluator,
    backend,
    model,
    abortController: null,
    trustedChunks: new Set(),
    callbacks: null,
    systemPrompt: options?.systemPrompt || null,
    sessionConfig,
  };
  
  const agentContext: AgentSessionContext = {
    id,
    agentName: agentId,
    isBackground,
    inputStream,
    outputStream,
    errorStream,
    history: session.history,
    config,
    sessionConfig,
    systemPrompt: session.systemPrompt,
    trustedChunks: session.trustedChunks,
    callbacks: null,
    
    createEvaluator: (backend: LLMBackend, model?: string, params?: LLMParams): AgentEvaluator => {
      const evaluator = createEvaluator(backend, config, model, { ...options?.llmParams, ...params });
      return {
        evaluateChunk: evaluator.evaluateChunk,
        abort: evaluator.abort,
      };
    },
    
    schedule: (cronExpr: string, callback: () => void | Promise<void>): (() => void) => {
      return schedule(cronExpr, callback);
    },
    
    persistState: async (): Promise<void> => {
      if (sessionStore && isBackground) {
        await sessionStore.saveSession(id, agentId, true, sessionConfig, session.systemPrompt);
        await sessionStore.saveHistory(id, session.history);
      }
    },
    
    loadState: async (): Promise<void> => {
      if (sessionStore && isBackground) {
        const savedHistory = await sessionStore.loadHistory(id);
        session.history.length = 0;
        session.history.push(...savedHistory);
      }
    },
  };
  
  session._agentContext = agentContext;
  
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
  
  if (isBackground && sessionStore) {
    await sessionStore.saveSession(id, agentId, true, sessionConfig, session.systemPrompt);
  }
  
  await agent.initialize(agentContext);
  
  sessions.set(id, session);
  return session;
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

export function deleteSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (session?.pipelineSubscription) {
    session.pipelineSubscription.unsubscribe();
  }
  
  if (sessionStore && session?.isBackground) {
    sessionStore.deleteSession(sessionId).catch(err => {
      console.error(`Failed to delete session ${sessionId} from store:`, err);
    });
  }
  
  return sessions.delete(sessionId);
}

export function listSessions(): string[] {
  return Array.from(sessions.keys());
}

export function listActiveSessions(): Array<{ id: string; agentName: string; isBackground: boolean }> {
  return Array.from(sessions.values()).map(s => ({
    id: s.id,
    agentName: s.agentName,
    isBackground: s.isBackground,
  }));
}

// =============================================================================
// Background Agent Management
// =============================================================================

export async function startBackgroundAgents(config: CoreConfig): Promise<void> {
  const agents = listBackgroundAgents();
  
  for (const agent of agents) {
    const sessionId = agent.name;
    
    if (sessionStore) {
      const existingSession = await sessionStore.getBackgroundSessionByAgentName(agent.name);
      
      if (existingSession) {
        console.log(`[Core] Restoring background agent: ${agent.name}`);
        const session = await createSession(config, {
          agentId: agent.name,
          isBackground: true,
          sessionId: existingSession.id,
          ...existingSession.config,
        });
        
        if (session._agentContext) {
          await session._agentContext.loadState();
        }
        
        continue;
      }
    }
    
    console.log(`[Core] Starting background agent: ${agent.name}`);
    await createSession(config, {
      agentId: agent.name,
      isBackground: true,
      sessionId,
    });
  }
}

export async function loadAgentsFromDisk(): Promise<void> {
  await loadAgents();
}

export { getAgent, listAgents, listBackgroundAgents };

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

export { type ChatCallbacks } from './lib/agent.js';

export async function processChatMessage(
  session: Session,
  message: string,
  callbacks: ChatCallbacks,
  config: CoreConfig
): Promise<void> {
  const abortController = new AbortController();
  session.abortController = abortController;
  session.callbacks = callbacks;
  
  if (session._agentContext) {
    session._agentContext.callbacks = callbacks;
  }
  
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

// =============================================================================
// Cleanup
// =============================================================================

export function shutdown(): void {
  clearAllScheduledJobs();
  
  for (const session of sessions.values()) {
    if (session.pipelineSubscription) {
      session.pipelineSubscription.unsubscribe();
    }
  }
  
  sessions.clear();
}
