/**
 * RXCAFE Session Store
 * SQLite persistence for all sessions
 */

import { Database } from 'bun:sqlite';
import type { Chunk } from './chunk.js';
import type { SessionConfig, LLMParams } from './agent.js';

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
        ui_mode TEXT NOT NULL DEFAULT 'chat',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    
    // Migration: Add ui_mode column if it doesn't exist
    try {
      this.db.run(`ALTER TABLE agent_sessions ADD COLUMN ui_mode TEXT NOT NULL DEFAULT 'chat'`);
    } catch (e) {
      // Column already exists, ignore
    }
    
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
  
  async saveSession(sessionId: string, agentName: string, isBackground: boolean, config: SessionConfig, systemPrompt: string | null, uiMode: string = 'chat'): Promise<void> {
    const now = Date.now();
    const configJson = JSON.stringify(config);
    
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO agent_sessions (id, agent_name, is_background, config_json, system_prompt, ui_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM agent_sessions WHERE id = ?), ?), ?)
    `);
    
    stmt.run(sessionId, agentName, isBackground ? 1 : 0, configJson, systemPrompt, uiMode, sessionId, now, now);
    stmt.finalize();
  }
  
  async loadSession(sessionId: string): Promise<{
    agentName: string;
    isBackground: boolean;
    config: SessionConfig;
    systemPrompt: string | null;
    uiMode: string;
  } | null> {
    const stmt = this.db.prepare(`
      SELECT agent_name, is_background, config_json, system_prompt, ui_mode
      FROM agent_sessions WHERE id = ?
    `);
    
    const result = stmt.get(sessionId) as {
      agent_name: string;
      is_background: number;
      config_json: string;
      system_prompt: string | null;
      ui_mode: string;
    } | undefined;
    
    stmt.finalize();
    
    if (!result) return null;
    
    return {
      agentName: result.agent_name,
      isBackground: result.is_background === 1,
      config: JSON.parse(result.config_json),
      systemPrompt: result.system_prompt,
      uiMode: result.ui_mode || 'chat',
    };
  }
  
  async saveHistory(sessionId: string, history: Chunk[]): Promise<void> {
    // Clear existing chunks for this session before saving new ones
    const deleteStmt = this.db.prepare(`DELETE FROM session_chunks WHERE session_id = ?`);
    deleteStmt.run(sessionId);
    deleteStmt.finalize();
    
    const insertStmt = this.db.prepare(`
      INSERT INTO session_chunks (id, session_id, chunk_json, created_at)
      VALUES (?, ?, ?, ?)
    `);
    
    for (const chunk of history) {
      // ===== BINARY DATA HANDLING =====
      // SQLite JSON storage cannot handle Uint8Array directly.
      // Convert binary content to Base64 string for JSON serialization.
      // The _isBase64 flag signals loadHistory() to restore the Uint8Array.
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
      
      const timestamp = chunk.timestamp ?? Date.now();
      if (!chunk.timestamp) {
        console.log(`[SessionStore] Chunk ${chunk.id} missing timestamp, using ${timestamp}`);
      }
      insertStmt.run(chunk.id, sessionId, safeStringify(serializedChunk), timestamp);
    }
    
    insertStmt.finalize();
    
    // Update session's updated_at timestamp
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
      
      // ===== RESTORE BINARY DATA =====
      // Check for _isBase64 flag (set during saveHistory).
      // Decode Base64 string back to Uint8Array for binary chunks.
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
  
  async listAllSessions(): Promise<Array<{ id: string; agentName: string; isBackground: boolean; updatedAt: number; uiMode: string }>> {
    const stmt = this.db.prepare(`
      SELECT id, agent_name, is_background, updated_at, ui_mode FROM agent_sessions
      ORDER BY updated_at DESC
    `);
    
    const results = stmt.all() as { id: string; agent_name: string; is_background: number; updated_at: number; ui_mode: string }[];
    stmt.finalize();
    
    return results.map(r => ({
      id: r.id,
      agentName: r.agent_name,
      isBackground: r.is_background === 1,
      updatedAt: r.updated_at,
      uiMode: r.ui_mode || 'chat',
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
  
  async getBackgroundSessionByAgentName(agentName: string): Promise<{ id: string; config: SessionConfig; systemPrompt: string | null; uiMode: string } | null> {
    const stmt = this.db.prepare(`
      SELECT id, config_json, system_prompt, ui_mode FROM agent_sessions
      WHERE agent_name = ? AND is_background = 1
    `);
    
    const result = stmt.get(agentName) as {
      id: string;
      config_json: string;
      system_prompt: string | null;
      ui_mode: string;
    } | undefined;
    
    stmt.finalize();
    
    if (!result) return null;
    
    return {
      id: result.id,
      config: JSON.parse(result.config_json),
      systemPrompt: result.system_prompt,
      uiMode: result.ui_mode || 'chat',
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
  
  async setSessionUIMode(sessionId: string, uiMode: string): Promise<void> {
    const stmt = this.db.prepare(`UPDATE agent_sessions SET ui_mode = ?, updated_at = ? WHERE id = ?`);
    stmt.run(uiMode, Date.now(), sessionId);
    stmt.finalize();
  }
}
