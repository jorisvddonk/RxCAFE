/**
 * RXCAFE Client Trust System
 * SQLite-based client authentication using bun:sqlite
 */

import { Database } from 'bun:sqlite';
import { randomBytes, createHash } from 'crypto';
import { join } from 'path';

export interface TrustDBConfig {
  dbPath: string;
}

export interface TrustedClient {
  id: number;
  token: string;
  description?: string;
  createdAt: number;
  lastUsedAt?: number;
  useCount: number;
}

export class TrustDatabase {
  private db: Database;
  private dbPath: string;

  constructor(dbPath: string = './rxcafe-trust.db') {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.initializeSchema();
  }

  private initializeSchema(): void {
    // Create trusted_clients table (for API auth)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS trusted_clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT UNIQUE NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        description TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        use_count INTEGER DEFAULT 0
      )
    `);

    // Create index on token_hash for faster lookups
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_token_hash ON trusted_clients(token_hash)
    `);

    // Create trusted_telegram_users table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS trusted_telegram_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id INTEGER UNIQUE,
        username TEXT UNIQUE,
        first_name TEXT,
        description TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        use_count INTEGER DEFAULT 0
      )
    `);

    // Create indexes for faster lookups
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_telegram_user_id ON trusted_telegram_users(telegram_user_id)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_telegram_username ON trusted_telegram_users(username)
    `);
  }

  /**
   * Generate a new random token
   */
  static generateToken(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Hash a token for storage
   */
  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Add a new trusted client
   * Returns the token (which cannot be retrieved later)
   */
  addClient(description?: string): string {
    const token = TrustDatabase.generateToken();
    const tokenHash = TrustDatabase.hashToken(token);
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO trusted_clients (token, token_hash, description, created_at)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(token, tokenHash, description || null, now);
    stmt.finalize();

    return token;
  }

  /**
   * Check if a token is trusted and update usage stats
   */
  verifyToken(token: string): boolean {
    const tokenHash = TrustDatabase.hashToken(token);
    const now = Date.now();

    // First check if token exists
    const checkStmt = this.db.prepare(`
      SELECT id FROM trusted_clients WHERE token_hash = ?
    `);
    const exists = checkStmt.get(tokenHash) as { id: number } | undefined;
    checkStmt.finalize();

    if (!exists) {
      return false;
    }

    // Update usage stats
    const updateStmt = this.db.prepare(`
      UPDATE trusted_clients
      SET last_used_at = ?, use_count = use_count + 1
      WHERE token_hash = ?
    `);
    updateStmt.run(now, tokenHash);
    updateStmt.finalize();

    return true;
  }

  /**
   * Check if a token is trusted without updating stats (for checks only)
   */
  isTokenTrusted(token: string): boolean {
    const tokenHash = TrustDatabase.hashToken(token);

    const stmt = this.db.prepare(`
      SELECT id FROM trusted_clients WHERE token_hash = ?
    `);

    const result = stmt.get(tokenHash) as { id: number } | undefined;
    stmt.finalize();

    return !!result;
  }

  /**
   * Get all trusted clients (without tokens, only metadata)
   */
  listClients(): Omit<TrustedClient, 'token'>[] {
    const stmt = this.db.prepare(`
      SELECT 
        id,
        description,
        created_at as createdAt,
        last_used_at as lastUsedAt,
        use_count as useCount
      FROM trusted_clients
      ORDER BY created_at DESC
    `);

    const results = stmt.all() as Omit<TrustedClient, 'token'>[];
    stmt.finalize();

    return results;
  }

  /**
   * Get a token by description (for retrieving web interface token)
   */
  getTokenByDescription(description: string): string | null {
    const stmt = this.db.prepare(`
      SELECT token FROM trusted_clients WHERE description = ?
    `);
    const result = stmt.get(description) as { token: string } | undefined;
    stmt.finalize();
    return result?.token || null;
  }

  /**
   * Remove a trusted client by ID
   */
  removeClient(id: number): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM trusted_clients WHERE id = ?
    `);

    const result = stmt.run(id);
    stmt.finalize();

    return result.changes > 0;
  }

  /**
   * Remove a trusted client by token
   */
  removeClientByToken(token: string): boolean {
    const tokenHash = TrustDatabase.hashToken(token);
    const stmt = this.db.prepare(`
      DELETE FROM trusted_clients WHERE token_hash = ?
    `);

    const result = stmt.run(tokenHash);
    stmt.finalize();

    return result.changes > 0;
  }

  /**
   * Check if any trusted clients exist
   */
  hasTrustedClients(): boolean {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM trusted_clients
    `);

    const result = stmt.get() as { count: number };
    stmt.finalize();

    return result.count > 0;
  }

  /**
   * Get count of trusted clients
   */
  getClientCount(): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM trusted_clients
    `);

    const result = stmt.get() as { count: number };
    stmt.finalize();

    return result.count;
  }

  // =============================================================================
  // Telegram User Trust Methods
  // =============================================================================

  /**
   * Add a trusted Telegram user by user ID
   */
  trustTelegramUser(userId: number, username?: string, firstName?: string, description?: string): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO trusted_telegram_users 
      (telegram_user_id, username, first_name, description, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(userId, username || null, firstName || null, description || null, now);
    stmt.finalize();
  }

  /**
   * Add a trusted Telegram user by username
   */
  trustTelegramUsername(username: string, description?: string): void {
    const now = Date.now();
    // Normalize username (remove @ if present)
    const normalizedUsername = username.startsWith('@') ? username.slice(1) : username;
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO trusted_telegram_users 
      (username, description, created_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(normalizedUsername, description || null, now);
    stmt.finalize();
  }

  /**
   * Remove a trusted Telegram user by user ID
   */
  untrustTelegramUser(userId: number): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM trusted_telegram_users WHERE telegram_user_id = ?
    `);
    const result = stmt.run(userId);
    stmt.finalize();
    return result.changes > 0;
  }

  /**
   * Remove a trusted Telegram user by username
   */
  untrustTelegramUsername(username: string): boolean {
    const normalizedUsername = username.startsWith('@') ? username.slice(1) : username;
    const stmt = this.db.prepare(`
      DELETE FROM trusted_telegram_users WHERE username = ?
    `);
    const result = stmt.run(normalizedUsername);
    stmt.finalize();
    return result.changes > 0;
  }

  /**
   * Check if a Telegram user is trusted (by user ID or username)
   */
  isTelegramUserTrusted(userId: number, username?: string): boolean {
    const now = Date.now();
    
    // Check by user ID
    const idStmt = this.db.prepare(`
      SELECT id FROM trusted_telegram_users WHERE telegram_user_id = ?
    `);
    const idResult = idStmt.get(userId) as { id: number } | undefined;
    idStmt.finalize();
    
    if (idResult) {
      // Update usage stats
      const updateStmt = this.db.prepare(`
        UPDATE trusted_telegram_users 
        SET last_used_at = ?, use_count = use_count + 1 
        WHERE telegram_user_id = ?
      `);
      updateStmt.run(now, userId);
      updateStmt.finalize();
      return true;
    }
    
    // Check by username if provided
    if (username) {
      const normalizedUsername = username.startsWith('@') ? username.slice(1) : username;
      const userStmt = this.db.prepare(`
        SELECT id FROM trusted_telegram_users WHERE username = ?
      `);
      const userResult = userStmt.get(normalizedUsername) as { id: number } | undefined;
      userStmt.finalize();
      
      if (userResult) {
        // Update usage stats and associate user ID with this username
        const updateStmt = this.db.prepare(`
          UPDATE trusted_telegram_users 
          SET last_used_at = ?, use_count = use_count + 1, telegram_user_id = ?
          WHERE username = ?
        `);
        updateStmt.run(now, userId, normalizedUsername);
        updateStmt.finalize();
        return true;
      }
    }
    
    return false;
  }

  /**
   * Check if any Telegram users are trusted (returns count)
   */
  hasTrustedTelegramUsers(): boolean {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM trusted_telegram_users
    `);
    const result = stmt.get() as { count: number };
    stmt.finalize();
    return result.count > 0;
  }

  /**
   * Get count of trusted Telegram users
   */
  getTelegramUserCount(): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM trusted_telegram_users
    `);
    const result = stmt.get() as { count: number };
    stmt.finalize();
    return result.count;
  }

  /**
   * List all trusted Telegram users
   */
  listTrustedTelegramUsers(): Array<{
    id: number;
    telegramUserId: number | null;
    username: string | null;
    firstName: string | null;
    description: string | null;
    createdAt: number;
    lastUsedAt: number | null;
    useCount: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT 
        id,
        telegram_user_id as telegramUserId,
        username,
        first_name as firstName,
        description,
        created_at as createdAt,
        last_used_at as lastUsedAt,
        use_count as useCount
      FROM trusted_telegram_users
      ORDER BY created_at DESC
    `);
    const results = stmt.all() as any[];
    stmt.finalize();
    return results;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Extract client token from request
 * Checks Authorization header first, then query param
 */
export function extractClientToken(request: Request): string | null {
  // Check Authorization header (Bearer token)
  const authHeader = request.headers.get('Authorization');
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1];
    }
  }

  // Check query parameter
  const url = new URL(request.url);
  const tokenParam = url.searchParams.get('token');
  if (tokenParam) {
    return tokenParam;
  }

  return null;
}

/**
 * Format a token for display (show only first and last 8 chars)
 */
export function maskToken(token: string): string {
  if (token.length <= 16) {
    return token.slice(0, 4) + '...' + token.slice(-4);
  }
  return token.slice(0, 8) + '...' + token.slice(-8);
}
