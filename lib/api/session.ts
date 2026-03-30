/**
 * Session API Handlers
 * 
 * REST endpoints for session management:
 * - POST /api/session       Create new session
 * - GET  /api/sessions      List all sessions (active + persisted)
 * - DELETE /api/session/:id Delete session
 * - GET  /api/session/:id/history  Get session history
 * - POST /api/session/:id/trust     Toggle chunk trust
 * - POST /api/session/:id/ui-mode   Set UI mode
 */

import { createNullChunk } from '../chunk.js';
import {
  getSession,
  getAgent,
  createSession,
  listActiveSessions,
  deleteSession,
  type CoreConfig,
  type CreateSessionOptions
} from '../../core.js';
import type { RuntimeSessionConfig } from '../agent.js';
import { validateConfigAgainstSchema } from '../agent.js';
import type { Database } from '../database.js';
import type { SessionStore } from '../session-store.js';

let config: CoreConfig;
let sessionStore: SessionStore;

/**
 * Safely stringify an object, handling circular references.
 * Used for debug output and error responses.
 */
function safeStringify(obj: any): string {
  const seen = new WeakSet();
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  });
}

export function init(deps: { config: CoreConfig; sessionStore: SessionStore }) {
  config = deps.config;
  sessionStore = deps.sessionStore;
}

export async function handleCreateSession(body?: any): Promise<Response> {
  try {
    const agentId = body?.agentId || 'default';
    const agent = getAgent(agentId);
    
    if (!agent) {
      return new Response(JSON.stringify({ 
        error: 'Agent not found',
        message: `No agent named '${agentId}'`
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    
    const runtimeConfig: RuntimeSessionConfig = {};
    if (body?.backend) runtimeConfig.backend = body.backend;
    if (body?.model) runtimeConfig.model = body.model;
    if (body?.systemPrompt) runtimeConfig.systemPrompt = body.systemPrompt;
    if (body?.llmParams) runtimeConfig.llmParams = body.llmParams;
    
    if (agent.configSchema) {
      const errors = await validateConfigAgainstSchema(runtimeConfig, agent.configSchema);
      if (errors.length > 0) {
        return new Response(JSON.stringify({ 
          error: 'Invalid configuration',
          message: 'Session configuration does not meet agent requirements',
          validationErrors: errors
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
    }
    
    const uiMode = body?.uiMode || 'chat';
    const session = await createSession(config, { agentId, runtimeConfig, uiMode });
    
    if (body?.backend || body?.model || body?.systemPrompt || body?.llmParams) {
      const annotations: Record<string, any> = { 'config.type': 'runtime' };
      if (body.backend) annotations['config.backend'] = body.backend;
      if (body.model) annotations['config.model'] = body.model;
      if (body.systemPrompt) annotations['config.systemPrompt'] = body.systemPrompt;
      
      if (body.llmParams) {
        const llmParams = body.llmParams;
        const llmKeys = ['temperature', 'maxTokens', 'topP', 'topK', 'repeatPenalty', 'stop', 'seed', 'maxContextLength', 'numCtx'] as const;
        for (const key of llmKeys) {
          if ((llmParams as any)[key] !== undefined) {
            annotations[`config.llm.${key}`] = (llmParams as any)[key];
          }
        }
      }
      session.outputStream.next(createNullChunk('com.rxcafe.api', annotations));
    }
    
    return new Response(JSON.stringify({ 
      sessionId: session.id,
      agentName: session.agentName,
      isBackground: session.isBackground,
      uiMode: session.uiMode,
      message: 'Session created'
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: 'Failed to create session',
      message: error instanceof Error ? error.message : 'Unknown error'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

export async function handleListSessions(): Promise<Response> {
  const activeSessions = listActiveSessions();
  const allSessionIds = new Set(activeSessions.map(s => s.id));
  
  if (sessionStore) {
    const persistedSessions = await sessionStore.listAllSessions();
    for (const ps of persistedSessions) {
      if (!allSessionIds.has(ps.id)) {
        activeSessions.push({
          id: ps.id,
          agentName: ps.agentName,
          isBackground: ps.isBackground,
          displayName: ps.id === ps.agentName ? ps.agentName : undefined,
          uiMode: ps.uiMode
        });
      }
    }
  }
  
  return new Response(JSON.stringify({ sessions: activeSessions }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function handleDeleteSession(sessionId: string): Promise<Response> {
  const success = await deleteSession(sessionId);
  return new Response(JSON.stringify({ success, message: success ? 'Session deleted' : 'Session not found or could not be deleted' }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function handleGetHistory(sessionId: string): Promise<Response> {
  let session = getSession(sessionId);
  
  if (!session && sessionStore) {
    const sessionData = await sessionStore.loadSession(sessionId);
    if (sessionData) {
      const agent = getAgent(sessionData.agentName);
      if (agent) {
        const restoredSession = await createSession(config, {
          agentId: sessionData.agentName,
          isBackground: sessionData.isBackground,
          sessionId: sessionId,
          uiMode: sessionData.uiMode,
          ...sessionData.config,
          systemPrompt: sessionData.systemPrompt || undefined,
        });
        
        if (restoredSession._agentContext) {
          await restoredSession._agentContext.loadState();
        }
        session = restoredSession;
      }
    }
  }
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  
  return new Response(safeStringify({
    sessionId,
    displayName: session.displayName,
    uiMode: session.uiMode,
    chunks: session.history
  }), { headers: { 'Content-Type': 'application/json' } });
}

export async function handleToggleTrust(sessionId: string, chunkId: string, trusted: boolean): Promise<Response> {
  let session = getSession(sessionId);
  
  if (!session && sessionStore) {
    const sessionData = await sessionStore.loadSession(sessionId);
    if (sessionData) {
      const agent = getAgent(sessionData.agentName);
      if (agent) {
        const restoredSession = await createSession(config, {
          agentId: sessionData.agentName,
          isBackground: sessionData.isBackground,
          sessionId: sessionId,
          uiMode: sessionData.uiMode,
          ...sessionData.config,
          systemPrompt: sessionData.systemPrompt || undefined,
        });
        
        if (restoredSession._agentContext) {
          await restoredSession._agentContext.loadState();
        }
        session = restoredSession;
      }
    }
  }
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  
  const { toggleChunkTrust } = await import('../../core.js');
  const result = toggleChunkTrust(session, chunkId, trusted);
  
  if (!result) {
    return new Response(JSON.stringify({ error: 'Chunk not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  
  return new Response(JSON.stringify({
    success: true,
    chunkId,
    trusted,
    message: trusted ? 'Chunk marked as trusted and added to LLM context' : 'Chunk marked as untrusted'
  }), { headers: { 'Content-Type': 'application/json' } });
}

export async function handleSetUIMode(sessionId: string, uiMode: string): Promise<Response> {
  let session = getSession(sessionId);
  
  if (!session && sessionStore) {
    const sessionData = await sessionStore.loadSession(sessionId);
    if (sessionData) {
      const agent = getAgent(sessionData.agentName);
      if (agent) {
        session = await createSession(config, {
          agentId: sessionData.agentName,
          isBackground: sessionData.isBackground,
          sessionId: sessionId,
          uiMode: sessionData.uiMode,
          ...sessionData.config,
        });
        
        if (session._agentContext) {
          await session._agentContext.loadState();
        }
      }
    }
  }
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  
  session.uiMode = uiMode;
  
  if (sessionStore) {
    await sessionStore.setSessionUIMode(sessionId, uiMode);
  }
  
  return new Response(JSON.stringify({ 
    success: true, 
    sessionId,
    uiMode
  }), { headers: { 'Content-Type': 'application/json' } });
}

export async function handleDeleteChunk(sessionId: string, chunkId: string): Promise<Response> {
  let session = getSession(sessionId);
  
  if (!session && sessionStore) {
    const sessionData = await sessionStore.loadSession(sessionId);
    if (sessionData) {
      const agent = getAgent(sessionData.agentName);
      if (agent) {
        const restoredSession = await createSession(config, {
          agentId: sessionData.agentName,
          isBackground: sessionData.isBackground,
          sessionId: sessionId,
          uiMode: sessionData.uiMode,
          ...sessionData.config,
          systemPrompt: sessionData.systemPrompt || undefined,
        });
        
        if (restoredSession._agentContext) {
          await restoredSession._agentContext.loadState();
        }
        session = restoredSession;
      }
    }
  }
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  
  const { deleteChunkFromSession } = await import('../../core.js');
  const result = deleteChunkFromSession(session, chunkId);
  
  if (!result) {
    return new Response(JSON.stringify({ error: 'Chunk not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  
  if (sessionStore) {
    await sessionStore.saveHistory(sessionId, session.history);
  }
  
  return new Response(JSON.stringify({
    success: true,
    chunkId,
    message: 'Chunk deleted'
  }), { headers: { 'Content-Type': 'application/json' } });
}
