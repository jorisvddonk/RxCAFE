/**
 * ObservableCAFE TUI - Terminal User Interface for chat
 * 
 * Usage:
 *   bun run tui.ts
 *   bun run tui.ts --url http://localhost:3000
 *   bun run tui.ts --token <token>
 * 
 * Environment variables:
 *   RXCAFE_URL    - Server URL (default: http://localhost:3000)
 *   RXCAFE_TOKEN  - API token
 * 
 * Requires a running server: bun start
 */

import {
  TUI,
  ProcessTerminal,
  Container,
  Box,
  Text,
  Input,
  Loader,
  SelectList,
  type Component,
  type SelectItem,
  type Focusable,
  truncateToWidth,
  matchesKey,
  Key,
} from "@mariozechner/pi-tui";
import chalk from "chalk";

const args = process.argv.slice(2);

function parseArgs(): { url?: string; token?: string } {
  const result: { url?: string; token?: string } = {};
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      result.url = args[i + 1];
      i++;
    } else if (args[i] === '--token' && args[i + 1]) {
      result.token = args[i + 1];
      i++;
    }
  }
  
  return result;
}

const cliOptions = parseArgs();
const SERVER_URL = cliOptions.url || process.env.RXCAFE_URL || 'http://localhost:3000';
const API_TOKEN = cliOptions.token || process.env.RXCAFE_TOKEN || '';

interface Session {
  id: string;
  agentName: string;
  isBackground: boolean;
  displayName?: string;
}

interface Chunk {
  id: string;
  contentType: string;
  content: string | null;
  producer: string;
  annotations: Record<string, any>;
}

interface Message {
  role: string;
  content: string;
}

type AppMode = 'chat' | 'sessions' | 'new-session';

class ChatApp implements Component, Focusable {
  private messages: Message[] = [];
  private sessionId: string | null = null;
  private agentName: string = 'default';
  private loading = false;
  private _focused = false;
  private mode: AppMode = 'chat';
  private knownSessions: Session[] = [];
  private agents: string[] = [];
  
  private header: Text;
  private inputBox: Box;
  private input: Input;
  private loader: Loader;
  private sessionsList: SelectList;
  
  private tui: TUI;
  private abortController: AbortController | null = null;
  private streamRunning = false;
  
  constructor(tui: TUI) {
    this.tui = tui;
    
    this.header = new Text("", 1, 0, (s) => chalk.bgBlack(s));
    
    this.input = new Input();
    this.input.onSubmit = (text) => this.handleSubmit(text);
    
    this.inputBox = new Box(1, 1, (s) => chalk.bgBlack(s));
    this.inputBox.addChild(this.input);
    
    this.loader = new Loader(
      tui,
      (s) => chalk.cyan(s),
      (s) => chalk.gray(s),
      "Thinking..."
    );
    
    this.sessionsList = new SelectList([], 10, {
      selectedPrefix: (s) => chalk.yellow(s),
      selectedText: (s) => chalk.white(s),
      description: (s) => chalk.gray(s),
      scrollInfo: (s) => chalk.gray(s),
      noMatch: (s) => chalk.red(s),
    });
    this.sessionsList.onSelect = (item) => this.handleSessionSelect(item);
    this.sessionsList.onCancel = () => this.setMode('chat');
    
    this.updateHeader();
  }
  
  get focused(): boolean {
    return this._focused;
  }
  
  set focused(value: boolean) {
    if (this._focused !== value) {
      this._focused = value;
      this.input.focused = value;
      if (this.input.invalidate) this.input.invalidate();
      this.sessionsList.focused = value && (this.mode === 'sessions' || this.mode === 'new-session');
    }
  }
  
  async init() {
    const headers: Record<string, string> = {};
    if (API_TOKEN) {
      headers['Authorization'] = `Bearer ${API_TOKEN}`;
    }
    
    try {
      const sessionsResp = await fetch(`${SERVER_URL}/api/sessions`, { headers });
      const sessionsData = await sessionsResp.json();
      this.knownSessions = sessionsData.sessions || [];
      
      const agentsResp = await fetch(`${SERVER_URL}/api/agents`, { headers });
      const agentsData = await agentsResp.json();
      this.agents = Array.isArray(agentsData) ? agentsData.map((a: any) => a.name || a) : [];
      
      if (this.knownSessions.length > 0) {
        await this.switchToSession(this.knownSessions[0].id);
      } else {
        await this.createSession('default');
      }
      
      this.addMessage('system', `Connected to ${SERVER_URL}`);
      this.addMessage('system', 'Commands: /clear, /sessions, /new, /quit');
    } catch (err: any) {
      this.addMessage('system', `Failed to connect: ${err.message}`);
      this.addMessage('system', 'Start server with: bun start');
    }
    
    this.tui.requestRender();
  }
  
  private async api<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (API_TOKEN) {
      headers['Authorization'] = `Bearer ${API_TOKEN}`;
    }
    
    const resp = await fetch(`${SERVER_URL}${path}`, {
      ...options,
      headers: {
        ...headers,
        ...options.headers,
      },
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error || resp.statusText);
    }
    return resp.json();
  }
  
  private async connectStream() {
    if (this.streamRunning) {
      this.disconnect();
    }
    
    if (!this.sessionId) return;
    
    const headers: Record<string, string> = {};
    if (API_TOKEN) {
      headers['Authorization'] = `Bearer ${API_TOKEN}`;
    }
    
    this.streamRunning = true;
    
    try {
      const response = await fetch(`${SERVER_URL}/api/session/${this.sessionId}/stream`, {
        headers
      });
      
      if (!response.ok) {
        throw new Error(`Stream error: ${response.status}`);
      }
      
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }
      
      const decoder = new TextDecoder();
      let buffer = '';
      
      while (this.streamRunning) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              this.handleStreamData(parsed);
            } catch (e) {
              // Skip invalid JSON
            }
          }
        }
      }
    } catch (err: any) {
      if (this.streamRunning) {
        this.addMessage('system', `Stream error: ${err.message}, reconnecting...`);
        setTimeout(() => this.connectStream(), 2000);
      }
    }
  }
  
  private handleStreamData(data: any) {
    switch (data.type) {
      case 'user':
        if (data.chunk && typeof data.chunk.content === 'string') {
          this.addMessage('user', data.chunk.content);
        }
        break;
      case 'chunk':
        if (data.chunk) {
          const role = data.chunk.annotations?.['chat.role'];
          const content = data.chunk.content;
          const contentType = data.chunk.contentType;
          
          if (role === 'assistant') {
            if (typeof content === 'string') {
              this.addMessage('assistant', content);
            } else if (contentType === 'binary') {
              const mimeType = data.chunk.annotations?.['image.mime-type'] || data.chunk.annotations?.['audio.mime-type'];
              const desc = data.chunk.annotations?.['image.description'] || data.chunk.annotations?.['audio.description'] || 'attachment';
              const label = mimeType ? `${mimeType}: ${desc}` : desc;
              this.addMessage('system', `[${label} - not displayed in TUI]`);
              this.loading = false;
              this.loader.stop();
              this.tui.requestRender();
            }
          }
        }
        break;
      case 'token':
        if (data.token) {
          // For streaming, we'd update the last message
        }
        break;
      case 'error':
        this.addMessage('system', `Error: ${data.error}`);
        this.loading = false;
        this.loader.stop();
        this.tui.requestRender();
        break;
      case 'finish':
      case 'done':
        this.loading = false;
        this.loader.stop();
        this.tui.requestRender();
        break;
    }
  }
  
  private updateHeader() {
    const parts = [this.sessionId ? this.sessionId.slice(0, 8) + '...' : 'No session'];
    if (this.agentName) parts.push(this.agentName);
    this.header.setText(` ObservableCAFE | ${parts.join(' | ')} `);
  }
  
  addMessage(role: string, content: string) {
    if (typeof content !== 'string') return;
    this.messages.push({ role, content });
    this.tui.requestRender();
  }
  
  setMode(mode: AppMode) {
    this.mode = mode;
    if (mode === 'sessions') {
      this.updateSessionsList();
    } else if (mode === 'new-session') {
      this.updateNewSessionList();
    }
    if (this.sessionsList.invalidate) this.sessionsList.invalidate();
    this.tui.requestRender();
  }
  
  private updateSessionsList() {
    const items: SelectItem[] = this.knownSessions.map(s => ({
      value: s.id,
      label: s.displayName || s.agentName,
      description: `${s.id.slice(0, 12)}...${s.id.slice(-4)} ${s.isBackground ? '[background]' : ''}`
    }));
    
    if (items.length === 0) {
      items.push({ value: '', label: 'No sessions', description: 'Create a new session' });
    }
    
    this.sessionsList = new SelectList(items, 10, {
      selectedPrefix: (s) => chalk.yellow(s),
      selectedText: (s) => chalk.white(s),
      description: (s) => chalk.gray(s),
      scrollInfo: (s) => chalk.gray(s),
      noMatch: (s) => chalk.red(s),
    });
    this.sessionsList.onSelect = (item) => this.handleSessionSelect(item);
    this.sessionsList.onCancel = () => this.setMode('chat');
  }
  
  private updateNewSessionList() {
    const items: SelectItem[] = this.agents.map(name => ({
      value: name,
      label: name,
      description: ''
    }));
    
    if (items.length === 0) {
      items.push({ value: 'default', label: 'default', description: 'default agent' });
    }
    
    this.sessionsList = new SelectList(items, 10, {
      selectedPrefix: (s) => chalk.yellow(s),
      selectedText: (s) => chalk.white(s),
      description: (s) => chalk.gray(s),
      scrollInfo: (s) => chalk.gray(s),
      noMatch: (s) => chalk.red(s),
    });
    this.sessionsList.onSelect = (item) => {
      this.createSession(item.value);
    };
    this.sessionsList.onCancel = () => this.setMode('chat');
  }
  
  private handleSessionSelect(item: SelectItem) {
    if (item.value) {
      this.switchToSession(item.value);
    }
    this.setMode('chat');
  }
  
  private async switchToSession(sessionId: string) {
    this.disconnect();
    
    this.sessionId = sessionId;
    this.messages = [];
    this.input.setValue("");
    
    try {
      const history = await this.api<Chunk[]>(`/api/session/${sessionId}/history`);
      for (const chunk of history) {
        if (chunk.contentType === 'text' && typeof chunk.content === 'string') {
          const role = chunk.annotations['chat.role'];
          if (role === 'user' || role === 'assistant' || role === 'system') {
            this.addMessage(role, chunk.content);
          }
        }
      }
      
      const sessionInfo = this.knownSessions.find(s => s.id === sessionId);
      if (sessionInfo) {
        this.agentName = sessionInfo.agentName;
      }
    } catch (err: any) {
      this.addMessage('system', `Failed to load history: ${err.message}`);
    }
    
    this.updateHeader();
    this.connectStream();
    this.addMessage('system', `Switched to session`);
    this.tui.requestRender();
  }
  
  private async createSession(agentId: string) {
    try {
      const result = await this.api<{ id: string }>('/api/session', {
        method: 'POST',
        body: JSON.stringify({ 
          agentId,
          backend: 'ollama',
          model: 'gemma3:1b'
        })
      });
      
      this.knownSessions.push({
        id: result.id,
        agentName: agentId,
        isBackground: false
      });
      
      await this.switchToSession(result.id);
      this.setMode('chat');
    } catch (err: any) {
      this.addMessage('system', `Failed to create session: ${err.message}`);
    }
  }
  
  private async deleteCurrentSession() {
    if (!this.sessionId) return;
    
    try {
      await this.api(`/api/session/${this.sessionId}`, { method: 'DELETE' });
      this.knownSessions = this.knownSessions.filter(s => s.id !== this.sessionId);
      
      if (this.knownSessions.length > 0) {
        await this.switchToSession(this.knownSessions[0].id);
      } else {
        this.sessionId = null;
        this.messages = [];
        await this.createSession('default');
      }
    } catch (err: any) {
      this.addMessage('system', `Failed to delete: ${err.message}`);
    }
    
    this.setMode('chat');
  }
  
  private disconnect() {
    this.streamRunning = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
  
  private handleSubmit(text: string) {
    if (this.mode !== 'chat') {
      if (matchesKey(text, Key.escape)) {
        this.setMode('chat');
      } else {
        this.sessionsList.handleInput(text);
      }
      return;
    }
    
    const trimmed = text.trim();
    if (!trimmed) return;
    this.input.setValue("");
    
    if (trimmed === '/quit' || trimmed === '/exit') {
      this.disconnect();
      this.tui.stop();
      return;
    }
    
    if (trimmed === '/clear') {
      this.messages = [];
      this.addMessage('system', 'History cleared.');
      return;
    }
    
    if (trimmed === '/sessions') {
      this.setMode('sessions');
      return;
    }
    
    if (trimmed === '/new' || trimmed === '/new-session') {
      this.setMode('new-session');
      return;
    }
    
    if (trimmed.startsWith('/system ')) {
      const promptText = trimmed.slice(8);
      this.sendChunk(promptText, 'system');
      this.addMessage('system', `System prompt set: ${promptText.substring(0, 50)}...`);
      return;
    }
    
    if (trimmed.startsWith('/rename ')) {
      const newName = trimmed.slice(8);
      this.sendChunk(newName, 'session-name', true);
      this.addMessage('system', `Session renamed to: ${newName}`);
      return;
    }
    
    if (trimmed === '/delete') {
      this.deleteCurrentSession();
      return;
    }
    
    this.addMessage('user', trimmed);
    this.sendMessage(trimmed);
  }
  
  private async sendChunk(content: string, annotation: string, isNull = false) {
    if (!this.sessionId) return;
    
    try {
      await this.api(`/api/session/${this.sessionId}/chunk`, {
        method: 'POST',
        body: JSON.stringify({
          content: isNull ? null : content,
          contentType: isNull ? 'null' : 'text',
          producer: 'com.rxcafe.user',
          annotations: {
            'chat.role': annotation === 'system' ? 'system' : undefined,
            'session.name': annotation === 'session-name' ? content : undefined,
            [annotation]: annotation === 'system' ? true : undefined
          }
        })
      });
    } catch (err: any) {
      this.addMessage('system', `Error: ${err.message}`);
    }
  }
  
  private async sendMessage(message: string) {
    if (!this.sessionId) return;
    
    this.loading = true;
    this.loader.start();
    this.tui.requestRender();
    
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (API_TOKEN) {
      headers['Authorization'] = `Bearer ${API_TOKEN}`;
    }
    
    try {
      const response = await fetch(`${SERVER_URL}/api/chat/${this.sessionId}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message })
      });
      
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(err.error || response.statusText);
      }
      
    } catch (err: any) {
      this.addMessage('system', `Error: ${err.message}`);
      this.loading = false;
      this.loader.stop();
      this.tui.requestRender();
    }
  }
  
  render(width: number): string[] {
    if (this.mode === 'sessions' || this.mode === 'new-session') {
      return this.renderSessionsMode(width);
    }
    return this.renderChatMode(width);
  }
  
  private renderChatMode(width: number): string[] {
    const lines: string[] = [];
    
    lines.push(...this.header.render(width));
    lines.push("");
    
    const maxMessages = Math.min(this.messages.length, 15);
    const startIdx = Math.max(0, this.messages.length - maxMessages);
    
    for (let i = startIdx; i < this.messages.length; i++) {
      const msg = this.messages[i];
      const roleColor = msg.role === 'user' ? chalk.yellow :
                       msg.role === 'assistant' ? chalk.green : chalk.cyan;
      const prefix = roleColor(`[${msg.role}]`);
      
      const contentLines = msg.content.split('\n');
      for (let j = 0; j < contentLines.length; j++) {
        const line = j === 0 ? `${prefix} ${contentLines[j]}` : `    ${contentLines[j]}`;
        lines.push(truncateToWidth(line, width));
      }
    }
    
    if (this.loading) {
      lines.push("");
      lines.push(...this.loader.render(width));
    }
    
    const inputLabel = chalk.gray("> ");
    const inputLines = this.input.render(width - 2);
    for (const line of inputLines) {
      lines.push(inputLabel + line);
    }
    
    return lines;
  }
  
  private renderSessionsMode(width: number): string[] {
    const lines: string[] = [];
    
    const title = this.mode === 'new-session' ? 'New Session - Select Agent' : 'Sessions';
    
    lines.push(...this.header.render(width));
    lines.push("");
    lines.push(chalk.bold.cyan(title));
    lines.push(chalk.gray("Use arrow keys to navigate, Enter to select, Escape to go back"));
    lines.push("");
    
    const listLines = this.sessionsList.render(width - 2);
    for (const line of listLines) {
      lines.push("  " + line);
    }
    
    return lines;
  }
  
  handleInput(data: string): void {
    if (this.mode === 'sessions' || this.mode === 'new-session') {
      if (matchesKey(data, Key.escape)) {
        this.setMode('chat');
      } else {
        this.sessionsList.handleInput(data);
      }
    } else {
      this.input.handleInput(data);
    }
  }
}

async function main() {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  
  const chatApp = new ChatApp(tui);
  tui.addChild(chatApp);
  tui.setFocus(chatApp);
  
  await chatApp.init();
  
  tui.start();
}

main().catch(err => {
  console.error('Failed to start TUI:', err);
  process.exit(1);
});
