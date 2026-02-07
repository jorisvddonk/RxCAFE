/**
 * Ollama API Client
 * Supports both streaming and non-streaming generation
 */

import { createTextChunk, createNullChunk, annotateChunk, type Chunk } from './chunk.js';

export interface OllamaSettings {
  baseUrl: string;
  model: string;
  temperature: number;
  topP: number;
  topK: number;
  numPredict: number;
  repeatPenalty: number;
  seed?: number;
  system?: string;
}

const defaultSettings: OllamaSettings = {
  baseUrl: 'http://localhost:11434',
  model: 'llama2',
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  numPredict: 500,
  repeatPenalty: 1.1,
};

export class OllamaAPI {
  private settings: OllamaSettings;

  constructor(baseUrl?: string, model?: string, settings?: Partial<OllamaSettings>) {
    this.settings = {
      ...defaultSettings,
      ...settings,
      baseUrl: baseUrl || defaultSettings.baseUrl,
      model: model || defaultSettings.model,
    };
  }

  updateSettings(newSettings: Partial<OllamaSettings>) {
    this.settings = { ...this.settings, ...newSettings };
  }

  getModel(): string {
    return this.settings.model;
  }

  async generate(prompt: string): Promise<string> {
    const response = await fetch(`${this.settings.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.settings.model,
        prompt,
        stream: false,
        options: {
          temperature: this.settings.temperature,
          top_p: this.settings.topP,
          top_k: this.settings.topK,
          num_predict: this.settings.numPredict,
          repeat_penalty: this.settings.repeatPenalty,
          seed: this.settings.seed,
        },
        system: this.settings.system,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status}`);
    }

    const data = await response.json();
    return data.response || '';
  }

  async *generateStream(prompt: string, abortSignal?: AbortSignal): AsyncIterable<{ token?: string; done?: boolean; finishReason?: string }> {
    const response = await fetch(`${this.settings.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.settings.model,
        prompt,
        stream: true,
        options: {
          temperature: this.settings.temperature,
          top_p: this.settings.topP,
          top_k: this.settings.topK,
          num_predict: this.settings.numPredict,
          repeat_penalty: this.settings.repeatPenalty,
          seed: this.settings.seed,
        },
        system: this.settings.system,
      }),
      signal: abortSignal,
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is not readable');
    }

    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim());

        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            
            if (data.response) {
              yield { token: data.response };
            }
            
            if (data.done) {
              yield { done: true, finishReason: 'stop' };
              return;
            }
          } catch (e) {
            // Skip malformed JSON
            continue;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.settings.baseUrl}/api/tags`);
    
    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status}`);
    }

    const data = await response.json();
    return data.models?.map((m: any) => m.name) || [];
  }

  async pullModel(model: string): Promise<void> {
    const response = await fetch(`${this.settings.baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: false }),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status}`);
    }
  }
}

export class OllamaEvaluator {
  private api: OllamaAPI;
  private systemPrompt: string;

  constructor(baseUrl?: string, model?: string, systemPrompt: string = '') {
    this.api = new OllamaAPI(baseUrl, model);
    this.systemPrompt = systemPrompt;
    
    if (systemPrompt) {
      this.api.updateSettings({ system: systemPrompt });
    }
  }

  getAPI(): OllamaAPI {
    return this.api;
  }

  updateSystemPrompt(prompt: string) {
    this.systemPrompt = prompt;
    this.api.updateSettings({ system: prompt });
  }

  async *evaluateChunk(chunk: Chunk): AsyncGenerator<Chunk> {
    if (chunk.contentType !== 'text') {
      yield annotateChunk(
        createNullChunk('com.rxcafe.ollama-evaluator'),
        'error.message',
        'OllamaEvaluator only accepts text chunks'
      );
      return;
    }

    const userMessage = chunk.content as string;

    yield annotateChunk(
      createNullChunk('com.rxcafe.ollama-evaluator'),
      'llm.generation-started',
      true
    );

    try {
      for await (const { token, done, finishReason } of this.api.generateStream(userMessage)) {
        if (token) {
          yield createTextChunk(token, 'com.rxcafe.ollama-evaluator', {
            'llm.stream': true,
            'llm.parent-chunk-id': chunk.id
          });
        }
        if (done && finishReason) {
          yield annotateChunk(
            createNullChunk('com.rxcafe.ollama-evaluator'),
            'llm.finish-reason',
            finishReason
          );
        }
      }
    } catch (error) {
      yield annotateChunk(
        createNullChunk('com.rxcafe.ollama-evaluator'),
        'error.message',
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }
}
