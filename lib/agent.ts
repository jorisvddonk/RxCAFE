/**
 * RXCAFE Agent System
 * 
 * Agents are pipeline builders that receive inputStream and build RxJS pipelines
 * that emit to outputStream. They can be used interactively (on-demand) or
 * as background sessions (persistent, auto-started).
 */

import { Subject } from './stream.js';
import type { Chunk } from './chunk.js';
import type { CoreConfig, LLMBackend } from '../core.js';

export interface LLMParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  stop?: string[];
  seed?: number;
  maxContextLength?: number;
  numCtx?: number;
}

export interface SessionConfig {
  backend?: LLMBackend;
  model?: string;
  llmParams?: LLMParams;
  systemPrompt?: string;
}

export interface AgentDefinition {
  name: string;
  description?: string;
  startInBackground?: boolean;
  
  initialize(session: AgentSessionContext): void | Promise<void>;
  destroy?(session: AgentSessionContext): void | Promise<void>;
}

export interface AgentSessionContext {
  id: string;
  agentName: string;
  isBackground: boolean;
  
  inputStream: Subject<Chunk>;
  outputStream: Subject<Chunk>;
  errorStream: Subject<Error>;
  history: Chunk[];
  
  config: CoreConfig;
  sessionConfig: SessionConfig;
  systemPrompt: string | null;
  
  createEvaluator(backend: LLMBackend, model?: string, params?: LLMParams): AgentEvaluator;
  
  schedule(cronExpr: string, callback: () => void | Promise<void>): () => void;
  
  persistState(): Promise<void>;
  loadState(): Promise<void>;
  
  trustedChunks: Set<string>;
  callbacks: ChatCallbacks | null;
  pipelineSubscription?: { unsubscribe: () => void };
}

export interface AgentEvaluator {
  evaluateChunk(chunk: Chunk): AsyncGenerator<Chunk>;
  abort(): Promise<void>;
}

export interface ChatCallbacks {
  onToken: (token: string) => void;
  onFinish: (fullResponse: string) => void;
  onError: (error: Error) => void;
}

export function extractLLMParamsFromConfig(configChunk: Chunk): LLMParams {
  const params: LLMParams = {};
  
  if (configChunk.annotations['config.llm.temperature'] !== undefined) {
    params.temperature = configChunk.annotations['config.llm.temperature'];
  }
  if (configChunk.annotations['config.llm.maxTokens'] !== undefined) {
    params.maxTokens = configChunk.annotations['config.llm.maxTokens'];
  }
  if (configChunk.annotations['config.llm.topP'] !== undefined) {
    params.topP = configChunk.annotations['config.llm.topP'];
  }
  if (configChunk.annotations['config.llm.topK'] !== undefined) {
    params.topK = configChunk.annotations['config.llm.topK'];
  }
  if (configChunk.annotations['config.llm.repeatPenalty'] !== undefined) {
    params.repeatPenalty = configChunk.annotations['config.llm.repeatPenalty'];
  }
  if (configChunk.annotations['config.llm.stop'] !== undefined) {
    params.stop = configChunk.annotations['config.llm.stop'];
  }
  if (configChunk.annotations['config.llm.seed'] !== undefined) {
    params.seed = configChunk.annotations['config.llm.seed'];
  }
  if (configChunk.annotations['config.llm.maxContextLength'] !== undefined) {
    params.maxContextLength = configChunk.annotations['config.llm.maxContextLength'];
  }
  if (configChunk.annotations['config.llm.numCtx'] !== undefined) {
    params.numCtx = configChunk.annotations['config.llm.numCtx'];
  }
  
  return params;
}

export function extractSessionConfigFromChunk(configChunk: Chunk): SessionConfig {
  return {
    backend: configChunk.annotations['config.backend'],
    model: configChunk.annotations['config.model'],
    llmParams: extractLLMParamsFromConfig(configChunk),
    systemPrompt: configChunk.annotations['config.systemPrompt'],
  };
}
