/**
 * RXCAFE Chat Application
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
  type Chunk
} from './lib/chunk.js';
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
  shutdown,
  type CoreConfig,
  type Session,
  type AddChunkOptions,
  type CreateSessionOptions
} from './core.js';
import { TelegramBot, TelegramUser, TelegramConfig } from './lib/telegram.js';
import { TrustDatabase, extractClientToken, maskToken } from './lib/trust.js';
import { SessionStore } from './lib/session-store.js';
import type { LLMParams } from './lib/agent.js';
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
  const db = new TrustDatabase();
  
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
  const db = new TrustDatabase();
  const token = TrustDatabase.generateToken();
  const description = args[args.indexOf('--generate-token') + 1] && !args[args.indexOf('--generate-token') + 1].startsWith('--')
    ? args[args.indexOf('--generate-token') + 1]
    : undefined;
  
  db.addClient(description);
  console.log('✅ New client token generated and trusted');
  console.log(`Token: ${token}`);
  console.log('');
  console.log('Share this token with the client. They should use it as:');
  console.log('  - Authorization: Bearer <token> header');
  console.log('  - Or ?token=<token> query parameter');
  if (description) {
    console.log(`Description: ${description}`);
  }
  db.close();
  process.exit(0);
}

// Handle --list-clients command
if (args.includes('--list-clients')) {
  const db = new TrustDatabase();
  const clients = db.listClients();
  
  if (clients.length === 0) {
    console.log('No trusted clients found.');
  } else {
    console.log(`Trusted clients (${clients.length}):`);
    console.log('');
    console.log('ID  | Description          | Created            | Last Used          | Uses');
    console.log('----|----------------------|--------------------|--------------------|------');
    
    for (const client of clients) {
      const desc = (client.description || '').slice(0, 20).padEnd(20);
      const created = new Date(client.createdAt).toLocaleString().slice(0, 18).padEnd(18);
      const lastUsed = client.lastUsedAt 
        ? new Date(client.lastUsedAt).toLocaleString().slice(0, 18).padEnd(18)
        : 'Never'.padEnd(18);
      const uses = client.useCount.toString().padStart(5);
      
      console.log(`${client.id.toString().padStart(3)} | ${desc} | ${created} | ${lastUsed} | ${uses}`);
    }
  }
  
  db.close();
  process.exit(0);
}

// Handle --revoke command
const revokeIndex = args.indexOf('--revoke');
if (revokeIndex !== -1 && args[revokeIndex + 1]) {
  const id = parseInt(args[revokeIndex + 1]);
  if (isNaN(id)) {
    console.log('❌ Invalid client ID');
    process.exit(1);
  }
  
  const db = new TrustDatabase();
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
  
  const db = new TrustDatabase();
  
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
  
  const db = new TrustDatabase();
  
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
  const db = new TrustDatabase();
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
const PORT = parseInt(process.env.PORT || '3000');
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL;
const TRUST_DB_PATH = process.env.TRUST_DB_PATH || './rxcafe-trust.db';

// Initialize trust database
const trustDb = new TrustDatabase(TRUST_DB_PATH);

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

// =============================================================================
// Telegram Bot Integration
// =============================================================================

// Map Telegram chat IDs to current RXCAFE session ID
const telegramCurrentSession = new Map<number, string>();

// Map Telegram chat IDs to all accessible session IDs
const telegramAllSessions = new Map<number, Set<string>>();

// Map Telegram chat IDs to their active outputStream subscriptions
const telegramSubscriptions = new Map<number, Subscription>();

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
        console.log(`[Telegram] Creating new session for chat ${chatId}`);
        const session = await createSession(config);
        telegramCurrentSession.set(chatId, session.id);
        
        if (!telegramAllSessions.has(chatId)) {
          telegramAllSessions.set(chatId, new Set());
        }
        telegramAllSessions.get(chatId)!.add(session.id);
        
        sessionId = session.id;
        console.log(`[Telegram] Created session ${sessionId}`);
        await telegramBot!.sendMessage(chatId, `🤖 *RXCAFE Bot Started*\n\nSession: \`${session.id}\`\nAgent: ${session.agentName}\nBackend: ${session.backend}${session.model ? ' (' + session.model + ')' : ''}\n\nType /help for available commands.`, { parseMode: 'Markdown' });
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
        const chatSessions = telegramAllSessions.get(chatId);
        if (!chatSessions || chatSessions.size === 0) {
          await telegramBot!.sendMessage(chatId, 'No sessions found. Use /new to create one.');
          return;
        }
        
        const buttons = Array.from(chatSessions).map(sid => {
          const s = getSession(sid);
          if (!s) return null;
          const name = s.displayName || s.agentName;
          const current = sid === sessionId ? '✓ ' : '';
          const bg = s.isBackground ? ' ⚙️' : '';
          return [{ text: `${current}${name}${bg}`, callback_data: `switch:${sid}` }];
        }).filter(b => b !== null) as any[][];
        
        await telegramBot!.sendMessage(chatId, `*Your Sessions:*\nSelect a session to switch:`, { 
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
          
          await telegramBot!.sendMessage(chatId, `✅ New session created\n\nSession: \`${newSession.id}\`\nAgent: ${newSession.agentName}\nBackend: ${newSession.backend}${newSession.model ? ' (' + newSession.model + ')' : ''}`, { parseMode: 'Markdown' });
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
  
  try {
    console.log(`[Telegram] Starting LLM evaluation...`);
    
    const callbacks: ChatCallbacks = {
      onToken: (token: string) => {
        tokenCount++;
        fullResponse += token;
        
        // Update message every 20 characters to avoid rate limits
        if (fullResponse.length % 20 === 0 && fullResponse.length > 0) {
          updateTelegramMessage(chatId, fullResponse, messageId).then(id => {
            if (id && !messageId) messageId = id;
          });
        }
      },
      onFinish: () => {
        console.log(`[Telegram] LLM evaluation complete. Tokens: ${tokenCount}, Response length: ${fullResponse.length}`);
        
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
        telegramBot!.sendMessage(chatId, `❌ Error: ${error.message}`);
        
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
      // No updates were made, send final message
      await telegramBot.sendMessage(chatId, text || 'No response');
    } else {
      // Update with final text (no cursor)
      await telegramBot.editMessage(chatId, messageId, text);
    }
    
    // Delete status message if it exists
    if (statusMessageId) {
      try {
        await telegramBot.editMessage(chatId, statusMessageId, '✅');
      } catch {
        // Ignore errors editing status message
      }
    }
  } catch (error) {
    console.error('[Telegram] Failed to finalize message:', error);
  }
}

async function switchTelegramSession(chatId: number, targetSessionId: string): Promise<void> {
  if (!telegramBot) return;
  
  const chatSessions = telegramAllSessions.get(chatId);
  
  if (!chatSessions?.has(targetSessionId)) {
    // Check if it's a background session
    const targetSession = getSession(targetSessionId);
    if (targetSession && targetSession.isBackground) {
      if (!telegramAllSessions.has(chatId)) {
        telegramAllSessions.set(chatId, new Set());
      }
      telegramAllSessions.get(chatId)!.add(targetSessionId);
    } else {
      await telegramBot.sendMessage(chatId, `❌ Session not found: \`${targetSessionId}\``, { parseMode: 'Markdown' });
      return;
    }
  }
  
  const targetSession = getSession(targetSessionId);
  if (!targetSession) {
    await telegramBot.sendMessage(chatId, `❌ Session expired or not found: \`${targetSessionId}\``, { parseMode: 'Markdown' });
    telegramAllSessions.get(chatId)?.delete(targetSessionId);
    return;
  }
  
  telegramCurrentSession.set(chatId, targetSessionId);
  await telegramBot.sendMessage(chatId, `✅ Switched to session: \`${targetSessionId}\`\nAgent: ${targetSession.agentName}\nName: ${targetSession.displayName || 'None'}`, { parseMode: 'Markdown' });
  
  // Update subscription to the new session's outputStream
  ensureTelegramSubscription(chatId, targetSession);
}

function ensureTelegramSubscription(chatId: number, session: Session) {
  const existingSub = telegramSubscriptions.get(chatId);
  
  // Only resubscribe if the session has actually changed
  // We'll store a custom property on the subscription to track the session ID
  if (existingSub) {
    if ((existingSub as any)._sessionId === session.id) {
      return;
    }
    existingSub.unsubscribe();
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
          
          if (isAssistant && !isActiveTurnForUs) {
              await telegramBot.sendMessage(chatId, chunk.content as string);
          }
      }
    }
  });
  
  (sub as any)._sessionId = session.id;
  telegramSubscriptions.set(chatId, sub);
}

// =============================================================================
// API Request Handlers
// =============================================================================

async function handleCreateSession(body?: any): Promise<Response> {
  try {
    const options: CreateSessionOptions = {
      backend: body?.backend,
      model: body?.model,
      agentId: body?.agentId,
      systemPrompt: body?.systemPrompt,
      llmParams: body?.llmParams,
    };
    
    const session = await createSession(config, options);
    
    return new Response(JSON.stringify({ 
      sessionId: session.id,
      backend: session.backend,
      model: session.model,
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
    (c.contentType === 'null' && c.annotations['session.name'])
  );
  
  return new Response(JSON.stringify({ 
    sessionId,
    backend: session.backend,
    model: session.model,
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
  
  const chunk = addChunkToSession(session, options);
  
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
  message: string
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
            controller.enqueue(`data: ${JSON.stringify({
              type: 'token',
              token: token
            })}\n\n`);
          },
          onFinish: () => {
            controller.enqueue(`data: ${JSON.stringify({ type: 'finish' })}\n\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            controller.close();
          },
          onError: (error: Error) => {
            controller.enqueue(`data: ${JSON.stringify({ 
              type: 'error',
              error: error.message 
            })}\n\n`);
            controller.close();
          }
        },
        config,
        { 'client.type': 'web' }
      ).catch(error => {
        controller.enqueue(`data: ${JSON.stringify({ 
          type: 'error',
          error: error instanceof Error ? error.message : 'Unknown error'
        })}\n\n`);
        controller.close();
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
      
      const response = await handleChatStream(sessionId, message);
      return addCors(response, corsHeaders);
    }
    
    if (pathname.match(/^\/api\/chat\/[^/]+\/abort$/) && request.method === 'POST') {
      const sessionId = pathname.split('/')[3];
      const response = await handleAbort(sessionId);
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
  initTelegramBot().catch(console.error);
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
