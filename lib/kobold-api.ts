/**
 * KoboldCPP API Client
 * Inspired by /Users/joris/projects/who-stole-my-arms/lib/llm-api/KoboldAPI.ts
 */

import { createTextChunk, createNullChunk, annotateChunk, type Chunk } from './chunk.js';
import type { LLMParams } from './agent.js';

export interface KoboldSettings {
  baseUrl: string;
  n: number;
  maxContextLength: number;
  maxLength: number;
  repetitionPenalty: number;
  temperature: number;
  topP: number;
  topK: number;
  topA: number;
  typical: number;
  tfs: number;
  repPenRange: number;
  repPenSlope: number;
  samplerOrder: number[];
  memory: string;
  trimStop: boolean;
  minP: number;
  dynatempRange: number;
  dynatempExponent: number;
  smoothingFactor: number;
  nsigma: number;
  bannedTokens: number[];
  renderSpecial: boolean;
  logprobs: boolean;
  replaceInstructPlaceholders: boolean;
  presencePenalty: number;
  logitBias: Record<string, number>;
  stopSequence: string[];
  useDefaultBadwordsids: boolean;
  bypassEos: boolean;
}

const defaultSettings: KoboldSettings = {
  baseUrl: 'http://localhost:5001',
  n: 1,
  maxContextLength: 10240,
  maxLength: 500,
  repetitionPenalty: 1.05,
  temperature: 0.75,
  topP: 0.92,
  topK: 100,
  topA: 0,
  typical: 1,
  tfs: 1,
  repPenRange: 360,
  repPenSlope: 0.7,
  samplerOrder: [6, 0, 1, 3, 4, 2, 5],
  memory: '',
  trimStop: false,
  minP: 0,
  dynatempRange: 0,
  dynatempExponent: 1,
  smoothingFactor: 0,
  nsigma: 0,
  bannedTokens: [],
  renderSpecial: false,
  logprobs: false,
  replaceInstructPlaceholders: true,
  presencePenalty: 0,
  logitBias: {},
  stopSequence: ['{{[INPUT]}}', '{{[OUTPUT]}}', '<|tool_call_end|>', '<|agent_call_end|>', '<|error_end|>'],
  useDefaultBadwordsids: false,
  bypassEos: false,
};

export class KoboldAPI {
  private baseUrl: string;
  private genkey: string;
  private settings: KoboldSettings;

  constructor(baseUrl: string = 'http://localhost:5001', settings?: Partial<KoboldSettings>) {
    this.baseUrl = baseUrl;
    this.genkey = `KCPP${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
    this.settings = { ...defaultSettings, ...settings, baseUrl };
  }

  updateSettings(newSettings: Partial<KoboldSettings>) {
    this.settings = { ...this.settings, ...newSettings };
    this.baseUrl = this.settings.baseUrl;
  }

  private async _callApi(endpoint: string, payload?: any): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined
    });

    if (!response.ok) {
      throw new Error(`Koboldcpp error: ${response.status}`);
    }

    return response.json();
  }

  private async _callApiGet(endpoint: string): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Koboldcpp error: ${response.status}`);
    }

    return response.json();
  }

  async generate(prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/v1/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        n: this.settings.n,
        max_context_length: this.settings.maxContextLength,
        max_length: this.settings.maxLength,
        rep_pen: this.settings.repetitionPenalty,
        temperature: this.settings.temperature,
        top_p: this.settings.topP,
        top_k: this.settings.topK,
        top_a: this.settings.topA,
        typical: this.settings.typical,
        tfs: this.settings.tfs,
        rep_pen_range: this.settings.repPenRange,
        rep_pen_slope: this.settings.repPenSlope,
        sampler_order: this.settings.samplerOrder,
        memory: this.settings.memory,
        trim_stop: this.settings.trimStop,
        genkey: this.genkey,
        min_p: this.settings.minP,
        dynatemp_range: this.settings.dynatempRange,
        dynatemp_exponent: this.settings.dynatempExponent,
        smoothing_factor: this.settings.smoothingFactor,
        nsigma: this.settings.nsigma,
        banned_tokens: this.settings.bannedTokens,
        render_special: this.settings.renderSpecial,
        logprobs: this.settings.logprobs,
        replace_instruct_placeholders: this.settings.replaceInstructPlaceholders,
        presence_penalty: this.settings.presencePenalty,
        logit_bias: this.settings.logitBias,
        stop_sequence: this.settings.stopSequence,
        use_default_badwordsids: this.settings.useDefaultBadwordsids,
        bypass_eos: this.settings.bypassEos,
      })
    });

    if (!response.ok) {
      throw new Error(`Koboldcpp error: ${response.status}`);
    }

    const data = await response.json();
    return data.results && data.results.length > 0 ? data.results[0].text : '';
  }

  async *generateStream(prompt: string, abortSignal?: AbortSignal): AsyncIterable<{ token?: string; finishReason?: string }> {
    const response = await fetch(`${this.baseUrl}/api/extra/generate/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        n: this.settings.n,
        max_context_length: this.settings.maxContextLength,
        max_length: this.settings.maxLength,
        rep_pen: this.settings.repetitionPenalty,
        temperature: this.settings.temperature,
        top_p: this.settings.topP,
        top_k: this.settings.topK,
        top_a: this.settings.topA,
        typical: this.settings.typical,
        tfs: this.settings.tfs,
        rep_pen_range: this.settings.repPenRange,
        rep_pen_slope: this.settings.repPenSlope,
        sampler_order: this.settings.samplerOrder,
        memory: this.settings.memory,
        trim_stop: this.settings.trimStop,
        genkey: this.genkey,
        min_p: this.settings.minP,
        dynatemp_range: this.settings.dynatempRange,
        dynatemp_exponent: this.settings.dynatempExponent,
        smoothing_factor: this.settings.smoothingFactor,
        nsigma: this.settings.nsigma,
        banned_tokens: this.settings.bannedTokens,
        render_special: this.settings.renderSpecial,
        logprobs: this.settings.logprobs,
        replace_instruct_placeholders: this.settings.replaceInstructPlaceholders,
        presence_penalty: this.settings.presencePenalty,
        logit_bias: this.settings.logitBias,
        stop_sequence: this.settings.stopSequence,
        use_default_badwordsids: this.settings.useDefaultBadwordsids,
        bypass_eos: this.settings.bypassEos,
      }),
      signal: abortSignal
    });

    if (!response.ok) {
      throw new Error(`Koboldcpp error: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is not readable');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        while (buffer.includes('\n\n')) {
          const messageEnd = buffer.indexOf('\n\n');
          const message = buffer.slice(0, messageEnd);
          buffer = buffer.slice(messageEnd + 2);

          for (const line of message.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.token) {
                  yield { token: data.token };
                }
                if (data.finish_reason) {
                  yield { finishReason: data.finish_reason };
                  return;
                }
              } catch (e) {
                continue;
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async getModel(): Promise<string> {
    const result = await this._callApiGet('/api/v1/model');
    return result.result;
  }

  async abortGeneration(): Promise<boolean> {
    try {
      await this._callApi('/api/extra/abort', { genkey: this.genkey });
      return true;
    } catch {
      return false;
    }
  }
}

export class KoboldEvaluator {
  private api: KoboldAPI;
  private systemPrompt: string;

  constructor(baseUrl?: string, systemPrompt: string = '', llmParams?: LLMParams) {
    const settings: Partial<KoboldSettings> = {};
    
    if (llmParams) {
      if (llmParams.temperature !== undefined) settings.temperature = llmParams.temperature;
      if (llmParams.maxTokens !== undefined) settings.maxLength = llmParams.maxTokens;
      if (llmParams.topP !== undefined) settings.topP = llmParams.topP;
      if (llmParams.topK !== undefined) settings.topK = llmParams.topK;
      if (llmParams.repeatPenalty !== undefined) settings.repetitionPenalty = llmParams.repeatPenalty;
      if (llmParams.stop !== undefined) settings.stopSequence = llmParams.stop;
      if (llmParams.maxContextLength !== undefined) settings.maxContextLength = llmParams.maxContextLength;
    }
    
    this.api = new KoboldAPI(baseUrl, settings);
    this.systemPrompt = systemPrompt;
  }

  getAPI(): KoboldAPI {
    return this.api;
  }

  async *evaluateChunk(chunk: Chunk): AsyncGenerator<Chunk> {
    if (chunk.contentType !== 'text') {
      yield annotateChunk(
        createNullChunk('com.rxcafe.kobold-evaluator'),
        'error.message',
        'KoboldEvaluator only accepts text chunks'
      );
      return;
    }

    const content = chunk.content as string;
    
    // Check if this is already a full conversation context (has full-prompt annotation)
    // If so, use it directly. Otherwise, wrap it as a single user message.
    const isFullPrompt = chunk.annotations['llm.full-prompt'] === true;
    
    let prompt: string;
    if (isFullPrompt) {
      // Content is already formatted as full conversation context
      prompt = this.systemPrompt 
        ? `${this.systemPrompt}\n\n${content}`
        : content;
    } else {
      // Single user message - wrap it
      prompt = this.systemPrompt 
        ? `${this.systemPrompt}\n\nUser: ${content}\nAssistant:`
        : `User: ${content}\nAssistant:`;
    }

    yield annotateChunk(
      createNullChunk('com.rxcafe.kobold-evaluator'),
      'llm.generation-started',
      true
    );

    try {
      for await (const { token, finishReason } of this.api.generateStream(prompt)) {
        if (token) {
          yield createTextChunk(token, 'com.rxcafe.kobold-evaluator', {
            'llm.stream': true,
            'llm.parent-chunk-id': chunk.id
          });
        }
        if (finishReason) {
          yield annotateChunk(
            createNullChunk('com.rxcafe.kobold-evaluator'),
            'llm.finish-reason',
            finishReason
          );
        }
      }
    } catch (error) {
      yield annotateChunk(
        createNullChunk('com.rxcafe.kobold-evaluator'),
        'error.message',
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }
}
