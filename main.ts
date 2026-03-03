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
 *   bun start -- --help                                # Show help
 *   bun start -- --trust <token>                       # Trust a new API client
 *   bun start -- --list-clients                        # List trusted API clients
 *   bun start -- --revoke <id>                         # Revoke a trusted API client
 *   bun start -- --trust-telegram <id_or_username>     # Trust a Telegram user
 *   bun start -- --untrust-telegram <id_or_username>   # Untrust a Telegram user
 *   bun start -- --list-telegram-users                 # List trusted Telegram users
 */

import { serve } from 'bun';
import { readFileSync, existsSync } from 'fs';
import { createBinaryChunk } from './lib/chunk.js';
import { connectedAgentStore, type ConnectedAgent } from './lib/connected-agents.js';
import {
  getDefaultConfig,
  createSession,
  getSession,
  fetchWebContent,
  addChunkToSession,
  loadAgentsFromDisk,
  startBackgroundAgents,
  restorePersistedSessions,
  listAgents as listAgentsFromCore,
  setSessionStore,
  setCoreConfig,
  shutdown,
  type CoreConfig,
  type Session
} from './core.js';
import { Database, extractClientToken, maskToken } from './lib/database.js';
import { SessionStore } from './lib/session-store.js';
import { handleCliCommands } from './lib/cli-handler.js';
import { 
  getFrontendHtml,
  getFrontendJs,
  getFrontendCss,
  getManifest,
  getServiceWorker,
  getIcon,
  getIconSvg,
  getWidgetFile,
  getWidgetCss,
  getJsFile,
  getDiceCss
} from './lib/frontend-server.js';
import { 
  initTelegramHandler, 
  restoreTelegramSubscriptions, 
  getTelegramBot
} from './lib/telegram-handler.js';
import * as api from './lib/api/index.js';

handleCliCommands(process.argv.slice(2));

const config: CoreConfig = getDefaultConfig();
setCoreConfig(config);

const PORT = parseInt(process.env.PORT || '3000');
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TRUST_DB_PATH = process.env.TRUST_DB_PATH || './rxcafe-trust.db';

const trustDb = new Database(TRUST_DB_PATH);
connectedAgentStore.setTrustDatabase(trustDb);

const sessionStore = new SessionStore(trustDb.getDatabase());
setSessionStore(sessionStore);

api.initApiHandlers({ config, trustDb, sessionStore });

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

if (!trustDb.hasTrustedClients()) {
  console.log('');
  console.log('🔒 No trusted API clients configured - ALL API CLIENTS WILL BE BLOCKED');
  console.log('   Run: bun start -- --generate-token [description]');
  console.log('');
}

if (TELEGRAM_TOKEN && !trustDb.hasTrustedTelegramUsers()) {
  console.log('');
  console.log('🔒 No trusted Telegram users configured - ALL TELEGRAM USERS WILL BE BLOCKED');
  console.log('   Run: bun start -- --trust-telegram <user_id_or_username> [description]');
  console.log('');
}

function getOrCreateWebToken(): string {
  const existingToken = trustDb.getTokenByDescription('Web Interface');
  return existingToken || trustDb.addClient('Web Interface');
}

const webToken = getOrCreateWebToken();

function createUntrustedResponse(token: string | null): Response {
  const providedToken = token ? maskToken(token) : 'none';
  
  return new Response(JSON.stringify({
    error: 'Unauthorized',
    message: 'This client is not trusted.',
    providedToken: providedToken,
    instructions: 'An admin needs to authorize this client by running:',
    command: token 
      ? `bun start -- --trust ${token} [description]`
      : 'bun start -- --trust <token> [description]',
    alternative: 'To generate a new token, run: bun start -- --generate-token [description]',
    hint: 'Pass the token via Authorization: Bearer <token> header or ?token=<token> query parameter'
  }), {
    status: 401,
    headers: { 
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer'
    }
  });
}

function verifyClient(request: Request): { trusted: boolean; token: string | null } {
  const token = extractClientToken(request);
  if (!token) return { trusted: false, token: null };
  return { trusted: trustDb.verifyToken(token), token };
}

function verifyAdmin(request: Request): { isAdmin: boolean; token: string | null; clientId: number | null } {
  const token = extractClientToken(request);
  if (!token) return { isAdmin: false, token: null, clientId: null };
  const clientId = trustDb.getClientIdByToken(token);
  if (!clientId) return { isAdmin: false, token, clientId: null };
  return { isAdmin: trustDb.isAdminToken(token), token, clientId };
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

function addCors(response: Response, corsHeaders: Record<string, string>): Response {
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }
  return response;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const USE_HTTPS = process.env.USE_HTTPS === 'true' || existsSync('./cert.pem');
const tlsConfig = USE_HTTPS ? {
  cert: readFileSync('./cert.pem'),
  key: readFileSync('./key.pem'),
} : undefined;

const server = serve({
  port: PORT,
  idleTimeout: 255,
  tls: tlsConfig,
  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    // Frontend static files
    if (pathname === '/' || pathname === '/index.html') {
      return new Response(getFrontendHtml(webToken), { headers: { 'Content-Type': 'text/html', ...corsHeaders } });
    }
    if (pathname === '/app.js') return new Response(getFrontendJs(), { headers: { 'Content-Type': 'application/javascript', ...corsHeaders } });
    if (pathname === '/styles.css') return new Response(getFrontendCss(), { headers: { 'Content-Type': 'text/css', ...corsHeaders } });
    if (pathname === '/manifest.json') return new Response(getManifest(), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    if (pathname === '/sw.js') return new Response(getServiceWorker(), { headers: { 'Content-Type': 'application/javascript', ...corsHeaders } });
    if (pathname === '/widgets/styles.css') return new Response(getWidgetCss(), { headers: { 'Content-Type': 'text/css', ...corsHeaders } });
    if (pathname === '/css/dice.css') return new Response(getDiceCss(), { headers: { 'Content-Type': 'text/css', ...corsHeaders } });
    if (pathname === '/icon.svg') return new Response(getIconSvg(), { headers: { 'Content-Type': 'image/svg+xml', ...corsHeaders } });
    
    if (pathname.startsWith('/widgets/')) {
      const filename = pathname.slice(9);
      const content = getWidgetFile(filename);
      if (content !== null) {
        const contentType = filename.endsWith('.js') ? 'application/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/plain';
        return new Response(content, { headers: { 'Content-Type': contentType, ...corsHeaders } });
      }
    }
    
    if (pathname.startsWith('/js/')) {
      const filename = pathname.slice(4);
      const content = getJsFile(filename);
      if (content !== null) {
        return new Response(content, { headers: { 'Content-Type': 'application/javascript', ...corsHeaders } });
      }
    }
    
    if (pathname === '/icon-192.png') {
      const icon = getIcon(192);
      return new Response(icon || getIconSvg(), { headers: { 'Content-Type': icon ? 'image/png' : 'image/svg+xml', ...corsHeaders } });
    }
    if (pathname === '/icon-512.png') {
      const icon = getIcon(512);
      return new Response(icon || getIconSvg(), { headers: { 'Content-Type': icon ? 'image/png' : 'image/svg+xml', ...corsHeaders } });
    }
    
    // Health check (no auth)
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
      }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }
    
    // Connected Agents API (agent auth)
    if (pathname.match(/^\/api\/connected-agents\/[^/]+$/) && request.method === 'DELETE') {
      const agentId = pathname.split('/')[3];
      const authResult = verifyAgentAuth(request);
      if ('error' in authResult) return addCors(authResult.error, corsHeaders);
      if (authResult.agent.id !== agentId) return addCors(new Response(JSON.stringify({ error: 'Agent ID mismatch' }), { status: 403, headers: { 'Content-Type': 'application/json' } }), corsHeaders);
      return addCors(api.handleUnregisterConnectedAgent(agentId), corsHeaders);
    }
    if (pathname.match(/^\/api\/connected-agents\/[^/]+\/sessions$/) && request.method === 'GET') {
      const agentId = pathname.split('/')[3];
      const authResult = verifyAgentAuth(request);
      if ('error' in authResult) return addCors(authResult.error, corsHeaders);
      return addCors(api.handleGetAgentSessions(agentId), corsHeaders);
    }
    if (pathname.match(/^\/api\/connected-agents\/[^/]+\/subscribe\/[^/]+$/) && request.method === 'POST') {
      const [,,, agentId,,, sessionId] = pathname.split('/');
      const authResult = verifyAgentAuth(request);
      if ('error' in authResult) return addCors(authResult.error, corsHeaders);
      return addCors(api.handleAgentSubscribe(agentId, sessionId), corsHeaders);
    }
    if (pathname.match(/^\/api\/connected-agents\/[^/]+\/subscribe\/[^/]+$/) && request.method === 'DELETE') {
      const [,,, agentId,,, sessionId] = pathname.split('/');
      const authResult = verifyAgentAuth(request);
      if ('error' in authResult) return addCors(authResult.error, corsHeaders);
      return addCors(api.handleAgentUnsubscribe(agentId, sessionId), corsHeaders);
    }
    if (pathname.match(/^\/api\/connected-agents\/[^/]+\/join\/[^/]+$/) && request.method === 'POST') {
      const [,,, agentId,,, sessionId] = pathname.split('/');
      const authResult = verifyAgentAuth(request);
      if ('error' in authResult) return addCors(authResult.error, corsHeaders);
      return addCors(api.handleAgentJoin(agentId, sessionId), corsHeaders);
    }
    if (pathname.match(/^\/api\/connected-agents\/[^/]+\/join\/[^/]+$/) && request.method === 'DELETE') {
      const [,,, agentId,,, sessionId] = pathname.split('/');
      const authResult = verifyAgentAuth(request);
      if ('error' in authResult) return addCors(authResult.error, corsHeaders);
      return addCors(api.handleAgentLeave(agentId, sessionId), corsHeaders);
    }
    if (pathname.match(/^\/api\/session\/[^/]+\/connected-agents$/) && request.method === 'GET') {
      const sessionId = pathname.split('/')[3];
      return addCors(api.handleGetSessionConnectedAgents(sessionId), corsHeaders);
    }
    if (pathname.match(/^\/api\/session\/[^/]+\/stream\/agent$/) && request.method === 'GET') {
      const sessionId = pathname.split('/')[3];
      return api.handleAgentSessionStream(request, sessionId);
    }
    if (pathname.match(/^\/api\/session\/[^/]+\/agent-chunk$/) && request.method === 'POST') {
      const sessionId = pathname.split('/')[3];
      return addCors(await api.handleAgentProduceChunk(request, sessionId), corsHeaders);
    }
    
    // Client auth required below
    const { trusted, token } = verifyClient(request);
    if (!trusted) return addCors(createUntrustedResponse(token), corsHeaders);
    
    // Telegram webhook
    if (pathname === '/webhook/telegram' && request.method === 'POST') {
      const telegramBot = getTelegramBot();
      if (!telegramBot) return new Response(JSON.stringify({ error: 'Telegram bot not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      await telegramBot.handleUpdate(await request.json());
      return new Response('OK', { status: 200 });
    }
    
    // API routes
    // Agent presets
    if (pathname === '/api/presets' && request.method === 'GET') return addCors(await api.handleListPresets(), corsHeaders);
    if (pathname === '/api/presets' && request.method === 'POST') return addCors(api.handleCreatePreset(await request.json().catch(() => ({}))), corsHeaders);
    if (pathname.match(/^\/api\/presets\/[^/]+$/) && request.method === 'GET') {
      const presetName = decodeURIComponent(pathname.split('/')[3]);
      return addCors(api.handleGetPreset(presetName), corsHeaders);
    }
    if (pathname.match(/^\/api\/presets\/[^/]+$/) && request.method === 'PUT') {
      const presetName = decodeURIComponent(pathname.split('/')[3]);
      return addCors(api.handleUpdatePreset(presetName, await request.json().catch(() => ({}))), corsHeaders);
    }
    if (pathname.match(/^\/api\/presets\/[^/]+$/) && request.method === 'DELETE') {
      const presetName = decodeURIComponent(pathname.split('/')[3]);
      return addCors(api.handleDeletePreset(presetName), corsHeaders);
    }
    if (pathname.match(/^\/api\/presets\/[^/]+\/create-session$/) && request.method === 'POST') {
      const presetName = decodeURIComponent(pathname.split('/')[3]);
      return addCors(await api.handleCreateSessionFromPreset(presetName), corsHeaders);
    }
    
    // Quickies API
    if (pathname === '/api/quickies' && request.method === 'GET') return addCors(api.handleListQuickies(), corsHeaders);
    if (pathname === '/api/quickies' && request.method === 'POST') return addCors(api.handleCreateQuickie(await request.json().catch(() => ({}))), corsHeaders);
    if (pathname.match(/^\/api\/quickies\/[^/]+$/) && request.method === 'GET') {
      const quickieId = pathname.split('/')[3];
      return addCors(api.handleGetQuickie(quickieId), corsHeaders);
    }
    if (pathname.match(/^\/api\/quickies\/[^/]+$/) && request.method === 'PUT') {
      const quickieId = pathname.split('/')[3];
      return addCors(api.handleUpdateQuickie(quickieId, await request.json().catch(() => ({}))), corsHeaders);
    }
    if (pathname.match(/^\/api\/quickies\/[^/]+$/) && request.method === 'DELETE') {
      const quickieId = pathname.split('/')[3];
      return addCors(api.handleDeleteQuickie(quickieId), corsHeaders);
    }
    if (pathname.match(/^\/api\/quickies\/[^/]+\/launch$/) && request.method === 'POST') {
      const quickieId = pathname.split('/')[3];
      return addCors(await api.handleLaunchQuickie(quickieId), corsHeaders);
    }
    
    if (pathname === '/api/agents' && request.method === 'GET') return addCors(await api.handleListAgents(), corsHeaders);
    if (pathname === '/api/sessions' && request.method === 'GET') return addCors(await api.handleListSessions(), corsHeaders);
    if (pathname === '/api/session' && request.method === 'POST') return addCors(await api.handleCreateSession(await request.json().catch(() => ({}))), corsHeaders);
    if (pathname.match(/^\/api\/session\/[^/]+$/) && request.method === 'DELETE') return addCors(await api.handleDeleteSession(pathname.split('/')[3]), corsHeaders);
    if (pathname === '/api/models' && request.method === 'GET') return addCors(await api.handleListModels(url.searchParams.get('backend') || undefined), corsHeaders);
    if (pathname.match(/^\/api\/session\/[^/]+\/history$/) && request.method === 'GET') return addCors(await api.handleGetHistory(pathname.split('/')[3]), corsHeaders);
    if (pathname.match(/^\/api\/session\/[^/]+\/ui-mode$/) && request.method === 'POST') {
      const sessionId = pathname.split('/')[3];
      const body = await request.json().catch(() => ({}));
      return addCors(await api.handleSetUIMode(sessionId, body.uiMode || 'chat'), corsHeaders);
    }
    if (pathname.match(/^\/api\/session\/[^/]+\/stream$/) && request.method === 'GET') return api.handleSessionStream(pathname.split('/')[3]);
    if (pathname.match(/^\/api\/session\/[^/]+\/errors$/) && request.method === 'GET') return addCors(await api.handleErrorStream(pathname.split('/')[3]), corsHeaders);
    
    if (pathname.match(/^\/api\/session\/[^/]+\/web$/) && request.method === 'POST') {
      const sessionId = pathname.split('/')[3];
      const body = await request.json();
      if (!body.url) return new Response(JSON.stringify({ error: 'URL required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      return addCors(await api.handleFetchWeb(sessionId, body.url), corsHeaders);
    }
    
    if (pathname.match(/^\/api\/session\/[^/]+\/chunk$/) && request.method === 'POST') {
      const sessionId = pathname.split('/')[3];
      const body = await request.json();
      return addCors(await api.handleAddChunk(sessionId, {
        content: body.content,
        contentType: body.contentType,
        producer: body.producer,
        annotations: body.annotations,
        emit: body.emit === true
      }), corsHeaders);
    }
    
    if (pathname.match(/^\/api\/session\/[^/]+\/chunk\/[^/]+\/trust$/) && request.method === 'POST') {
      const parts = pathname.split('/');
      const [,,, sessionId,, chunkId] = parts;
      const body = await request.json();
      return addCors(await api.handleToggleTrust(sessionId, chunkId, body.trusted === true), corsHeaders);
    }
    
    if (pathname.match(/^\/api\/chat\/[^/]+$/) && request.method === 'POST') {
      const sessionId = pathname.split('/')[3];
      const body = await request.json();
      
      if (body.audio) {
        const session = getSession(sessionId);
        if (!session) return new Response(JSON.stringify({ error: 'Session not found' }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        
        const { data, mimeType, duration } = body.audio;
        if (!data || !mimeType) return new Response(JSON.stringify({ error: 'Audio data and MIME type required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        
        let audioUint8: Uint8Array;
        if (Array.isArray(data)) audioUint8 = new Uint8Array(data);
        else if (typeof data === 'object' && data !== null) {
          if (data.type === 'Buffer' && Array.isArray(data.data)) audioUint8 = new Uint8Array(data.data);
          else audioUint8 = new Uint8Array(Object.values(data));
        } else {
          return new Response(JSON.stringify({ error: 'Invalid audio data format' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }
        
        const audioChunk = createBinaryChunk(audioUint8, mimeType, 'com.rxcafe.user', {
          'chat.role': 'user',
          'audio.duration': duration,
          'client.type': 'web',
          'admin.authorized': verifyAdmin(request).isAdmin
        });
        
        session.inputStream.next(audioChunk);
        return new Response(JSON.stringify({ success: true, chunk: audioChunk }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      
      const message = body.message;
      if (!message || typeof message !== 'string') return new Response(JSON.stringify({ error: 'Message or audio required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      
      const { isAdmin } = verifyAdmin(request);
      return addCors(await api.handleChatStream(sessionId, message, isAdmin), corsHeaders);
    }
    
    if (pathname.match(/^\/api\/chat\/[^/]+\/abort$/) && request.method === 'POST') {
      return addCors(await api.handleAbort(pathname.split('/')[3]), corsHeaders);
    }
    
    if (pathname === '/api/connected-agents' && request.method === 'POST') {
      return addCors(api.handleRegisterConnectedAgent(await request.json().catch(() => ({}))), corsHeaders);
    }
    
    if (pathname === '/api/system/command' && request.method === 'POST') {
      const { isAdmin } = verifyAdmin(request);
      if (!isAdmin) return addCors(createForbiddenResponse(), corsHeaders);
      return addCors(await api.handleSystemCommand(request), corsHeaders);
    }
    
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }
});

const protocol = USE_HTTPS ? 'https' : 'http';
console.log(`Server running at ${protocol}://localhost:${PORT}?token=${webToken}`);

(async () => {
  console.log('[Server] Loading agents...');
  await loadAgentsFromDisk();
  
  const agents = listAgentsFromCore();
  console.log(`[Server] Loaded ${agents.length} agents: ${agents.map(a => a.name).join(', ')}`);
  
  console.log('[Server] Restoring persisted sessions...');
  const restoredCount = await restorePersistedSessions(config);
  if (restoredCount > 0) console.log(`[Server] Restored ${restoredCount} sessions from persistence`);
  
  console.log('[Server] Starting background agents...');
  await startBackgroundAgents(config);
  
  await initTelegramHandler({ trustDb, sessionStore, config });
  await restoreTelegramSubscriptions();
})();

process.on('SIGINT', () => { console.log('\nShutting down...'); shutdown(); trustDb.close(); process.exit(0); });
process.on('SIGTERM', () => { console.log('\nShutting down...'); shutdown(); trustDb.close(); process.exit(0); });
