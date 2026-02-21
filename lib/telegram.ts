/**
 * Telegram Bot Integration for RXCAFE Chat
 * Allows Telegram to act as input/output for the chat system
 */

import { createTextChunk, createNullChunk, annotateChunk, type Chunk } from './chunk.js';

export interface TelegramConfig {
  token: string;
  webhookUrl?: string;
  polling?: boolean;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  entities?: TelegramMessageEntity[];
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
}

export type TelegramMessageHandler = (chatId: number, text: string, user: TelegramUser) => Promise<void>;
export type TelegramCallbackHandler = (chatId: number, data: string, user: TelegramUser, callbackId: string) => Promise<void>;

export class TelegramBot {
  private token: string;
  private baseUrl: string;
  private webhookUrl?: string;
  private polling: boolean;
  private pollingActive = false;
  private lastUpdateId: number = 0;
  private messageHandlers: TelegramMessageHandler[] = [];
  private callbackHandlers: TelegramCallbackHandler[] = [];
  private pendingEdits: Map<string, { text: string; timer?: NodeJS.Timeout }> = new Map();
  private editQueue: Array<{ chatId: number; messageId: number; text: string }> = [];
  private processingQueue = false;
  private lastEditTime = 0;
  private static readonly MIN_EDIT_INTERVAL_MS = 300;
  private static readonly DEBOUNCE_MS = 100;

  constructor(config: TelegramConfig) {
    this.token = config.token;
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
    this.webhookUrl = config.webhookUrl;
    this.polling = config.polling ?? !config.webhookUrl;
  }

  async init(): Promise<void> {
    // Get bot info to verify token
    const me = await this.getMe();
    console.log(`Telegram bot initialized: @${me.username}`);

    if (this.webhookUrl) {
      await this.setWebhook(this.webhookUrl);
      console.log(`Webhook set to: ${this.webhookUrl}`);
    } else if (this.polling) {
      // Clear any existing webhook first (in case one was set before)
      try {
        await this.deleteWebhook();
        console.log('Cleared existing webhook');
      } catch {
        // Ignore errors if no webhook was set
      }
      this.startPolling();
      console.log('Started polling for updates');
    }
  }

  async getMe(): Promise<TelegramUser> {
    const response = await fetch(`${this.baseUrl}/getMe`);
    const data = await response.json();
    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description}`);
    }
    return data.result;
  }

  async setWebhook(url: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await response.json();
    if (!data.ok) {
      throw new Error(`Failed to set webhook: ${data.description}`);
    }
  }

  async deleteWebhook(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/deleteWebhook`);
    const data = await response.json();
    if (!data.ok) {
      throw new Error(`Failed to delete webhook: ${data.description}`);
    }
  }

  async sendPhoto(chatId: number, photo: Uint8Array | string, caption?: string): Promise<TelegramMessage> {
    const formData = new FormData();
    formData.append('chat_id', chatId.toString());
    
    if (photo instanceof Uint8Array) {
      const blob = new Blob([photo], { type: 'image/png' });
      formData.append('photo', blob, 'photo.png');
    } else {
      formData.append('photo', photo);
    }
    
    if (caption) {
      formData.append('caption', caption);
    }

    const response = await fetch(`${this.baseUrl}/sendPhoto`, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();
    if (!data.ok) {
      throw new Error(`Failed to send photo: ${data.description}`);
    }
    return data.result;
  }

  async sendAudio(chat_id: number, audio: Uint8Array | string, caption?: string): Promise<TelegramMessage> {
    const formData = new FormData();
    formData.append('chat_id', chat_id.toString());
    
    if (audio instanceof Uint8Array) {
      const blob = new Blob([audio], { type: 'audio/wav' });
      formData.append('audio', blob, 'audio.wav');
    } else {
      formData.append('audio', audio);
    }
    
    if (caption) {
      formData.append('caption', caption);
    }

    const response = await fetch(`${this.baseUrl}/sendAudio`, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();
    if (!data.ok) {
      throw new Error(`Failed to send audio: ${data.description}`);
    }
    return data.result;
  }

  startPolling(): void {
    if (this.pollingActive) {
      console.log('Polling already active');
      return;
    }
    
    this.pollingActive = true;
    this.pollLoop();
    console.log('Started polling for updates');
  }

  stopPolling(): void {
    this.pollingActive = false;
    console.log('Stopped polling');
  }

  private async pollLoop(): Promise<void> {
    while (this.pollingActive) {
      try {
        await this.pollUpdates();
      } catch (error) {
        console.error('Polling error:', error);
      }
      
      // Small delay between polls, but only if still active
      if (this.pollingActive) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  async pollUpdates(): Promise<void> {
    // Don't poll if we've been stopped
    if (!this.pollingActive) {
      return;
    }

    try {
      const response = await fetch(`${this.baseUrl}/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offset: this.lastUpdateId + 1,
          limit: 100,
          timeout: 30
        })
      });

      const data = await response.json();
      if (!data.ok) {
        // Handle conflict error - another instance is polling
        if (data.error_code === 409) {
          console.error('Telegram polling conflict detected. Another bot instance may be running.');
          console.error('Please stop other instances or use webhook mode instead.');
          // Stop polling to prevent infinite error loop
          this.pollingActive = false;
          return;
        }
        console.error('Telegram getUpdates error:', data.description);
        return;
      }

      const updates: TelegramUpdate[] = data.result;
      if (updates.length > 0) {
        console.log(`Telegram: Received ${updates.length} update(s)`);
        for (const update of updates) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          await this.handleUpdate(update);
        }
      }
    } catch (error) {
      console.error('Telegram poll error:', error);
    }
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) {
      await this.handleMessage(update.message);
    } else if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    }
  }

  async handleMessage(message: TelegramMessage): Promise<void> {
    if (!message.text || !message.from) return;

    for (const handler of this.messageHandlers) {
      try {
        await handler(message.chat.id, message.text, message.from);
      } catch (error) {
        console.error('Message handler error:', error);
      }
    }
  }

  async handleCallbackQuery(callback: TelegramCallbackQuery): Promise<void> {
    if (!callback.data || !callback.from || !callback.message) return;

    for (const handler of this.callbackHandlers) {
      try {
        await handler(callback.message.chat.id, callback.data, callback.from, callback.id);
      } catch (error) {
        console.error('Callback handler error:', error);
      }
    }
  }

  onMessage(handler: TelegramMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onCallback(handler: TelegramCallbackHandler): void {
    this.callbackHandlers.push(handler);
  }

  async sendMessage(chatId: number, text: string, options?: {
    parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
    replyMarkup?: any;
  }): Promise<TelegramMessage> {
    // Telegram has a 4096 character limit for messages
    const maxLength = 4096;
    let messageText = text;

    if (text.length > maxLength) {
      messageText = text.substring(0, maxLength - 3) + '...';
    }

    const body: any = {
      chat_id: chatId,
      text: messageText
    };

    if (options?.parseMode) {
      body.parse_mode = options.parseMode;
    }

    if (options?.replyMarkup) {
      body.reply_markup = options.replyMarkup;
    }

    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!data.ok) {
      console.error('Failed to send message:', data.description);
      throw new Error(`Failed to send message: ${data.description}`);
    }
    
    return data.result;
  }

  async sendStreamingMessage(chatId: number, textStream: AsyncIterable<string>): Promise<void> {
    // Send initial message
    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '...'
      })
    });

    const data = await response.json();
    if (!data.ok) {
      console.error('Failed to send initial message:', data.description);
      return;
    }

    const messageId = data.result.message_id;
    let fullText = '';

    for await (const token of textStream) {
      fullText += token;
      this.editMessage(chatId, messageId, fullText + ' ▌');
    }

    await this.editMessage(chatId, messageId, fullText);
  }

  async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
    const key = `${chatId}:${messageId}`;
    const existing = this.pendingEdits.get(key);
    
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }
    
    this.pendingEdits.set(key, { text });
    
    this.pendingEdits.get(key)!.timer = setTimeout(() => {
      const pending = this.pendingEdits.get(key);
      if (pending) {
        this.pendingEdits.delete(key);
        this.editQueue.push({ chatId, messageId, text: pending.text });
        this.processEditQueue();
      }
    }, TelegramBot.DEBOUNCE_MS);
  }

  private async processEditQueue(): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;
    
    while (this.editQueue.length > 0) {
      const now = Date.now();
      const elapsed = now - this.lastEditTime;
      
      if (elapsed < TelegramBot.MIN_EDIT_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, TelegramBot.MIN_EDIT_INTERVAL_MS - elapsed));
      }
      
      const item = this.editQueue.shift();
      if (!item) break;
      
      this.lastEditTime = Date.now();
      await this.doEditMessage(item.chatId, item.messageId, item.text);
    }
    
    this.processingQueue = false;
  }

  private async doEditMessage(chatId: number, messageId: number, text: string): Promise<void> {
    const maxLength = 4096;
    let messageText = text;

    if (text.length > maxLength) {
      messageText = text.substring(0, maxLength - 3) + '...';
    }

    const response = await fetch(`${this.baseUrl}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: messageText
      })
    });

    const data = await response.json();
    if (!data.ok && data.error_code !== 400) {
      console.error('Failed to edit message:', data.description);
    }
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await fetch(`${this.baseUrl}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackId,
        text
      })
    });
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    const response = await fetch(`${this.baseUrl}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId
      })
    });
    const data = await response.json();
    if (!data.ok) {
      console.error('Failed to delete message:', data.description);
    }
  }

  createTrustKeyboard(chunkId: string): any {
    return {
      inline_keyboard: [[
        {
          text: '✅ Trust',
          callback_data: `trust:${chunkId}:true`
        },
        {
          text: '❌ Untrust',
          callback_data: `trust:${chunkId}:false`
        }
      ]]
    };
  }
}
