/**
 * Anki Card Store
 * SQLite persistence for flashcard sets
 */

import { Database } from 'bun:sqlite';

export interface AnkiCard {
  id: number;
  setId: number;
  front: string;
  back: string;
  ease: number;
  interval: number;
  due: number;
  reviews: number;
  createdAt: number;
}

export interface AnkiSet {
  id: number;
  name: string;
  description: string | null;
  cardCount: number;
  dueCount: number;
  createdAt: number;
}

export class AnkiStore {
  private db: Database;
  
  constructor(db: Database) {
    this.db = db;
    this.initializeSchema();
  }
  
  private initializeSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS anki_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    
    this.db.run(`
      CREATE TABLE IF NOT EXISTS anki_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        set_id INTEGER NOT NULL,
        front TEXT NOT NULL,
        back TEXT NOT NULL,
        ease REAL NOT NULL DEFAULT 2.5,
        interval INTEGER NOT NULL DEFAULT 0,
        due INTEGER NOT NULL,
        reviews INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (set_id) REFERENCES anki_sets(id) ON DELETE CASCADE
      )
    `);
    
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_anki_cards_set_id ON anki_cards(set_id)
    `);
    
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_anki_cards_due ON anki_cards(due)
    `);
  }
  
  async createSet(name: string, description?: string): Promise<number> {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO anki_sets (name, description, created_at)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(name, description || null, now);
    stmt.finalize();
    return result.lastInsertRowid as number;
  }
  
  async listSets(): Promise<AnkiSet[]> {
    const now = Date.now();
    const stmt = this.db.prepare(`
      SELECT 
        s.id, s.name, s.description, s.created_at as createdAt,
        COUNT(c.id) as cardCount,
        SUM(CASE WHEN c.due <= ? THEN 1 ELSE 0 END) as dueCount
      FROM anki_sets s
      LEFT JOIN anki_cards c ON c.set_id = s.id
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `);
    const results = stmt.all(now) as any[];
    stmt.finalize();
    return results.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      cardCount: r.cardCount || 0,
      dueCount: r.dueCount || 0,
      createdAt: r.createdAt
    }));
  }
  
  async getSet(setId: number): Promise<AnkiSet | null> {
    const now = Date.now();
    const stmt = this.db.prepare(`
      SELECT 
        s.id, s.name, s.description, s.created_at as createdAt,
        COUNT(c.id) as cardCount,
        SUM(CASE WHEN c.due <= ? THEN 1 ELSE 0 END) as dueCount
      FROM anki_sets s
      LEFT JOIN anki_cards c ON c.set_id = s.id
      WHERE s.id = ?
      GROUP BY s.id
    `);
    const result = stmt.get(now, setId) as any;
    stmt.finalize();
    if (!result) return null;
    return {
      id: result.id,
      name: result.name,
      description: result.description,
      cardCount: result.cardCount || 0,
      dueCount: result.dueCount || 0,
      createdAt: result.createdAt
    };
  }
  
  async getSetByName(name: string): Promise<AnkiSet | null> {
    const now = Date.now();
    const stmt = this.db.prepare(`
      SELECT 
        s.id, s.name, s.description, s.created_at as createdAt,
        COUNT(c.id) as cardCount,
        SUM(CASE WHEN c.due <= ? THEN 1 ELSE 0 END) as dueCount
      FROM anki_sets s
      LEFT JOIN anki_cards c ON c.set_id = s.id
      WHERE s.name = ?
      GROUP BY s.id
    `);
    const result = stmt.get(now, name) as any;
    stmt.finalize();
    if (!result) return null;
    return {
      id: result.id,
      name: result.name,
      description: result.description,
      cardCount: result.cardCount || 0,
      dueCount: result.dueCount || 0,
      createdAt: result.createdAt
    };
  }
  
  async deleteSet(setId: number): Promise<boolean> {
    const stmt = this.db.prepare(`DELETE FROM anki_sets WHERE id = ?`);
    const result = stmt.run(setId);
    stmt.finalize();
    return result.changes > 0;
  }
  
  async addCard(setId: number, front: string, back: string): Promise<number> {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO anki_cards (set_id, front, back, ease, interval, due, reviews, created_at)
      VALUES (?, ?, ?, 2.5, 0, ?, 0, ?)
    `);
    const result = stmt.run(setId, front, back, now, now);
    stmt.finalize();
    return result.lastInsertRowid as number;
  }
  
  async addCards(setId: number, cards: Array<{ front: string; back: string }>): Promise<number> {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO anki_cards (set_id, front, back, ease, interval, due, reviews, created_at)
      VALUES (?, ?, ?, 2.5, 0, ?, 0, ?)
    `);
    
    let count = 0;
    for (const card of cards) {
      stmt.run(setId, card.front, card.back, now, now);
      count++;
    }
    stmt.finalize();
    return count;
  }
  
  async getCard(cardId: number): Promise<AnkiCard | null> {
    const stmt = this.db.prepare(`
      SELECT id, set_id as setId, front, back, ease, interval, due, reviews, created_at as createdAt
      FROM anki_cards WHERE id = ?
    `);
    const result = stmt.get(cardId) as any;
    stmt.finalize();
    return result || null;
  }
  
  async getDueCards(setId?: number, limit?: number): Promise<AnkiCard[]> {
    const now = Date.now();
    let sql = `
      SELECT id, set_id as setId, front, back, ease, interval, due, reviews, created_at as createdAt
      FROM anki_cards WHERE due <= ?
    `;
    const params: any[] = [now];
    
    if (setId !== undefined) {
      sql += ` AND set_id = ?`;
      params.push(setId);
    }
    
    sql += ` ORDER BY due ASC`;
    
    if (limit) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }
    
    const stmt = this.db.prepare(sql);
    const results = stmt.all(...params) as AnkiCard[];
    stmt.finalize();
    return results;
  }
  
  async updateCard(cardId: number, updates: { ease?: number; interval?: number; due?: number; reviews?: number }): Promise<void> {
    const setClauses: string[] = [];
    const params: any[] = [];
    
    if (updates.ease !== undefined) {
      setClauses.push('ease = ?');
      params.push(updates.ease);
    }
    if (updates.interval !== undefined) {
      setClauses.push('interval = ?');
      params.push(updates.interval);
    }
    if (updates.due !== undefined) {
      setClauses.push('due = ?');
      params.push(updates.due);
    }
    if (updates.reviews !== undefined) {
      setClauses.push('reviews = ?');
      params.push(updates.reviews);
    }
    
    if (setClauses.length === 0) return;
    
    params.push(cardId);
    const stmt = this.db.prepare(`UPDATE anki_cards SET ${setClauses.join(', ')} WHERE id = ?`);
    stmt.run(...params);
    stmt.finalize();
  }
  
  async deleteCard(cardId: number): Promise<boolean> {
    const stmt = this.db.prepare(`DELETE FROM anki_cards WHERE id = ?`);
    const result = stmt.run(cardId);
    stmt.finalize();
    return result.changes > 0;
  }
  
  async deleteCardsBySet(setId: number): Promise<number> {
    const stmt = this.db.prepare(`DELETE FROM anki_cards WHERE set_id = ?`);
    const result = stmt.run(setId);
    stmt.finalize();
    return result.changes;
  }
  
  async getCardsBySet(setId: number): Promise<AnkiCard[]> {
    const stmt = this.db.prepare(`
      SELECT id, set_id as setId, front, back, ease, interval, due, reviews, created_at as createdAt
      FROM anki_cards WHERE set_id = ? ORDER BY created_at ASC
    `);
    const results = stmt.all(setId) as AnkiCard[];
    stmt.finalize();
    return results;
  }
  
  async getCardCount(setId?: number): Promise<number> {
    let sql = `SELECT COUNT(*) as count FROM anki_cards`;
    const params: any[] = [];
    
    if (setId !== undefined) {
      sql += ` WHERE set_id = ?`;
      params.push(setId);
    }
    
    const stmt = this.db.prepare(sql);
    const result = stmt.get(...params) as { count: number };
    stmt.finalize();
    return result.count;
  }
  
  async getDueCount(setId?: number): Promise<number> {
    const now = Date.now();
    let sql = `SELECT COUNT(*) as count FROM anki_cards WHERE due <= ?`;
    const params: any[] = [now];
    
    if (setId !== undefined) {
      sql += ` AND set_id = ?`;
      params.push(setId);
    }
    
    const stmt = this.db.prepare(sql);
    const result = stmt.get(...params) as { count: number };
    stmt.finalize();
    return result.count;
  }
}
