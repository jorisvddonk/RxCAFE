/* eslint-disable @typescript-eslint/no-explicit-any */
export interface SheetbotTask {
  id: string;
  name?: string;
  script: string;
  status: 0 | 1 | 2 | 3 | 4;
  data: string | Record<string, any>;
  artefacts: string[];
  dependsOn: string[];
  transitions: any[];
  type: 'deno' | 'python' | 'bash' | 'freedos-bat';
  capabilitiesSchema?: string | Record<string, any>;
}

export interface SheetbotTaskCreate {
  script: string;
  name?: string;
  id?: string;
  data?: string | Record<string, any>;
  capabilitiesSchema?: string | Record<string, any>;
  type?: 'deno' | 'python' | 'bash' | 'freedos-bat';
  transitions?: any[];
  dependsOn?: string[];
  status?: 0 | 1 | 2 | 3 | 4;
}

export interface SheetbotTaskUpdate {
  status?: 0 | 1 | 2 | 3 | 4;
}

export interface SheetbotTaskTrackerStats {
  added: number;
  completed: number;
  failed: number;
  windowMinutes: number;
}

export interface SheetbotAgentTrackerStats {
  totalUniqueAgents: number;
  activeAgents: number;
  agents: {
    id: string;
    ip: string;
    type: string;
    lastSeen: number;
    capabilities?: Record<string, any>;
  }[];
  windowMinutes: number;
}

export interface SheetbotLibraryItem {
  filename: string;
  name: string;
  capabilitiesSchema?: Record<string, any>;
  suggestedData?: Record<string, any>;
  comments?: string;
}

export interface SheetbotSheet {
  columns: { name: string; type: string }[];
  rows: any[][];
}

export interface SheetbotError {
  error: string;
}

export type TaskStatusName = 'AWAITING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PAUSED' | 'DELETED';

export const TaskStatusNames: Record<number, TaskStatusName> = {
  0: 'AWAITING',
  1: 'RUNNING',
  2: 'COMPLETED',
  3: 'FAILED',
  4: 'PAUSED'
};

export class SheetbotAPI {
  private baseUrl: string;
  private token?: string;

  constructor(baseUrl: string = 'http://localhost:3000') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  setToken(token: string) {
    this.token = token;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {};

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    let fetchOptions: RequestInit = { ...options };

    if (options.body) {
      if (typeof options.body === 'object' && !(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        fetchOptions = {
          ...options,
          headers,
          body: JSON.stringify(options.body as object)
        };
      } else if (typeof options.body === 'string' && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
        fetchOptions = {
          ...options,
          headers
        };
      } else {
        fetchOptions = {
          ...options,
          headers
        };
      }
    } else {
      fetchOptions = {
        ...options,
        headers
      };
    }

    const response = await fetch(`${this.baseUrl}${path}`, fetchOptions);

    if (!response.ok) {
      const error: SheetbotError = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json();
  }

  async login(username: string, password: string): Promise<string> {
    const result = await this.request<{ token: string }>('/login', {
      method: 'POST',
      body: { username, password } as unknown as BodyInit
    });
    this.token = result.token;
    return result.token;
  }

  async loginWithApiKey(apiKey: string): Promise<string> {
    const result = await this.request<{ token: string }>('/login', {
      method: 'POST',
      body: { apiKey } as unknown as BodyInit
    });
    this.token = result.token;
    return result.token;
  }

  async ensureAuthenticated(): Promise<void> {
    if (!this.token) {
      throw new Error('Not authenticated. Call login() or loginWithApiKey() first.');
    }
  }

  async getTasks(): Promise<SheetbotTask[]> {
    return this.request<SheetbotTask[]>('/tasks');
  }

  async getTask(id: string): Promise<SheetbotTask> {
    return this.request<SheetbotTask>(`/tasks/${id}`);
  }

  async createTask(task: SheetbotTaskCreate): Promise<SheetbotTask> {
    const body = JSON.stringify(task);
    return this.request<SheetbotTask>('/tasks', {
      method: 'POST',
      body
    });
  }

  async updateTask(id: string, update: SheetbotTaskUpdate): Promise<void> {
    const body = JSON.stringify(update);
    return this.request<void>(`/tasks/${id}`, {
      method: 'PATCH',
      body
    });
  }

  async deleteTask(id: string): Promise<void> {
    return this.request<void>(`/tasks/${id}`, {
      method: 'DELETE'
    });
  }

  async acceptTask(id: string): Promise<void> {
    return this.request<void>(`/tasks/${id}/accept`, {
      method: 'POST'
    });
  }

  async completeTask(id: string, data?: Record<string, any>): Promise<void> {
    const body = data ? JSON.stringify({ data }) : undefined;
    return this.request<void>(`/tasks/${id}/complete`, {
      method: 'POST',
      body
    });
  }

  async failTask(id: string): Promise<void> {
    return this.request<void>(`/tasks/${id}/failed`, {
      method: 'POST'
    });
  }

  async getTaskTrackerStats(minutes?: number): Promise<SheetbotTaskTrackerStats> {
    const query = minutes ? `?minutes=${minutes}` : '';
    return this.request<SheetbotTaskTrackerStats>(`/tasktracker${query}`);
  }

  async getAgentTrackerStats(minutes?: number): Promise<SheetbotAgentTrackerStats> {
    const query = minutes ? `?minutes=${minutes}` : '';
    return this.request<SheetbotAgentTrackerStats>(`/agenttracker${query}`);
  }

  async getScript(uuid: string): Promise<string> {
    return this.request<string>(`/scripts/${uuid}`);
  }

  async listSheets(): Promise<string[]> {
    return this.request<string[]>('/sheets');
  }

  async getSheet(name: string): Promise<SheetbotSheet> {
    return this.request<SheetbotSheet>(`/sheets/${name}`);
  }

  async getLibrary(): Promise<SheetbotLibraryItem[]> {
    return this.request<SheetbotLibraryItem[]>('/library');
  }

  async upsertSheetRow(sheetName: string, key: string, data: Record<string, any>): Promise<void> {
    const body = JSON.stringify({ key, ...data });
    return this.request<void>(`/sheets/${sheetName}/data`, {
      method: 'POST',
      body
    });
  }

  async deleteSheetRow(sheetName: string, key: string): Promise<void> {
    return this.request<void>(`/sheets/${sheetName}/data/${key}`, {
      method: 'DELETE'
    });
  }

  createEventSource(): EventSource {
    const url = `${this.baseUrl}/events`;
    return new EventSource(url);
  }
}

export const sheetbotAPI = new SheetbotAPI();
