import { createBinaryChunk, type Chunk } from './chunk.js';
import type { Session } from '../core.js';
import { TelegramBot, type TelegramUser, type TelegramConfig, type TelegramVoice, type TelegramAudio } from './telegram.js';
import type { Database } from './database.js';
import type { SessionStore } from './session-store.js';
import type { Subscription } from './stream.js';
import type { CoreConfig } from '../core.js';
import { getSession, createSession, fetchWebContent, toggleChunkTrust, addChunkToSession, listAgents as listAgentsFromCore, listActiveSessions } from '../core.js';
import type { ConnectedAgent } from './connected-agents.js';

export interface TelegramSubscriptions {
  currentSession: Map<number, string>;
  allSessions: Map<number, Set<string>>;
  subscriptions: Map<number, Map<string, Subscription>>;
}

export const telegramState: TelegramSubscriptions = {
  currentSession: new Map<number, string>(),
  allSessions: new Map<number, Set<string>>(),
  subscriptions: new Map<number, Map<string, Subscription>>()
};

let telegramBot: TelegramBot | null = null;
let trustDb: Database | null = null;
let sessionStore: SessionStore | null = null;
let config: CoreConfig | null = null;

export function getTelegramBot(): TelegramBot | null {
  return telegramBot;
}

export interface TelegramHandlerDeps {
  trustDb: Database;
  sessionStore: SessionStore;
  config: CoreConfig;
}

export async function initTelegramHandler(deps: TelegramHandlerDeps): Promise<TelegramBot | null> {
  trustDb = deps.trustDb;
  sessionStore = deps.sessionStore;
  config = deps.config;

  const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
  const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL;

  if (!TELEGRAM_TOKEN) {
    console.log('Telegram bot not configured. Set TELEGRAM_TOKEN to enable.');
    return null;
  }

  const telegramConfig: TelegramConfig = {
    token: TELEGRAM_TOKEN,
    webhookUrl: TELEGRAM_WEBHOOK_URL,
    polling: !TELEGRAM_WEBHOOK_URL
  };

  telegramBot = new TelegramBot(telegramConfig);

  try {
    await telegramBot.init();
    setupMessageHandlers();
    setupCallbackHandlers();
    console.log('[Telegram] Bot initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Telegram bot:', error);
    telegramBot = null;
  }

  return telegramBot;
}

function setupMessageHandlers() {
  if (!telegramBot) return;

  telegramBot.onMessage(async (chatId, text, user, voice, audio) => {
    const isTrusted = trustDb?.isTelegramUserTrusted(user.id, user.username);
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

    if (voice || audio) {
      await handleAudioMessage(chatId, user, voice, audio);
      return;
    }

    if (!text) return;

    console.log(`Telegram message from ${user.first_name} (${user.username || 'no username'}) ID:${user.id}: ${text.substring(0, 50)}...`);

    const sessionId = await getOrCreateSession(chatId);
    if (!sessionId) {
      await telegramBot!.sendMessage(chatId, '❌ Session error. Use /new to create a new session.');
      telegramState.currentSession.delete(chatId);
      return;
    }

    const session = getSession(sessionId);
    if (!session) {
      await telegramBot!.sendMessage(chatId, '❌ Session error. Use /new to create a new session.');
      telegramState.currentSession.delete(chatId);
      return;
    }

    ensureSubscription(chatId, session);
    await handleCommand(chatId, text, session, sessionId);
  });
}

function setupCallbackHandlers() {
  if (!telegramBot) return;

  telegramBot.onCallback(async (chatId, data, user, callbackId) => {
    if (data.startsWith('trust:')) {
      const parts = data.split(':');
      const chunkId = parts[1];
      const trusted = parts[2] === 'true';

      const sessionId = telegramState.currentSession.get(chatId);
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
      await switchSession(chatId, targetSessionId);
    } else if (data.startsWith('qr:')) {
      const parts = data.split(':');
      const response = parts.slice(2).join(':');

      await telegramBot!.answerCallback(callbackId, `📝 ${response}`);

      const sessionId = telegramState.currentSession.get(chatId);
      if (!sessionId) return;

      const session = getSession(sessionId);
      if (!session) return;

      await handleChatMessage(chatId, session, response);
    }
  });
}

async function getOrCreateSession(chatId: number): Promise<string | null> {
  let sessionId = telegramState.currentSession.get(chatId);
  if (sessionId) return sessionId;

  const defaultTelegramSessionId = 'default-telegram';
  console.log(`[Telegram] Ensuring default session exists: ${defaultTelegramSessionId}`);

  let session = getSession(defaultTelegramSessionId);

  if (!session && sessionStore) {
    const sessionData = await sessionStore.loadSession(defaultTelegramSessionId);
    if (sessionData) {
      console.log(`[Telegram] Restoring default session from store`);
      session = await createSession(config!, {
        agentId: sessionData.agentName,
        isBackground: sessionData.isBackground,
        sessionId: defaultTelegramSessionId,
      });
      if (session._agentContext) await session._agentContext.loadState();
    }
  }

  if (!session) {
    console.log(`[Telegram] Creating new default session`);
    session = await createSession(config!, {
      sessionId: defaultTelegramSessionId,
      agentId: 'default'
    });
  }

  sessionId = session.id;
  telegramState.currentSession.set(chatId, sessionId);

  if (!telegramState.allSessions.has(chatId)) {
    telegramState.allSessions.set(chatId, new Set());
  }
  telegramState.allSessions.get(chatId)!.add(sessionId);

  console.log(`[Telegram] Using session ${sessionId} for chat ${chatId}`);
  await telegramBot!.sendMessage(chatId, `🤖 *RXCAFE Bot Ready*\n\nUsing session: \`default-telegram\`\nAgent: ${session.agentName}\n\nType /help for available commands.`, { parseMode: 'Markdown' });

  return sessionId;
}

async function handleCommand(chatId: number, text: string, session: Session, sessionId: string) {
  if (!telegramBot) return;

  if (text === '/start' || text.startsWith('/start ')) {
    await telegramBot.sendMessage(chatId, `👋 Welcome to RXCAFE Chat!\n\nCurrent session: \`${sessionId}\`\nAgent: ${session.agentName}\n\nUse /help to see available commands.`, { parseMode: 'Markdown' });
    return;
  }

  if (text === '/help') {
    await telegramBot.sendMessage(chatId, `*Available Commands:*

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
    await telegramBot.sendMessage(chatId, `Current Session ID:\n\`${sessionId}\``, { parseMode: 'Markdown' });
    return;
  }

  if (text === '/share') {
    const url = `${process.env.PUBLIC_URL || 'http://localhost:' + process.env.PORT || 3000}/#${sessionId}`;
    await telegramBot.sendMessage(chatId, `Shareable Web Link:\n${url}`, { parseMode: 'Markdown' });
    return;
  }

  if (text.startsWith('/join ')) {
    const targetId = text.slice(6).trim();
    const targetSession = getSession(targetId);

    if (!targetSession) {
      await telegramBot.sendMessage(chatId, `❌ Session not found: \`${targetId}\``, { parseMode: 'Markdown' });
      return;
    }

    telegramState.currentSession.set(chatId, targetId);
    if (!telegramState.allSessions.has(chatId)) {
      telegramState.allSessions.set(chatId, new Set());
    }
    telegramState.allSessions.get(chatId)!.add(targetId);

    await telegramBot.sendMessage(chatId, `✅ Joined session: \`${targetId}\`\nAgent: ${targetSession.agentName}\nName: ${targetSession.displayName || 'None'}`, { parseMode: 'Markdown' });

    ensureSubscription(chatId, targetSession);
    return;
  }

  if (text === '/subscriptions') {
    const subs = trustDb?.listTelegramSubscriptions(chatId) || [];
    if (subs.length === 0) {
      await telegramBot.sendMessage(chatId, 'No active auto-subscriptions.');
    } else {
      const list = subs.map(sid => `• \`${sid}\``).join('\n');
      await telegramBot.sendMessage(chatId, `*Your Auto-Subscriptions:*\n\n${list}`, { parseMode: 'Markdown' });
    }
    return;
  }

  if (text.startsWith('/subscribe ')) {
    const targetId = text.slice(11).trim();
    trustDb?.addTelegramSubscription(chatId, targetId);

    const targetSession = getSession(targetId);
    if (targetSession) {
      ensureSubscription(chatId, targetSession);
      await telegramBot.sendMessage(chatId, `✅ Subscribed to \`${targetId}\`. You will now receive updates automatically.`);
    } else {
      await telegramBot.sendMessage(chatId, `✅ Subscribed to \`${targetId}\`. Updates will start once the session is active.`);
    }
    return;
  }

  if (text.startsWith('/unsubscribe ')) {
    const targetId = text.slice(13).trim();
    const success = trustDb?.removeTelegramSubscription(chatId, targetId) || false;
    if (success) {
      if (sessionId !== targetId) {
        const subsMap = telegramState.subscriptions.get(chatId);
        if (subsMap instanceof Map) {
          const sub = subsMap.get(targetId);
          if (sub) {
            sub.unsubscribe();
            subsMap.delete(targetId);
          }
        }
      }
      await telegramBot.sendMessage(chatId, `✅ Unsubscribed from \`${targetId}\`.`);
    } else {
      await telegramBot.sendMessage(chatId, `❌ Not subscribed to \`${targetId}\`.`);
    }
    return;
  }

  if (text === '/agents') {
    const agents = listAgentsFromCore();
    const agentList = agents.map(a => {
      const bg = a.startInBackground ? ' [background]' : '';
      return `• *${a.name}*${bg}\n  ${a.description || 'No description'}`;
    }).join('\n');
    await telegramBot.sendMessage(chatId, `*Available Agents:*\n\n${agentList}`, { parseMode: 'Markdown' });
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
      await telegramBot.sendMessage(chatId, 'No sessions found. Use /new to create one.');
      return;
    }

    const buttons = allSessions.map(s => {
      const name = s.displayName || s.agentName;
      const current = s.id === sessionId ? '✓ ' : '';
      const bg = s.isBackground ? ' ⚙️' : '';
      return [{ text: `${current}${name}${bg}`, callback_data: `switch:${s.id}` }];
    }) as any[][];

    await telegramBot.sendMessage(chatId, `*All Available Sessions:*\nSelect a session to switch:`, {
      parseMode: 'Markdown',
      replyMarkup: { inline_keyboard: buttons }
    });
    return;
  }

  if (text.startsWith('/switch ')) {
    const targetSessionId = text.slice(8).trim();
    await switchSession(chatId, targetSessionId);
    return;
  }

  if (text === '/new' || text.startsWith('/new ')) {
    const agentName = text.slice(4).trim() || 'default';
    console.log(`[Telegram] Creating new session for chat ${chatId} with agent ${agentName}`);

    try {
      const newSession = await createSession(config!, { agentId: agentName });

      if (!telegramState.allSessions.has(chatId)) {
        telegramState.allSessions.set(chatId, new Set());
      }
      telegramState.allSessions.get(chatId)!.add(newSession.id);
      telegramState.currentSession.set(chatId, newSession.id);

      await telegramBot.sendMessage(chatId, `✅ New session created\n\nSession: \`${newSession.id}\`\nAgent: ${newSession.agentName}`, { parseMode: 'Markdown' });
    } catch (err) {
      await telegramBot.sendMessage(chatId, `❌ Failed to create session: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    return;
  }

  if (text.startsWith('/web ')) {
    const url = text.slice(5).trim();
    await handleWebCommand(chatId, session, url);
    return;
  }

  if (text.startsWith('/system ')) {
    const prompt = text.slice(8).trim();
    handleSystemCommand(chatId, session, prompt);
    return;
  }

  await handleChatMessage(chatId, session, text);
}

async function handleWebCommand(chatId: number, session: Session, url: string): Promise<void> {
  if (!telegramBot) return;

  await telegramBot.sendMessage(chatId, `🌐 Fetching ${url}...`);

  try {
    const chunk = await fetchWebContent(url);
    session.inputStream.next(chunk);

    const isTrusted = chunk.annotations?.['security.trust-level']?.trusted === true;
    const messageText = `🌐 *Web Content Fetched*\n\nSource: ${url}\nStatus: ${isTrusted ? '✅ Trusted' : '⚠️ Untrusted'}\n\n${(chunk.content as string).substring(0, 500)}${(chunk.content as string).length > 500 ? '...' : ''}`;

    if (!isTrusted) {
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

function handleSystemCommand(chatId: number, session: Session, prompt: string): void {
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

async function handleAudioMessage(chatId: number, user: TelegramUser, voice?: TelegramVoice, audio?: TelegramAudio): Promise<void> {
  if (!telegramBot) return;

  const audioInfo = voice || audio;
  if (!audioInfo) return;

  const duration = audioInfo.duration || 0;
  const mimeType = audioInfo.mime_type || 'audio/ogg';
  const fileId = audioInfo.file_id;

  console.log(`[Telegram] Processing audio message, duration: ${duration}s, mimeType: ${mimeType}`);

  let statusMessage: any;
  try {
    statusMessage = await telegramBot.sendMessage(chatId, '🎙️ Processing audio...');
  } catch (error) {
    console.error('[Telegram] Failed to send status message:', error);
  }

  try {
    const file = await telegramBot.getFile(fileId);
    if (!file.file_path) {
      throw new Error('Failed to get file path from Telegram');
    }

    const audioData = await telegramBot.downloadFile(file.file_path);
    console.log(`[Telegram] Downloaded ${audioData.length} bytes`);

    const sessionId = await getOrCreateSession(chatId);
    if (!sessionId) {
      await telegramBot.sendMessage(chatId, '❌ Session error. Use /new to create a new session.');
      telegramState.currentSession.delete(chatId);
      return;
    }

    const session = getSession(sessionId);
    if (!session) {
      await telegramBot.sendMessage(chatId, '❌ Session error. Use /new to create a new session.');
      telegramState.currentSession.delete(chatId);
      return;
    }

    ensureSubscription(chatId, session);

    const audioChunk = createBinaryChunk(
      audioData,
      mimeType,
      'com.rxcafe.user',
      {
        'chat.role': 'user',
        'audio.duration': duration,
        'telegram.chatId': chatId,
        'client.type': 'telegram',
        'telegram.voice': !!voice,
        'telegram.audio': !!audio
      }
    );

    session.inputStream.next(audioChunk);

    if (statusMessage?.message_id) {
      try {
        await telegramBot.deleteMessage(chatId, statusMessage.message_id);
      } catch {
        // Ignore errors
      }
    }

    console.log(`[Telegram] Audio chunk sent to session ${sessionId}`);

  } catch (error) {
    console.error('[Telegram] Error processing audio:', error);
    await telegramBot.sendMessage(chatId, `❌ Failed to process audio: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

async function handleChatMessage(chatId: number, session: Session, message: string): Promise<void> {
  if (!telegramBot || !config) return;

  console.log(`[Telegram] Processing message: "${message.substring(0, 50)}..."`);

  let statusMessage: any;
  try {
    statusMessage = await telegramBot.sendMessage(chatId, '🤔 Thinking...');
    console.log(`[Telegram] Sent status message, ID: ${statusMessage.message_id}`);
  } catch (error) {
    console.error('[Telegram] Failed to send status message:', error);
  }

  let fullResponse = '';
  let messageId: number | null = null;
  let lastUpdateResponse = '';
  let updateInProgress = false;

  const { processChatMessage } = await import('../core.js');

  try {
    await processChatMessage(
      session,
      message,
      {
        onToken: (token: string) => {
          fullResponse += token;

          if (fullResponse.length - lastUpdateResponse.length >= 20 && !updateInProgress) {
            updateInProgress = true;
            updateMessage(chatId, fullResponse, messageId).then(id => {
              if (id) messageId = id;
              lastUpdateResponse = fullResponse;
              updateInProgress = false;
            }).catch(() => {
              updateInProgress = false;
            });
          }
        },
        onFinish: async () => {
          console.log(`[Telegram] LLM evaluation complete. Response length: ${fullResponse.length}`);

          const start = Date.now();
          while (updateInProgress && Date.now() - start < 5000) {
            await new Promise(r => setTimeout(r, 100));
          }

          finalizeMessage(chatId, fullResponse, messageId, statusMessage?.message_id);
        },
        onError: (error: Error) => {
          console.error('[Telegram] LLM error:', error);

          const waitAndSend = async () => {
            const start = Date.now();
            while (updateInProgress && Date.now() - start < 5000) {
              await new Promise(r => setTimeout(r, 100));
            }
            await telegramBot!.sendMessage(chatId, `❌ Error: ${error.message}`);
          };

          waitAndSend();
        }
      },
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

async function updateMessage(chatId: number, text: string, messageId: number | null): Promise<number | null> {
  if (!telegramBot) return null;

  try {
    if (!messageId) {
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

async function finalizeMessage(chatId: number, text: string, messageId: number | null, statusMessageId?: number): Promise<void> {
  if (!telegramBot) return;

  try {
    if (!messageId) {
      if (text) {
        await telegramBot.sendMessage(chatId, text);
      }
    } else {
      await telegramBot.editMessage(chatId, messageId, text);
    }

    if (statusMessageId) {
      try {
        await telegramBot.deleteMessage(chatId, statusMessageId);
      } catch {
        // Ignore errors
      }
    }
  } catch (error) {
    console.error('[Telegram] Failed to finalize message:', error);
  }
}

async function switchSession(chatId: number, targetSessionId: string): Promise<void> {
  if (!telegramBot || !config) return;

  const previousSessionId = telegramState.currentSession.get(chatId);
  if (previousSessionId && previousSessionId !== targetSessionId) {
    const persistentSubs = trustDb?.listTelegramSubscriptions(chatId) || [];
    if (!persistentSubs.includes(previousSessionId)) {
      const subsMap = telegramState.subscriptions.get(chatId);
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

  if (!telegramState.allSessions.has(chatId)) {
    telegramState.allSessions.set(chatId, new Set());
  }
  telegramState.allSessions.get(chatId)!.add(targetSessionId);

  telegramState.currentSession.set(chatId, targetSessionId);
  await telegramBot.sendMessage(chatId, `✅ Switched to session: \`${targetSessionId}\`\nAgent: ${targetSession.agentName}\nName: ${targetSession.displayName || 'None'}`, { parseMode: 'Markdown' });

  ensureSubscription(chatId, targetSession);
}

function ensureSubscription(chatId: number, session: Session) {
  let subsMap = telegramState.subscriptions.get(chatId);
  if (!subsMap) {
    subsMap = new Map<string, Subscription>();
    telegramState.subscriptions.set(chatId, subsMap);
  }

  if (subsMap.has(session.id)) {
    return;
  }

  console.log(`[Telegram] Subscribing chat ${chatId} to session ${session.id} outputStream`);

  const sub = session.outputStream.subscribe({
    next: async (chunk: Chunk) => {
      if (!telegramBot) return;

      if (chunk.annotations['chat.role'] === 'user' && chunk.annotations['telegram.chatId'] === chatId) return;
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
      } else if (chunk.contentType === 'text') {
        const role = chunk.annotations['chat.role'];
        const isAssistant = role === 'assistant';
        const isUser = role === 'user';
        const isSystem = role === 'system';
        const isWeb = chunk.producer === 'com.rxcafe.web-fetch' || chunk.annotations['web.source-url'];

        if (isUser) {
          await telegramBot.sendMessage(chatId, `👤 *User:* ${chunk.content}`, { parseMode: 'Markdown' });
        } else if (isWeb) {
          const url = chunk.annotations['web.source-url'] || 'unknown';
          await telegramBot.sendMessage(chatId, `🌐 *Web Content:* ${url}\n\n${(chunk.content as string).substring(0, 500)}...`, { parseMode: 'Markdown' });
        } else if (isSystem) {
          await telegramBot.sendMessage(chatId, `⚙️ *System:* ${chunk.content}`, { parseMode: 'Markdown' });
        } else if (isAssistant) {
          if (!chunk.content || (typeof chunk.content === 'string' && !chunk.content.trim())) {
            return;
          }
          const quickResponses = chunk.annotations['com.rxcafe.quickResponses'];
          if (quickResponses && Array.isArray(quickResponses) && quickResponses.length > 0) {
            await telegramBot.sendMessage(chatId, chunk.content as string, {
              replyMarkup: telegramBot.createQuickResponsesKeyboard(quickResponses)
            });
          } else {
            await telegramBot.sendMessage(chatId, chunk.content as string);
          }
        }
      }
    }
  });

  subsMap.set(session.id, sub);
}

export async function restoreTelegramSubscriptions(): Promise<void> {
  if (!telegramBot || !trustDb) return;

  console.log('[Telegram] Restoring persistent auto-subscriptions...');
  const allSubs = trustDb.listAllTelegramSubscriptions();
  for (const sub of allSubs) {
    const session = getSession(sub.sessionId);
    if (session) {
      ensureSubscription(sub.chatId, session);
    }
  }
}

export function getTelegramState(): TelegramSubscriptions {
  return telegramState;
}
