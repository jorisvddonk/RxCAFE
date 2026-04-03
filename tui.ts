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

// Allow self-signed certs for local dev
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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
const SERVER_URL = cliOptions.url || process.env.RXCAFE_URL || 'https://localhost:3000';
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

type AppMode = 'chat' | 'sessions' | 'new-session' | 'wizard' | 'inspector';

interface AgentInfo {
  name: string;
  description?: string;
  configSchema?: {
    properties?: Record<string, any>;
  };
}

interface WizardState {
  step: number;
  agent: string;
  backend: string;
  model: string;
  systemPrompt: string;
  temperature: string;
  maxTokens: string;
  topP: string;
  currentTextInput: string;
  customFields: Record<string, string>;
}

class ChatApp implements Component, Focusable {
  private messages: Message[] = [];
  private sessionId: string | null = null;
  private agentName: string = 'default';
  private loading = false;
  private _focused = false;
  private mode: AppMode = 'chat';
  private knownSessions: Session[] = [];
  private agents: AgentInfo[] = [];
  
  private header: Text;
  private inputBox: Box;
  private input: Input;
  private loader: Loader;
  private sessionsList: SelectList;
  
  private wizardState: WizardState = {
    step: 0,
    agent: 'default',
    backend: 'ollama',
    model: 'gemma3:1b',
    systemPrompt: '',
    temperature: '0.7',
    maxTokens: '500',
    topP: '0.9',
    currentTextInput: '',
    customFields: {}
  };
  private wizardInput = '';
  
  private inspectorChunks: Chunk[] = [];
  private inspectorSelectedIndex = 0;
  private inspectorExpanded = false;
  
  private tui: TUI;
  private abortController: AbortController | null = null;
  private streamRunning = false;
  private streamReader: ReadableStreamDefaultReader | null = null;
  
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
      this.agents = agentsData.agents || [];
      
      if (this.knownSessions.length > 0) {
        await this.switchToSession(this.knownSessions[0].id);
      } else {
        await this.createSession('default');
      }
      
      this.addMessage('tui', `Connected to ${SERVER_URL}`);
      this.addMessage('tui', 'Type /help for commands');
    } catch (err: any) {
      this.addMessage('tui', `Failed to connect: ${err.message}`);
      this.addMessage('tui', 'Start server with: bun start');
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
      
      this.streamReader = reader;
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
      
      this.streamReader = null;
    } catch (err: any) {
      if (this.streamRunning) {
        this.addMessage('tui', `Stream error: ${err.message}, reconnecting...`);
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
              this.addMessage('tui', `[${label} - not displayed in TUI]`);
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
        this.addMessage('tui', `Error: ${data.error}`);
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
    } else if (mode === 'inspector') {
      this.loadInspectorChunks();
    }
    if (this.sessionsList.invalidate) this.sessionsList.invalidate();
    this.tui.requestRender();
  }
  
  private async loadInspectorChunks() {
    if (!this.sessionId) {
      this.inspectorChunks = [];
      return;
    }
    try {
      const historyResp = await this.api<{ chunks: Chunk[] }>(`/api/session/${this.sessionId}/history`);
      this.inspectorChunks = historyResp.chunks || [];
      this.inspectorSelectedIndex = 0;
      this.inspectorExpanded = false;
    } catch (err: any) {
      this.addMessage('tui', `Failed to load chunks: ${err.message}`);
      this.inspectorChunks = [];
    }
  }
  
  private updateSessionsList() {
    const items: SelectItem[] = this.knownSessions
      .filter(s => s.id)
      .map(s => ({
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
    const defaultAgent = this.agents.find(a => a.name === 'default')?.name 
      || this.agents.find(a => a.name === 'voice-chat')?.name
      || this.agents[0]?.name 
      || 'default';
    this.wizardState = {
      step: 0,
      agent: defaultAgent,
      backend: 'ollama',
      model: 'gemma3:1b',
      systemPrompt: '',
      temperature: '0.7',
      maxTokens: '500',
      topP: '0.9',
      currentTextInput: '',
      customFields: {}
    };
    this.wizardInput = '';
    this.mode = 'wizard';
    this.tui.requestRender();
  }
  
  private getCurrentAgentSchema() {
    const agent = this.agents.find(a => a.name === this.wizardState.agent);
    const configSchema = agent?.configSchema;
    if (!configSchema) return {};
    if (typeof configSchema !== 'object') return {};
    return (configSchema as any).properties || {};
  }
  
  private getWizardStepConfig() {
    const properties = this.getCurrentAgentSchema(); // Already returns properties object
    const steps: { title: string; field: string; options?: string[]; inputType?: 'text' | 'number' | 'select' }[] = [
      { title: 'Select Agent', field: 'agent' }
    ];
    
    if (properties.backend) {
      steps.push({ title: 'Backend', field: 'backend', options: ['ollama', 'kobold', 'llamacpp'], inputType: 'select' });
    }
    if (properties.model) {
      steps.push({ title: 'Model', field: 'model' });
    }
    if (properties.systemPrompt) {
      steps.push({ title: 'System Prompt', field: 'systemPrompt' });
    }
    
    // Handle llmParams nested properties
    if (properties.llmParams?.properties) {
      for (const [key, prop] of Object.entries(properties.llmParams.properties)) {
        const llmProp = prop as any;
        if (llmProp.enum) {
          steps.push({ title: `${key}`, field: `llmParams.${key}`, options: llmProp.enum, inputType: 'select' });
        } else if (llmProp.type === 'number' || llmProp.type === 'integer') {
          steps.push({ title: `${key}`, field: `llmParams.${key}`, inputType: 'number' });
        }
      }
    }
    
    // Handle other nested objects (like handyConfig)
    for (const [key, prop] of Object.entries(properties)) {
      if (['backend', 'model', 'systemPrompt', 'llmParams'].includes(key)) continue;
      const nestedSchema = prop as any;
      if (nestedSchema.type === 'object' && nestedSchema.properties) {
        for (const [nestedKey, nestedProp] of Object.entries(nestedSchema.properties)) {
          const nestedPropDef = nestedProp as any;
          if (nestedPropDef.enum) {
            steps.push({ title: `${key}: ${nestedKey}`, field: `${key}.${nestedKey}`, options: nestedPropDef.enum, inputType: 'select' });
          } else if (nestedPropDef.type === 'number' || nestedPropDef.type === 'integer') {
            steps.push({ title: `${key}: ${nestedKey}`, field: `${key}.${nestedKey}`, inputType: 'number' });
          } else {
            steps.push({ title: `${key}: ${nestedKey}`, field: `${key}.${nestedKey}` });
          }
        }
      } else if (nestedSchema.enum) {
        steps.push({ title: nestedSchema.description || key, field: key, options: nestedSchema.enum, inputType: 'select' });
      } else if (nestedSchema.type === 'number' || nestedSchema.type === 'integer') {
        steps.push({ title: nestedSchema.description || key, field: key, inputType: 'number' });
      } else {
        steps.push({ title: nestedSchema.description || key, field: key });
      }
    }
    
    steps.push({ title: 'Create Session', field: 'create' });
    
    return steps;
  }
  
  private renderWizardMode(width: number): string[] {
    const lines: string[] = [];
    lines.push(...this.header.render(width));
    lines.push("");
    lines.push(chalk.bold.cyan("New Session"));
    
    const steps = this.getWizardStepConfig();
    const currentStep = steps[this.wizardState.step];
    
    // Render step indicators
    const stepIndicators = steps.map((s, i) => {
      if (i < this.wizardState.step) return chalk.green("✓");
      if (i === this.wizardState.step) return chalk.yellow(String(i + 1));
      return chalk.gray(String(i + 1));
    }).join(" > ");
    lines.push(stepIndicators);
    lines.push("");
    
    // Current step content
    lines.push(chalk.bold(`${currentStep.title}:`));
    lines.push("");
    
    if (currentStep.field === 'agent') {
      for (const agent of this.agents) {
        const marker = agent.name === this.wizardState.agent ? "▶" : " ";
        const selected = agent.name === this.wizardState.agent ? chalk.yellow(marker) : chalk.gray(marker);
        lines.push(`${selected} ${agent.name} ${chalk.gray(agent.description || '')}`);
      }
      lines.push("");
      lines.push(chalk.gray("Use ↑/↓ to select, Enter to continue, Escape to cancel"));
    } else if (currentStep.options) {
      for (const opt of currentStep.options) {
        const marker = opt === (this.wizardState as any)[currentStep.field] ? "▶" : " ";
        const selected = opt === (this.wizardState as any)[currentStep.field] ? chalk.yellow(marker) : chalk.gray(marker);
        lines.push(`${selected} ${opt}`);
      }
      lines.push("");
      lines.push(chalk.gray("Use ↑/↓ to select, Enter to continue, Escape to go back"));
    } else if (currentStep.field === 'systemPrompt') {
      const existingValue = this.wizardState.systemPrompt || "(none)";
      lines.push(chalk.gray("Current: " + existingValue));
      lines.push("");
      if (this.wizardState.currentTextInput) {
        lines.push(chalk.cyan(`> ${this.wizardState.currentTextInput}_`));
      } else {
        lines.push(chalk.gray("Type system prompt and press Enter, or Enter for none"));
      }
      lines.push(chalk.gray("Escape to go back"));
    } else if (currentStep.field === 'create') {
      const properties = this.getCurrentAgentSchema(); // Already returns properties object
      
      lines.push(chalk.green(`Agent: ${this.wizardState.agent}`));
      if (properties.backend) {
        lines.push(chalk.green(`Backend: ${this.wizardState.backend}`));
      }
      if (properties.model) {
        lines.push(chalk.green(`Model: ${this.wizardState.model}`));
      }
      if (this.wizardState.systemPrompt && properties.systemPrompt) {
        const sys = this.wizardState.systemPrompt.slice(0, 30);
        lines.push(chalk.green(`System: ${sys}...`));
      }
      // Show llmParams fields
      if (properties.llmParams?.properties) {
        if (this.wizardState.customFields['llmParams.temperature']) {
          lines.push(chalk.green(`Temperature: ${this.wizardState.customFields['llmParams.temperature']}`));
        }
        if (this.wizardState.customFields['llmParams.maxTokens']) {
          lines.push(chalk.green(`Max Tokens: ${this.wizardState.customFields['llmParams.maxTokens']}`));
        }
        if (this.wizardState.customFields['llmParams.topP']) {
          lines.push(chalk.green(`Top P: ${this.wizardState.customFields['llmParams.topP']}`));
        }
      }
      // Show customFields (includes llmParams and other nested fields)
      for (const [key, value] of Object.entries(this.wizardState.customFields)) {
        if (key.startsWith('llmParams.')) continue; // Already shown above
        lines.push(chalk.green(`${key}: ${value}`));
      }
      lines.push("");
      lines.push(chalk.gray("Press Enter to create, Escape to go back"));
    } else {
      // Get value from either wizardState or customFields (for nested fields)
      let currentValue = '';
      const topLevelFields = ['backend', 'model', 'systemPrompt', 'temperature', 'maxTokens', 'topP'];
      if (topLevelFields.includes(currentStep.field)) {
        currentValue = (this.wizardState as any)[currentStep.field] || '';
      } else {
        currentValue = this.wizardState.customFields[currentStep.field] || '';
      }
      lines.push(chalk.gray(`Current: ${currentValue || '(none)'}`));
      lines.push("");
      if (this.wizardState.currentTextInput) {
        lines.push(chalk.cyan(`> ${this.wizardState.currentTextInput}_`));
      } else {
        lines.push(chalk.gray("Type value and press Enter, Escape to go back"));
      }
    }
    
    return lines;
  }
  
  private handleWizardInput(data: string) {
    if (!data || typeof data !== 'string') return;
    
    if (matchesKey(data, Key.escape)) {
      if (this.wizardState.step > 0) {
        this.wizardState.step--;
        this.wizardState.currentTextInput = '';
        this.tui.requestRender();
      } else {
        this.setMode('chat');
      }
      return;
    }
    
    const steps = this.getWizardStepConfig();
    const currentStep = steps[this.wizardState.step];
    
    // Handle text input for text/number fields (not agent, not create, not options)
    if (!currentStep.options && currentStep.field !== 'agent' && currentStep.field !== 'create') {
      if (matchesKey(data, Key.backspace)) {
        this.wizardState.currentTextInput = this.wizardState.currentTextInput.slice(0, -1);
        this.tui.requestRender();
        return;
      }
      
      // Handle regular text input
      if (data.length === 1 && !data.match(/[\x00-\x1F]/)) {
        this.wizardState.currentTextInput += data;
        this.tui.requestRender();
        return;
      }
    }
    
    if (matchesKey(data, Key.enter)) {
      if (currentStep.field === 'agent') {
        // Move to next step
        this.wizardState.step++;
        this.tui.requestRender();
      } else if (currentStep.field === 'create') {
        this.createSessionWithConfig();
      } else if (currentStep.options) {
        // Options step - save current selection to customFields and move to next step
        const currentVal = (this.wizardState as any)[currentStep.field];
        if (currentVal) {
          this.wizardState.customFields[currentStep.field] = currentVal;
        }
        this.wizardState.step++;
        this.tui.requestRender();
      } else if (currentStep.field === 'systemPrompt') {
        // Save the text input to systemPrompt
        if (this.wizardState.currentTextInput) {
          this.wizardState.systemPrompt = this.wizardState.currentTextInput;
        }
        this.wizardState.currentTextInput = '';
        this.wizardState.step++;
        this.tui.requestRender();
      } else {
        // All other fields (including nested like llmParams.temperature) go to customFields
        if (this.wizardState.currentTextInput) {
          this.wizardState.customFields[currentStep.field] = this.wizardState.currentTextInput;
        }
        this.wizardState.currentTextInput = '';
        this.wizardState.step++;
        this.tui.requestRender();
      }
      return;
    }
    
    // Handle arrow keys for agent/option selection
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      if (currentStep.field === 'agent') {
        const idx = this.agents.findIndex(a => a.name === this.wizardState.agent);
        let newIdx = idx;
        if (matchesKey(data, Key.up)) newIdx = idx > 0 ? idx - 1 : this.agents.length - 1;
        else newIdx = idx < this.agents.length - 1 ? idx + 1 : 0;
        this.wizardState.agent = this.agents[newIdx].name;
        this.wizardState.customFields = {};
        this.wizardState.currentTextInput = '';
        this.tui.requestRender();
      } else if (currentStep.options) {
        const opts = currentStep.options;
        const currentVal = (this.wizardState as any)[currentStep.field];
        const idx = opts.indexOf(currentVal);
        let newIdx = idx;
        if (matchesKey(data, Key.up)) newIdx = idx > 0 ? idx - 1 : opts.length - 1;
        else newIdx = idx < opts.length - 1 ? idx + 1 : 0;
        (this.wizardState as any)[currentStep.field] = opts[newIdx];
        this.tui.requestRender();
      }
    }
  }
  
  private async createSessionWithConfig() {
    try {
      this.addMessage('tui', `Creating session...`);
      
      const schema = this.getCurrentAgentSchema();
      
      const body: any = {
        agentId: this.wizardState.agent,
        backend: this.wizardState.backend,
        model: this.wizardState.model
      };
      
      if (this.wizardState.systemPrompt) {
        body.systemPrompt = this.wizardState.systemPrompt;
      }
      
      // Handle all custom fields, including nested ones (e.g., llmParams.temperature, handyConfig.baseUrl)
      for (const [key, value] of Object.entries(this.wizardState.customFields)) {
        if (!value) continue;
        
        if (key.includes('.')) {
          const [parent, child] = key.split('.');
          if (!body[parent]) body[parent] = {};
          const schema = this.getCurrentAgentSchema();
          const parentSchema = (schema.properties?.[parent] as any)?.properties?.[child];
          if (parentSchema?.type === 'number' || parentSchema?.type === 'integer') {
            body[parent][child] = parseFloat(value);
          } else {
            body[parent][child] = value;
          }
        } else {
          const propSchema = (schema.properties as any)?.[key];
          if (propSchema?.type === 'number' || propSchema?.type === 'integer') {
            body[key] = parseFloat(value);
          } else {
            body[key] = value;
          }
        }
      }
      
      const result = await this.api<{ sessionId: string }>('/api/session', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      
      if (!result.sessionId) {
        throw new Error('No sessionId returned');
      }
      
      this.knownSessions.push({
        id: result.sessionId,
        agentName: this.wizardState.agent,
        isBackground: false
      });
      
      await this.switchToSession(result.sessionId);
      this.setMode('chat');
    } catch (err: any) {
      this.addMessage('tui', `Failed to create session: ${err.message}`);
      this.setMode('chat');
    }
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
      const historyResp = await this.api<{ chunks: Chunk[] }>(`/api/session/${sessionId}/history`);
      const history = historyResp.chunks || [];
      for (const chunk of history) {
        if (chunk.contentType === 'text' && typeof chunk.content === 'string') {
          const role = chunk.annotations['chat.role'];
          if (role === 'user' || role === 'assistant' || role === 'tui') {
            this.addMessage(role, chunk.content);
          }
        }
      }
      
      const sessionInfo = this.knownSessions.find(s => s.id === sessionId);
      if (sessionInfo) {
        this.agentName = sessionInfo.agentName;
      }
    } catch (err: any) {
      this.addMessage('tui', `Failed to load history: ${err.message}`);
    }
    
    this.updateHeader();
    this.connectStream();
    this.addMessage('tui', `Switched to session`);
    this.tui.requestRender();
  }
  
  private async createSession(agentId: string) {
    const finalAgent = agentId || 'default';
    try {
      this.addMessage('tui', `Creating session with ${finalAgent}...`);
      const result = await this.api<{ sessionId: string }>('/api/session', {
        method: 'POST',
        body: JSON.stringify({ 
          agentId: finalAgent,
          backend: 'ollama',
          model: 'gemma3:1b'
        })
      });
      
      if (!result.sessionId) {
        throw new Error('No sessionId returned');
      }
      
      this.knownSessions.push({
        id: result.sessionId,
        agentName: finalAgent,
        isBackground: false
      });
      
      await this.switchToSession(result.sessionId);
      this.setMode('chat');
    } catch (err: any) {
      this.addMessage('tui', `Failed to create session: ${err.message}`);
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
      this.addMessage('tui', `Failed to delete: ${err.message}`);
    }
    
    this.setMode('chat');
  }
  
  private disconnect() {
    this.streamRunning = false;
    if (this.streamReader) {
      this.streamReader.cancel();
      this.streamReader = null;
    }
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
      process.exit(0);
      return;
    }
    
    if (trimmed === '/clear') {
      this.messages = [];
      this.addMessage('tui', 'History cleared.');
      return;
    }
    
    if (trimmed === '/help' || trimmed === '/?') {
      this.addMessage('tui', '--- Commands ---');
      this.addMessage('tui', '/help, /?    - Show this help');
      this.addMessage('tui', '/sessions    - Switch sessions');
      this.addMessage('tui', '/new        - Create new session');
      this.addMessage('tui', '/clear      - Clear messages');
      this.addMessage('tui', '/inspector  - Inspect session chunks');
      this.addMessage('tui', '/rename <n> - Rename session');
      this.addMessage('tui', '/delete     - Delete session');
      this.addMessage('tui', '/system <p> - Set system prompt');
      this.addMessage('tui', '/quit, /exit - Exit');
      this.addMessage('tui', '//<cmd>     - Forward to agent (e.g. //help sends /help)');
      return;
    }
    
    if (trimmed === '/sessions') {
      this.setMode('sessions');
      return;
    }
    
    if (trimmed === '/new' || trimmed === '/new-session') {
      this.wizardState.currentTextInput = '';
      this.setMode('new-session');
      return;
    }
    
    if (trimmed.startsWith('/system ')) {
      const promptText = trimmed.slice(8);
      this.sendChunk(promptText, 'tui');
      this.addMessage('tui', `System prompt set: ${promptText.substring(0, 50)}...`);
      return;
    }
    
    if (trimmed.startsWith('/rename ')) {
      const newName = trimmed.slice(8);
      this.sendChunk(newName, 'session-name', true);
      this.addMessage('tui', `Session renamed to: ${newName}`);
      return;
    }
    
    if (trimmed === '/delete') {
      this.deleteCurrentSession();
      return;
    }
    
    if (trimmed === '/inspector') {
      this.setMode('inspector');
      return;
    }
    
    if (trimmed.startsWith('//')) {
      const agentMessage = trimmed.slice(1);
      this.addMessage('user', agentMessage);
      this.sendMessage(agentMessage);
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
            'chat.role': annotation === 'tui' ? 'tui' : undefined,
            'session.name': annotation === 'session-name' ? content : undefined,
            [annotation]: annotation === 'tui' ? true : undefined
          }
        })
      });
    } catch (err: any) {
      this.addMessage('tui', `Error: ${err.message}`);
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
      this.addMessage('tui', `Error: ${err.message}`);
      this.loading = false;
      this.loader.stop();
      this.tui.requestRender();
    }
  }
  
  render(width: number): string[] {
    if (this.mode === 'sessions' || this.mode === 'new-session') {
      return this.renderSessionsMode(width);
    }
    if (this.mode === 'wizard') {
      return this.renderWizardMode(width);
    }
    if (this.mode === 'inspector') {
      return this.renderInspectorMode(width);
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
    lines.push(chalk.gray("Use arrow keys to navigate, Enter to select, d to delete, Escape to go back"));
    lines.push("");
    
    const listLines = this.sessionsList.render(width - 2);
    for (const line of listLines) {
      lines.push("  " + line);
    }
    
    return lines;
  }
  
  private getChunkRole(chunk: Chunk): string {
    const role = chunk.annotations?.['chat.role'];
    if (role) return role;
    if (chunk.producer === 'com.rxcafe.web-fetch' || chunk.annotations?.['web.source-url']) return 'web';
    if (chunk.producer.includes('kobold') || chunk.producer.includes('ollama') || chunk.producer === 'com.rxcafe.assistant') return 'assistant';
    return chunk.producer.split('.').pop() || 'unknown';
  }
  
  private getRoleColor(role: string): (s: string) => string {
    switch (role) {
      case 'user': return chalk.yellow;
      case 'assistant': return chalk.green;
      case 'system': return chalk.magenta;
      case 'web': return chalk.blue;
      case 'tui': return chalk.cyan;
      default: return chalk.gray;
    }
  }
  
  private renderInspectorMode(width: number): string[] {
    const lines: string[] = [];
    
    lines.push(...this.header.render(width));
    lines.push("");
    lines.push(chalk.bold.cyan("Inspector"));
    lines.push("");
    
    if (!this.sessionId) {
      lines.push(chalk.gray("No session selected"));
      return lines;
    }
    
    lines.push(chalk.gray("Session: ") + this.sessionId.slice(0, 16) + "...");
    lines.push(chalk.gray("Agent: ") + this.agentName);
    lines.push(chalk.gray("Chunks: ") + String(this.inspectorChunks.length));
    lines.push("");
    lines.push(chalk.gray("Controls: ↑/↓ navigate, Enter expand/details, r refresh, Escape back"));
    lines.push("");
    
    if (this.inspectorChunks.length === 0) {
      lines.push(chalk.gray("No chunks in session"));
      return lines;
    }
    
    const maxVisible = Math.min(this.inspectorChunks.length, 12);
    const startIdx = Math.max(0, Math.min(this.inspectorSelectedIndex - 4, this.inspectorChunks.length - maxVisible));
    const endIdx = Math.min(startIdx + maxVisible, this.inspectorChunks.length);
    
    for (let i = startIdx; i < endIdx; i++) {
      const chunk = this.inspectorChunks[i];
      const isSelected = i === this.inspectorSelectedIndex;
      const role = this.getChunkRole(chunk);
      const roleColor = this.getRoleColor(role);
      const shortId = chunk.id.split('-').slice(-2).join('-');
      
      const prefix = isSelected ? chalk.bgYellow.black("▶") : " ";
      const idStr = chalk.gray(shortId);
      const roleStr = roleColor(`[${role}]`);
      
      let contentPreview = "";
      if (chunk.contentType === 'text' && typeof chunk.content === 'string') {
        contentPreview = chunk.content.substring(0, 50).replace(/\n/g, ' ');
        if (chunk.content.length > 50) contentPreview += "...";
      } else if (chunk.contentType === 'null') {
        contentPreview = chalk.gray("(null)");
      } else if (chunk.contentType === 'binary') {
        contentPreview = chalk.gray("(binary)");
      }
      
      lines.push(`${prefix} ${idStr} ${roleStr} ${contentPreview}`);
      
      if (isSelected && this.inspectorExpanded) {
        const jsonStr = JSON.stringify(chunk, null, 2);
        const jsonLines = jsonStr.split('\n');
        for (const jsonLine of jsonLines) {
          const truncated = truncateToWidth(jsonLine, width - 4);
          lines.push("  " + chalk.gray(truncated));
        }
      }
    }
    
    return lines;
  }
  
  handleInput(data: string): void {
    if (!data || typeof data !== 'string') return;
    
    if (this.mode === 'inspector') {
      if (matchesKey(data, Key.escape)) {
        this.setMode('chat');
      } else if (matchesKey(data, Key.enter)) {
        this.inspectorExpanded = !this.inspectorExpanded;
        this.tui.requestRender();
      } else if (matchesKey(data, Key.up)) {
        this.inspectorSelectedIndex = Math.max(0, this.inspectorSelectedIndex - 1);
        this.tui.requestRender();
      } else if (matchesKey(data, Key.down)) {
        this.inspectorSelectedIndex = Math.min(this.inspectorChunks.length - 1, this.inspectorSelectedIndex + 1);
        this.tui.requestRender();
      } else if (data === 'r' || data === 'R') {
        this.loadInspectorChunks().then(() => this.tui.requestRender());
      }
      return;
    }
    
    if (this.mode === 'wizard') {
      this.handleWizardInput(data);
    } else if (this.mode === 'sessions' || this.mode === 'new-session') {
      if (matchesKey(data, Key.escape)) {
        this.setMode('chat');
      } else if (data === 'd' || data === 'D') {
        const selectedItem = this.sessionsList.getSelectedItem();
        if (selectedItem && selectedItem.value) {
          this.deleteSessionById(selectedItem.value);
        }
      } else {
        this.sessionsList.handleInput(data);
      }
    } else {
      this.input.handleInput(data);
    }
  }
  
  private async deleteSessionById(sessionId: string) {
    try {
      await this.api(`/api/session/${sessionId}`, { method: 'DELETE' });
      this.knownSessions = this.knownSessions.filter(s => s.id !== sessionId);
      this.addMessage('tui', `Deleted session: ${sessionId.slice(0, 12)}...`);
      this.updateSessionsList();
      if (this.sessionsList.invalidate) this.sessionsList.invalidate();
      this.tui.requestRender();
    } catch (err: any) {
      this.addMessage('tui', `Failed to delete: ${err.message}`);
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
