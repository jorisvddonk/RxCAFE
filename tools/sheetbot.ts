import { SheetbotAPI, SheetbotTask, SheetbotTaskCreate, SheetbotAgentTrackerStats, SheetbotLibraryItem, TaskStatusNames } from '../lib/sheetbot-api.js';

export interface SheetbotToolParams {
  baseUrl?: string;
  apiKey?: string;
  token?: string;
}

const createAuthenticatedApi = async (params: SheetbotToolParams): Promise<SheetbotAPI> => {
  const baseUrl = params.baseUrl || process.env.SHEETBOT_BASEURL || 'http://localhost:3000';
  const api = new SheetbotAPI(baseUrl);
  
  if (params.token) {
    api.setToken(params.token);
  } else {
    const apiKey = params.apiKey || process.env.SHEETBOT_AUTH_APIKEY;
    if (apiKey) {
      await api.loginWithApiKey(apiKey);
    }
  }
  
  return api;
};

export interface ListTasksParams extends SheetbotToolParams {
  status?: number;
}

export interface GetTaskParams extends SheetbotToolParams {
  taskId: string;
}

export interface CreateTaskParams extends SheetbotToolParams {
  script: string;
  name?: string;
  type?: 'deno' | 'python' | 'bash';
  data?: Record<string, any>;
}

export interface DeleteTaskParams extends SheetbotToolParams {
  taskId: string;
}

export interface ListSheetsParams extends SheetbotToolParams {}

export interface GetSheetParams extends SheetbotToolParams {
  sheet: string;
}

export interface GetAgentStatsParams extends SheetbotToolParams {
  minutes?: number;
}

export class SheetbotTool {
  readonly name = 'sheetbot_list_sheets';
  readonly systemPrompt = SHEETBOT_LIST_SHEETS_PROMPT;

  async execute(params: ListSheetsParams): Promise<any> {
    const api = await createAuthenticatedApi(params);
    const sheets = await api.listSheets();
    return { sheets, count: sheets.length };
  }
}

export class SheetbotGetSheetTool {
  readonly name = 'sheetbot_get_sheet';
  readonly systemPrompt = SHEETBOT_GET_SHEET_PROMPT;

  async execute(params: GetSheetParams): Promise<any> {
    const api = await createAuthenticatedApi(params);
    const sheet = await api.getSheet(params.sheet);
    const columns = sheet.columns.map(c => c.name);
    const rows = sheet.rows.slice(0, 20).map(row => {
      const obj: Record<string, any> = {};
      row.forEach((val, i) => { obj[columns[i]] = val; });
      return obj;
    });
    return {
      sheet: params.sheet,
      columns,
      rowCount: sheet.rows.length,
      rows,
      truncated: sheet.rows.length > 20
    };
  }
}

export class SheetbotListTasksTool {
  readonly name = 'sheetbot_list_tasks';
  readonly systemPrompt = SHEETBOT_LIST_TASKS_PROMPT;

  async execute(params: ListTasksParams): Promise<any> {
    const api = await createAuthenticatedApi(params);
    const tasks = await api.getTasks();
    let filtered = tasks;
    if (params.status !== undefined) {
      filtered = tasks.filter(t => t.status === params.status);
    }
    const formatted = filtered.map(t => ({
      id: t.id,
      name: t.name || '(unnamed)',
      status: `${t.status} (${TaskStatusNames[t.status] || 'UNKNOWN'})`,
      type: t.type,
      data: t.data
    }));
    return { count: filtered.length, tasks: formatted };
  }
}

export class SheetbotGetTaskTool {
  readonly name = 'sheetbot_get_task';
  readonly systemPrompt = SHEETBOT_GET_TASK_PROMPT;

  async execute(params: GetTaskParams): Promise<any> {
    const api = await createAuthenticatedApi(params);
    const task = await api.getTask(params.taskId);
    return {
      id: task.id,
      name: task.name || '(unnamed)',
      status: `${task.status} (${TaskStatusNames[t.status] || 'UNKNOWN'})`,
      type: task.type,
      script: task.script.substring(0, 200) + (task.script.length > 200 ? '...' : ''),
      data: task.data,
      dependsOn: task.dependsOn,
      artefacts: task.artefacts
    };
  }
}

export class SheetbotCreateTaskTool {
  readonly name = 'sheetbot_create_task';
  readonly systemPrompt = SHEETBOT_CREATE_TASK_PROMPT;

  async execute(params: CreateTaskParams): Promise<any> {
    const api = await createAuthenticatedApi(params);
    const taskCreate: SheetbotTaskCreate = {
      script: params.script,
      name: params.name,
      type: params.type || 'deno',
      data: params.data
    };
    const task = await api.createTask(taskCreate);
    return {
      id: task.id,
      name: task.name || '(unnamed)',
      status: `${task.status} (${TaskStatusNames[task.status]})`,
      message: `Created task ${task.id}${task.name ? ` (${task.name})` : ''}`
    };
  }
}

export class SheetbotDeleteTaskTool {
  readonly name = 'sheetbot_delete_task';
  readonly systemPrompt = SHEETBOT_DELETE_TASK_PROMPT;

  async execute(params: DeleteTaskParams): Promise<any> {
    const api = await createAuthenticatedApi(params);
    await api.deleteTask(params.taskId);
    return { message: `Deleted task ${params.taskId}` };
  }
}

export class SheetbotListAgentsTool {
  readonly name = 'sheetbot_list_agents';
  readonly systemPrompt = SHEETBOT_LIST_AGENTS_PROMPT;

  async execute(params: GetAgentStatsParams): Promise<any> {
    const api = await createAuthenticatedApi(params);
    const stats = await api.getAgentTrackerStats(params.minutes);
    
    const formatted = stats.agents.map(a => ({
      id: a.id,
      ip: a.ip,
      type: a.type,
      lastSeen: new Date(a.lastSeen).toISOString(),
      capabilities: a.capabilities
    }));
    
    return {
      totalUniqueAgents: stats.totalUniqueAgents,
      activeAgents: stats.activeAgents,
      windowMinutes: stats.windowMinutes,
      agents: formatted
    };
  }
}

export class SheetbotListLibraryTool {
  readonly name = 'sheetbot_list_library';
  readonly systemPrompt = SHEETBOT_LIST_LIBRARY_PROMPT;

  async execute(params: SheetbotToolParams): Promise<any> {
    const api = await createAuthenticatedApi(params);
    const library = await api.getLibrary();
    
    const formatted = library.map(item => ({
      filename: item.filename,
      name: item.name,
      capabilitiesSchema: item.capabilitiesSchema,
      comments: item.comments
    }));
    
    return {
      count: library.length,
      scripts: formatted
    };
  }
}

export const SHEETBOT_LIST_SHEETS_PROMPT = `
Tool: sheetbot_list_sheets
Description: List all available sheets in SheetBot
Parameters:
- baseUrl: SheetBot server URL (optional, default: http://localhost:3000)
- token: JWT token for authentication (optional)

Example: <|tool_call|>{"name":"sheetbot_list_sheets","parameters":{}}<|tool_call_end|>
`;

export const SHEETBOT_GET_SHEET_PROMPT = `
Tool: sheetbot_get_sheet
Description: Get data from a specific sheet
Parameters:
- baseUrl: SheetBot server URL (optional)
- token: JWT token for authentication (optional)
- sheet: Sheet name (required)

Example: <|tool_call|>{"name":"sheetbot_get_sheet","parameters":{"sheet":"users"}}<|tool_call_end|>
`;

export const SHEETBOT_LIST_TASKS_PROMPT = `
Tool: sheetbot_list_tasks
Description: List all tasks in SheetBot, optionally filtered by status
Parameters:
- baseUrl: SheetBot server URL (optional)
- token: JWT token for authentication (optional)
- status: Filter by status (0=AWAITING, 1=RUNNING, 2=COMPLETED, 3=FAILED, 4=PAUSED)

Example: <|tool_call|>{"name":"sheetbot_list_tasks","parameters":{"status":0}}<|tool_call_end|>
`;

export const SHEETBOT_GET_TASK_PROMPT = `
Tool: sheetbot_get_task
Description: Get details of a specific task
Parameters:
- baseUrl: SheetBot server URL (optional)
- token: JWT token for authentication (optional)
- taskId: Task UUID (required)

Example: <|tool_call|>{"name":"sheetbot_get_task","parameters":{"taskId":"12345678-1234-1234-1234-123456789abc"}}<|tool_call_end|>
`;

export const SHEETBOT_CREATE_TASK_PROMPT = `
Tool: sheetbot_create_task
Description: Create a new task in SheetBot
Parameters:
- baseUrl: SheetBot server URL (optional)
- token: JWT token for authentication (optional)
- script: Task script content (required)
- name: Task name (optional)
- type: Execution type (deno|python|bash, default: deno)
- data: JSON data object (optional)

Example: <|tool_call|>{"name":"sheetbot_create_task","parameters":{"script":"console.log('hello')","name":"Test Task"}}<|tool_call_end|>
`;

export const SHEETBOT_DELETE_TASK_PROMPT = `
Tool: sheetbot_delete_task
Description: Delete a task from SheetBot
Parameters:
- baseUrl: SheetBot server URL (optional)
- token: JWT token for authentication (optional)
- taskId: Task UUID (required)

Example: <|tool_call|>{"name":"sheetbot_delete_task","parameters":{"taskId":"12345678-1234-1234-1234-123456789abc"}}<|tool_call_end|>
`;

export const SHEETBOT_LIST_AGENTS_PROMPT = `
Tool: sheetbot_list_agents
Description: List recently active agents in SheetBot
Parameters:
- baseUrl: SheetBot server URL (optional)
- token: JWT token for authentication (optional)
- minutes: Time window in minutes (optional, default: 1440)

Example: <|tool_call|>{"name":"sheetbot_list_agents","parameters":{"minutes":60}}<|tool_call_end|>
`;

export const SHEETBOT_LIST_LIBRARY_PROMPT = `
Tool: sheetbot_list_library
Description: List available scripts in SheetBot library with their capabilities schemas
Parameters:
- baseUrl: SheetBot server URL (optional)
- token: JWT token for authentication (optional)

Example: <|tool_call|>{"name":"sheetbot_list_library","parameters":{}}<|tool_call_end|>
`;

export const SHEETBOT_SYSTEM_PROMPT = `
You have access to SheetBot tools for managing tasks and sheets.

SheetBot is a distributed task execution system with a spreadsheet-like data layer.

Task statuses:
- 0 (AWAITING): Ready for execution
- 1 (RUNNING): Currently being executed
- 2 (COMPLETED): Finished successfully
- 3 (FAILED): Finished with error
- 4 (PAUSED): Not ready for execution

${SHEETBOT_LIST_SHEETS_PROMPT}
${SHEETBOT_GET_SHEET_PROMPT}
${SHEETBOT_LIST_TASKS_PROMPT}
${SHEETBOT_GET_TASK_PROMPT}
${SHEETBOT_CREATE_TASK_PROMPT}
${SHEETBOT_DELETE_TASK_PROMPT}
${SHEETBOT_LIST_AGENTS_PROMPT}
${SHEETBOT_LIST_LIBRARY_PROMPT}
`;
