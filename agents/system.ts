/**
 * System Agent
 * Background agent for administrative operations via API.
 * Session ID: 'system'
 */

import type { AgentDefinition, AgentSessionContext, ChatCallbacks } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { createTextChunk, createNullChunk } from '../lib/chunk.js';
import { EMPTY, filter, map, mergeMap, catchError, tap } from '../lib/stream.js';
import { Database } from '../lib/database.js';
import { getSession, listActiveSessions, deleteSession } from '../core.js';
import { connectedAgentStore } from '../lib/connected-agents.js';
import { reloadAgents } from '../lib/agent-loader.js';

const TRUST_DB_PATH = process.env.TRUST_DB_PATH || './rxcafe-trust.db';

function parseCommand(text: string): { command: string; args: string[] } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('!')) return null;
  
  const parts = trimmed.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);
  
  return { command, args };
}

function createResponseChunk(content: string, isMarkdown: boolean = false): Chunk {
  const annotations: Record<string, any> = {
    'chat.role': 'assistant',
    'system.response': true
  };
  if (isMarkdown) {
    annotations['parsers.markdown.enabled'] = true;
  }
  return createTextChunk(content, 'com.rxcafe.system-agent', annotations);
}

function createErrorChunk(message: string): Chunk {
  return createTextChunk(message, 'com.rxcafe.system-agent', {
    'chat.role': 'assistant',
    'system.error': true
  });
}

export const systemAgent: AgentDefinition = {
  name: 'system',
  description: 'Background agent for administrative operations. API-only access.',
  startInBackground: true,
  allowsReload: false,  // System agent maintains state - reload would disrupt admin operations
  configSchema: {
    type: 'object',
    properties: {},
    required: []
  },
  
  async initialize(session: AgentSessionContext) {
    const trustDb = new Database(TRUST_DB_PATH);
    
    await session.loadState();
    
    const sub = session.inputStream.pipe(
      filter((chunk: Chunk) => chunk.contentType === 'text'),
      filter((chunk: Chunk) => {
        const isAdmin = chunk.annotations['admin.authorized'] === true;
        if (!isAdmin) {
          const errorMsg = 'Admin privileges required. Access the system session with an admin token.';
          const callbacks = session.callbacks;
          if (callbacks?.onToken) {
            callbacks.onToken(errorMsg);
          }
          if (callbacks?.onFinish) {
            callbacks.onFinish();
          }
          session.outputStream.next(createErrorChunk(errorMsg));
          return false;
        }
        return true;
      }),
      mergeMap(async (chunk: Chunk) => {
        const text = chunk.content as string;
        const parsed = parseCommand(text);
        
        if (!parsed) {
          return [createErrorChunk('Invalid command. Commands start with !. Try !help')];
        }
        
        const { command, args } = parsed;
        
        try {
          switch (command) {
            case '!help':
              return handleHelp();
            
            case '!tokens':
              return handleTokens(trustDb);
            
            case '!token-create':
              return handleTokenCreate(trustDb, args);
            
            case '!token-revoke':
              return handleTokenRevoke(trustDb, args);
            
            case '!token-admin':
              return handleTokenAdmin(trustDb, args);
            
            case '!telegram-users':
              return handleTelegramUsers(trustDb);
            
            case '!telegram-trust':
              return handleTelegramTrust(trustDb, args);
            
            case '!telegram-untrust':
              return handleTelegramUntrust(trustDb, args);
            
            case '!sessions':
              return handleSessions();
            
            case '!session-kill':
              return handleSessionKill(args);
            
            case '!agents':
              return handleAgents();
            
            case '!agent-kick':
              return handleAgentKick(args);
            
            case '!status':
              return handleStatus(trustDb);
            
            case '!reload':
              return await handleReload(args);
            
            default:
              return [createErrorChunk(`Unknown command: ${command}\n\nType !help for available commands.`)];
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          return [createErrorChunk(`Error: ${message}`)];
        }
      }),
      mergeMap(chunks => chunks),
      catchError((error: Error) => {
        session.errorStream.next(error);
        return EMPTY;
      })
    ).subscribe({
      next: (chunk: Chunk) => {
        session.outputStream.next(chunk);
        if (chunk.contentType === 'text') {
          const callbacks = session.callbacks;
          if (callbacks?.onToken) {
            callbacks.onToken(chunk.content as string);
          }
          if (callbacks?.onFinish) {
            callbacks.onFinish();
          }
        }
      },
      error: (error: Error) => session.errorStream.next(error)
    });
    
    session.pipelineSubscription = sub;
  }
};

function handleHelp(): Chunk[] {
  const lines = [
    'System Agent Commands',
    '=====================',
    '',
    'Token Management:',
    '  !tokens                    List all API tokens',
    '  !token-create [desc] [--admin]  Create new token',
    '  !token-revoke <id>         Revoke a token',
    '  !token-admin <id>          Toggle admin status',
    '',
    'Telegram Users:',
    '  !telegram-users            List trusted Telegram users',
    '  !telegram-trust <id|user> [desc]  Trust a user',
    '  !telegram-untrust <id|user>  Untrust a user',
    '',
    'Sessions:',
    '  !sessions                  List all active sessions',
    '  !session-kill <id>         Delete a session',
    '',
    'Connected Agents:',
    '  !agents                    List connected agents',
    '  !agent-kick <id>           Unregister an agent',
    '',
    'System:',
    '  !status                    Show system health summary',
    '  !reload [agent1 agent2...] Reload all agents or specific ones',
    '  !help                      Show this help message',
  ];
  
  return [createResponseChunk(lines.join('\n'), true)];
}

function handleTokens(trustDb: Database): Chunk[] {
  const clients = trustDb.listClients();
  
  if (clients.length === 0) {
    return [createResponseChunk('No API tokens found.')];
  }
  
  const lines = [
    `**API Tokens (${clients.length}):**`,
    '',
    '| ID | Admin | Description | Created | Uses |',
    '|----|-------|-------------|---------|------|'
  ];
  
  for (const client of clients) {
    const admin = client.isAdmin ? '✓' : '';
    const desc = client.description || '';
    const created = new Date(client.createdAt).toLocaleDateString();
    const uses = client.useCount;
    
    lines.push(`| ${client.id} | ${admin} | ${desc} | ${created} | ${uses} |`);
  }
  
  return [createResponseChunk(lines.join('\n'), true)];
}

function handleTokenCreate(trustDb: Database, args: string[]): Chunk[] {
  const description = args[0] && !args[0].startsWith('--') ? args.join(' ') : undefined;
  const isAdmin = args.includes('--admin');
  
  const token = trustDb.addClientWithAdmin(description, isAdmin);
  
  const lines = [
    '✅ New token created:',
    '',
    `Token: ${token}`,
    '',
    'Share this token securely. It cannot be retrieved later.'
  ];
  
  if (description) {
    lines.push(`Description: ${description}`);
  }
  if (isAdmin) {
    lines.push('Admin: YES');
  }
  
  return [createResponseChunk(lines.join('\n'))];
}

function handleTokenRevoke(trustDb: Database, args: string[]): Chunk[] {
  if (args.length === 0) {
    return [createErrorChunk('Usage: !token-revoke <id>')];
  }
  
  const id = parseInt(args[0]);
  if (isNaN(id)) {
    return [createErrorChunk('Invalid token ID. Must be a number.')];
  }
  
  const client = trustDb.getClientById(id);
  if (!client) {
    return [createErrorChunk(`Token ${id} not found.`)];
  }
  
  const success = trustDb.removeClient(id);
  
  if (success) {
    return [createResponseChunk(`✅ Token ${id} revoked successfully.\nDescription: ${client.description || 'none'}`)];
  } else {
    return [createErrorChunk(`Failed to revoke token ${id}.`)];
  }
}

function handleTokenAdmin(trustDb: Database, args: string[]): Chunk[] {
  if (args.length === 0) {
    return [createErrorChunk('Usage: !token-admin <id>')];
  }
  
  const id = parseInt(args[0]);
  if (isNaN(id)) {
    return [createErrorChunk('Invalid token ID. Must be a number.')];
  }
  
  const client = trustDb.getClientById(id);
  if (!client) {
    return [createErrorChunk(`Token ${id} not found.`)];
  }
  
  const newStatus = !client.isAdmin;
  const success = trustDb.setAdminStatus(id, newStatus);
  
  if (success) {
    return [createResponseChunk(`✅ Token ${id} admin status: ${newStatus ? 'ENABLED' : 'DISABLED'}\nDescription: ${client.description || 'none'}`)];
  } else {
    return [createErrorChunk(`Failed to update token ${id}.`)];
  }
}

function handleTelegramUsers(trustDb: Database): Chunk[] {
  const users = trustDb.listTrustedTelegramUsers();
  
  if (users.length === 0) {
    return [createResponseChunk('No trusted Telegram users found.')];
  }
  
  const lines = [
    `**Trusted Telegram Users (${users.length}):**`,
    '',
    '| ID | User ID | Username | First Name | Uses |',
    '|----|---------|----------|------------|------|'
  ];
  
  for (const user of users) {
    const userId = user.telegramUserId?.toString() || 'N/A';
    const username = user.username || 'N/A';
    const firstName = user.firstName || 'N/A';
    const uses = user.useCount;
    
    lines.push(`| ${user.id} | ${userId} | ${username} | ${firstName} | ${uses} |`);
  }
  
  return [createResponseChunk(lines.join('\n'), true)];
}

function handleTelegramTrust(trustDb: Database, args: string[]): Chunk[] {
  if (args.length === 0) {
    return [createErrorChunk('Usage: !telegram-trust <id|username> [description]')];
  }
  
  const identifier = args[0];
  const description = args.slice(1).join(' ') || undefined;
  
  const userId = parseInt(identifier);
  
  if (!isNaN(userId)) {
    trustDb.trustTelegramUser(userId, undefined, undefined, description);
    return [createResponseChunk(`✅ Trusted Telegram user ID: ${userId}${description ? `\nDescription: ${description}` : ''}`)];
  } else {
    trustDb.trustTelegramUsername(identifier, description);
    return [createResponseChunk(`✅ Trusted Telegram username: ${identifier}${description ? `\nDescription: ${description}` : ''}`)];
  }
}

function handleTelegramUntrust(trustDb: Database, args: string[]): Chunk[] {
  if (args.length === 0) {
    return [createErrorChunk('Usage: !telegram-untrust <id|username>')];
  }
  
  const identifier = args[0];
  const userId = parseInt(identifier);
  let success: boolean;
  
  if (!isNaN(userId)) {
    success = trustDb.untrustTelegramUser(userId);
    if (success) {
      return [createResponseChunk(`✅ Untrusted Telegram user ID: ${userId}`)];
    } else {
      return [createErrorChunk(`Telegram user ID ${userId} not found.`)];
    }
  } else {
    success = trustDb.untrustTelegramUsername(identifier);
    if (success) {
      return [createResponseChunk(`✅ Untrusted Telegram username: ${identifier}`)];
    } else {
      return [createErrorChunk(`Telegram username ${identifier} not found.`)];
    }
  }
}

function handleSessions(): Chunk[] {
  const sessions = listActiveSessions();
  
  if (sessions.length === 0) {
    return [createResponseChunk('No active sessions found.')];
  }
  
  const lines = [
    `**Active Sessions (${sessions.length}):**`,
    '',
    '| Session ID | Agent | Background | Name |',
    '|------------|-------|------------|------|'
  ];
  
  for (const s of sessions) {
    const id = s.id.length > 20 ? s.id.slice(0, 20) + '...' : s.id;
    const bg = s.isBackground ? '✓' : '';
    const name = s.displayName || '';
    
    lines.push(`| ${id} | ${s.agentName} | ${bg} | ${name} |`);
  }
  
  return [createResponseChunk(lines.join('\n'), true)];
}

function handleSessionKill(args: string[]): Chunk[] {
  if (args.length === 0) {
    return [createErrorChunk('Usage: !session-kill <sessionId>')];
  }
  
  const sessionId = args[0];
  const session = getSession(sessionId);
  
  if (!session) {
    return [createErrorChunk(`Session ${sessionId} not found.`)];
  }
  
  deleteSession(sessionId);
  return [createResponseChunk(`✅ Session ${sessionId} killed.`)];
}

function handleAgents(): Chunk[] {
  const agents = connectedAgentStore as any;
  const agentList = agents.agents ? Array.from(agents.agents.values()) : [];
  
  if (agentList.length === 0) {
    return [createResponseChunk('No connected agents found.')];
  }
  
  const lines = [
    `**Connected Agents (${agentList.length}):**`,
    '',
    '| Agent ID | Name | Description |',
    '|----------|------|-------------|'
  ];
  
  for (const agent of agentList) {
    const id = agent.id.length > 20 ? agent.id.slice(0, 20) + '...' : agent.id;
    const name = agent.name || '';
    const desc = agent.description || '';
    
    lines.push(`| ${id} | ${name} | ${desc} |`);
  }
  
  return [createResponseChunk(lines.join('\n'), true)];
}

function handleAgentKick(args: string[]): Chunk[] {
  if (args.length === 0) {
    return [createErrorChunk('Usage: !agent-kick <agentId>')];
  }
  
  const agentId = args[0];
  const success = connectedAgentStore.unregister(agentId);
  
  if (success) {
    return [createResponseChunk(`✅ Agent ${agentId} kicked.`)];
  } else {
    return [createErrorChunk(`Agent ${agentId} not found.`)];
  }
}

function handleStatus(trustDb: Database): Chunk[] {
  const clients = trustDb.listClients();
  const adminClients = clients.filter(c => c.isAdmin);
  const telegramUsers = trustDb.listTrustedTelegramUsers();
  const sessions = listActiveSessions();
  const agents = (connectedAgentStore as any).agents ? Array.from((connectedAgentStore as any).agents.values()) : [];
  
  const lines = [
    'System Status',
    '=============',
    '',
    `API Tokens: ${clients.length} (${adminClients.length} admin)`,
    `Telegram Users: ${telegramUsers.length}`,
    `Active Sessions: ${sessions.length}`,
    `Connected Agents: ${agents.length}`,
    '',
    'Background Sessions:',
  ];
  
  const bgSessions = sessions.filter(s => s.isBackground);
  for (const s of bgSessions) {
    lines.push(`  - ${s.agentName}`);
  }
  
  return [createResponseChunk(lines.join('\n'))];
}

async function handleReload(args: string[]): Promise<Chunk[]> {
  const specificAgents = args.length > 0 ? args : undefined;
  const result = await reloadAgents(specificAgents);
  
  const lines = [
    '🔄 Agent Reload Complete',
    '',
  ];
  
  if (specificAgents) {
    lines.push(`**Reloading specific agents:** ${specificAgents.join(', ')}`);
    lines.push('');
  }
  
  lines.push(`**Reloaded (${result.loaded.length}):**`);
  lines.push(result.loaded.length > 0 ? result.loaded.join(', ') : '  (none)');
  lines.push('');
  
  if (result.changed.length > 0) {
    lines.push(`**Source changed:**`);
    lines.push(result.changed.join(', '));
    lines.push('');
  }
  
  if (result.newAgents.length > 0) {
    lines.push(`**New agents loaded:**`);
    lines.push(result.newAgents.join(', '));
    lines.push('');
  }
  
  if (result.skipped.length > 0) {
    lines.push(`**Skipped (denied reload, has state):**`);
    lines.push(result.skipped.join(', '));
  }
  
  return [createResponseChunk(lines.join('\n'), true)];
}

export default systemAgent;
