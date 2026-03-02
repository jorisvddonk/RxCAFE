import type { Chunk } from '../lib/chunk.js';
import { createTextChunk } from '../lib/chunk.js';
import { Observable } from '../lib/stream.js';
import { DieRollerTool } from '../tools/die-roller.js';
import { BashTool } from '../tools/bash-executor.js';
import { ReadFileTool } from '../tools/read-file.js';
import { WriteFileTool } from '../tools/write-file.js';
import { UpdateFileTool } from '../tools/update-file.js';
import { ListDirectoryTool } from '../tools/list-directory.js';
import { GlobTool } from '../tools/glob.js';
import { WebSearchTool } from '../tools/web-search.js';
import { WebFetchTool } from '../tools/web-fetch.js';
import { KnowledgeWriteTool, KnowledgeRetrieveTool, KnowledgeSearchTool, KnowledgeListTool } from '../tools/knowledgebase.js';
import { gitTool } from '../tools/git.js';

export interface Tool {
  name: string;
  execute(params: any): any;
  systemPrompt?: string;
}

const ALL_TOOLS: Map<string, Tool> = new Map([
  ['rollDice', new DieRollerTool()],
  ['bash', new BashTool()],
  ['readFile', new ReadFileTool()],
  ['writeFile', new WriteFileTool()],
  ['updateFile', new UpdateFileTool()],
  ['listDirectory', new ListDirectoryTool()],
  ['glob', new GlobTool()],
  ['webSearch', new WebSearchTool()],
  ['webFetch', new WebFetchTool()],
  ['knowledgeWrite', new KnowledgeWriteTool()],
  ['knowledgeRetrieve', new KnowledgeRetrieveTool()],
  ['knowledgeSearch', new KnowledgeSearchTool()],
  ['knowledgeList', new KnowledgeListTool()],
  ['git', gitTool]
]);

export function getTool(name: string): Tool | undefined {
  return ALL_TOOLS.get(name);
}

export function getToolNames(): string[] {
  return Array.from(ALL_TOOLS.keys());
}

export function getToolsSystemPrompt(toolNames?: string[]): string {
  const names = toolNames && toolNames.length > 0 ? toolNames : getToolNames();

  const toolPrompts = names
    .map(name => {
      const tool = ALL_TOOLS.get(name);
      return tool?.systemPrompt || '';
    })
    .filter(p => p.length > 0)
    .join('\n\n');

  return toolPrompts ? `You have access to the following tools:\n\n${toolPrompts}` : '';
}

export interface ExecuteToolsOptions {
  tools?: string[];
}

export function executeTools(options: ExecuteToolsOptions = {}) {
  const tools = options.tools 
    ? new Map(options.tools.map(name => [name, ALL_TOOLS.get(name)]).filter(([, t]) => t !== undefined) as [string, Tool][])
    : ALL_TOOLS;

  return (chunk: Chunk): Observable<Chunk> => {
    return new Observable(subscriber => {
      const toolDetection = chunk.annotations?.['com.rxcafe.tool-detection'];
      
      if (!toolDetection?.hasToolCalls) {
        subscriber.next(chunk);
        subscriber.complete();
        return;
      }

      const executionPromises = toolDetection.toolCalls.map(async (call: any) => {
        const tool = tools.get(call.name);
        
        if (!tool) {
          console.warn(`[ToolExecutor] Tool not found: ${call.name}`);
          return null;
        }

        try {
          const result = await tool.execute(call.parameters);
          return createTextChunk(
            formatToolResult(call.name, result),
            `com.rxcafe.tool.${call.name}`,
            {
              'chat.role': 'assistant',
              'tool.name': call.name,
              'tool.results': result
            }
          );
        } catch (error) {
          console.error(`[ToolExecutor] Error executing tool ${call.name}:`, error);
          return null;
        }
      });

      Promise.all(executionPromises).then(results => {
        const validResults = results.filter(result => result !== null);
        
        subscriber.next(chunk);
        
        validResults.forEach(result => subscriber.next(result));
        
        subscriber.complete();
      });
    });
  };
}

function formatToolResult(toolName: string, result: any): string {
  if (toolName === 'rollDice') {
    return `${result.expression}: ${result.rolls.join(' + ')} = ${result.total}`;
  }

  if (toolName === 'bash') {
    let output = '';
    if (result.timedOut) {
      output = `Command timed out after ${result.timeout || 30000}ms\n`;
    }
    if (result.stderr) {
      output += `stderr: ${result.stderr}\n`;
    }
    if (result.stdout) {
      output += result.stdout;
    }
    if (result.exitCode !== null && result.exitCode !== 0) {
      output += `\nexit code: ${result.exitCode}`;
    }
    return output || '(no output)';
  }

  if (toolName === 'readFile') {
    if (result.error) return `Error: ${result.error}`;
    return `[${result.path}] (${result.size} bytes)\n${result.content}`;
  }

  if (toolName === 'writeFile' || toolName === 'updateFile') {
    if (result.error) return `Error: ${result.error}`;
    return `Wrote ${result.bytesWritten} bytes to ${result.path} (${result.action})`;
  }

  if (toolName === 'listDirectory') {
    if (result.error) return `Error: ${result.error}`;
    const lines = result.files.map((f: any) => 
      `${f.isDirectory ? 'd' : '-'} ${f.size.toString().padStart(8)} ${f.name}`
    );
    return `Contents of ${result.path}:\n${lines.join('\n')}`;
  }

  if (toolName === 'glob') {
    if (result.error) return `Error: ${result.error}`;
    if (result.matches.length === 0) return 'No matches found';
    return `Matches (${result.matches.length}):\n${result.matches.join('\n')}`;
  }

  if (toolName === 'webSearch') {
    if (result.error) return `Error: ${result.error}`;
    if (result.results.length === 0) return 'No results found';
    return result.results.map((r: any) => 
      `${r.title}\n${r.url}\n${r.snippet}\n`
    ).join('---\n');
  }

  if (toolName === 'webFetch') {
    if (result.error) return `Error: ${result.error}`;
    return `[${result.url}]\n${result.title ? result.title + '\n' : ''}${result.content}`;
  }

  if (toolName === 'knowledgeWrite') {
    if (result.error) return `Error: ${result.error}`;
    return `Stored entry #${result.id} successfully`;
  }

  if (toolName === 'knowledgeRetrieve') {
    if (result.error) return `Error: ${result.error}`;
    if (!result.success) return `Entry not found`;
    return `[Entry #${result.id}] ${result.content}`;
  }

  if (toolName === 'knowledgeSearch') {
    if (result.error) return `Error: ${result.error}`;
    if (result.results.length === 0) return 'No matching entries found';
    return result.results.map((r: any) => 
      `[#${r.id}] score:${r.score}\n${r.content}`
    ).join('\n---\n');
  }

  if (toolName === 'knowledgeList') {
    if (result.error) return `Error: ${result.error}`;
    return `Total: ${result.total} entries\n` + 
      result.entries.map((e: any) => 
        `[#${e.id}] ${e.content}`
      ).join('\n');
  }

  if (toolName === 'git') {
    if (result.stderr) return `Error: ${result.stderr}`;
    return result.stdout || '(no output)';
  }

  return JSON.stringify(result, null, 2);
}

export const TOOLS_SYSTEM_PROMPT = getToolsSystemPrompt(getToolNames());
