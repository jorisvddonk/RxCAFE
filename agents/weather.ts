/**
 * Weather Agent
 * Fetches and displays weather data using Open-Meteo API
 */

import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { annotateChunk, createTextChunk } from '../lib/chunk.js';
import { EMPTY, filter, map, mergeMap, catchError, tap, Observable } from '../lib/stream.js';
import { completeTurnWithLLM } from '../lib/evaluator-utils.js';
import { detectToolCalls } from '../evaluators/tool-call-detector.js';
import { executeTools } from '../evaluators/tool-executor.js';
import { WEATHER_SYSTEM_PROMPT } from '../tools/weather.js';

export const weatherAgent: AgentDefinition = {
  name: 'weather',
  description: 'Weather forecast agent using Open-Meteo API',
  supportedUIs: ['chat'],
  
  configSchema: {
    type: 'object',
    properties: {
      backend: { type: 'string', description: 'LLM backend (kobold or ollama)', default: 'ollama' },
      model: { type: 'string', description: 'Model name' },
      systemPrompt: { type: 'string', description: 'System prompt' },
      llmParams: {
        type: 'object',
        properties: {
          temperature: { type: 'number', default: 0.3 },
          maxTokens: { type: 'number', default: 500 },
          topP: { type: 'number', default: 0.9 },
          topK: { type: 'number', default: 40 },
          repeatPenalty: { type: 'number', default: 1.1 },
          stop: { type: 'array', items: { type: 'string' }, default: [] },
          seed: { type: 'number' },
          maxContextLength: { type: 'number' },
          numCtx: { type: 'number' },
        },
        default: {
          temperature: 0.3,
          maxTokens: 500,
          topP: 0.9,
          topK: 40,
          repeatPenalty: 1.1
        }
      }
    },
    default: {
      backend: 'ollama',
      llmParams: {
        temperature: 0.3,
        maxTokens: 500,
        topP: 0.9,
        topK: 40,
        repeatPenalty: 1.1
      }
    },
    required: ['backend', 'model']
  },
  
  initialize(session: AgentSessionContext) {
    const systemPrompt = `You are a helpful weather assistant. You can fetch current weather data and forecasts using the getWeather tool.

When users ask about weather:
1. Extract the location they mentioned
2. Use your knowledge to determine approximate latitude/longitude for that location
3. Call the getWeather tool with those coordinates
4. Present the weather information in a friendly, easy-to-read format

Available tool:
- getWeather: Fetches weather from Open-Meteo API (free, no API key needed)
  Parameters: latitude, longitude, timezone (optional)

Example cities for reference:
- Stockholm: 59.3345, 18.0632
- New York: 40.7128, -74.0060
- London: 51.5074, -0.1278
- Tokyo: 35.6762, 139.6503
- Sydney: -33.8688, 151.2093

Always present temperatures in Celsius and include wind information.

${WEATHER_SYSTEM_PROMPT}`;

    session.systemPrompt = systemPrompt;

    console.log('[WeatherAgent] Initializing weather agent...');

    const sub = session.inputStream.pipe(
      filter((chunk: any): chunk is Chunk => {
        if (!chunk || typeof chunk !== 'object') {
          console.log(`[WeatherAgent] FILTER0: Rejecting non-object chunk:`, chunk);
          return false;
        }
        if (chunk.constructor && chunk.constructor.name && chunk.constructor.name.includes('Subject')) {
          console.log(`[WeatherAgent] FILTER0: Rejecting Subject chunk:`, chunk.constructor.name);
          return false;
        }
        return true;
      }) as any,

      filter((chunk: Chunk) => {
        const isText = chunk.contentType === 'text';
        console.log(`[WeatherAgent] Input chunk: id=${chunk.id}, type=${chunk.contentType}, isText=${isText}`);
        return isText;
      }) as any,

      map((chunk: Chunk) => {
        if (chunk.annotations['chat.role']) return chunk;
        console.log(`[WeatherAgent] Annotating chunk ${chunk.id} with chat.role=user`);
        return annotateChunk(chunk, 'chat.role', 'user');
      }),
      
      filter((chunk: Chunk) => {
        const trustLevel = chunk.annotations['security.trust-level'];
        console.log(`[WeatherAgent] TRUST_FILTER: chunk=${chunk.id}, trustLevel=${JSON.stringify(trustLevel)}, pass=${!trustLevel || trustLevel.trusted !== false}`);
        return !trustLevel || trustLevel.trusted !== false;
      }),

      tap((chunk: Chunk) => {
        console.log(`[WeatherAgent] BEFORE_LLM: chunk=${chunk.id}, role=${chunk.annotations['chat.role']}`);
      }),

      tap((chunk: any) => {
        console.log(`[WeatherAgent] TAP1: chunk=${chunk?.id}, type=${chunk?.constructor?.name}`);
        if (chunk?.constructor?.name?.includes('Subject')) {
          console.log(`[WeatherAgent] TAP1: Found Subject!`);
          console.log(new Error().stack);
        }
      }) as any,

      mergeMap((chunk: Chunk): Observable<Chunk> => {
        console.log(`[WeatherAgent] MERGE_LLM_START: chunk=${chunk.id}, role=${chunk.annotations['chat.role']}`);
        if (chunk.annotations['chat.role'] !== 'user') {
          console.log(`[WeatherAgent] Skipping LLM for chunk ${chunk.id} (role=${chunk.annotations['chat.role']})`);
          return new Observable(subscriber => {
            subscriber.next(chunk);
            subscriber.complete();
          });
        }
        console.log(`[WeatherAgent] Calling LLM for chunk ${chunk.id}: "${String(chunk.content).substring(0, 50)}..."`);
        const result = completeTurnWithLLM(chunk, session.createLLMChunkEvaluator(), session);
        console.log(`[WeatherAgent] completeTurnWithLLM returned: type=${result?.constructor?.name}`);
        return result;
      }),

      tap((chunk: Chunk) => {
        console.log(`[WeatherAgent] Post-LLM chunk: id=${chunk.id}, role=${chunk.annotations?.['chat.role']}, hasToolDetection=${!!chunk.annotations?.['com.rxcafe.tool-detection']}`);
      }),

      mergeMap(detectToolCalls()),

      mergeMap((chunk: Chunk): Observable<Chunk> => {
        const toolDetection = chunk.annotations?.['com.rxcafe.tool-detection'];
        console.log(`[WeatherAgent] Tool detection: hasToolCalls=${toolDetection?.hasToolCalls}, calls=${JSON.stringify(toolDetection?.toolCalls?.map((c: any) => c.name))}`);
        if (toolDetection?.hasToolCalls) {
          const result = executeTools({ tools: ['getWeather'] })(chunk);
          console.log(`[WeatherAgent] executeTools returned: type=${result?.constructor?.name}`);
          return result;
        }
        return new Observable(subscriber => {
          subscriber.next(chunk);
          subscriber.complete();
        });
      }),
      
      mergeMap((chunk: Chunk): Observable<Chunk> => {
        if (chunk.annotations?.['tool.name'] === 'getWeather') {
          const weatherData = chunk.annotations?.['tool.results'];
          console.log('[WeatherAgent] Tool result chunk received, weatherData:', JSON.stringify(weatherData, null, 2).substring(0, 500));
          if (weatherData && !weatherData.error) {
            const widgetChunk = createTextChunk(
              JSON.stringify(weatherData),
              'com.rxcafe.weather.widget',
              {
                'chat.role': 'assistant',
                'weather.data': true,
                'weather.location': `${weatherData.location.latitude},${weatherData.location.longitude}`,
                'weather.timezone': weatherData.timezone
              }
            );
            console.log(`[WeatherAgent] Created widget chunk: id=${widgetChunk.id}, content length=${widgetChunk.content?.length || 0}`);
            return new Observable(subscriber => {
              subscriber.next(chunk);
              subscriber.next(widgetChunk);
              subscriber.complete();
            });
          }
        }
        return new Observable(subscriber => {
          subscriber.next(chunk);
          subscriber.complete();
        });
      }),
      
      catchError((error: Error) => {
        session.errorStream.next(error);
        return EMPTY;
      }),

      filter((chunk: any): chunk is Chunk => {
        if (chunk && chunk.constructor && chunk.constructor.name && chunk.constructor.name.includes('Subject')) {
          console.log(`[WeatherAgent] FILTER_END: Rejecting Subject:`, chunk.constructor.name);
          return false;
        }
        return true;
      }) as any
    ).subscribe({
      next: (chunk: unknown) => {
        console.log(`[WeatherAgent] Raw chunk before emit:`, typeof chunk, chunk?.constructor?.name, chunk);
        const c = chunk as Chunk;
        if (!c || !c.id || !c.contentType) {
          console.error(`[WeatherAgent] ERROR: Invalid chunk being emitted to outputStream!`);
          console.error(`[WeatherAgent] Chunk details: id=${c?.id}, contentType=${c?.contentType}, producer=${c?.producer}`);
          return;
        }
        const annotationKeys = c.annotations ? Object.keys(c.annotations) : [];
        console.log(`[WeatherAgent] Emitting chunk: id=${c.id}, type=${c.contentType}, producer=${c.producer}, annotations=${JSON.stringify(annotationKeys)}`);
        session.outputStream.next(c);
      },
      error: (error: Error) => session.errorStream.next(error)
    });
    
    session.pipelineSubscription = sub;
  }
};

export default weatherAgent;
