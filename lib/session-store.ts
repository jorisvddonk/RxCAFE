/**
 * RXCAFE Session Store
 * SQLite persistence for all sessions
 */

import { Database } from 'bun:sqlite';
import type { Chunk } from './chunk.js';
import type { SessionConfig, LLMParams } from './agent.js';

export class SessionStore {
  private db: Database;
  
  constructor(db: Database) {
    this.db = db;
    this.initializeSchema();
  }
  
  private initializeSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        is_background INTEGER NOT NULL DEFAULT 0,
        config_json TEXT,
        system_prompt TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    
    this.db.run(`
      CREATE TABLE IF NOT EXISTS session_chunks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        chunk_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
      )
    `);
    
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_session_chunks_session_id ON session_chunks(session_id)
    `);
    
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent_name ON agent_sessions(agent_name)
    `);
    
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated_at ON agent_sessions(updated_at)
    `);
  }
  
  async saveSession(sessionId: string, agentName: string, isBackground: boolean, config: SessionConfig, systemPrompt: string | null): Promise<void> {
    const now = Date.now();
    const configJson = JSON.stringify(config);
    
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO agent_sessions (id, agent_name, is_background, config_json, system_prompt, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM agent_sessions WHERE id = ?), ?), ?)
    `);
    
    stmt.run(sessionId, agentName, isBackground ? 1 : 0, configJson, systemPrompt, sessionId, now, now);
    stmt.finalize();
  }
  
  async loadSession(sessionId: string): Promise<{
    agentName: string;
    isBackground: boolean;
    config: SessionConfig;
    systemPrompt: string | null;
  } | null> {
    const stmt = this.db.prepare(`
      SELECT agent_name, is_background, config_json, system_prompt
      FROM agent_sessions WHERE id = ?
    `);
    
    const result = stmt.get(sessionId) as {
      agent_name: string;
      is_background: number;
      config_json: string;
      system_prompt: string | null;
    } | undefined;
    
    stmt.finalize();
    
    if (!result) return null;
    
    return {
      agentName: result.agent_name,
      isBackground: result.is_background === 1,
      config: JSON.parse(result.config_json),
      systemPrompt: result.system_prompt,
    };
  }
  
  async saveHistory(sessionId: string, history: Chunk[]): Promise<void> {
    const deleteStmt = this.db.prepare(`DELETE FROM session_chunks WHERE session_id = ?`);
    deleteStmt.run(sessionId);
    deleteStmt.finalize();
    
    const insertStmt = this.db.prepare(`
      INSERT INTO session_chunks (id, session_id, chunk_json, created_at)
      VALUES (?, ?, ?, ?)
    `);
    
    for (const chunk of history) {
      // Handle binary data for JSON storage
      let serializedChunk = chunk;
      if (chunk.contentType === 'binary' && chunk.content && (chunk.content as any).data instanceof Uint8Array) {
        const binaryContent = chunk.content as any;
        serializedChunk = {
          ...chunk,
          content: {
            ...binaryContent,
            data: Buffer.from(binaryContent.data).toString('base64'),
            _isBase64: true
          }
        };
      }
      
      insertStmt.run(chunk.id, sessionId, JSON.stringify(serializedChunk), chunk.timestamp);
    }
    
    insertStmt.finalize();
    
    const updateStmt = this.db.prepare(`UPDATE agent_sessions SET updated_at = ? WHERE id = ?`);
    updateStmt.run(Date.now(), sessionId);
    updateStmt.finalize();
  }
  
  async loadHistory(sessionId: string): Promise<Chunk[]> {
    const stmt = this.db.prepare(`
      SELECT chunk_json FROM session_chunks
      WHERE session_id = ?
      ORDER BY created_at ASC
    `);
    
    const results = stmt.all(sessionId) as { chunk_json: string }[];
    stmt.finalize();
    
    return results.map(r => {
      const chunk = JSON.parse(r.chunk_json) as Chunk;
      // Restore binary data from Base64
      if (chunk.contentType === 'binary' && chunk.content && (chunk.content as any)._isBase64) {
        const binaryContent = chunk.content as any;
        return {
          ...chunk,
          content: {
            data: new Uint8Array(Buffer.from(binaryContent.data, 'base64')),
            mimeType: binaryContent.mimeType
          }
        };
      }
      return chunk;
    });
  }
  
  async deleteSession(sessionId: string): Promise<void> {
    const stmt = this.db.prepare(`DELETE FROM agent_sessions WHERE id = ?`);
    stmt.run(sessionId);
    stmt.finalize();
  }
  
  async listAllSessions(): Promise<Array<{ id: string; agentName: string; isBackground: boolean; updatedAt: number }>> {
    const stmt = this.db.prepare(`
      SELECT id, agent_name, is_background, updated_at FROM agent_sessions
      ORDER BY updated_at DESC
    `);
    
    const results = stmt.all() as { id: string; agent_name: string; is_background: number; updated_at: number }[];
    stmt.finalize();
    
    return results.map(r => ({
      id: r.id,
      agentName: r.agent_name,
      isBackground: r.is_background === 1,
      updatedAt: r.updated_at,
    }));
  }
  
  async listBackgroundSessions(): Promise<Array<{ id: string; agentName: string }>> {
    const stmt = this.db.prepare(`
      SELECT id, agent_name FROM agent_sessions WHERE is_background = 1
    `);
    
    const results = stmt.all() as { id: string; agent_name: string }[];
    stmt.finalize();
    
    return results.map(r => ({ id: r.id, agentName: r.agent_name }));
  }
  
  async getBackgroundSessionByAgentName(agentName: string): Promise<{ id: string; config: SessionConfig; systemPrompt: string | null } | null> {
    const stmt = this.db.prepare(`
      SELECT id, config_json, system_prompt FROM agent_sessions
      WHERE agent_name = ? AND is_background = 1
    `);
    
    const result = stmt.get(agentName) as {
      id: string;
      config_json: string;
      system_prompt: string | null;
    } | undefined;
    
    stmt.finalize();
    
    if (!result) return null;
    
    return {
      id: result.id,
      config: JSON.parse(result.config_json),
      systemPrompt: result.system_prompt,
    };
  }
  
  async cleanupOldSessions(maxAge: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - maxAge;
    const stmt = this.db.prepare(`
      DELETE FROM agent_sessions 
      WHERE is_background = 0 AND updated_at < ?
    `);
    const result = stmt.run(cutoff);
    stmt.finalize();
    return result.changes;
  }
}
