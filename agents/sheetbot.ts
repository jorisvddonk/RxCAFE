import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { annotateChunk } from '../lib/chunk.js';
import { EMPTY, filter, map, mergeMap, catchError } from '../lib/stream.js';
import { completeTurnWithLLM } from '../lib/evaluator-utils.js';
import { executeTools, getToolsSystemPrompt } from '../evaluators/tool-executor.js';
import { detectToolCalls } from '../evaluators/tool-call-detector.js';

export interface SheetbotTaskCreatorConfig {
  baseUrl?: string;
  apiKey?: string;
  token?: string;
  backend?: string;
  model?: string;
  systemPrompt?: string;
  llmParams?: {
    temperature?: number;
    maxTokens?: number;
  };
}

const SHEETBOT_TOOLS = [
  'sheetbot_list_sheets',
  'sheetbot_get_sheet',
  'sheetbot_list_tasks',
  'sheetbot_get_task',
  'sheetbot_create_task',
  'sheetbot_delete_task',
  'sheetbot_list_agents',
  'sheetbot_list_library'
];

export const sheetbotTaskCreatorAgent: AgentDefinition = {
  name: 'sheetbot',
  description: 'Create and manage SheetBot tasks via natural language. Use the sheetbot tool to list, create, and manage tasks.',
  configSchema: {
    type: 'object',
    properties: {
      baseUrl: { type: 'string', description: 'SheetBot server URL (default: from SHEETBOT_BASEURL env or http://localhost:3000)' },
      apiKey: { type: 'string', description: 'API key for authentication (default: from SHEETBOT_AUTH_APIKEY env)' },
      token: { type: 'string', description: 'JWT token for authentication (optional, will be obtained via login if apiKey provided)' },
      backend: { type: 'string', description: 'LLM backend (kobold or ollama)', default: 'ollama' },
      model: { type: 'string', description: 'Model name' },
      systemPrompt: { type: 'string', description: 'System prompt override' },
      llmParams: {
        type: 'object',
        properties: {
          temperature: { type: 'number' },
          maxTokens: { type: 'number' }
        }
      }
    },
    required: ['backend', 'model']
  },

  initialize(session: AgentSessionContext) {
    const config = session.config as SheetbotTaskCreatorConfig;
    
    const defaultSystemPrompt = `You are a helpful assistant that helps users create and manage SheetBot tasks.

SheetBot is a distributed task execution system where you can create tasks that run on remote agents.

When a user asks to create a task, help them:
1. Understand what script they want to run
2. Choose the appropriate execution type (deno, python, or bash)
3. Optionally add a name and data for the task

Available task statuses:
- AWAITING (0): Ready for execution
- RUNNING (1): Currently being executed  
- COMPLETED (2): Finished successfully
- FAILED (3): Finished with error
- PAUSED (4): Not ready for execution

${getToolsSystemPrompt(SHEETBOT_TOOLS)}

Always confirm when you've created or modified a task, and provide the task ID to the user.`;

    session.systemPrompt = config.systemPrompt || defaultSystemPrompt;

    const sub = session.inputStream.pipe(
      filter((chunk: Chunk) => chunk.contentType === 'text'),
      
      map((chunk: Chunk) => {
        if (chunk.annotations['chat.role']) return chunk;
        return annotateChunk(chunk, 'chat.role', 'user');
      }),
      
      filter((chunk: Chunk) => {
        const trustLevel = chunk.annotations['security.trust-level'];
        return !trustLevel || trustLevel.trusted !== false;
      }),
      
      mergeMap((chunk: Chunk) => {
        if (chunk.annotations['chat.role'] !== 'user') return [chunk];
        
        const backend = (config.backend || 'ollama') as 'ollama' | 'kobold';
        
        const evaluator = session.createLLMChunkEvaluator(
          backend,
          config.model,
          config.llmParams || { temperature: 0.7, maxTokens: 1000 }
        );
        
        return completeTurnWithLLM(chunk, evaluator, session).pipe(
          mergeMap(detectToolCalls()),
          mergeMap(executeTools({ tools: SHEETBOT_TOOLS }))
        );
      }),
      
      catchError((error: Error) => {
        session.errorStream.next(error);
        return EMPTY;
      })
    ).subscribe({
      next: (chunk: Chunk) => session.outputStream.next(chunk),
      error: (error: Error) => session.errorStream.next(error)
    });
    
    session.pipelineSubscription = sub;
  }
};

export default sheetbotTaskCreatorAgent;
