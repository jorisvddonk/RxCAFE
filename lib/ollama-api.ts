/**
 * Ollama API Client
 * Supports both streaming and non-streaming generation
 */

import { createTextChunk, createNullChunk, annotateChunk, type Chunk } from './chunk.js';
import type { LLMParams } from './agent.js';

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
  numCtx?: number;
  stop?: string[];
}

const defaultSettings: OllamaSettings = {
  baseUrl: 'http://localhost:11434',
  model: 'llama2',
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  numPredict: 500,
  repeatPenalty: 1.1,
  stop: ['\nUser:', 'Assistant:'],
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
          num_ctx: this.settings.numCtx,
          stop: this.settings.stop,
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

  async *generateStream(prompt: string, abortSignal?: AbortSignal, systemOverride?: string): AsyncIterable<{ token?: string; done?: boolean; finishReason?: string }> {
    console.log(`[OllamaAPI] Generating with model: ${this.settings.model}, prompt length: ${prompt.length}`);
    
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
          num_ctx: this.settings.numCtx,
          stop: this.settings.stop,
        },
        system: systemOverride !== undefined ? systemOverride : this.settings.system,
      }),
      signal: abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[OllamaAPI] HTTP error ${response.status}: ${errorText}`);
      throw new Error(`Ollama error: ${response.status} - ${errorText}`);
    }

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is not readable');
    }

    const decoder = new TextDecoder();
    let tokenCount = 0;

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
              tokenCount++;
              if (tokenCount === 1) {
                console.log(`[OllamaAPI] Received first token`);
              }
              yield { token: data.response };
            }
            
            if (data.done) {
              console.log(`[OllamaAPI] Generation complete, total tokens: ${tokenCount}`);
              yield { done: true, finishReason: 'stop' };
              return;
            }
          } catch (e) {
            // Skip malformed JSON
            continue;
          }
        }
      }
      console.log(`[OllamaAPI] Stream ended, total tokens: ${tokenCount}`);
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

  constructor(baseUrl?: string, model?: string, systemPrompt: string = '', llmParams?: LLMParams) {
    const settings: Partial<OllamaSettings> = {};
    
    if (llmParams) {
      if (llmParams.temperature !== undefined) settings.temperature = llmParams.temperature;
      if (llmParams.maxTokens !== undefined) settings.numPredict = llmParams.maxTokens;
      if (llmParams.topP !== undefined) settings.topP = llmParams.topP;
      if (llmParams.topK !== undefined) settings.topK = llmParams.topK;
      if (llmParams.repeatPenalty !== undefined) settings.repeatPenalty = llmParams.repeatPenalty;
      if (llmParams.seed !== undefined) settings.seed = llmParams.seed;
      if (llmParams.numCtx !== undefined) settings.numCtx = llmParams.numCtx;
      if (llmParams.stop !== undefined) settings.stop = llmParams.stop;
    }
    
    this.api = new OllamaAPI(baseUrl, model, settings);
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
    console.log(`[OllamaEvaluator] Evaluating chunk, contentType: ${chunk.contentType}, length: ${(chunk.content as string)?.length || 0}`);
    
    if (chunk.contentType !== 'text') {
      console.log(`[OllamaEvaluator] Skipping non-text chunk`);
      yield annotateChunk(
        createNullChunk('com.rxcafe.ollama-evaluator'),
        'error.message',
        'OllamaEvaluator only accepts text chunks'
      );
      return;
    }

    const content = chunk.content as string;
    
    // Check if this is already a full conversation context (has full-prompt annotation)
    const isFullPrompt = chunk.annotations['llm.full-prompt'] === true;
    
    let prompt: string;
    if (isFullPrompt) {
      prompt = content; // System prompt is ignored for full-prompt chunks in Ollama too
    } else {
      prompt = content; // In Ollama, the system prompt is already in settings
    }

    console.log(`[OllamaEvaluator] Sending prompt (${prompt.length} chars) to model ${this.api.getModel()}`);

    yield annotateChunk(
      createNullChunk('com.rxcafe.ollama-evaluator'),
      'llm.generation-started',
      true
    );

    try {
      let tokenCount = 0;
      for await (const { token, done, finishReason } of this.api.generateStream(prompt, undefined, isFullPrompt ? '' : undefined)) {
        if (token) {
          tokenCount++;
          if (tokenCount === 1) {
            console.log(`[OllamaEvaluator] Received first token`);
          }
          yield createTextChunk(token, 'com.rxcafe.ollama-evaluator', {
            'llm.stream': true,
            'llm.parent-chunk-id': chunk.id
          });
        }
        if (done && finishReason) {
          console.log(`[OllamaEvaluator] Generation complete, ${tokenCount} tokens`);
          yield annotateChunk(
            createNullChunk('com.rxcafe.ollama-evaluator'),
            'llm.finish-reason',
            finishReason
          );
        }
      }
      console.log(`[OllamaEvaluator] Stream ended, ${tokenCount} total tokens`);
    } catch (error) {
      console.error(`[OllamaEvaluator] Error:`, error);
      yield annotateChunk(
        createNullChunk('com.rxcafe.ollama-evaluator'),
        'error.message',
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }
}
