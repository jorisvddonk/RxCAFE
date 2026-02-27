/**
 * ObservableCAFE Chat Application
 * Main entry point - HTTP server with API and frontend
 * 
 * This file wires together:
 * - Core business logic (from core.ts)
 * - HTTP server for API and frontend
 * - Telegram bot integration
 * - Client trust system with SQLite
 * 
 * Usage:
 *   bun start                                          # Start server
 *   bun start -- --trust <token>                       # Trust a new API client
 *   bun start -- --list-clients                        # List trusted API clients
 *   bun start -- --revoke <id>                         # Revoke a trusted API client
 *   bun start -- --trust-telegram <id_or_username>     # Trust a Telegram user
 *   bun start -- --untrust-telegram <id_or_username>   # Untrust a Telegram user
 *   bun start -- --list-telegram-users                 # List trusted Telegram users
 */

import { serve } from 'bun';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  createTextChunk,
  createNullChunk,
  type Chunk
} from './lib/chunk.js';
import { connectedAgentStore, type ConnectedAgent } from './lib/connected-agents.js';
import {
  getDefaultConfig,
  createSession,
  getSession,
  getAgent,
  fetchWebContent,
  toggleChunkTrust,
  addChunkToSession,
  listModels,
  processChatMessage,
  abortGeneration,
  loadAgentsFromDisk,
  startBackgroundAgents,
  restorePersistedSessions,
  listAgents as listAgentsFromCore,
  listActiveSessions,
  deleteSession,
  setSessionStore,
  setCoreConfig,
  shutdown,
  type CoreConfig,
  type Session,
  type AddChunkOptions,
  type CreateSessionOptions
} from './core.js';
import { TelegramBot, TelegramUser, TelegramConfig } from './lib/telegram.js';
import { Database, extractClientToken, maskToken } from './lib/database.js';
import { SessionStore } from './lib/session-store.js';
import type { LLMParams, RuntimeSessionConfig } from './lib/agent.js';
import { validateConfigAgainstSchema } from './lib/agent.js';
import { Subscription } from './lib/stream.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// =============================================================================
// CLI Argument Parsing
// =============================================================================

const args = process.argv.slice(2);

// Handle --trust command (add new client)
const trustIndex = args.indexOf('--trust');
if (trustIndex !== -1 && args[trustIndex + 1]) {
  const token = args[trustIndex + 1];
  const db = new Database();
  
  if (db.isTokenTrusted(token)) {
    console.log('❌ This token is already trusted');
    db.close();
    process.exit(1);
  }
  
  const description = args[trustIndex + 2] && !args[trustIndex + 2].startsWith('--') 
    ? args[trustIndex + 2] 
    : undefined;
  
  db.addClient(description);
  console.log('✅ Client trusted successfully');
  console.log(`Token: ${maskToken(token)}`);
  if (description) {
    console.log(`Description: ${description}`);
  }
  db.close();
  process.exit(0);
}

// Handle --generate-token command
if (args.includes('--generate-token')) {
  const db = new Database();
  const isAdmin = args.includes('--admin');
  const description = args[args.indexOf('--generate-token') + 1] && !args[args.indexOf('--generate-token') + 1].startsWith('--')
    ? args[args.indexOf('--generate-token') + 1]
    : undefined;
  
  const token = db.addClientWithAdmin(description, isAdmin);
  console.log('✅ New client token generated and trusted');
  console.log(`Token: ${token}`);
  console.log('');
  console.log('Share this token with the client. They should use it as:');
  console.log('  - Authorization: Bearer <token> header');
  console.log('  - Or ?token=<token> query parameter');
  if (description) {
    console.log(`Description: ${description}`);
  }
  if (isAdmin) {
    console.log('Admin: YES - This token has administrative privileges');
  }
  db.close();
  process.exit(0);
}

// Handle --list-clients command
if (args.includes('--list-clients')) {
  const db = new Database();
  const clients = db.listClients();
  
  if (clients.length === 0) {
    console.log('No trusted clients found.');
  } else {
    console.log(`Trusted clients (${clients.length}):`);
    console.log('');
    console.log('ID  | Admin | Description          | Created            | Last Used          | Uses');
    console.log('----|-------|----------------------|--------------------|--------------------|------');
    
    for (const client of clients) {
      const admin = client.isAdmin ? '  ✓  ' : '     ';
      const desc = (client.description || '').slice(0, 20).padEnd(20);
      const created = new Date(client.createdAt).toLocaleString().slice(0, 18).padEnd(18);
      const lastUsed = client.lastUsedAt 
        ? new Date(client.lastUsedAt).toLocaleString().slice(0, 18).padEnd(18)
        : 'Never'.padEnd(18);
      const uses = client.useCount.toString().padStart(5);
      
      console.log(`${client.id.toString().padStart(3)} | ${admin} | ${desc} | ${created} | ${lastUsed} | ${uses}`);
    }
  }
  
  db.close();
  process.exit(0);
}

// Handle --token-admin command
const tokenAdminIndex = args.indexOf('--token-admin');
if (tokenAdminIndex !== -1 && args[tokenAdminIndex + 1]) {
  const id = parseInt(args[tokenAdminIndex + 1]);
  if (isNaN(id)) {
    console.log('❌ Invalid client ID');
    process.exit(1);
  }
  
  const db = new Database();
  const client = db.getClientById(id);
  
  if (!client) {
    console.log(`❌ Client ${id} not found`);
    db.close();
    process.exit(1);
  }
  
  const newAdminStatus = !client.isAdmin;
  const success = db.setAdminStatus(id, newAdminStatus);
  
  if (success) {
    console.log(`✅ Client ${id} admin status: ${newAdminStatus ? 'ENABLED' : 'DISABLED'}`);
    if (client.description) {
      console.log(`Description: ${client.description}`);
    }
  } else {
    console.log(`❌ Failed to update client ${id}`);
  }
  
  db.close();
  process.exit(success ? 0 : 1);
}

// Handle --revoke command
const revokeIndex = args.indexOf('--revoke');
if (revokeIndex !== -1 && args[revokeIndex + 1]) {
  const id = parseInt(args[revokeIndex + 1]);
  if (isNaN(id)) {
    console.log('❌ Invalid client ID');
    process.exit(1);
  }
  
  const db = new Database();
  const success = db.removeClient(id);
  
  if (success) {
    console.log(`✅ Client ${id} revoked successfully`);
  } else {
    console.log(`❌ Client ${id} not found`);
  }
  
  db.close();
  process.exit(success ? 0 : 1);
}

// Handle --trust-telegram command
const trustTelegramIndex = args.indexOf('--trust-telegram');
if (trustTelegramIndex !== -1 && args[trustTelegramIndex + 1]) {
  const identifier = args[trustTelegramIndex + 1];
  const description = args[trustTelegramIndex + 2] && !args[trustTelegramIndex + 2].startsWith('--') 
    ? args[trustTelegramIndex + 2] 
    : undefined;
  
  const db = new Database();
  
  // Check if it's a user ID (numeric) or username
  const userId = parseInt(identifier);
  if (!isNaN(userId)) {
    db.trustTelegramUser(userId, undefined, undefined, description);
    console.log(`✅ Trusted Telegram user ID: ${userId}`);
  } else {
    // Treat as username
    db.trustTelegramUsername(identifier, description);
    console.log(`✅ Trusted Telegram username: ${identifier}`);
  }
  
  if (description) {
    console.log(`Description: ${description}`);
  }
  
  db.close();
  process.exit(0);
}

// Handle --untrust-telegram command
const untrustTelegramIndex = args.indexOf('--untrust-telegram');
if (untrustTelegramIndex !== -1 && args[untrustTelegramIndex + 1]) {
  const identifier = args[untrustTelegramIndex + 1];
  
  const db = new Database();
  
  // Check if it's a user ID (numeric) or username
  const userId = parseInt(identifier);
  let success: boolean;
  
  if (!isNaN(userId)) {
    success = db.untrustTelegramUser(userId);
    if (success) {
      console.log(`✅ Untrusted Telegram user ID: ${userId}`);
    } else {
      console.log(`❌ Telegram user ID ${userId} not found`);
    }
  } else {
    success = db.untrustTelegramUsername(identifier);
    if (success) {
      console.log(`✅ Untrusted Telegram username: ${identifier}`);
    } else {
      console.log(`❌ Telegram username ${identifier} not found`);
    }
  }
  
  db.close();
  process.exit(success ? 0 : 1);
}

// Handle --list-telegram-users command
if (args.includes('--list-telegram-users')) {
  const db = new Database();
  const users = db.listTrustedTelegramUsers();
  
  if (users.length === 0) {
    console.log('No trusted Telegram users found.');
  } else {
    console.log(`Trusted Telegram users (${users.length}):`);
    console.log('');
    console.log('ID  | User ID    | Username             | First Name           | Created            | Uses');
    console.log('----|------------|----------------------|----------------------|--------------------|------');
    
    for (const user of users) {
      const userId = (user.telegramUserId?.toString() || 'N/A').padEnd(10);
      const username = (user.username || 'N/A').padEnd(20);
      const firstName = (user.firstName || 'N/A').padEnd(20);
      const created = new Date(user.createdAt).toLocaleString().slice(0, 18).padEnd(18);
      const uses = user.useCount.toString().padStart(5);
      
      console.log(`${user.id.toString().padStart(3)} | ${userId} | ${username} | ${firstName} | ${created} | ${uses}`);
    }
  }
  
  db.close();
  process.exit(0);
}

// =============================================================================
// Configuration
// =============================================================================

const config: CoreConfig = getDefaultConfig();
setCoreConfig(config);

const PORT = parseInt(process.env.PORT || '3000');
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL;
const TRUST_DB_PATH = process.env.TRUST_DB_PATH || './rxcafe-trust.db';

// Initialize trust database
const trustDb = new Database(TRUST_DB_PATH);

// Initialize connected agents store
connectedAgentStore.setTrustDatabase(trustDb);

// Initialize session store
const sessionStore = new SessionStore(trustDb.getDatabase());
setSessionStore(sessionStore);

console.log(`RXCAFE Chat Server`);
console.log(`Backend: ${config.backend}`);
console.log(`KoboldCPP URL: ${config.koboldBaseUrl}`);
console.log(`Ollama URL: ${config.ollamaBaseUrl}`);
console.log(`Ollama Model: ${config.ollamaModel}`);
console.log(`Port: ${PORT}`);
console.log(`Tracing: ${config.tracing ? 'ENABLED' : 'disabled'}`);
console.log(`Telegram: ${TELEGRAM_TOKEN ? 'ENABLED' : 'disabled'}`);
console.log(`Trust DB: ${TRUST_DB_PATH}`);
console.log(`Trusted API clients: ${trustDb.getClientCount()}`);
console.log(`Trusted Telegram users: ${trustDb.getTelegramUserCount()}`);

// Check if we have any trusted API clients
const hasTrustedClients = trustDb.hasTrustedClients();
if (!hasTrustedClients) {
  console.log('');
  console.log('🔒 No trusted API clients configured - ALL API CLIENTS WILL BE BLOCKED');
  console.log('   Run: bun start -- --generate-token [description]');
  console.log('');
}

// Check Telegram trust status
const hasTrustedTelegramUsers = trustDb.hasTrustedTelegramUsers();
if (TELEGRAM_TOKEN && !hasTrustedTelegramUsers) {
  console.log('');
  console.log('🔒 No trusted Telegram users configured - ALL TELEGRAM USERS WILL BE BLOCKED');
  console.log('   Run: bun start -- --trust-telegram <user_id_or_username> [description]');
  console.log('');
}

// Get or create web token for localhost access
function getOrCreateWebToken(): string {
  // First check for existing web token
  const existingToken = trustDb.getTokenByDescription('Web Interface');
  if (existingToken) {
    return existingToken;
  }
  // Generate new token
  return trustDb.addClient('Web Interface');
}

const webToken = getOrCreateWebToken();

// =============================================================================
// Client Trust Verification
// =============================================================================

function createUntrustedResponse(token: string | null): Response {
  const providedToken = token ? maskToken(token) : 'none';
  
  const body = {
    error: 'Unauthorized',
    message: 'This client is not trusted.',
    providedToken: providedToken,
    instructions: 'An admin needs to authorize this client by running:',
    command: token 
      ? `bun start -- --trust ${token} [description]`
      : 'bun start -- --trust <token> [description]',
    alternative: 'To generate a new token, run: bun start -- --generate-token [description]',
    hint: 'Pass the token via Authorization: Bearer <token> header or ?token=<token> query parameter'
  };
  
  return new Response(JSON.stringify(body, null, 2), {
    status: 401,
    headers: { 
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer'
    }
  });
}

function verifyClient(request: Request): { trusted: boolean; token: string | null } {
  const token = extractClientToken(request);
  
  if (!token) {
    return { trusted: false, token: null };
  }
  
  const isTrusted = trustDb.verifyToken(token);
  return { trusted: isTrusted, token };
}

function verifyAdmin(request: Request): { isAdmin: boolean; token: string | null; clientId: number | null } {
  const token = extractClientToken(request);
  
  if (!token) {
    return { isAdmin: false, token: null, clientId: null };
  }
  
  const clientId = trustDb.getClientIdByToken(token);
  if (!clientId) {
    return { isAdmin: false, token, clientId: null };
  }
  
  const isAdmin = trustDb.isAdminToken(token);
  return { isAdmin, token, clientId };
}

function createForbiddenResponse(): Response {
  return new Response(JSON.stringify({
    error: 'Forbidden',
    message: 'Admin privileges required for this operation.'
  }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' }
  });
}

function verifyAgentAuth(request: Request): { agent: ConnectedAgent } | { error: Response } {
  const apiKey = request.headers.get('X-API-Key');
  
  if (!apiKey) {
    return { error: new Response(JSON.stringify({ error: 'X-API-Key header required' }), { status: 401, headers: { 'Content-Type': 'application/json' } }) };
  }
  
  const agent = connectedAgentStore.getByApiKey(apiKey);
  
  if (!agent) {
    return { error: new Response(JSON.stringify({ error: 'Invalid API key' }), { status: 401, headers: { 'Content-Type': 'application/json' } }) };
  }
  
  return { agent };
}

// =============================================================================
// Telegram Bot Integration
// =============================================================================

// Map Telegram chat IDs to current RXCAFE session ID
const telegramCurrentSession = new Map<number, string>();

// Map Telegram chat IDs to all accessible session IDs
const telegramAllSessions = new Map<number, Set<string>>();

// Map Telegram chat IDs to their active outputStream subscriptions
// Now stores a Map of sessionId -> Subscription for each chat
const telegramSubscriptions = new Map<number, Map<string, Subscription>>();

let telegramBot: TelegramBot | null = null;

async function initTelegramBot(): Promise<void> {
  if (!TELEGRAM_TOKEN) {
    console.log('Telegram bot not configured. Set TELEGRAM_TOKEN to enable.');
    return;
  }

  const telegramConfig: TelegramConfig = {
    token: TELEGRAM_TOKEN,
    webhookUrl: TELEGRAM_WEBHOOK_URL,
    polling: !TELEGRAM_WEBHOOK_URL
  };

  telegramBot = new TelegramBot(telegramConfig);
  
  try {
    await telegramBot.init();
    
    // Handle incoming messages
    telegramBot.onMessage(async (chatId, text, user) => {
      console.log(`Telegram message from ${user.first_name} (${user.username || 'no username'}) ID:${user.id}: ${text.substring(0, 50)}...`);
      
      // Check if user is trusted
      const isTrusted = trustDb.isTelegramUserTrusted(user.id, user.username);
      if (!isTrusted) {
        console.log(`[Telegram] Untrusted user ${user.first_name} (${user.id}) blocked`);
        await telegramBot!.sendMessage(chatId, 
          `🔒 *Access Denied*\n\n` +
          `You are not authorized to use this bot.\n\n` +
          `Your Telegram ID: \`${user.id}\`\n` +
          `Username: \`${user.username || 'none'}\`\n\n` +
          `Contact the admin to get access.`, 
          { parseMode: 'Markdown' }
        );
        return;
      }
      
      // Get or create session for this chat
      let sessionId = telegramCurrentSession.get(chatId);
      if (!sessionId) {
        const defaultTelegramSessionId = 'default-telegram';
        console.log(`[Telegram] Ensuring default session exists: ${defaultTelegramSessionId}`);
        
        let session = getSession(defaultTelegramSessionId);
        
        if (!session && sessionStore) {
          // Check if it's in the store
          const sessionData = await sessionStore.loadSession(defaultTelegramSessionId);
          if (sessionData) {
            console.log(`[Telegram] Restoring default session from store`);
            session = await createSession(config, {
              agentId: sessionData.agentName,
              isBackground: sessionData.isBackground,
              sessionId: defaultTelegramSessionId,
            });
            if (session._agentContext) await session._agentContext.loadState();
          }
        }
        
        if (!session) {
          console.log(`[Telegram] Creating new default session`);
          session = await createSession(config, { 
            sessionId: defaultTelegramSessionId,
            agentId: 'default'
          });
        }
        
        sessionId = session.id;
        telegramCurrentSession.set(chatId, sessionId);
        
        if (!telegramAllSessions.has(chatId)) {
          telegramAllSessions.set(chatId, new Set());
        }
        telegramAllSessions.get(chatId)!.add(sessionId);
        
        console.log(`[Telegram] Using session ${sessionId} for chat ${chatId}`);
        await telegramBot!.sendMessage(chatId, `🤖 *RXCAFE Bot Ready*\n\nUsing session: \`default-telegram\`\nAgent: ${session.agentName}\n\nType /help for available commands.`, { parseMode: 'Markdown' });
      }
      
      const session = getSession(sessionId);
      if (!session) {
        await telegramBot!.sendMessage(chatId, '❌ Session error. Use /new to create a new session.');
        telegramCurrentSession.delete(chatId);
        return;
      }
      
      // Ensure we are listening to the session's outputStream
      ensureTelegramSubscription(chatId, session);
      
      // Handle commands
      if (text === '/start' || text.startsWith('/start ')) {
        await telegramBot!.sendMessage(chatId, `👋 Welcome to RXCAFE Chat!\n\nCurrent session: \`${sessionId}\`\nAgent: ${session.agentName}\n\nUse /help to see available commands.`, { parseMode: 'Markdown' });
        return;
      }
      
      if (text === '/help') {
        await telegramBot!.sendMessage(chatId, `*Available Commands:*

*Session Management:*
/new [agent] - Create new session
/sessions - List and switch sessions
/join <id> - Join an existing session
/subscribe <id> - Auto-receive updates from a session
/unsubscribe <id> - Stop auto-updates
/subscriptions - List auto-subscriptions
/share - Get shareable link
/id - Get current session ID
/agents - List available agents

*Chat:*
/web <URL> - Fetch web content
/system <prompt> - Set system prompt

*Current:* \`${sessionId}\`
*Agent:* ${session.agentName}`, { parseMode: 'Markdown' });
        return;
      }
      
      if (text === '/id') {
        await telegramBot!.sendMessage(chatId, `Current Session ID:\n\`${sessionId}\``, { parseMode: 'Markdown' });
        return;
      }

      if (text === '/share') {
        // We'll use the server's webToken if available, but technically anyone with the session ID can see it
        const url = `${process.env.PUBLIC_URL || 'http://localhost:' + PORT}/#${sessionId}`;
        await telegramBot!.sendMessage(chatId, `Shareable Web Link:\n${url}`, { parseMode: 'Markdown' });
        return;
      }

      if (text.startsWith('/join ')) {
        const targetId = text.slice(6).trim();
        const targetSession = getSession(targetId);
        
        if (!targetSession) {
          await telegramBot!.sendMessage(chatId, `❌ Session not found: \`${targetId}\``, { parseMode: 'Markdown' });
          return;
        }

        telegramCurrentSession.set(chatId, targetId);
        if (!telegramAllSessions.has(chatId)) {
          telegramAllSessions.set(chatId, new Set());
        }
        telegramAllSessions.get(chatId)!.add(targetId);

        await telegramBot!.sendMessage(chatId, `✅ Joined session: \`${targetId}\`\nAgent: ${targetSession.agentName}\nName: ${targetSession.displayName || 'None'}`, { parseMode: 'Markdown' });
        
        ensureTelegramSubscription(chatId, targetSession);
        return;
      }

      if (text === '/subscriptions') {
        const subs = trustDb.listTelegramSubscriptions(chatId);
        if (subs.length === 0) {
          await telegramBot!.sendMessage(chatId, 'No active auto-subscriptions.');
        } else {
          const list = subs.map(sid => `• \`${sid}\``).join('\n');
          await telegramBot!.sendMessage(chatId, `*Your Auto-Subscriptions:*\n\n${list}`, { parseMode: 'Markdown' });
        }
        return;
      }

      if (text.startsWith('/subscribe ')) {
        const targetId = text.slice(11).trim();
        trustDb.addTelegramSubscription(chatId, targetId);
        
        const targetSession = getSession(targetId);
        if (targetSession) {
          ensureTelegramSubscription(chatId, targetSession);
          await telegramBot!.sendMessage(chatId, `✅ Subscribed to \`${targetId}\`. You will now receive updates automatically.`);
        } else {
          await telegramBot!.sendMessage(chatId, `✅ Subscribed to \`${targetId}\`. Updates will start once the session is active.`);
        }
        return;
      }

      if (text.startsWith('/unsubscribe ')) {
        const targetId = text.slice(13).trim();
        const success = trustDb.removeTelegramSubscription(chatId, targetId);
        if (success) {
          // If it's not the current session, we should unsubscribe the RxJS sub
          if (sessionId !== targetId) {
            const subsMap = telegramSubscriptions.get(chatId);
            if (subsMap instanceof Map) {
              const sub = subsMap.get(targetId);
              if (sub) {
                sub.unsubscribe();
                subsMap.delete(targetId);
              }
            }
          }
          await telegramBot!.sendMessage(chatId, `✅ Unsubscribed from \`${targetId}\`.`);
        } else {
          await telegramBot!.sendMessage(chatId, `❌ Not subscribed to \`${targetId}\`.`);
        }
        return;
      }
      
      if (text === '/agents') {
        const agents = listAgentsFromCore();
        const agentList = agents.map(a => {
          const bg = a.startInBackground ? ' [background]' : '';
          return `• *${a.name}*${bg}\n  ${a.description || 'No description'}`;
        }).join('\n');
        await telegramBot!.sendMessage(chatId, `*Available Agents:*\n\n${agentList}`, { parseMode: 'Markdown' });
        return;
      }
      
      if (text === '/sessions') {
        const activeSessions = listActiveSessions();
        const allSessions = [...activeSessions];
        const seenIds = new Set(activeSessions.map(s => s.id));
        
        if (sessionStore) {
          const persisted = await sessionStore.listAllSessions();
          for (const ps of persisted) {
            if (!seenIds.has(ps.id)) {
              allSessions.push({
                id: ps.id,
                agentName: ps.agentName,
                isBackground: ps.isBackground,
                displayName: ps.id === ps.agentName ? ps.agentName : undefined
              });
            }
          }
        }

        if (allSessions.length === 0) {
          await telegramBot!.sendMessage(chatId, 'No sessions found. Use /new to create one.');
          return;
        }
        
        const buttons = allSessions.map(s => {
          const name = s.displayName || s.agentName;
          const current = s.id === sessionId ? '✓ ' : '';
          const bg = s.isBackground ? ' ⚙️' : '';
          return [{ text: `${current}${name}${bg}`, callback_data: `switch:${s.id}` }];
        }) as any[][];
        
        await telegramBot!.sendMessage(chatId, `*All Available Sessions:*\nSelect a session to switch:`, { 
          parseMode: 'Markdown',
          replyMarkup: { inline_keyboard: buttons }
        });
        return;
      }
      
      if (text.startsWith('/switch ')) {
        const targetSessionId = text.slice(8).trim();
        await switchTelegramSession(chatId, targetSessionId);
        return;
      }
      
      if (text === '/new' || text.startsWith('/new ')) {
        const agentName = text.slice(4).trim() || 'default';
        console.log(`[Telegram] Creating new session for chat ${chatId} with agent ${agentName}`);
        
        try {
          const newSession = await createSession(config, { agentId: agentName });
          
          if (!telegramAllSessions.has(chatId)) {
            telegramAllSessions.set(chatId, new Set());
          }
          telegramAllSessions.get(chatId)!.add(newSession.id);
          telegramCurrentSession.set(chatId, newSession.id);
          
          await telegramBot!.sendMessage(chatId, `✅ New session created\n\nSession: \`${newSession.id}\`\nAgent: ${newSession.agentName}`, { parseMode: 'Markdown' });
        } catch (err) {
          await telegramBot!.sendMessage(chatId, `❌ Failed to create session: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
        return;
      }
      
      if (text.startsWith('/web ')) {
        const url = text.slice(5).trim();
        await handleTelegramWebCommand(chatId, session, url);
        return;
      }
      
      if (text.startsWith('/system ')) {
        const prompt = text.slice(8).trim();
        handleTelegramSystemCommand(chatId, session, prompt);
        return;
      }
      
      // Regular message - process through LLM
      await handleTelegramMessage(chatId, session, text);
    });
    
    // Handle callback queries (trust buttons and session switcher)
    telegramBot.onCallback(async (chatId, data, user, callbackId) => {
      if (data.startsWith('trust:')) {
        const parts = data.split(':');
        const chunkId = parts[1];
        const trusted = parts[2] === 'true';
        
        const sessionId = telegramCurrentSession.get(chatId);
        if (!sessionId) return;
        
        const session = getSession(sessionId);
        if (!session) return;
        
        const result = toggleChunkTrust(session, chunkId, trusted);
        
        if (result) {
          await telegramBot!.answerCallback(callbackId, trusted ? '✅ Trusted' : '❌ Untrusted');
          await telegramBot!.sendMessage(chatId, trusted ? '✅ Chunk trusted and added to LLM context' : '❌ Chunk untrusted');
        }
      } else if (data.startsWith('switch:')) {
        const targetSessionId = data.split(':')[1];
        await telegramBot!.answerCallback(callbackId, '🔄 Switching...');
        await switchTelegramSession(chatId, targetSessionId);
      }
    });
    
  } catch (error) {
    console.error('Failed to initialize Telegram bot:', error);
    telegramBot = null;
  }
}

async function handleTelegramWebCommand(chatId: number, session: Session, url: string): Promise<void> {
  if (!telegramBot) return;
  
  await telegramBot.sendMessage(chatId, `🌐 Fetching ${url}...`);
  
  try {
    const chunk = await fetchWebContent(url);
    session.inputStream.next(chunk);
    
    // Store chunk info for trust buttons
    const isTrusted = chunk.annotations?.['security.trust-level']?.trusted === true;
    const messageText = `🌐 *Web Content Fetched*\n\nSource: ${url}\nStatus: ${isTrusted ? '✅ Trusted' : '⚠️ Untrusted'}\n\n${(chunk.content as string).substring(0, 500)}${(chunk.content as string).length > 500 ? '...' : ''}`;
    
    if (!isTrusted) {
      // Send with trust buttons
      await telegramBot.sendMessage(chatId, messageText, {
        parseMode: 'Markdown',
        replyMarkup: telegramBot.createTrustKeyboard(chunk.id)
      });
    } else {
      await telegramBot.sendMessage(chatId, messageText, { parseMode: 'Markdown' });
    }
    
  } catch (error) {
    await telegramBot.sendMessage(chatId, `❌ Failed to fetch URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

function handleTelegramSystemCommand(chatId: number, session: Session, prompt: string): void {
  if (!telegramBot) return;
  
  addChunkToSession(session, {
    content: prompt,
    producer: 'com.rxcafe.system-prompt',
    annotations: {
      'chat.role': 'system',
      'system.prompt': true
    }
  });
  telegramBot.sendMessage(chatId, `✅ System prompt set:\n\n\`${prompt.substring(0, 500)}${prompt.length > 500 ? '...' : ''}\``, { parseMode: 'Markdown' });
}

async function handleTelegramMessage(chatId: number, session: Session, message: string): Promise<void> {
  if (!telegramBot) return;
  
  console.log(`[Telegram] Processing message: "${message.substring(0, 50)}..."`);
  
  // Send "typing" indicator
  let statusMessage: any;
  try {
    statusMessage = await telegramBot.sendMessage(chatId, '🤔 Thinking...');
    console.log(`[Telegram] Sent status message, ID: ${statusMessage.message_id}`);
  } catch (error) {
    console.error('[Telegram] Failed to send status message:', error);
  }
  
  let fullResponse = '';
  let messageId: number | null = null;
  let tokenCount = 0;
  let lastUpdateResponse = '';
  let updateInProgress = false;
  
  try {
    console.log(`[Telegram] Starting LLM evaluation...`);
    
    const callbacks: ChatCallbacks = {
      onToken: (token: string) => {
        tokenCount++;
        fullResponse += token;
        
        // Update message every 20 characters, but only if not already updating
        // This prevents the race condition that causes duplicate messages
        if (fullResponse.length - lastUpdateResponse.length >= 20 && !updateInProgress) {
          updateInProgress = true;
          updateTelegramMessage(chatId, fullResponse, messageId).then(id => {
            if (id) messageId = id;
            lastUpdateResponse = fullResponse;
            updateInProgress = false;
          }).catch(() => {
            updateInProgress = false;
          });
        }
      },
      onFinish: async () => {
        console.log(`[Telegram] LLM evaluation complete. Tokens: ${tokenCount}, Response length: ${fullResponse.length}`);
        
        // Wait for any pending update to finish to ensure we have the correct messageId
        const start = Date.now();
        while (updateInProgress && Date.now() - start < 5000) {
          await new Promise(r => setTimeout(r, 100));
        }

        // Final message update
        finalizeTelegramMessage(chatId, fullResponse, messageId, statusMessage?.message_id);

        // Clear callbacks
        if (session.callbacks === callbacks) {
            session.callbacks = null;
            if (session._agentContext) session._agentContext.callbacks = null;
        }
      },
      onError: (error: Error) => {
        console.error('[Telegram] LLM error:', error);
        
        // Wait for any pending update to finish
        const waitAndSend = async () => {
          const start = Date.now();
          while (updateInProgress && Date.now() - start < 5000) {
            await new Promise(r => setTimeout(r, 100));
          }
          await telegramBot!.sendMessage(chatId, `❌ Error: ${error.message}`);
          
          // Delete status message if it exists
          if (statusMessageId) {
            try {
              await telegramBot!.deleteMessage(chatId, statusMessageId);
            } catch { /* ignore */ }
          }
        };

        waitAndSend();
        
        // Clear callbacks
        if (session.callbacks === callbacks) {
            session.callbacks = null;
            if (session._agentContext) session._agentContext.callbacks = null;
        }
      }
    };

    // Tag the callbacks so we know they belong to THIS telegram chat
    (callbacks as any).telegramChatId = chatId;

    await processChatMessage(
      session,
      message,
      callbacks,
      config,
      { 'client.type': 'telegram', 'telegram.chatId': chatId }
    );
    
  } catch (error) {
    console.error('[Telegram] Error processing message:', error);
    try {
      await telegramBot.sendMessage(chatId, `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } catch (sendError) {
      console.error('[Telegram] Failed to send error message:', sendError);
    }
  }
}

async function updateTelegramMessage(chatId: number, text: string, messageId: number | null): Promise<number | null> {
  if (!telegramBot) return null;
  
  try {
    if (!messageId) {
      // First update - need to send new message
      const msg = await telegramBot.sendMessage(chatId, text + ' ▌');
      return msg.message_id;
    } else {
      await telegramBot.editMessage(chatId, messageId, text + ' ▌');
      return messageId;
    }
  } catch (error) {
    console.error('[Telegram] Failed to update message:', error);
    return messageId;
  }
}

async function finalizeTelegramMessage(chatId: number, text: string, messageId: number | null, statusMessageId?: number): Promise<void> {
  if (!telegramBot) return;
  
  try {
    if (!messageId) {
      // If no updates were made and there's no text, just be silent (e.g. command handled by agent)
      if (text) {
        await telegramBot.sendMessage(chatId, text);
      }
    } else {
      // Update with final text (no cursor)
      await telegramBot.editMessage(chatId, messageId, text);
    }
    
    // Delete status message if it exists
    if (statusMessageId) {
      try {
        await telegramBot.deleteMessage(chatId, statusMessageId);
      } catch {
        // Ignore errors deleting status message
      }
    }
  } catch (error) {
    console.error('[Telegram] Failed to finalize message:', error);
  }
}

async function switchTelegramSession(chatId: number, targetSessionId: string): Promise<void> {
  if (!telegramBot) return;
  
  // Clean up transient subscription to previous session (only if not explicitly subscribed)
  const previousSessionId = telegramCurrentSession.get(chatId);
  if (previousSessionId && previousSessionId !== targetSessionId) {
    const persistentSubs = trustDb.listTelegramSubscriptions(chatId);
    if (!persistentSubs.includes(previousSessionId)) {
      const subsMap = telegramSubscriptions.get(chatId);
      if (subsMap) {
        const sub = subsMap.get(previousSessionId);
        if (sub) {
          sub.unsubscribe();
          subsMap.delete(previousSessionId);
          console.log(`[Telegram] Unsubscribed chat ${chatId} from transient session ${previousSessionId}`);
        }
      }
    }
  }
  
  let targetSession = getSession(targetSessionId);
  
  // If not active, try loading from persistence
  if (!targetSession && sessionStore) {
    const sessionData = await sessionStore.loadSession(targetSessionId);
    if (sessionData) {
      console.log(`[Telegram] Restoring session from persistence: ${targetSessionId}`);
      try {
        targetSession = await createSession(config, {
          agentId: sessionData.agentName,
          isBackground: sessionData.isBackground,
          sessionId: targetSessionId,
          ...sessionData.config,
          systemPrompt: sessionData.systemPrompt || undefined,
        });
        
        if (targetSession._agentContext) {
          await targetSession._agentContext.loadState();
        }
      } catch (err) {
        console.error(`[Telegram] Failed to restore session ${targetSessionId}:`, err);
      }
    }
  }

  if (!targetSession) {
    await telegramBot.sendMessage(chatId, `❌ Session not found or expired: \`${targetSessionId}\``, { parseMode: 'Markdown' });
    return;
  }
  
  // Add to user's list of accessible sessions
  if (!telegramAllSessions.has(chatId)) {
    telegramAllSessions.set(chatId, new Set());
  }
  telegramAllSessions.get(chatId)!.add(targetSessionId);

  telegramCurrentSession.set(chatId, targetSessionId);
  await telegramBot.sendMessage(chatId, `✅ Switched to session: \`${targetSessionId}\`\nAgent: ${targetSession.agentName}\nName: ${targetSession.displayName || 'None'}`, { parseMode: 'Markdown' });
  
  ensureTelegramSubscription(chatId, targetSession);
}

function ensureTelegramSubscription(chatId: number, session: Session) {
  let subsMap = telegramSubscriptions.get(chatId);
  if (!subsMap) {
    subsMap = new Map<string, Subscription>();
    telegramSubscriptions.set(chatId, subsMap);
  }
  
  if (subsMap.has(session.id)) {
    return;
  }

  console.log(`[Telegram] Subscribing chat ${chatId} to session ${session.id} outputStream`);

  const sub = session.outputStream.subscribe({
    next: async (chunk: Chunk) => {
      if (!telegramBot) return;
      
      // Skip user messages that originated from THIS specific Telegram chat to avoid echoing
      if (chunk.annotations['chat.role'] === 'user' && chunk.annotations['telegram.chatId'] === chatId) return;
      
      // Skip assistant tokens (they are handled via onToken callbacks during active generation)
      if (chunk.annotations['llm.stream']) return;

      if (chunk.contentType === 'binary') {
        const { data, mimeType } = chunk.content as any;
        const caption = chunk.annotations['image.description'] || chunk.annotations['audio.description'];
        
        let uint8;
        if (data instanceof Uint8Array) {
          uint8 = data;
        } else if (Array.isArray(data)) {
          uint8 = new Uint8Array(data);
        } else if (typeof data === 'object' && data !== null) {
          if (data.type === 'Buffer' && Array.isArray(data.data)) {
            uint8 = new Uint8Array(data.data);
          } else {
            uint8 = new Uint8Array(Object.values(data));
          }
        } else {
          console.error('[Telegram] Invalid binary data format', data);
          return;
        }

        try {
          if (mimeType.startsWith('image/')) {
            await telegramBot.sendPhoto(chatId, uint8, caption);
          } else if (mimeType.startsWith('audio/')) {
            await telegramBot.sendAudio(chatId, uint8, caption);
          }
        } catch (err) {
          console.error('[Telegram] Failed to send media:', err);
        }
      }
      // Handle text messages (User messages from other clients, Assistant responses, System updates, or Web content)
      else if (chunk.contentType === 'text') {
          const role = chunk.annotations['chat.role'];
          const isAssistant = role === 'assistant';
          const isUser = role === 'user';
          const isSystem = role === 'system';
          const isWeb = chunk.producer === 'com.rxcafe.web-fetch' || chunk.annotations['web.source-url'];
          
          // 1. Send User messages that originated from elsewhere (e.g. Web UI)
          if (isUser) {
              // We already filtered out 'user' chunks from THIS chat at the top of next()
              await telegramBot.sendMessage(chatId, `👤 *User:* ${chunk.content}`, { parseMode: 'Markdown' });
          }
          // 2. Send Web content (e.g. results of /web command on Web UI)
          else if (isWeb) {
              const url = chunk.annotations['web.source-url'] || 'unknown';
              await telegramBot.sendMessage(chatId, `🌐 *Web Content:* ${url}\n\n${(chunk.content as string).substring(0, 500)}...`, { parseMode: 'Markdown' });
          }
          // 3. Send System updates (e.g. /system changes from Web UI)
          else if (isSystem) {
              await telegramBot.sendMessage(chatId, `⚙️ *System:* ${chunk.content}`, { parseMode: 'Markdown' });
          }
          // 4. Send Assistant messages only if we aren't currently "streaming" them
          // via interactive callbacks (prevents doubles).
          // We check if the active callbacks belong to THIS specific Telegram chat.
          const isActiveTurnForUs = (session.callbacks as any)?.telegramChatId === chatId;
          const isStreamingProducer = chunk.producer === 'com.rxcafe.assistant';
          
          if (isAssistant && (!isActiveTurnForUs || !isStreamingProducer)) {
              await telegramBot.sendMessage(chatId, chunk.content as string);
          }
      }
    }
  });
  
  subsMap.set(session.id, sub);
}

// =============================================================================
// API Request Handlers
// =============================================================================

async function handleCreateSession(body?: any): Promise<Response> {
  try {
    const agentId = body?.agentId || 'default';
    const agent = getAgent(agentId);
    
    if (!agent) {
      return new Response(JSON.stringify({ 
        error: 'Agent not found',
        message: `No agent named '${agentId}'`
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Build runtime config from request
    const runtimeConfig: RuntimeSessionConfig = {};
    
    if (body?.backend) runtimeConfig.backend = body.backend;
    if (body?.model) runtimeConfig.model = body.model;
    if (body?.systemPrompt) runtimeConfig.systemPrompt = body.systemPrompt;
    if (body?.llmParams) runtimeConfig.llmParams = body.llmParams;
    
    // Validate config against agent's schema
    if (agent.configSchema) {
      const errors = await validateConfigAgainstSchema(runtimeConfig, agent.configSchema);
      if (errors.length > 0) {
        return new Response(JSON.stringify({ 
          error: 'Invalid configuration',
          message: 'Session configuration does not meet agent requirements',
          validationErrors: errors
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    const options: CreateSessionOptions = {
      agentId,
      runtimeConfig,
    };
    
    const session = await createSession(config, options);
    
    // Emit runtime config as a null chunk to history
    if (body?.backend || body?.model || body?.systemPrompt || body?.llmParams) {
      const annotations: Record<string, any> = {
        'config.type': 'runtime',
      };
      
      if (body.backend) annotations['config.backend'] = body.backend;
      if (body.model) annotations['config.model'] = body.model;
      if (body.systemPrompt) annotations['config.systemPrompt'] = body.systemPrompt;
      
      if (body.llmParams) {
        const llmParams = body.llmParams;
        if (llmParams.temperature !== undefined) annotations['config.llm.temperature'] = llmParams.temperature;
        if (llmParams.maxTokens !== undefined) annotations['config.llm.maxTokens'] = llmParams.maxTokens;
        if (llmParams.topP !== undefined) annotations['config.llm.topP'] = llmParams.topP;
        if (llmParams.topK !== undefined) annotations['config.llm.topK'] = llmParams.topK;
        if (llmParams.repeatPenalty !== undefined) annotations['config.llm.repeatPenalty'] = llmParams.repeatPenalty;
        if (llmParams.stop !== undefined) annotations['config.llm.stop'] = llmParams.stop;
        if (llmParams.seed !== undefined) annotations['config.llm.seed'] = llmParams.seed;
        if (llmParams.maxContextLength !== undefined) annotations['config.llm.maxContextLength'] = llmParams.maxContextLength;
        if (llmParams.numCtx !== undefined) annotations['config.llm.numCtx'] = llmParams.numCtx;
      }
      
      const configChunk = createNullChunk('com.rxcafe.api', annotations);
      session.outputStream.next(configChunk);
    }
    
    return new Response(JSON.stringify({ 
      sessionId: session.id,
      agentName: session.agentName,
      isBackground: session.isBackground,
      message: 'Session created'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: 'Failed to create session',
      message: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleListAgents(): Promise<Response> {
  const agents = listAgentsFromCore();
  
  return new Response(JSON.stringify({
    agents: agents.map(a => ({
      name: a.name,
      description: a.description,
      startInBackground: a.startInBackground,
      configSchema: a.configSchema || [],
    }))
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleListSessions(): Promise<Response> {
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
          displayName: ps.id === ps.agentName ? ps.agentName : undefined // Default for background agents
        });
      }
    }
  }
  
  return new Response(JSON.stringify({ sessions: activeSessions }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleDeleteSession(sessionId: string): Promise<Response> {
  const success = await deleteSession(sessionId);
  
  return new Response(JSON.stringify({ success, message: success ? 'Session deleted' : 'Session not found or could not be deleted' }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleListModels(backend?: string): Promise<Response> {
  try {
    const result = await listModels(config, backend);
    
    if (result.backend === 'kobold') {
      return new Response(JSON.stringify({ 
        backend: 'kobold',
        message: 'KoboldCPP does not support model listing'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: 'Failed to list models',
      message: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleGetHistory(sessionId: string): Promise<Response> {
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
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const historyChunks = session.history.filter(c => 
    c.contentType === 'text' || 
    c.contentType === 'binary' || 
    (c.contentType === 'null' && (c.annotations['session.name'] || c.annotations['config.type'] === 'runtime'))
  );
  
  return new Response(JSON.stringify({ 
    sessionId,
    displayName: session.displayName,
    chunks: historyChunks
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleErrorStream(sessionId: string): Promise<Response> {
  const session = getSession(sessionId);
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const { Subject, Observable } = await import('./lib/stream.js');
  const { observableToStream } = await import('./lib/stream.js');
  
  const errorStream = observableToStream(
    session.errorStream.asObservable(),
    (err: Error) => `data: ${JSON.stringify({ type: 'error', message: err.message, timestamp: Date.now() })}\n\n`
  );
  
  return new Response(errorStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}

async function handleFetchWeb(sessionId: string, url: string): Promise<Response> {
  const session = getSession(sessionId);
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    const fetchedChunk = await fetchWebContent(url);
    
    const chunk = addChunkToSession(session, {
      content: fetchedChunk.content as string,
      producer: fetchedChunk.producer,
      annotations: fetchedChunk.annotations,
      emit: true
    });
    
    return new Response(JSON.stringify({
      success: true,
      chunk: chunk,
      message: 'Web content fetched and added as untrusted chunk'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch URL'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleAddChunk(sessionId: string, options: AddChunkOptions): Promise<Response> {
  const session = getSession(sessionId);
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Runtime config chunks should be emitted to inputStream so they're processed
  const isRuntimeConfig = options.contentType === 'null' && options.annotations?.['config.type'] === 'runtime';
  
  // Validate runtime config against agent schema
  if (isRuntimeConfig && options.annotations) {
    const agent = getAgent(session.agentName);
    if (agent?.configSchema) {
      const runtimeConfig: RuntimeSessionConfig = {
        backend: options.annotations['config.backend'],
        model: options.annotations['config.model'],
        systemPrompt: options.annotations['config.systemPrompt'],
      };
      
      // Extract llmParams from annotations
      const llmParams: any = {};
      const llmKeys = ['temperature', 'maxTokens', 'topP', 'topK', 'repeatPenalty', 'stop', 'seed', 'maxContextLength', 'numCtx'];
      for (const key of llmKeys) {
        const val = options.annotations[`config.llm.${key}`];
        if (val !== undefined) {
          llmParams[key] = val;
        }
      }
      if (Object.keys(llmParams).length > 0) {
        runtimeConfig.llmParams = llmParams;
      }
      
      const errors = await validateConfigAgainstSchema(runtimeConfig, agent.configSchema);
      if (errors.length > 0) {
        return new Response(JSON.stringify({ 
          error: 'Invalid configuration',
          message: 'Runtime config does not meet agent requirements',
          validationErrors: errors
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
  }
  
  const chunk = addChunkToSession(session, { ...options, emit: isRuntimeConfig });
  
  return new Response(JSON.stringify({
    success: true,
    chunk: chunk
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleToggleTrust(sessionId: string, chunkId: string, trusted: boolean): Promise<Response> {
  const session = getSession(sessionId);
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const result = toggleChunkTrust(session, chunkId, trusted);
  
  if (!result) {
    return new Response(JSON.stringify({ error: 'Chunk not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  return new Response(JSON.stringify({
    success: true,
    chunkId,
    trusted,
    message: trusted ? 'Chunk marked as trusted and added to LLM context' : 'Chunk marked as untrusted'
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleChatStream(
  sessionId: string, 
  message: string,
  isAdmin: boolean = false
): Promise<Response> {
  const session = getSession(sessionId);
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Handle /system command
  if (message.startsWith('/system ')) {
    const prompt = message.slice(8).trim();
    const chunk = addChunkToSession(session, {
      content: prompt,
      producer: 'com.rxcafe.system-prompt',
      annotations: {
        'chat.role': 'system',
        'system.prompt': true
      }
    });
    return new Response(JSON.stringify({
      type: 'system',
      chunk: chunk,
      message: 'System prompt set'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Build SSE response stream
  const stream = new ReadableStream({
    start(controller) {
      // Process the chat message
      processChatMessage(
        session,
        message,
        {
          onToken: (token: string) => {
            try {
              controller.enqueue(`data: ${JSON.stringify({
                type: 'token',
                token: token
              })}\n\n`);
            } catch { /* controller closed */ }
          },
          onFinish: () => {
            try {
              controller.enqueue(`data: ${JSON.stringify({ type: 'finish' })}\n\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
              controller.close();
            } catch { /* controller closed */ }
          },
          onError: (error: Error) => {
            try {
              controller.enqueue(`data: ${JSON.stringify({ 
                type: 'error',
                error: error.message 
              })}\n\n`);
              controller.close();
            } catch { /* controller closed */ }
          }
        },
        config,
        { 'client.type': 'web', 'admin.authorized': isAdmin }
      ).catch(error => {
        try {
          controller.enqueue(`data: ${JSON.stringify({ 
            type: 'error',
            error: error instanceof Error ? error.message : 'Unknown error'
          })}\n\n`);
          controller.close();
        } catch { /* controller closed */ }
      });
      
      // User chunk confirmation sent via general SSE stream
    },
    cancel() {
      abortGeneration(session);
    }
  });
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}

function handleSessionStream(sessionId: string): Response {
  let session = getSession(sessionId);
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Capture cleanup in closure so cancel() can reach it without relying on
  // `this` (which refers to the underlyingSource object, not the controller).
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      
      // Send initial connection message
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`));
      
      // Subscribe to output stream
      const outputSub = session!.outputStream.subscribe({
        next: (chunk: Chunk) => {
          if (chunk.contentType === 'text' || chunk.contentType === 'binary') {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                type: 'chunk',
                chunk: chunk
              })}\n\n`));
            } catch {
              // Controller may be closed if the client disconnected
            }
          }
        },
        error: (err: Error) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              type: 'error',
              error: err.message
            })}\n\n`));
          } catch { /* ignore */ }
        }
      });
      
      // Subscribe to error stream
      const errorSub = session!.errorStream.subscribe({
        next: (err: Error) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              type: 'error',
              error: err.message
            })}\n\n`));
          } catch { /* ignore */ }
        }
      });
      
      cleanup = () => {
        outputSub.unsubscribe();
        errorSub.unsubscribe();
      };
    },
    cancel() {
      if (cleanup) {
        cleanup();
        cleanup = null;
      }
    }
  });
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}

async function handleAbort(sessionId: string): Promise<Response> {
  const session = getSession(sessionId);
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  await abortGeneration(session);
  
  return new Response(JSON.stringify({ message: 'Generation aborted' }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// =============================================================================
// Frontend Serving
// =============================================================================

function getFrontendHtml(token?: string): string {
  try {
    let html = readFileSync(join(__dirname, 'frontend', 'index.html'), 'utf-8');
    // Inject token into HTML if provided
    if (token) {
      const tokenScript = `<script>window.RXCAFE_TOKEN = "${token}";</script>`;
      html = html.replace('</head>', `${tokenScript}</head>`);
    }
    return html;
  } catch {
    return `<!DOCTYPE html>
<html>
<head><title>RXCAFE Chat</title></head>
<body>
<h1>RXCAFE Chat</h1>
<p>Frontend not found.</p>
</body>
</html>`;
  }
}

function getFrontendJs(): string {
  try {
    return readFileSync(join(__dirname, 'frontend', 'app.js'), 'utf-8');
  } catch {
    return 'console.error("Frontend JS not found");';
  }
}

function getFrontendCss(): string {
  try {
    return readFileSync(join(__dirname, 'frontend', 'styles.css'), 'utf-8');
  } catch {
    return '';
  }
}

function getManifest(): string {
  try {
    return readFileSync(join(__dirname, 'frontend', 'manifest.json'), 'utf-8');
  } catch {
    return '{}';
  }
}

function getServiceWorker(): string {
  try {
    return readFileSync(join(__dirname, 'frontend', 'sw.js'), 'utf-8');
  } catch {
    return '';
  }
}

function getIcon(size: number): Buffer | null {
  try {
    return readFileSync(join(__dirname, 'frontend', `icon-${size}.png`));
  } catch {
    return null;
  }
}

function getIconSvg(): string {
  try {
    return readFileSync(join(__dirname, 'frontend', 'icon.svg'), 'utf-8');
  } catch {
    return '<svg xmlns="http://www.w3.org/2000/svg"/>';
  }
}

function getWidgetFile(filename: string): string | null {
  try {
    return readFileSync(join(__dirname, 'frontend', 'widgets', filename), 'utf-8');
  } catch {
    return null;
  }
}

function getWidgetCss(): string {
  try {
    return readFileSync(join(__dirname, 'frontend', 'widgets', 'styles.css'), 'utf-8');
  } catch {
    return '';
  }
}

// =============================================================================
// HTTP Server
// =============================================================================

const server = serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    // Serve frontend (no auth required for frontend files)
    if (pathname === '/' || pathname === '/index.html') {
      return new Response(getFrontendHtml(webToken), {
        headers: { 'Content-Type': 'text/html', ...corsHeaders }
      });
    }
    
    if (pathname === '/app.js') {
      return new Response(getFrontendJs(), {
        headers: { 'Content-Type': 'application/javascript', ...corsHeaders }
      });
    }
    
    if (pathname === '/styles.css') {
      return new Response(getFrontendCss(), {
        headers: { 'Content-Type': 'text/css', ...corsHeaders }
      });
    }
    
    // PWA files
    if (pathname === '/manifest.json') {
      return new Response(getManifest(), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    
    if (pathname === '/sw.js') {
      return new Response(getServiceWorker(), {
        headers: { 'Content-Type': 'application/javascript', ...corsHeaders }
      });
    }
    
    // Widget files (AFE - Agent Form Elements)
    if (pathname === '/widgets/styles.css') {
      return new Response(getWidgetCss(), {
        headers: { 'Content-Type': 'text/css', ...corsHeaders }
      });
    }
    
    if (pathname.startsWith('/widgets/')) {
      const filename = pathname.slice(9); // Remove '/widgets/'
      const content = getWidgetFile(filename);
      if (content !== null) {
        const contentType = filename.endsWith('.js') ? 'application/javascript' : 
                           filename.endsWith('.css') ? 'text/css' : 'text/plain';
        return new Response(content, {
          headers: { 'Content-Type': contentType, ...corsHeaders }
        });
      }
    }
    
    if (pathname === '/icon.svg') {
      return new Response(getIconSvg(), {
        headers: { 'Content-Type': 'image/svg+xml', ...corsHeaders }
      });
    }
    
    if (pathname === '/icon-192.png') {
      const icon = getIcon(192);
      if (icon) {
        return new Response(icon, {
          headers: { 'Content-Type': 'image/png', ...corsHeaders }
        });
      }
      // Fallback to SVG
      return new Response(getIconSvg(), {
        headers: { 'Content-Type': 'image/svg+xml', ...corsHeaders }
      });
    }
    
    if (pathname === '/icon-512.png') {
      const icon = getIcon(512);
      if (icon) {
        return new Response(icon, {
          headers: { 'Content-Type': 'image/png', ...corsHeaders }
        });
      }
      // Fallback to SVG
      return new Response(getIconSvg(), {
        headers: { 'Content-Type': 'image/svg+xml', ...corsHeaders }
      });
    }
    
    // Health check (no auth required)
    if (pathname === '/api/health') {
      return new Response(JSON.stringify({ 
        status: 'ok',
        timestamp: Date.now(),
        backend: config.backend,
        koboldUrl: config.koboldBaseUrl,
        ollamaUrl: config.ollamaBaseUrl,
        ollamaModel: config.ollamaModel,
        authRequired: true,
        trustedClients: trustDb.getClientCount()
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    
    // Connected Agents API (uses agent auth, not client trust)
    // Registration requires client trust (handled below)
    // All other endpoints use X-API-Key from the agent's registration
    
    if (pathname.match(/^\/api\/connected-agents\/[^/]+$/) && request.method === 'DELETE') {
      const agentId = pathname.split('/')[3];
      const authResult = verifyAgentAuth(request);
      if ('error' in authResult) return addCors(authResult.error, corsHeaders);
      if (authResult.agent.id !== agentId) {
        return addCors(new Response(JSON.stringify({ error: 'Agent ID mismatch' }), { status: 403, headers: { 'Content-Type': 'application/json' } }), corsHeaders);
      }
      const response = handleUnregisterConnectedAgent(agentId);
      return addCors(response, corsHeaders);
    }

    if (pathname.match(/^\/api\/connected-agents\/[^/]+\/sessions$/) && request.method === 'GET') {
      const agentId = pathname.split('/')[3];
      const authResult = verifyAgentAuth(request);
      if ('error' in authResult) return addCors(authResult.error, corsHeaders);
      if (authResult.agent.id !== agentId) {
        return addCors(new Response(JSON.stringify({ error: 'Agent ID mismatch' }), { status: 403, headers: { 'Content-Type': 'application/json' } }), corsHeaders);
      }
      const response = handleGetAgentSessions(agentId);
      return addCors(response, corsHeaders);
    }

    if (pathname.match(/^\/api\/connected-agents\/[^/]+\/subscribe\/[^/]+$/) && request.method === 'POST') {
      const parts = pathname.split('/');
      const agentId = parts[3];
      const sessionId = parts[5];
      const authResult = verifyAgentAuth(request);
      if ('error' in authResult) return addCors(authResult.error, corsHeaders);
      if (authResult.agent.id !== agentId) {
        return addCors(new Response(JSON.stringify({ error: 'Agent ID mismatch' }), { status: 403, headers: { 'Content-Type': 'application/json' } }), corsHeaders);
      }
      const response = handleAgentSubscribe(agentId, sessionId);
      return addCors(response, corsHeaders);
    }

    if (pathname.match(/^\/api\/connected-agents\/[^/]+\/subscribe\/[^/]+$/) && request.method === 'DELETE') {
      const parts = pathname.split('/');
      const agentId = parts[3];
      const sessionId = parts[5];
      const authResult = verifyAgentAuth(request);
      if ('error' in authResult) return addCors(authResult.error, corsHeaders);
      if (authResult.agent.id !== agentId) {
        return addCors(new Response(JSON.stringify({ error: 'Agent ID mismatch' }), { status: 403, headers: { 'Content-Type': 'application/json' } }), corsHeaders);
      }
      const response = handleAgentUnsubscribe(agentId, sessionId);
      return addCors(response, corsHeaders);
    }

    if (pathname.match(/^\/api\/connected-agents\/[^/]+\/join\/[^/]+$/) && request.method === 'POST') {
      const parts = pathname.split('/');
      const agentId = parts[3];
      const sessionId = parts[5];
      const authResult = verifyAgentAuth(request);
      if ('error' in authResult) return addCors(authResult.error, corsHeaders);
      if (authResult.agent.id !== agentId) {
        return addCors(new Response(JSON.stringify({ error: 'Agent ID mismatch' }), { status: 403, headers: { 'Content-Type': 'application/json' } }), corsHeaders);
      }
      const response = handleAgentJoin(agentId, sessionId);
      return addCors(response, corsHeaders);
    }

    if (pathname.match(/^\/api\/connected-agents\/[^/]+\/join\/[^/]+$/) && request.method === 'DELETE') {
      const parts = pathname.split('/');
      const agentId = parts[3];
      const sessionId = parts[5];
      const authResult = verifyAgentAuth(request);
      if ('error' in authResult) return addCors(authResult.error, corsHeaders);
      if (authResult.agent.id !== agentId) {
        return addCors(new Response(JSON.stringify({ error: 'Agent ID mismatch' }), { status: 403, headers: { 'Content-Type': 'application/json' } }), corsHeaders);
      }
      const response = handleAgentLeave(agentId, sessionId);
      return addCors(response, corsHeaders);
    }

    if (pathname.match(/^\/api\/session\/[^/]+\/connected-agents$/) && request.method === 'GET') {
      const sessionId = pathname.split('/')[3];
      const authResult = verifyAgentAuth(request);
      if ('error' in authResult) return addCors(authResult.error, corsHeaders);
      const response = handleGetSessionConnectedAgents(sessionId);
      return addCors(response, corsHeaders);
    }

    if (pathname.match(/^\/api\/session\/[^/]+\/stream\/agent$/) && request.method === 'GET') {
      const sessionId = pathname.split('/')[3];
      const response = handleAgentSessionStream(request, sessionId);
      return response;
    }

    if (pathname.match(/^\/api\/session\/[^/]+\/agent-chunk$/) && request.method === 'POST') {
      const sessionId = pathname.split('/')[3];
      const response = await handleAgentProduceChunk(request, sessionId);
      return addCors(response, corsHeaders);
    }
    
    // Verify client for all API endpoints below
    const { trusted, token } = verifyClient(request);
    if (!trusted) {
      return addCors(createUntrustedResponse(token), corsHeaders);
    }
    
    // Telegram webhook endpoint
    if (pathname === '/webhook/telegram' && request.method === 'POST') {
      if (!telegramBot) {
        return new Response(JSON.stringify({ error: 'Telegram bot not configured' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const update = await request.json();
      await telegramBot.handleUpdate(update);
      
      return new Response('OK', { status: 200 });
    }
    
    // API Routes
    if (pathname === '/api/agents' && request.method === 'GET') {
      const response = await handleListAgents();
      return addCors(response, corsHeaders);
    }
    
    if (pathname === '/api/sessions' && request.method === 'GET') {
      const response = await handleListSessions();
      return addCors(response, corsHeaders);
    }
    
    if (pathname === '/api/session' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const response = await handleCreateSession(body);
      return addCors(response, corsHeaders);
    }

    if (pathname.match(/^\/api\/session\/[^/]+$/) && request.method === 'DELETE') {
      const sessionId = pathname.split('/')[3];
      const response = await handleDeleteSession(sessionId);
      return addCors(response, corsHeaders);
    }
    
    if (pathname === '/api/models' && request.method === 'GET') {
      const backend = url.searchParams.get('backend') || undefined;
      const response = await handleListModels(backend);
      return addCors(response, corsHeaders);
    }
    
    if (pathname.match(/^\/api\/session\/[^/]+\/history$/) && request.method === 'GET') {
      const sessionId = pathname.split('/')[3];
      const response = await handleGetHistory(sessionId);
      return addCors(response, corsHeaders);
    }
    
    if (pathname.match(/^\/api\/session\/[^/]+\/stream$/) && request.method === 'GET') {
      const sessionId = pathname.split('/')[3];
      const response = handleSessionStream(sessionId);
      return response;
    }
    
    // Error stream endpoint (SSE)
    if (pathname.match(/^\/api\/session\/[^/]+\/errors$/) && request.method === 'GET') {
      const sessionId = pathname.split('/')[3];
      const response = await handleErrorStream(sessionId);
      return addCors(response, corsHeaders);
    }
    
    // Web fetch endpoint
    if (pathname.match(/^\/api\/session\/[^/]+\/web$/) && request.method === 'POST') {
      const sessionId = pathname.split('/')[3];
      const body = await request.json();
      const urlToFetch = body.url;
      
      if (!urlToFetch) {
        return new Response(JSON.stringify({ error: 'URL required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      const response = await handleFetchWeb(sessionId, urlToFetch);
      return addCors(response, corsHeaders);
    }
    
    // Add chunk endpoint
    if (pathname.match(/^\/api\/session\/[^/]+\/chunk$/) && request.method === 'POST') {
      const sessionId = pathname.split('/')[3];
      const body = await request.json();
      
      const response = await handleAddChunk(sessionId, {
        content: body.content,
        contentType: body.contentType,
        producer: body.producer,
        annotations: body.annotations,
        emit: body.emit === true
      });
      return addCors(response, corsHeaders);
    }
    
    // Trust toggle endpoint
    if (pathname.match(/^\/api\/session\/[^/]+\/chunk\/[^/]+\/trust$/) && request.method === 'POST') {
      const parts = pathname.split('/');
      const sessionId = parts[3];
      const chunkId = parts[5];
      const body = await request.json();
      const trusted = body.trusted === true;
      
      const response = await handleToggleTrust(sessionId, chunkId, trusted);
      return addCors(response, corsHeaders);
    }
    
    if (pathname.match(/^\/api\/chat\/[^/]+$/) && request.method === 'POST') {
      const sessionId = pathname.split('/')[3];
      const body = await request.json();
      const message = body.message;
      
      if (!message || typeof message !== 'string') {
        return new Response(JSON.stringify({ error: 'Message required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      const { isAdmin } = verifyAdmin(request);
      const response = await handleChatStream(sessionId, message, isAdmin);
      return addCors(response, corsHeaders);
    }
    
    if (pathname.match(/^\/api\/chat\/[^/]+\/abort$/) && request.method === 'POST') {
      const sessionId = pathname.split('/')[3];
      const response = await handleAbort(sessionId);
      return addCors(response, corsHeaders);
    }

    // Connected Agents API
    if (pathname === '/api/connected-agents' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const response = handleRegisterConnectedAgent(body);
      return addCors(response, corsHeaders);
    }
    
    // System agent routes (admin-only)
    if (pathname === '/api/system/command' && request.method === 'POST') {
      const { isAdmin, token } = verifyAdmin(request);
      if (!isAdmin) {
        return addCors(createForbiddenResponse(), corsHeaders);
      }
      const response = await handleSystemCommand(request);
      return addCors(response, corsHeaders);
    }
    
    // 404
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
});

function addCors(response: Response, corsHeaders: Record<string, string>): Response {
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }
  return response;
}

// Connected Agents API Handlers

function handleRegisterConnectedAgent(body: { name?: string; description?: string }): Response {
  const name = body.name || 'Unnamed Agent';
  const agent = connectedAgentStore.register(name, body.description);
  
  return new Response(JSON.stringify({
    agentId: agent.id,
    apiKey: agent.apiKey,
    name: agent.name
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function handleUnregisterConnectedAgent(agentId: string): Response {
  const success = connectedAgentStore.unregister(agentId);
  
  if (!success) {
    return new Response(JSON.stringify({ error: 'Agent not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  return new Response(null, { status: 204 });
}

function handleGetAgentSessions(agentId: string): Response {
  const agent = connectedAgentStore.getById(agentId);
  
  if (!agent) {
    return new Response(JSON.stringify({ error: 'Agent not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const sessions = connectedAgentStore.getSessions(agentId);
  
  return new Response(JSON.stringify({
    agentId,
    sessions
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function handleAgentSubscribe(agentId: string, sessionId: string): Response {
  const agent = connectedAgentStore.getById(agentId);
  
  if (!agent) {
    return new Response(JSON.stringify({ error: 'Agent not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const success = connectedAgentStore.subscribe(agentId, sessionId);
  
  if (!success) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function handleAgentUnsubscribe(agentId: string, sessionId: string): Response {
  const agent = connectedAgentStore.getById(agentId);
  
  if (!agent) {
    return new Response(JSON.stringify({ error: 'Agent not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const success = connectedAgentStore.unsubscribe(agentId, sessionId);
  
  if (!success) {
    return new Response(JSON.stringify({ error: 'Not subscribed to this session' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function handleAgentJoin(agentId: string, sessionId: string): Response {
  const agent = connectedAgentStore.getById(agentId);
  
  if (!agent) {
    return new Response(JSON.stringify({ error: 'Agent not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const success = connectedAgentStore.join(agentId, sessionId);
  
  if (!success) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function handleAgentLeave(agentId: string, sessionId: string): Response {
  const agent = connectedAgentStore.getById(agentId);
  
  if (!agent) {
    return new Response(JSON.stringify({ error: 'Agent not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const success = connectedAgentStore.leave(agentId, sessionId);
  
  if (!success) {
    return new Response(JSON.stringify({ error: 'Not joined to this session' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function handleGetSessionConnectedAgents(sessionId: string): Response {
  const session = getSession(sessionId);
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const agents = connectedAgentStore.getAgentsInSession(sessionId);
  
  return new Response(JSON.stringify({
    sessionId,
    agents
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function handleAgentSessionStream(request: Request, sessionId: string): Response {
  const apiKey = request.headers.get('X-API-Key');
  
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'X-API-Key header required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const agent = connectedAgentStore.getByApiKey(apiKey);
  
  if (!agent) {
    return new Response(JSON.stringify({ error: 'Invalid API key' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  if (!connectedAgentStore.canReadChunks(agent.id, sessionId)) {
    return new Response(JSON.stringify({ error: 'Not subscribed to this session' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const session = getSession(sessionId);
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'connected', agentId: agent.id, sessionId })}\n\n`));
      
      const sub = session.outputStream.subscribe({
        next: (chunk: Chunk) => {
          try {
            controller.enqueue(encoder.encode(`event: chunk\ndata: ${JSON.stringify(chunk)}\n\n`));
          } catch { /* controller closed */ }
        },
        error: (err: Error) => {
          try {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`));
          } catch { /* ignore */ }
        }
      });
      
      return () => sub.unsubscribe();
    },
    cancel() {}
  });
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}

async function handleAgentProduceChunk(request: Request, sessionId: string): Promise<Response> {
  const apiKey = request.headers.get('X-API-Key');
  
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'X-API-Key header required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const agent = connectedAgentStore.getByApiKey(apiKey);
  
  if (!agent) {
    return new Response(JSON.stringify({ error: 'Invalid API key' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  if (!connectedAgentStore.canProduceChunk(agent.id, sessionId)) {
    return new Response(JSON.stringify({ error: 'Not joined to this session' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const session = getSession(sessionId);
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const body = await request.json().catch(() => ({}));
  
  const chunk = addChunkToSession(session, {
    content: body.content,
    contentType: body.contentType,
    producer: `com.observablecafe.connected-agent.${agent.id}`,
    annotations: body.annotations,
    emit: true
  });
  
  return new Response(JSON.stringify({
    success: true,
    chunk
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleSystemCommand(request: Request): Promise<Response> {
  const systemSession = getSession('system');
  
  if (!systemSession) {
    return new Response(JSON.stringify({ error: 'System agent not running' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const body = await request.json().catch(() => ({}));
  const command = body.command;
  
  if (!command || typeof command !== 'string') {
    return new Response(JSON.stringify({ error: 'Command required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  return new Promise((resolve) => {
    let responseText = '';
    let responded = false;
    
    const timeout = setTimeout(() => {
      if (!responded) {
        responded = true;
        sub.unsubscribe();
        resolve(new Response(JSON.stringify({ error: 'Command timeout' }), {
          status: 504,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
    }, 10000);
    
    const sub = systemSession.outputStream.subscribe({
      next: (chunk: Chunk) => {
        if (chunk.annotations['system.response'] || chunk.annotations['system.error']) {
          responseText = chunk.content as string;
        }
        
        if (chunk.annotations['system.response'] || chunk.annotations['system.error']) {
          if (!responded) {
            responded = true;
            clearTimeout(timeout);
            sub.unsubscribe();
            resolve(new Response(JSON.stringify({
              success: !chunk.annotations['system.error'],
              response: responseText
            }), {
              headers: { 'Content-Type': 'application/json' }
            }));
          }
        }
      }
    });
    
    const commandChunk = createTextChunk(command, 'com.rxcafe.api', {
      'chat.role': 'user',
      'client.type': 'api',
      'admin.authorized': true
    });
    
    systemSession.inputStream.next(commandChunk);
  });
}

console.log(`Server running at http://localhost:${PORT}?token=${webToken}`);

// Load agents and start background agents
(async () => {
  console.log('[Server] Loading agents...');
  await loadAgentsFromDisk();
  
  const agents = listAgentsFromCore();
  console.log(`[Server] Loaded ${agents.length} agents: ${agents.map(a => a.name).join(', ')}`);
  
  console.log('[Server] Restoring persisted sessions...');
  const restoredCount = await restorePersistedSessions(config);
  if (restoredCount > 0) {
    console.log(`[Server] Restored ${restoredCount} sessions from persistence`);
  }
  
  console.log('[Server] Starting background agents...');
  await startBackgroundAgents(config);
  
  // Initialize Telegram bot (if configured)
  initTelegramBot().then(() => {
    // Restore persistent Telegram auto-subscriptions
    if (telegramBot) {
      console.log('[Telegram] Restoring persistent auto-subscriptions...');
      const allSubs = trustDb.listAllTelegramSubscriptions();
      for (const sub of allSubs) {
        const session = getSession(sub.sessionId);
        if (session) {
          ensureTelegramSubscription(sub.chatId, session);
        }
      }
    }
  }).catch(console.error);
})();

// Cleanup on exit
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  shutdown();
  trustDb.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  shutdown();
  trustDb.close();
  process.exit(0);
});
