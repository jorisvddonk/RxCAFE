import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import { createTextChunk } from '../lib/chunk.js';
import { filter } from '../lib/stream.js';
import { transcribeAudio, HandyTranscriptionConfig } from '../evaluators/handy-transcriber.js';

/**
 * Handy Transcriber Agent
 * Transcribes audio chunks using Handy's local speech-to-text API
 */
export const handyTranscriberAgent: AgentDefinition = {
  name: 'handy-transcriber',
  description: 'Transcribes audio chunks using Handy\'s local speech-to-text API',
  configSchema: {
    type: 'object',
    properties: {
      handy_baseUrl: { 
        type: 'string', 
        description: 'Handy API base URL (default: http://localhost:5500)' 
      },
      handy_responseFormat: { 
        type: 'string', 
        enum: ['json', 'verbose_json'],
        description: 'Response format (default: json)' 
      },
      handy_timestampGranularities: { 
        type: 'array',
        items: { type: 'string', enum: ['segment'] },
        description: 'Timestamp granularities (default: [])' 
      }
    },
    default: {
      handy_baseUrl: "http://localhost:5500",
      handy_responseFormat: "json",
      handy_timestampGranularities: []
    },
    required: []
  },
  
  initialize(session: AgentSessionContext) {
    console.log(`[HandyTranscriber] Initializing for session ${session.id}`);

    // Get config from session
    const config: HandyTranscriptionConfig = {
      baseUrl: session.sessionConfig['config.handy_baseUrl'] || 'http://localhost:5500',
      responseFormat: session.sessionConfig['config.handy_responseFormat'] || 'json',
      timestampGranularities: session.sessionConfig['config.handy_timestampGranularities'] || []
    };

     const sub = session.inputStream.pipe(
      filter(c => c.contentType === 'binary' && (c.content as any).mimeType?.startsWith('audio/')),
    ).subscribe({
      next: chunk => {
        // Use the transcription evaluator
        transcribeAudio(session, config)(chunk).subscribe({
          next: transcribedChunk => {
            // If we got a transcribed chunk, also send it to outputStream
            if (transcribedChunk.contentType === 'text') {
              session.outputStream.next(transcribedChunk);
            }
          },
          complete: () => {
            // Call onFinish to signal the end of the turn
            if (session.callbacks?.onFinish) {
              session.callbacks.onFinish();
            }
          },
          error: error => {
            console.error('[HandyTranscriber] Error:', error);
            session.outputStream.next(createTextChunk(
              `Sorry, I couldn't transcribe the audio: ${error.message}`,
              'com.rxcafe.handy-transcriber',
              { 'chat.role': 'assistant' }
            ));
            if (session.callbacks?.onFinish) {
              session.callbacks.onFinish();
            }
          }
        });
      },
      error: error => {
        console.error('[HandyTranscriber] Stream error:', error);
      }
    });

    session.pipelineSubscription = sub;
  }
};

export default handyTranscriberAgent;