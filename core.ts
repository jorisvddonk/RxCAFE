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
import { Subject, Observable, merge, EMPTY, from, filter, map, mergeMap, catchError, tap, debounceTime } from './lib/stream.js';
import { KoboldEvaluator } from './lib/kobold-api.js';
import { OllamaEvaluator } from './lib/ollama-api.js';
import { LlamaCppEvaluator } from './lib/llamacpp-api.js';
import { OpenAIEvaluator } from './lib/openai-api.js';
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
import { getPromptTemplate, listPromptTemplates, defaultInterpolator, nullInterpolator, type PromptTemplate, type InterpolatorFn } from './lib/prompt-templates.js';

// =============================================================================
// Configuration
// =============================================================================

export type LLMBackend = 'kobold' | 'ollama' | 'llamacpp' | 'openai';

export interface CoreConfig {
  backend: LLMBackend;
  koboldBaseUrl: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  llamacppBaseUrl: string;
  llamacppModel: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiApiKey: string;
  tracing: boolean;
  sessionStore?: SessionStore;
}

export function getDefaultConfig(): CoreConfig {
  return {
    backend: (process.env.LLM_BACKEND as LLMBackend) || 'kobold',
    koboldBaseUrl: process.env.KOBOLD_URL || 'http://localhost:5001',
    ollamaBaseUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'gemma3:1b',
    llamacppBaseUrl: process.env.LLAMACPP_URL || 'http://localhost:8080',
    llamacppModel: process.env.LLAMACPP_MODEL || 'model.gguf',
    openaiBaseUrl: process.env.OPENAI_URL || 'http://localhost:8000',
    openaiModel: process.env.OPENAI_MODEL || '',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
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

export function createLLMChunkEvaluator(
  backend: LLMBackend, 
  config: CoreConfig,
  model?: string,
  llmParams?: LLMParams,
  openaiBaseUrl?: string
): LLMEvaluator {
  if (backend === 'ollama') {
    const ollama = new OllamaEvaluator(config.ollamaBaseUrl, model || config.ollamaModel, '', llmParams);
    return {
      evaluateChunk: ollama.evaluateChunk.bind(ollama),
      abort: async () => {}
    };
  } else if (backend === 'llamacpp') {
    const llamacpp = new LlamaCppEvaluator(config.llamacppBaseUrl, model || config.llamacppModel, '', llmParams);
    return {
      evaluateChunk: llamacpp.evaluateChunk.bind(llamacpp),
      abort: async () => {}
    };
  } else if (backend === 'openai') {
    const baseUrl = openaiBaseUrl || config.openaiBaseUrl;
    const openai = new OpenAIEvaluator(baseUrl, model || config.openaiModel, '', llmParams, config.openaiApiKey);
    return {
      evaluateChunk: openai.evaluateChunk.bind(openai),
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
  uiMode?: string;
  
  _agentContext?: AgentSessionContext;
}

const sessions = new Map<string, Session>();
export const sessionUpdates = new Subject<{ sessionId: string; messageCount: number }>();
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
  uiMode?: string;
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
    llmEvaluator: createLLMChunkEvaluator(backend, config, model, runtimeConfig.llmParams, runtimeConfig.openaiBaseUrl),
    backend,
    model,
    abortController: null,
    trustedChunks: new Set(),
    callbacks: null,
    systemPrompt: runtimeConfig.systemPrompt || null,
    runtimeConfig,
    persistsState: agent.persistsState !== false,
    uiMode: options?.uiMode || 'chat',
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
    trustedChunks: session.trustedChunks,
    get systemPrompt() { return session.systemPrompt; },
    get callbacks() { return session.callbacks; },
    set callbacks(val) { session.callbacks = val; },
    get runtimeConfig() { return session.runtimeConfig; },
    
    createLLMChunkEvaluator: (backendOrParams?: LLMBackend | LLMParams, model?: string, params?: LLMParams): AgentEvaluator => {
      let b: LLMBackend;
      let m: string | undefined;
      let p: LLMParams | undefined;

      if (typeof backendOrParams === 'object') {
        // One-liner: session.createLLMChunkEvaluator({ temperature: 0 })
        b = session.runtimeConfig.backend || config.backend;
        m = session.runtimeConfig.model;
        p = { ...session.runtimeConfig.llmParams, ...backendOrParams };
      } else {
        // Standard: session.createLLMChunkEvaluator('ollama', 'llama3', { ... })
        b = backendOrParams || session.runtimeConfig.backend || config.backend;
        m = model || session.runtimeConfig.model;
        p = { ...session.runtimeConfig.llmParams, ...params };
      }

      const evaluator = createLLMChunkEvaluator(b, config, m, p, session.runtimeConfig.openaiBaseUrl);
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
        await sessionStore.saveSession(id, agentId, isBackground, {}, null, session.uiMode || 'chat');
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
        session.llmEvaluator = createLLMChunkEvaluator(
          session.backend,
          config,
          session.model,
          session.runtimeConfig.llmParams,
          session.runtimeConfig.openaiBaseUrl
        );
      }
    },
  };
  
  session._agentContext = agentContext;

  // =============================================================================
  // UNIFIED STREAM PIPELINE
  // =============================================================================
  // This is the heart of the session's data flow:
  // 1. INPUT STREAM → OUTPUT STREAM: Forward user messages and config changes
  // 2. OUTPUT STREAM → HISTORY: Track all output chunks for persistence
  // 3. DEBOUNCED PERSISTENCE: Save history to SQLite after 500ms of inactivity
  // 
  // The merge() operator allows both streams to flow independently.
  // The debounceTime(500) prevents excessive database writes during rapid updates.

  const historyTrigger = new Subject<void>();
  
  merge(
    // ===== INPUT → OUTPUT PIPELINE =====
    // Forward input chunks to output, filtering for valid content types.
    // Accepts: text chunks with user/system role, web content, session config, or binary
    inputStream.pipe(
      filter((chunk: any) => {
        if (!chunk || typeof chunk !== 'object') {
          console.log('[Core] FILTER0: Rejecting non-object in inputStream');
          return false;
        }
        const chunkType = chunk?.constructor?.name || 'unknown';
        if (chunkType.includes('Subject')) {
          console.log('[Core] FILTER0: Rejecting Subject in inputStream, type:', chunkType);
          return false;
        }
        // Extract role and source information for filtering
        const role = chunk.annotations?.['chat.role'];
        const isWeb = chunk.producer === 'com.rxcafe.web-fetch' || chunk.annotations?.['web.source-url'];
        const isSessionName = !!chunk.annotations?.['session.name'];
        const isRuntimeConfig = chunk.contentType === 'null' && chunk.annotations?.['config.type'] === 'runtime';
        const isBinary = chunk.contentType === 'binary';
        return isBinary || ((chunk.contentType === 'text' || chunk.contentType === 'null') &&
               (role === 'user' || role === 'system' || isWeb || isSessionName || isRuntimeConfig));
      }),
      tap(chunk => {
        console.log('[Core] INPUT→OUTPUT: emitting chunk, type=', typeof chunk, chunk?.constructor?.name);
        outputStream.next(chunk);
      })
    ),
    // ===== OUTPUT → HISTORY PIPELINE =====
    // Track all output chunks, update session state, and persist to history.
    outputStream.pipe(
      tap(chunk => {
        // ===== SESSION NAMING =====
        // Allow chunks to rename the session display name
        if (chunk.annotations?.['session.name']) {
          session.displayName = String(chunk.annotations['session.name']);
          console.log(`[Core] Session ${session.id} renamed to: ${session.displayName}`);
        }
        
        // ===== RUNTIME CONFIGURATION =====
        // Null chunks with 'config.type: runtime' update session config dynamically.
        // This allows runtime changes to backend, model, system prompt, and LLM params.
        if (chunk.contentType === 'null' && chunk.annotations?.['config.type'] === 'runtime') {
          console.log(`[Core] Processing runtime config chunk:`, chunk.annotations);
          const newConfig = extractRuntimeConfigFromChunk(chunk);
          console.log(`[Core] Session ${session.id} runtime config BEFORE:`, session.runtimeConfig);
          console.log(`[Core] Session ${session.id} runtime config AFTER (from chunk):`, newConfig);
          console.log(`[Core] Session ${session.id} voice from chunk:`, newConfig.voice);
          
          // Merge new config with existing config (partial updates preserve existing values)
          session.runtimeConfig = { ...session.runtimeConfig, ...newConfig };
          
          // Update session-level settings from runtime config
          if (session.runtimeConfig.backend) session.backend = session.runtimeConfig.backend;
          if (session.runtimeConfig.model) session.model = session.runtimeConfig.model;
          if (session.runtimeConfig.systemPrompt) session.systemPrompt = session.runtimeConfig.systemPrompt;
          
          // Recreate evaluator with new config
          session.llmEvaluator = createLLMChunkEvaluator(
            session.backend,
            config,
            session.model,
            session.runtimeConfig.llmParams,
            session.runtimeConfig.openaiBaseUrl
          );
        }
        
        // ===== HISTORY MANAGEMENT =====
        // Update or append chunks to session history.
        // Filter out any stray Subject objects that might leak into the stream.
        const chunkType = chunk?.constructor?.name || '';
        if (chunkType.includes('Subject')) {
          console.log('[Core] HISTORY_FILTER: Rejecting Subject:', chunkType);
          return;
        }
        const existingIndex = session.history.findIndex(c => c.id === chunk.id);
        if (existingIndex !== -1) {
          // Update existing chunk (e.g., streaming tokens coalesced)
          session.history[existingIndex] = chunk;
        } else {
            // Validate chunk before adding to history
            if (!chunk || !chunk.id || !chunk.contentType) {
              console.error(`[Core] Invalid chunk being added to history:`, chunk);
              console.error(`[Core] Stack trace:`, new Error().stack);
            } else {
              session.history.push(chunk);
              historyTrigger.next();  // Signal that history was updated

              // Emit session update for message count changes
              if (chunk.annotations?.['chat.role'] === 'user' || chunk.annotations?.['chat.role'] === 'assistant') {
                const messageCount = session.history.filter(c =>
                  c.annotations?.['chat.role'] === 'user' || c.annotations?.['chat.role'] === 'assistant'
                ).length;
                sessionUpdates.next({ sessionId: id, messageCount });
              }
            }
        }
      })
    )
  ).pipe(
    debounceTime(500)  // Debounce to batch rapid updates into single persist calls
  ).subscribe({
    next: async () => {
      // Persist session state to SQLite
      if (sessionStore && session.persistsState !== false) {
        try {
          await sessionStore.saveHistory(id, session.history);
          await sessionStore.saveSession(id, agentId, isBackground, {}, null, session.uiMode || 'chat');
        } catch (err) {
          console.error(`[Core] Failed to persist session ${id}:`, err);
        }
      }
    }
  });
  
  if (sessionStore) {
    await sessionStore.saveSession(id, agentId, isBackground, {}, null, session.uiMode || 'chat');
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
  
  if (sessionStore) {
    try {
      await sessionStore.deleteSession(sessionId);
    } catch (err) {
      console.error(`Failed to delete session ${sessionId} from store:`, err);
    }
  }
  
  return sessions.delete(sessionId);
}

/**
 * Reload an agent for an existing session.
 * 
 * This enables hot-reloading of agent logic without disrupting active connections:
 * 1. Unsubscribe from the old agent's pipeline
 * 2. Call destroy() on the old agent to clean up resources
 * 3. Reuse existing streams (inputStream, outputStream) to preserve SSE connections
 * 4. Rebuild the agent context with fresh callbacks
 * 5. Initialize the new agent
 * 
 * The key insight is that we DON'T recreate the streams - only the agent logic changes.
 * This allows connected clients to continue receiving events while the agent updates.
 */
export async function reloadSessionAgent(sessionId: string, config: CoreConfig): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;
  
  const newAgent = getAgent(session.agentName);
  if (!newAgent) {
    console.error(`[Core] Cannot reload session ${sessionId}: agent ${session.agentName} not found`);
    return false;
  }
  
  // ===== PHASE 1: TEARDOWN =====
  // Unsubscribe from old pipeline to stop processing
  if (session.pipelineSubscription) {
    session.pipelineSubscription.unsubscribe();
  }
  
  // Call destroy on old agent to release resources (timers, connections, etc.)
  try {
    const oldAgent = getAgent(session.agentName);
    if (oldAgent?.destroy && session._agentContext) {
      await oldAgent.destroy(session._agentContext);
    }
  } catch (err) {
    console.warn(`[Core] Error calling destroy on old agent for session ${sessionId}:`, err);
  }
  
  // ===== PHASE 2: STREAM PRESERVATION =====
  // Reuse existing streams - don't create new ones
  // This preserves SSE connections and other subscribers
  
  // ===== PHASE 3: CONTEXT REBUILD =====
  // Create fresh agent context with existing streams and history
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
    trustedChunks: session.trustedChunks,
    get systemPrompt() { return session.systemPrompt; },
    get callbacks() { return session.callbacks; },
    set callbacks(val) { session.callbacks = val; },
    get runtimeConfig() { 
      return session.runtimeConfig; 
    },
    
    createLLMChunkEvaluator: (backendOrParams?: LLMBackend | LLMParams, model?: string, params?: LLMParams): AgentEvaluator => {
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

      const evaluator = createLLMChunkEvaluator(b, config, m, p, session.runtimeConfig.openaiBaseUrl);
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
        await sessionStore.saveSession(session.id, session.agentName, session.isBackground, {}, null, session.uiMode || 'chat');
        await sessionStore.saveHistory(session.id, session.history);
      }
    },
    
    loadState: async (): Promise<void> => {
      // Already loaded, no-op
    },
  };
  
  // ===== PHASE 4: INITIALIZE NEW AGENT =====
  await newAgent.initialize(session._agentContext);
  
  console.log(`[Core] Reloaded agent for session ${sessionId} (${session.agentName})`);
  return true;
}

export function listSessions(): string[] {
  return Array.from(sessions.keys());
}

export function listActiveSessions(): Array<{ id: string; agentName: string; isBackground: boolean; displayName?: string; uiMode?: string; messageCount?: number }> {
  return Array.from(sessions.values()).map(s => ({
    id: s.id,
    agentName: s.agentName,
    isBackground: s.isBackground,
    displayName: s.displayName,
    uiMode: s.uiMode,
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

export function deleteChunkFromSession(
  session: Session,
  chunkId: string
): boolean {
  const chunkIndex = session.history.findIndex(c => c.id === chunkId);
  if (chunkIndex === -1) {
    return false;
  }
  
  session.trustedChunks.delete(chunkId);
  session.history.splice(chunkIndex, 1);
  return true;
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

/**
 * Build conversation context string for LLM prompts.
 * 
 * Constructs a formatted string containing:
 * 1. System prompt (if provided)
 * 2. Chat history with User/Assistant roles
 * 3. Web content (marked with source URL)
 * 
 * Security filtering: Only includes chunks that are:
 * - Text content type
 * - Have a recognized role (user/assistant) or are web content
 * - Have trust level 'trusted' or no trust level (assumed trusted)
 * 
 * The excludeChunkId parameter allows omitting the current input chunk
 * to prevent duplicate context when generating responses.
 * 
 * @param history - Session history array
 * @param excludeChunkId - Chunk ID to exclude (typically the current input)
 * @param systemPrompt - Optional system prompt to prepend
 * @returns Formatted context string for LLM
 */
export interface ConversationContextResult {
  context: string;
  template: PromptTemplate;
}

/**
 * Build a conversation context string from session history.
 * 
 * Scans history for the most recent runtime config chunk to find:
 * - System prompt (config.systemPrompt)
 * - Prompt template (config.promptTemplate)
 * 
 * The prompt template controls how system/user/assistant messages are formatted.
 * 
 * @param history - Session history array
 * @param excludeChunkId - Chunk ID to exclude (typically the current input)
 * @param systemPrompt - Optional system prompt to prepend
 * @returns Object with formatted context string and the template used
 */
export function buildConversationContext(history: Chunk[], excludeChunkId?: string, systemPrompt?: string | null, templateVars?: Record<string, string>): ConversationContextResult {
  const contextParts: string[] = [];
  
  // Extract template name, system prompt, and template vars from the most recent runtime config chunk
  let effectiveSystemPrompt = systemPrompt;
  let effectiveTemplateVars = templateVars;
  let template: PromptTemplate = getPromptTemplate('rxcafe')!;
  for (let i = history.length - 1; i >= 0; i--) {
    const chunk = history[i];
    if (chunk.contentType === 'null' && chunk.annotations['config.type'] === 'runtime') {
      const configPrompt = chunk.annotations['config.systemPrompt'];
      if (configPrompt) {
        effectiveSystemPrompt = String(configPrompt);
      }
      const configTemplate = chunk.annotations['config.promptTemplate'];
      if (configTemplate) {
        const found = getPromptTemplate(String(configTemplate));
        if (found) template = found;
      }
      // Collect template vars from annotations
      const vars: Record<string, string> = { ...effectiveTemplateVars };
      for (const [key, value] of Object.entries(chunk.annotations)) {
        if (key.startsWith('config.templateVars.')) {
          const varName = key.slice('config.templateVars.'.length);
          vars[varName] = String(value);
        }
      }
      effectiveTemplateVars = vars;
      break;
    }
  }
  
  const interpolator: InterpolatorFn = template.interpolator === null
    ? nullInterpolator
    : (template.interpolator || defaultInterpolator);
  
  const interpolate = (text: string): string => {
    if (!effectiveTemplateVars) return text;
    return interpolator(text, effectiveTemplateVars);
  };
  
  // Add system prompt at the top
  if (effectiveSystemPrompt) {
    let processedPrompt = effectiveSystemPrompt;
    if (template.systemPromptTransform) {
      processedPrompt = template.systemPromptTransform(processedPrompt);
    }
    processedPrompt = interpolate(processedPrompt);
    const parts: string[] = [];
    if (template.systemPrefix) parts.push(interpolate(template.systemPrefix));
    parts.push(processedPrompt);
    if (template.systemSuffix) parts.push(interpolate(template.systemSuffix));
    contextParts.push(parts.join(''));
  }
  
  // Process each chunk in history
  for (const chunk of history) {
    // Skip the chunk being responded to (avoid duplication)
    if (chunk.id === excludeChunkId) continue;
    
    // Only process text chunks
    if (chunk.contentType !== 'text') continue;
    
    // Extract role and trust information
    const role = chunk.annotations['chat.role'];
    const trustLevel = chunk.annotations['security.trust-level'];
    const isChunkTrusted = !trustLevel || trustLevel.trusted === true;
    
    // ===== SECURITY: FILTER UNTRUSTED CONTENT =====
    // Untrusted content (e.g., from untrusted web sources) is excluded
    // This prevents prompt injection attacks via untrusted content
    if (!isChunkTrusted) continue;
    
    const content = chunk.content as string;
    
    // Format based on role or source
    if (role === 'user') {
      const parts: string[] = [];
      if (template.userPrefix) parts.push(interpolate(template.userPrefix));
      parts.push(content);
      if (template.userSuffix) parts.push(interpolate(template.userSuffix));
      contextParts.push(parts.join(''));
    } else if (role === 'assistant') {
      const parts: string[] = [];
      if (template.assistantPrefix) parts.push(interpolate(template.assistantPrefix));
      parts.push(content);
      if (template.assistantSuffix) parts.push(interpolate(template.assistantSuffix));
      contextParts.push(parts.join(''));
    } else if (chunk.producer === 'com.rxcafe.web-fetch' || chunk.annotations['web.source-url']) {
      // Web content is marked with its source URL
      const url = chunk.annotations['web.source-url'] || 'unknown';
      contextParts.push(`[Web content from ${url}]: ${content}`);
    }
  }
  
  return {
    context: contextParts.join('\n\n'),
    template,
  };
}

// =============================================================================
// Model Listing
// =============================================================================

export async function listModels(config: CoreConfig, backend?: string, baseUrl?: string): Promise<{ models: string[]; backend: string }> {
  const targetBackend = backend || config.backend;
  
  if (targetBackend === 'ollama') {
    const { OllamaAPI } = await import('./lib/ollama-api.js');
    const api = new OllamaAPI(config.ollamaBaseUrl);
    const models = await api.listModels();
    return { models, backend: 'ollama' };
  } else if (targetBackend === 'llamacpp') {
    const { LlamaCppAPI } = await import('./lib/llamacpp-api.js');
    const api = new LlamaCppAPI(config.llamacppBaseUrl, config.llamacppModel);
    const models = await api.listModels();
    return { models, backend: 'llamacpp' };
  } else if (targetBackend === 'openai') {
    const { OpenAIAPI } = await import('./lib/openai-api.js');
    const effectiveBaseUrl = baseUrl || config.openaiBaseUrl;
    const api = new OpenAIAPI(effectiveBaseUrl, config.openaiModel, config.openaiApiKey);
    const models = await api.listModels();
    return { models, backend: 'openai' };
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
