import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { createTextChunk, createBinaryChunk } from '../lib/chunk.js';
import { filter, mergeMap, catchError, EMPTY, from } from '../lib/stream.js';
import { SheetbotAPI } from '../lib/sheetbot-api.js';

export interface SheetbotFreedosConfig {
  baseUrl?: string;
  apiKey?: string;
  token?: string;
}

const FREEDOS_SCRIPT_TEMPLATE = `@ECHO OFF
REM ============================================================
REM  Sheetbot FreeDOS Task Script - Noctis IV Planet Dump
REM  Reads coordinates from task data, renders planet, uploads BMPs.
REM
REM  Task data format:
REM  {
REM    "x": -18928,
REM    "y": 29680,
REM    "z": -67336,
REM    "planet": 3
REM  }
REM ============================================================

SET PATH=C\;%PATH%

REM ---- Fetch task data ----
ECHO Fetching task data...
ECHO -s> c.cfg
ECHO -k>> c.cfg
ECHO -H "Authorization: %SHEETBOT_AUTHORIZATION_HEADER%">> c.cfg
ECHO url = "%SHEETBOT_TASK_BASEURL%">> c.cfg
curl -K c.cfg > taskdata.json
DEL c.cfg

ECHO Task data:
TYPE taskdata.json

REM ---- Extract coordinates using setvar ----
jget data.x < taskdata.json | setvar COORD_X
CALL setvar.bat
jget data.y < taskdata.json | setvar COORD_Y
CALL setvar.bat
jget data.z < taskdata.json | setvar COORD_Z
CALL setvar.bat
jget data.planet < taskdata.json | setvar COORD_P
CALL setvar.bat

DEL taskdata.json setvar.bat

ECHO Coordinates: %COORD_X% %COORD_Y% %COORD_Z% planet %COORD_P%

REM ---- CD into Noctis directory ----
CD c:\\nivplus\\Noctis-IV-Plus-planetdump\\modules

REM ---- Run Noctis planet dump ----
ECHO Running Noctis IV planet dump...
noctis.exe -dump %COORD_X% %COORD_Y% %COORD_Z% %COORD_P%
ECHO Noctis done.

REM ---- Upload PLANET.BMP ----
ECHO Uploading PLANET.BMP...
ECHO -s> c.cfg
ECHO -k>> c.cfg
ECHO -F file=@PLANET.BMP>> c.cfg
ECHO -H "Authorization: %SHEETBOT_AUTHORIZATION_HEADER%">> c.cfg
ECHO url = "%SHEETBOT_TASK_ARTEFACTURL%">> c.cfg
curl -K c.cfg
DEL c.cfg

REM ---- Upload P_SURFAC.BMP ----
ECHO Uploading P_SURFAC.BMP...
ECHO -s> c.cfg
ECHO -k>> c.cfg
ECHO -F file=@P_SURFAC.BMP>> c.cfg
ECHO -H "Authorization: %SHEETBOT_AUTHORIZATION_HEADER%">> c.cfg
ECHO url = "%SHEETBOT_TASK_ARTEFACTURL%">> c.cfg
curl -K c.cfg
DEL c.cfg

REM ---- Upload P_WCLOUD.BMP ----
ECHO Uploading P_WCLOUD.BMP...
ECHO -s> c.cfg
ECHO -k>> c.cfg
ECHO -F file=@P_WCLOUD.BMP>> c.cfg
ECHO -H "Authorization: %SHEETBOT_AUTHORIZATION_HEADER%">> c.cfg
ECHO url = "%SHEETBOT_TASK_ARTEFACTURL%">> c.cfg
curl -K c.cfg
DEL c.cfg

REM ---- Report completion ----
jset data {} > done.json
ECHO -s> curl.cfg
ECHO -k>> curl.cfg
ECHO -X POST>> curl.cfg
ECHO --data-binary @->> curl.cfg
ECHO -H "Content-Type: application/json">> curl.cfg
ECHO -H "Authorization: %SHEETBOT_AUTHORIZATION_HEADER%">> curl.cfg
ECHO url = "%SHEETBOT_TASK_COMPLETEURL%">> curl.cfg
curl -K curl.cfg < done.json
ECHO.
ECHO Done!

REM ---- Cleanup ----
DEL done.json curl.cfg`;

function parseCoordinates(text: string): { x: number; y: number; z: number; planet: number } | null {
  const coordRegex = /x\s*[=:]\s*(-?\d+)[,\s]+y\s*[=:]\s*(-?\d+)[,\s]+z\s*[=:]\s*(-?\d+)(?:[,\s]+planet\s*[=:]\s*(\d+))?/i;
  const match = text.match(coordRegex);
  
  if (match) {
    return {
      x: parseInt(match[1], 10),
      y: parseInt(match[2], 10),
      z: parseInt(match[3], 10),
      planet: match[4] ? parseInt(match[4], 10) : 3
    };
  }
  
  const simpleRegex = /(-?\d+)\s+(-?\d+)\s+(-?\d+)(?:\s+(\d+))?$/;
  const simpleMatch = text.match(simpleRegex);
  
  if (simpleMatch) {
    return {
      x: parseInt(simpleMatch[1], 10),
      y: parseInt(simpleMatch[2], 10),
      z: parseInt(simpleMatch[3], 10),
      planet: simpleMatch[4] ? parseInt(simpleMatch[4], 10) : 3
    };
  }
  
  return null;
}

function createResponseChunk(content: string): Chunk {
  return createTextChunk(content, 'com.rxcafe.sheetbot-freedos', {
    'chat.role': 'assistant',
    'sheetbot-freedos.response': true,
    'parsers.markdown.enabled': true
  });
}

function createErrorChunk(message: string): Chunk {
  return createTextChunk(message, 'com.rxcafe.sheetbot-freedos', {
    'chat.role': 'assistant',
    'sheetbot-freedos.error': true
  });
}

async function downloadArtefact(baseUrl: string, token: string, taskId: string, artefactPath: string): Promise<Uint8Array> {
  const response = await fetch(`${baseUrl}/tasks/${taskId}/artefacts/${encodeURIComponent(artefactPath)}`, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to download artefact: ${response.status} ${response.statusText}`);
  }
  
  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

export const sheetbotFreedosAgent: AgentDefinition = {
  name: 'sheetbot-freedos',
  description: 'Create FreeDOS tasks that render Noctis IV planets. Provide x, y, z coordinates and optionally planet index.',
  configSchema: {
    type: 'object',
    properties: {},
    required: []
  },

  initialize(session: AgentSessionContext) {
    const config = session.config as SheetbotFreedosConfig;
    
    const baseUrl = config.baseUrl || process.env.SHEETBOT_BASEURL || 'http://localhost:3000';
    const apiKey = config.apiKey || process.env.SHEETBOT_AUTH_APIKEY;
    
    const getAuthenticatedApi = async (): Promise<SheetbotAPI> => {
      const api = new SheetbotAPI(baseUrl);
      let token = '';
      
      if (config.token) {
        api.setToken(config.token);
        token = config.token;
      } else if (apiKey) {
        token = await api.loginWithApiKey(apiKey);
      } else {
        throw new Error('No authentication configured. Set SHEETBOT_AUTH_APIKEY or provide token in config.');
      }
      
      (api as any)._token = token;
      return api;
    };
    
    let pendingTaskId: string | null = null;
    let monitoringTask = false;
    
    const sub = session.inputStream.pipe(
      filter((chunk: Chunk) => chunk.contentType === 'text'),
      filter((chunk: Chunk) => chunk.annotations['chat.role'] === 'user'),
      filter((chunk: Chunk) => {
        const trustLevel = chunk.annotations['security.trust-level'];
        return !trustLevel || trustLevel.trusted !== false;
      }),
      
      mergeMap(async (chunk: Chunk) => {
        const text = chunk.content as string;
        const callbacks = session.callbacks;
        
        if (monitoringTask) {
          if (callbacks?.onFinish) callbacks.onFinish();
          return [createResponseChunk('A task is currently being monitored. Please wait for it to complete.')];
        }
        
        const coords = parseCoordinates(text);
        
        if (!coords) {
          if (callbacks?.onFinish) callbacks.onFinish();
          return [createResponseChunk(
            `Please provide coordinates in one of these formats:
- \`x=123 y=456 z=789 planet=3\`
- \`123 456 789 3\`
- \`x: 123, y: 456, z: 789, planet: 3\`

The default planet index is 3 if not specified.`
          )];
        }
        
        monitoringTask = true;
        
        try {
          const api = await getAuthenticatedApi();
          
          session.outputStream.next(createResponseChunk(
            `Creating FreeDOS task with coordinates: x=${coords.x}, y=${coords.y}, z=${coords.z}, planet=${coords.planet}...`
          ));
          
          if (callbacks?.onFinish) callbacks.onFinish();
          
          const task = await api.createTask({
            script: FREEDOS_SCRIPT_TEMPLATE,
            name: `Noctis Planet ${coords.x} ${coords.y} ${coords.z}`,
            type: 'freedos-bat' as any,
            data: JSON.stringify({
              x: coords.x,
              y: coords.y,
              z: coords.z,
              planet: coords.planet
            })
          });
          
          pendingTaskId = task.id;
          
          session.outputStream.next(createResponseChunk(
            `Task created with ID: \`${task.id.slice(0, 8)}\`
Monitoring for completion (up to 10 minutes)...`
          ));
          
          const maxWaitMs = 10 * 60 * 1000;
          const pollIntervalMs = 5000;
          
          await new Promise<void>((resolve, reject) => {
            const startTime = Date.now();
            
            const pollTimer = setInterval(async () => {
              try {
                if (Date.now() - startTime > maxWaitMs) {
                  clearInterval(pollTimer);
                  monitoringTask = false;
                  reject(new Error('Task monitoring timed out after 10 minutes'));
                  return;
                }
                
                const updatedTask = await api.getTask(task.id);
                
                if (updatedTask.status === 2) {
                  clearInterval(pollTimer);
                  resolve();
                } else if (updatedTask.status === 3) {
                  clearInterval(pollTimer);
                  reject(new Error('Task failed'));
                }
              } catch (err) {
                console.error('Error polling task:', err);
              }
            }, pollIntervalMs);
          });
          
          const completedTask = await api.getTask(task.id);
          
          session.outputStream.next(createResponseChunk(
            `Task completed! Found ${completedTask.artefacts.length} artefact(s).`
          ));
          
          const artefactNames = ['PLANET.BMP', 'P_SURFAC.BMP', 'P_WCLOUD.BMP'];
          
          for (const artefactName of artefactNames) {
            try {
              const data = await downloadArtefact(baseUrl, api['token'] || '', task.id, artefactName);
              
              const imageChunk = createBinaryChunk(data, 'image/bmp', 'com.rxcafe.sheetbot-freedos', {
                'chat.role': 'assistant',
                'sheetbot-freedos.artefact': artefactName,
                'sheetbot-freedos.taskId': task.id
              });
              
              session.outputStream.next(imageChunk);
            } catch (err) {
              console.error(`Error downloading ${artefactName}:`, err);
              session.outputStream.next(createResponseChunk(
                `Note: Could not download ${artefactName}: ${err instanceof Error ? err.message : 'Unknown error'}`
              ));
            }
          }
          
          monitoringTask = false;
          
          if (callbacks?.onFinish) callbacks.onFinish();
          
          return [createResponseChunk(
            `Task \`${task.id.slice(0, 8)}\` complete. You can now provide new coordinates.`
          )];
          
        } catch (err) {
          monitoringTask = false;
          const message = err instanceof Error ? err.message : 'Unknown error';
          if (callbacks?.onFinish) callbacks.onFinish();
          return [createErrorChunk(`Error: ${message}`)];
        }
      }),
      
      mergeMap((chunks: Chunk | Chunk[]) => Array.isArray(chunks) ? from(chunks) : [chunks]),
      
      catchError((error: Error) => {
        session.errorStream.next(error);
        monitoringTask = false;
        if (session.callbacks?.onFinish) session.callbacks.onFinish();
        return EMPTY;
      })
    ).subscribe({
      next: (chunk: Chunk) => session.outputStream.next(chunk),
      error: (error: Error) => session.errorStream.next(error)
    });
    
    session.pipelineSubscription = sub;
  }
};

export default sheetbotFreedosAgent;