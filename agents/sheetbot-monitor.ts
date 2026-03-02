import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import { createTextChunk } from '../lib/chunk.js';
import { SheetbotAPI, TaskStatusNames } from '../lib/sheetbot-api.js';

export interface SheetbotMonitorConfig {
  baseUrl?: string;
  apiKey?: string;
  token?: string;
  pollInterval?: number;
}

export const sheetbotMonitorAgent: AgentDefinition = {
  name: 'sheetbot-monitor',
  description: 'Background agent that monitors SheetBot task events (status changes, new tasks, deleted tasks)',
  startInBackground: true,
  persistsState: false,
  configSchema: {
    type: 'object',
    properties: {
      baseUrl: { type: 'string', description: 'SheetBot server URL (default: from SHEETBOT_BASEURL env or http://localhost:3000)' },
      apiKey: { type: 'string', description: 'API key for authentication (default: from SHEETBOT_AUTH_APIKEY env)' },
      token: { type: 'string', description: 'JWT token for authentication (optional, will be obtained via login if apiKey provided)' },
      pollInterval: { type: 'number', description: 'Polling interval in seconds (default: 30)' }
    },
    required: []
  },

  initialize(session: AgentSessionContext) {
    const config = session.config as SheetbotMonitorConfig;
    
    const baseUrl = config.baseUrl || process.env.SHEETBOT_BASEURL || 'http://localhost:3000';
    const apiKey = config.apiKey || process.env.SHEETBOT_AUTH_APIKEY;
    
    if (!apiKey) {
      console.log('[SheetbotMonitor] SHEETBOT_AUTH_APIKEY not set, skipping background agent');
      session.outputStream.next(createTextChunk(
        'SheetBot monitor skipped: SHEETBOT_AUTH_APIKEY not configured',
        'com.rxcafe.sheetbot-monitor',
        { 'chat.role': 'assistant', 'sheetbot.event': 'skipped' }
      ));
      return;
    }
    
    const pollInterval = (config.pollInterval || 30) * 1000;
    
    const api = new SheetbotAPI(baseUrl);
    
    const startMonitor = async () => {
      if (config.token) {
        api.setToken(config.token);
      } else {
        console.log('[SheetbotMonitor] Authenticating with API key...');
        try {
          await api.loginWithApiKey(apiKey);
          console.log('[SheetbotMonitor] Authentication successful');
        } catch (error) {
          console.error('[SheetbotMonitor] Authentication failed:', error);
          session.outputStream.next(createTextChunk(
            `SheetBot monitor error: Authentication failed - ${error}`,
            'com.rxcafe.sheetbot-monitor',
            { 'chat.role': 'assistant', 'sheetbot.event': 'auth_error' }
          ));
          return;
        }
      }

      console.log(`[SheetbotMonitor] Starting monitor for ${baseUrl}`);

      const knownTasks = new Map<string, number>();
      let eventSource: EventSource | null = null;
      let pollTimer: ReturnType<typeof setInterval> | null = null;

      const emitMessage = (message: string, eventType: string) => {
        const chunk = createTextChunk(
          message,
          'com.rxcafe.sheetbot-monitor',
          { 'chat.role': 'assistant', 'sheetbot.event': eventType }
        );
        session.outputStream.next(chunk);
      };

      const checkForChanges = async () => {
        try {
          const tasks = await api.getTasks();
          
          for (const task of tasks) {
            const oldStatus = knownTasks.get(task.id);
            
            if (oldStatus === undefined) {
              knownTasks.set(task.id, task.status);
              emitMessage(
                `New task: ${task.name || task.id} (${TaskStatusNames[task.status]})`,
                'task:created'
              );
            } else if (oldStatus !== task.status) {
              knownTasks.set(task.id, task.status);
              const oldStatusName = TaskStatusNames[oldStatus] || 'UNKNOWN';
              const newStatusName = TaskStatusNames[task.status] || 'UNKNOWN';
              emitMessage(
                `Task ${task.name || task.id} changed: ${oldStatusName} → ${newStatusName}`,
                'task:status_changed'
              );
            }
          }

          const currentIds = new Set(tasks.map(t => t.id));
          for (const [id] of knownTasks) {
            if (!currentIds.has(id)) {
              knownTasks.delete(id);
              emitMessage(
                `Task deleted: ${id}`,
                'task:deleted'
              );
            }
          }
        } catch (error) {
          console.error('[SheetbotMonitor] Error checking tasks:', error);
        }
      };

      const trySubscribeEvents = () => {
      try {
        eventSource = api.createEventSource();
        
        eventSource.onopen = () => {
          console.log('[SheetbotMonitor] SSE connected');
        };

        eventSource.addEventListener('task:created', (event) => {
          try {
            const data = JSON.parse(event.data);
            knownTasks.set(data.data.taskId, 0);
            emitMessage(
              `New task created: ${data.data.taskId}`,
              'task:created'
            );
          } catch (e) {
            console.error('[SheetbotMonitor] Error parsing task:created:', e);
          }
        });

        eventSource.addEventListener('task:status_changed', (event) => {
          try {
            const data = JSON.parse(event.data);
            const oldStatus = data.data.oldStatus;
            const newStatus = data.data.newStatus;
            knownTasks.set(data.data.taskId, newStatus);
            emitMessage(
              `Task ${data.data.taskId} status changed: ${TaskStatusNames[oldStatus]} → ${TaskStatusNames[newStatus]}`,
              'task:status_changed'
            );
          } catch (e) {
            console.error('[SheetbotMonitor] Error parsing task:status_changed:', e);
          }
        });

        eventSource.addEventListener('task:deleted', (event) => {
          try {
            const data = JSON.parse(event.data);
            knownTasks.delete(data.data.taskId);
            emitMessage(
              `Task deleted: ${data.data.taskId}`,
              'task:deleted'
            );
          } catch (e) {
            console.error('[SheetbotMonitor] Error parsing task:deleted:', e);
          }
        });

        eventSource.onerror = () => {
          console.log('[SheetbotMonitor] SSE error, falling back to polling');
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
        };
      } catch (error) {
        console.log('[SheetbotMonitor] SSE not available, using polling');
      }
    };

      checkForChanges().then(() => {
        trySubscribeEvents();
        
        pollTimer = setInterval(checkForChanges, pollInterval);
      });

      session.pipelineSubscription = {
        unsubscribe: () => {
          console.log('[SheetbotMonitor] Stopping');
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
        }
      } as any;
    };

    startMonitor();
  },

  destroy(session: AgentSessionContext) {
    console.log('[SheetbotMonitor] Destroying');
    if (session.pipelineSubscription) {
      session.pipelineSubscription.unsubscribe();
    }
  }
};

export default sheetbotMonitorAgent;
