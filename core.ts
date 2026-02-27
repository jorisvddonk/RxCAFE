/**
 * ObservableCAFE Core Business Logic
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
  type RuntimeSessionConfig,
  type ChatCallbacks,
  extractRuntimeConfigFromChunk
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
  displayName?: string;
  runtimeConfig: RuntimeSessionConfig;
  pipelineSubscription?: { unsubscribe: () => void };
  persistsState?: boolean;

  _agentContext?: AgentSessionContext;
}

const sessions = new Map<string, Session>();
const persistDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
let sessionStore: SessionStore | null = null;
let coreConfig: CoreConfig | null = null;

export function setCoreConfig(config: CoreConfig): void {
  coreConfig = config;
}

export function getCoreConfig(): CoreConfig | null {
  return coreConfig;
}

export function setSessionStore(store: SessionStore): void {
  sessionStore = store;
}

export function getSessionStore(): SessionStore | null {
  return sessionStore;
}

export interface CreateSessionOptions {
  agentId?: string;
  isBackground?: boolean;
  sessionId?: string;
  runtimeConfig?: RuntimeSessionConfig;
}

export async function createSession(
  config: CoreConfig,
  options?: CreateSessionOptions
): Promise<Session> {
  const agentId = options?.agentId || 'default';
  const isBackground = options?.isBackground || false;
  const id = options?.sessionId || `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  
  const inputStream = new Subject<Chunk>();
  const outputStream = new Subject<Chunk>();
  const errorStream = new Subject<Error>();
  
  const agent = getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  
  // Use runtime config if provided directly
  const runtimeConfig: RuntimeSessionConfig = options?.runtimeConfig || {};
  const backend = runtimeConfig.backend || config.backend;
  const model = runtimeConfig.model || config.ollamaModel;
  
  const session: Session = {
    id,
    agentName: agentId,
    isBackground,
    inputStream,
    outputStream,
    errorStream,
    history: [],
    llmEvaluator: createEvaluator(backend, config, model, runtimeConfig.llmParams),
    backend,
    model,
    abortController: null,
    trustedChunks: new Set(),
    callbacks: null,
    systemPrompt: runtimeConfig.systemPrompt || null,
    runtimeConfig,
    persistsState: agent.persistsState !== false,
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
    sessionConfig: {},
    systemPrompt: session.systemPrompt,
    trustedChunks: session.trustedChunks,
    get callbacks() { return session.callbacks; },
    set callbacks(val) { session.callbacks = val; },
    
    createEvaluator: (backendOrParams?: LLMBackend | LLMParams, model?: string, params?: LLMParams): AgentEvaluator => {
      let b: LLMBackend;
      let m: string | undefined;
      let p: LLMParams | undefined;

      if (typeof backendOrParams === 'object') {
        // One-liner: session.createEvaluator({ temperature: 0 })
        b = session.runtimeConfig.backend || config.backend;
        m = session.runtimeConfig.model;
        p = { ...session.runtimeConfig.llmParams, ...backendOrParams };
      } else {
        // Standard: session.createEvaluator('ollama', 'llama3', { ... })
        b = backendOrParams || session.runtimeConfig.backend || config.backend;
        m = model || session.runtimeConfig.model;
        p = { ...session.runtimeConfig.llmParams, ...params };
      }

      const evaluator = createEvaluator(b, config, m, p);
      return {
        evaluateChunk: evaluator.evaluateChunk,
        abort: evaluator.abort,
      };
    },
    
    schedule: (cronExpr: string, callback: () => void | Promise<void>): (() => void) => {
      return schedule(cronExpr, callback);
    },
    
    persistState: async (): Promise<void> => {
      if (sessionStore) {
        await sessionStore.saveSession(id, agentId, isBackground, {});
        await sessionStore.saveHistory(id, session.history);
      }
    },
    
    loadState: async (): Promise<void> => {
      if (sessionStore) {
        const savedHistory = await sessionStore.loadHistory(id);
        session.history.length = 0;
        session.history.push(...savedHistory);
        
        // Scan history for the most recent config chunk
        for (let i = session.history.length - 1; i >= 0; i--) {
          const chunk = session.history[i];
          if (chunk.contentType === 'null' && chunk.annotations['config.type'] === 'runtime') {
            session.runtimeConfig = extractRuntimeConfigFromChunk(chunk);
            break;
          }
        }
        
        // Scan history for the most recent display name
        for (let i = session.history.length - 1; i >= 0; i--) {
          const chunk = session.history[i];
          if (chunk.annotations && chunk.annotations['session.name']) {
            session.displayName = String(chunk.annotations['session.name']);
            break;
          }
        }
        
        // Update session with extracted config
        if (session.runtimeConfig.backend) {
          session.backend = session.runtimeConfig.backend;
        }
        if (session.runtimeConfig.model) {
          session.model = session.runtimeConfig.model;
        }
        if (session.runtimeConfig.systemPrompt) {
          session.systemPrompt = session.runtimeConfig.systemPrompt;
        }
        
        // Always recreate evaluator on load
        session.llmEvaluator = createEvaluator(
          session.backend,
          config,
          session.model,
          session.runtimeConfig.llmParams
        );
      }
    },
  };
  
  session._agentContext = agentContext;
  
  outputStream.subscribe({
    next: (chunk) => {
      // Check for session naming annotation
      if (chunk.annotations && chunk.annotations['session.name']) {
        session.displayName = String(chunk.annotations['session.name']);
        console.log(`[Core] Session ${session.id} renamed to: ${session.displayName}`);
      }
      
      // Check for runtime config chunk
      if (chunk.contentType === 'null' && chunk.annotations['config.type'] === 'runtime') {
        session.runtimeConfig = extractRuntimeConfigFromChunk(chunk);
        console.log(`[Core] Session ${session.id} runtime config updated:`, session.runtimeConfig);
        
        // Update session with extracted config
        if (session.runtimeConfig.backend) {
          session.backend = session.runtimeConfig.backend;
        }
        if (session.runtimeConfig.model) {
          session.model = session.runtimeConfig.model;
        }
        if (session.runtimeConfig.systemPrompt) {
          session.systemPrompt = session.runtimeConfig.systemPrompt;
        }
        
        // Recreate evaluator whenever backend, model, or llmParams changes
        session.llmEvaluator = createEvaluator(
          session.backend,
          config,
          session.model,
          session.runtimeConfig.llmParams
        );
      }
      
      const existingIndex = session.history.findIndex(c => c.id === chunk.id);
      if (existingIndex !== -1) {
        //console.log(`[Core] Updating history chunk: ${chunk.id} (session ${session.id})`);
        session.history[existingIndex] = chunk;
      } else {
        //console.log(`[Core] Adding new history chunk: ${chunk.id} (session ${session.id})`);
        session.history.push(chunk);
        
        // Debounced auto-persistence
        if (sessionStore && session.persistsState !== false) {
          if (persistDebounceTimers.has(id)) {
            clearTimeout(persistDebounceTimers.get(id));
          }
          persistDebounceTimers.set(id, setTimeout(async () => {
            try {
              await sessionStore!.saveHistory(id, session.history);
              await sessionStore!.saveSession(id, agentId, isBackground, {});
            } catch (err) {
              console.error(`[Core] Failed to persist session ${id}:`, err);
            }
          }, 500));
        }
      }
    }
  });
  
  // Pass user messages and metadata from inputStream to outputStream for history
  inputStream.subscribe({
    next: (chunk) => {
      const role = chunk.annotations['chat.role'];
      const isWeb = chunk.producer === 'com.rxcafe.web-fetch' || chunk.annotations['web.source-url'];
      const isSessionName = !!chunk.annotations['session.name'];
      const isRuntimeConfig = chunk.contentType === 'null' && chunk.annotations['config.type'] === 'runtime';
      
      if ((chunk.contentType === 'text' || chunk.contentType === 'null') && 
          (role === 'user' || role === 'system' || isWeb || isSessionName || isRuntimeConfig)) {
        outputStream.next(chunk);
      }
    }
  });
  
  if (sessionStore) {
    await sessionStore.saveSession(id, agentId, isBackground, {});
  }
  
  await agent.initialize(agentContext);
  
  sessions.set(id, session);
  return session;
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (session?.pipelineSubscription) {
    session.pipelineSubscription.unsubscribe();
  }
  
  if (persistDebounceTimers.has(sessionId)) {
    clearTimeout(persistDebounceTimers.get(sessionId));
    persistDebounceTimers.delete(sessionId);
  }
  
  if (sessionStore) {
    try {
      await sessionStore.deleteSession(sessionId);
    } catch (err) {
      console.error(`Failed to delete session ${sessionId} from store:`, err);
    }
  }
  
  return sessions.delete(sessionId);
}

export async function reloadSessionAgent(sessionId: string, config: CoreConfig): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;
  
  const newAgent = getAgent(session.agentName);
  if (!newAgent) {
    console.error(`[Core] Cannot reload session ${sessionId}: agent ${session.agentName} not found`);
    return false;
  }
  
  // Unsubscribe from old pipeline
  if (session.pipelineSubscription) {
    session.pipelineSubscription.unsubscribe();
  }
  
  // Call destroy on old agent if it exists
  try {
    const oldAgent = getAgent(session.agentName);
    if (oldAgent?.destroy && session._agentContext) {
      await oldAgent.destroy(session._agentContext);
    }
  } catch (err) {
    console.warn(`[Core] Error calling destroy on old agent for session ${sessionId}:`, err);
  }
  
  // Reuse existing streams - don't create new ones
  // This preserves SSE connections and other subscribers
  
  // Rebuild agent context with new streams
  session._agentContext = {
    id: session.id,
    agentName: session.agentName,
    isBackground: session.isBackground,
    inputStream: session.inputStream,
    outputStream: session.outputStream,
    errorStream: session.errorStream,
    history: session.history,
    config,
    sessionConfig: {},
    systemPrompt: session.systemPrompt,
    trustedChunks: session.trustedChunks,
    get callbacks() { return session.callbacks; },
    set callbacks(val) { session.callbacks = val; },
    
    createEvaluator: (backendOrParams?: LLMBackend | LLMParams, model?: string, params?: LLMParams): AgentEvaluator => {
      let b: LLMBackend;
      let m: string | undefined;
      let p: LLMParams | undefined;

      if (typeof backendOrParams === 'object') {
        b = session.runtimeConfig.backend || config.backend;
        m = session.runtimeConfig.model;
        p = { ...session.runtimeConfig.llmParams, ...backendOrParams };
      } else {
        b = backendOrParams || session.runtimeConfig.backend || config.backend;
        m = model || session.runtimeConfig.model;
        p = { ...session.runtimeConfig.llmParams, ...params };
      }

      const evaluator = createEvaluator(b, config, m, p);
      return {
        evaluateChunk: evaluator.evaluateChunk,
        abort: evaluator.abort,
      };
    },
    
    schedule: (cronExpr: string, callback: () => void | Promise<void>): (() => void) => {
      return schedule(cronExpr, callback);
    },
    
    persistState: async (): Promise<void> => {
      if (sessionStore) {
        await sessionStore.saveSession(session.id, session.agentName, session.isBackground, {});
        await sessionStore.saveHistory(session.id, session.history);
      }
    },
    
    loadState: async (): Promise<void> => {
      // Already loaded, no-op
    },
  };
  
  // Initialize with new agent
  await newAgent.initialize(session._agentContext);
  
  console.log(`[Core] Reloaded agent for session ${sessionId} (${session.agentName})`);
  return true;
}

export function listSessions(): string[] {
  return Array.from(sessions.keys());
}

export function listActiveSessions(): Array<{ id: string; agentName: string; isBackground: boolean; displayName?: string }> {
  return Array.from(sessions.values()).map(s => ({
    id: s.id,
    agentName: s.agentName,
    isBackground: s.isBackground,
    displayName: s.displayName,
  }));
}

// =============================================================================
// Session Persistence
// =============================================================================

export async function restorePersistedSessions(config: CoreConfig): Promise<number> {
  if (!sessionStore) return 0;
  
  const persistedSessions = await sessionStore.listAllSessions();
  let restored = 0;
  
  for (const persisted of persistedSessions) {
    if (sessions.has(persisted.id)) continue;
    
    const agent = getAgent(persisted.agentName);
    if (!agent) {
      console.log(`[Core] Skipping persisted session ${persisted.id}: agent ${persisted.agentName} not found`);
      continue;
    }
    
    try {
      console.log(`[Core] Restoring session: ${persisted.id} (${persisted.agentName})`);
      
      const session = await createSession(config, {
        agentId: persisted.agentName,
        isBackground: persisted.isBackground,
        sessionId: persisted.id,
      });
      
      if (session._agentContext) {
        await session._agentContext.loadState();
      }
      
      restored++;
    } catch (err) {
      console.error(`[Core] Failed to restore session ${persisted.id}:`, err);
    }
  }
  
  return restored;
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
  content?: string;
  contentType?: 'text' | 'null';
  producer?: string;
  annotations?: Record<string, any>;
  emit?: boolean;
}

export function addChunkToSession(session: Session, options: AddChunkOptions): Chunk {
  const contentType = options.contentType || (options.content !== undefined ? 'text' : 'null');
  
  let chunk: Chunk;
  if (contentType === 'null') {
    chunk = createNullChunk(options.producer || 'com.rxcafe.user', options.annotations);
  } else {
    chunk = createTextChunk(
      options.content || '',
      options.producer || 'com.rxcafe.user',
      options.annotations
    );
  }
  
  if (options.emit) {
    session.inputStream.next(chunk);
  } else {
    session.history.push(chunk);
    
    if (options.annotations?.['chat.role'] === 'system' && contentType === 'text') {
      session.systemPrompt = options.content || null;
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
  config: CoreConfig,
  extraAnnotations: Record<string, any> = {}
): Promise<void> {
  const abortController = new AbortController();
  session.abortController = abortController;
  session.callbacks = callbacks;
  
  if (session._agentContext) {
    session._agentContext.callbacks = callbacks;
  }
  
  const userChunk = createTextChunk(message, 'com.rxcafe.user', {
    'chat.role': 'user',
    ...extraAnnotations
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
