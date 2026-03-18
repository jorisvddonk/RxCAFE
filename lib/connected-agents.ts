/**
 * Connected Agents Store
 * 
 * Manages external agents that connect to ObservableCAFE via REST API.
 * External agents can:
 * - Subscribe to sessions to receive events (join/leave notifications)
 * - Join sessions to read context and produce chunks
 * 
 * Security:
 * - Agents authenticate via API keys (sk-agent-*)
 * - Session access is validated against in-memory state and database
 * - canProduceChunk/canReadChunks determine what agents can do
 */

import { Chunk, createNullChunk } from './chunk.js';
import { getSession } from '../core.js';
import { Database } from './database.js';

/**
 * Represents an external agent connected to the system.
 * API keys are stored but hashed/regenerated for security.
 */
export interface ConnectedAgent {
  id: string;
  name: string;
  description?: string;
  apiKey: string;
  createdAt: number;
}

/**
 * Session modes for connected agents:
 * - subscribed: Agent receives event notifications only
 * - joined: Agent can read session context and produce chunks
 */
export type AgentSessionMode = 'subscribed' | 'joined';

/**
 * Associates an agent with a specific session.
 */
export interface AgentSession {
  sessionId: string;
  mode: AgentSessionMode;
}

/**
 * Manages connected agents and their session associations.
 * Provides registration, session management, and event emission.
 */
export class ConnectedAgentStore {
  // In-memory stores for fast access
  private agents = new Map<string, ConnectedAgent>();
  private apiKeyToAgentId = new Map<string, string>();
  private agentSessions = new Map<string, Set<AgentSession>>();
  private trustDb: Database | null = null;

  /**
   * Initialize the store with a database for persistence.
   * Loads existing session mappings from database.
   */
  setTrustDatabase(db: Database): void {
    this.trustDb = db;
    this.loadFromDatabase();
  }

  /**
   * Load session mappings from persistent storage.
   * API keys cannot be recovered from hash, so we use in-memory store as source of truth.
   */
  private loadFromDatabase(): void {
    if (!this.trustDb) return;

    // Load session mappings from DB
    for (const agentId of this.agents.keys()) {
      const sessions = this.trustDb.getAgentSessions(agentId);
      this.agentSessions.set(agentId, new Set(sessions));
    }
  }

  /**
   * Register a new connected agent.
   * Generates a unique API key (sk-agent-*) for authentication.
   * Returns the agent info including the generated API key.
   */
  register(name: string, description?: string): ConnectedAgent {
    const id = `agent-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const apiKey = `sk-agent-${crypto.randomUUID()}`;
    
    const agent: ConnectedAgent = {
      id,
      name,
      description,
      apiKey,
      createdAt: Date.now()
    };

    this.agents.set(id, agent);
    this.apiKeyToAgentId.set(apiKey, id);
    this.agentSessions.set(id, new Set());

    // Persist to database
    if (this.trustDb) {
      this.trustDb.addConnectedAgent(id, apiKey, name, description);
    }

    return agent;
  }

  unregister(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    // Remove from database
    if (this.trustDb) {
      this.trustDb.removeConnectedAgent(agentId);
    }

    this.apiKeyToAgentId.delete(agent.apiKey);
    this.agents.delete(agentId);
    this.agentSessions.delete(agentId);

    return true;
  }

  getById(agentId: string): ConnectedAgent | undefined {
    return this.agents.get(agentId);
  }

  getByApiKey(apiKey: string): ConnectedAgent | undefined {
    const agentId = this.apiKeyToAgentId.get(apiKey);
    if (!agentId) return undefined;
    return this.agents.get(agentId);
  }

  subscribe(agentId: string, sessionId: string): boolean {
    const agent = this.agents.get(agentId);
    const session = getSession(sessionId);
    
    if (!agent || !session) return false;

    const sessions = this.agentSessions.get(agentId);
    if (!sessions) return false;

    const existing = Array.from(sessions).find(s => s.sessionId === sessionId);
    if (existing) {
      if (existing.mode === 'joined') return true;
      existing.mode = 'subscribed';
    } else {
      sessions.add({ sessionId, mode: 'subscribed' });
    }

    // Persist to database
    if (this.trustDb) {
      this.trustDb.setAgentSession(agentId, sessionId, 'subscribed');
    }

    this.emitAgentEvent(session, agentId, agent.name, 'subscribed');
    return true;
  }

  unsubscribe(agentId: string, sessionId: string): boolean {
    const agent = this.agents.get(agentId);
    const session = getSession(sessionId);
    
    if (!agent || !session) return false;

    const sessions = this.agentSessions.get(agentId);
    if (!sessions) return false;

    const existing = Array.from(sessions).find(s => s.sessionId === sessionId);
    if (!existing || existing.mode !== 'subscribed') return false;

    sessions.delete(existing);

    // Remove from database
    if (this.trustDb) {
      this.trustDb.removeAgentSession(agentId, sessionId);
    }

    this.emitAgentEvent(session, agentId, agent.name, 'unsubscribed');
    return true;
  }

  join(agentId: string, sessionId: string): boolean {
    const agent = this.agents.get(agentId);
    const session = getSession(sessionId);
    
    if (!agent || !session) return false;

    const sessions = this.agentSessions.get(agentId);
    if (!sessions) return false;

    const existing = Array.from(sessions).find(s => s.sessionId === sessionId);
    if (existing) {
      if (existing.mode === 'joined') return true;
      existing.mode = 'joined';
    } else {
      sessions.add({ sessionId, mode: 'joined' });
    }

    // Persist to database
    if (this.trustDb) {
      this.trustDb.setAgentSession(agentId, sessionId, 'joined');
    }

    this.emitAgentEvent(session, agentId, agent.name, 'joined');
    return true;
  }

  leave(agentId: string, sessionId: string): boolean {
    const agent = this.agents.get(agentId);
    const session = getSession(sessionId);
    
    if (!agent || !session) return false;

    const sessions = this.agentSessions.get(agentId);
    if (!sessions) return false;

    const existing = Array.from(sessions).find(s => s.sessionId === sessionId);
    if (!existing || existing.mode !== 'joined') return false;

    sessions.delete(existing);

    // Remove from database
    if (this.trustDb) {
      this.trustDb.removeAgentSession(agentId, sessionId);
    }

    this.emitAgentEvent(session, agentId, agent.name, 'left');
    return true;
  }

  getSessions(agentId: string): AgentSession[] {
    const sessions = this.agentSessions.get(agentId);
    return sessions ? Array.from(sessions) : [];
  }

  getAgentsInSession(sessionId: string): { agentId: string; name: string; mode: AgentSessionMode }[] {
    const result: { agentId: string; name: string; mode: AgentSessionMode }[] = [];
    
    for (const [agentId, sessions] of this.agentSessions) {
      const agent = this.agents.get(agentId);
      if (!agent) continue;

      for (const session of sessions) {
        if (session.sessionId === sessionId) {
          result.push({
            agentId,
            name: agent.name,
            mode: session.mode
          });
        }
      }
    }

    return result;
  }

  canProduceChunk(agentId: string, sessionId: string): boolean {
    // Check in-memory first
    const sessions = this.agentSessions.get(agentId);
    if (!sessions) return false;

    const session = Array.from(sessions).find(s => s.sessionId === sessionId);
    if (session?.mode === 'joined') return true;

    // Check database (for restored sessions)
    if (this.trustDb) {
      return this.trustDb.canAgentProduceChunks(agentId, sessionId);
    }

    return false;
  }

  canReadChunks(agentId: string, sessionId: string): boolean {
    // Check in-memory first
    const sessions = this.agentSessions.get(agentId);
    if (sessions) {
      const canRead = Array.from(sessions).some(s => s.sessionId === sessionId);
      if (canRead) return true;
    }

    // Check database (for restored sessions)
    if (this.trustDb) {
      return this.trustDb.canAgentReadChunks(agentId, sessionId);
    }

    return false;
  }

  /**
   * Emit an agent lifecycle event to the session's output stream.
   * Events are sent as null chunks with the event data in annotations.
   * This allows UI and other components to react to agent join/leave.
   */
  private emitAgentEvent(
    session: any,
    agentId: string,
    agentName: string,
    event: 'subscribed' | 'unsubscribed' | 'joined' | 'left'
  ): void {
    const chunk = createNullChunk('com.observablecafe.connected-agent', {
      'com.observablecafe.connected-agent': {
        event,
        agentId,
        agentName,
        sessionId: session.id
      }
    });

    session.outputStream.next(chunk);
  }
}

export const connectedAgentStore = new ConnectedAgentStore();
