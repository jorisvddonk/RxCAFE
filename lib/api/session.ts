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
 * - GET  /api/session/:sessionId/chunk/:chunkId/binary  Fetch raw binary data for a chunk
 */

import { createNullChunk, type BinaryContent, type Chunk } from '../chunk.js';
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
    
    // Build runtimeConfig with agent schema defaults BEFORE createSession
    // so initialize() has access to voice and other defaults
    const defaults = agent.configSchema?.default || {};
    const runtimeConfig: RuntimeSessionConfig = {
      backend: body?.backend || defaults.backend,
      model: body?.model || defaults.model,
      systemPrompt: body?.systemPrompt || defaults.systemPrompt,
      llmParams: body?.llmParams || defaults.llmParams,
    };
    if (body?.voice || defaults.voice) {
      runtimeConfig.voice = body?.voice || defaults.voice;
    }
    if (body?.promptTemplate || defaults.promptTemplate) {
      runtimeConfig.promptTemplate = body?.promptTemplate || defaults.promptTemplate;
    }
    if (body?.templateVars || defaults.templateVars) {
      runtimeConfig.templateVars = body?.templateVars || defaults.templateVars;
    }
    if (body?.openaiBaseUrl || defaults.openaiBaseUrl) {
      runtimeConfig.openaiBaseUrl = body?.openaiBaseUrl || defaults.openaiBaseUrl;
    }
    
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
    
    // Emit config chunk for persistence (history)
    const annotations: Record<string, any> = { 'config.type': 'runtime' };
    if (runtimeConfig.backend) annotations['config.backend'] = runtimeConfig.backend;
    if (runtimeConfig.model) annotations['config.model'] = runtimeConfig.model;
    if (runtimeConfig.systemPrompt) annotations['config.systemPrompt'] = runtimeConfig.systemPrompt;
    if (runtimeConfig.promptTemplate) annotations['config.promptTemplate'] = runtimeConfig.promptTemplate;
    if (runtimeConfig.voice) annotations['config.voice'] = runtimeConfig.voice;
    if (runtimeConfig.openaiBaseUrl) annotations['config.openaiBaseUrl'] = runtimeConfig.openaiBaseUrl;
    
    if (runtimeConfig.templateVars && typeof runtimeConfig.templateVars === 'object') {
      for (const [key, value] of Object.entries(runtimeConfig.templateVars)) {
        annotations[`config.templateVars.${key}`] = value;
      }
    }
    
    if (runtimeConfig.llmParams) {
      const llmKeys = ['temperature', 'maxTokens', 'topP', 'topK', 'repeatPenalty', 'stop', 'stopTokenStrip', 'seed', 'maxContextLength', 'numCtx'] as const;
      for (const key of llmKeys) {
        if ((runtimeConfig.llmParams as any)[key] !== undefined) {
          annotations[`config.llm.${key}`] = (runtimeConfig.llmParams as any)[key];
        }
      }
    }
    session.outputStream.next(createNullChunk('com.rxcafe.api', annotations));
    
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

function toBinaryRef(chunk: Chunk): any {
  const binaryContent = chunk.content as BinaryContent;
  return {
    ...chunk,
    contentType: 'binary-ref',
    content: {
      chunkId: chunk.id,
      mimeType: binaryContent.mimeType,
      byteSize: binaryContent.data.byteLength,
    },
  };
}

export async function handleGetHistory(sessionId: string, binaryRefs: boolean = false): Promise<Response> {
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

  const chunks = binaryRefs
    ? session.history.map(chunk => chunk.contentType === 'binary' ? toBinaryRef(chunk) : chunk)
    : session.history;
  
  return new Response(safeStringify({
    sessionId,
    displayName: session.displayName,
    uiMode: session.uiMode,
    chunks,
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

export async function handleGetChunkBinary(sessionId: string, chunkId: string): Promise<Response> {
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

  const chunk = session.history.find(c => c.id === chunkId);
  if (!chunk) {
    return new Response(JSON.stringify({ error: 'Chunk not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  if (chunk.contentType !== 'binary') {
    return new Response(JSON.stringify({ error: 'Chunk is not a binary chunk', contentType: chunk.contentType }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const binaryContent = chunk.content as BinaryContent;
  if (!binaryContent?.data) {
    return new Response(JSON.stringify({ error: 'Binary data unavailable' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(binaryContent.data, {
    headers: {
      'Content-Type': binaryContent.mimeType,
      'Content-Length': String(binaryContent.data.byteLength),
    },
  });
}
