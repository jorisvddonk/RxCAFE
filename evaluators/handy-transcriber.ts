import { Observable } from 'rxjs';
import { Chunk, createTextChunk, annotateChunk } from '../lib/chunk.js';
import { AgentSessionContext } from '../lib/agent.js';

export interface HandyTranscriptionConfig {
  baseUrl?: string;
  responseFormat?: 'json' | 'verbose_json';
  timestampGranularities?: string[];
}

const DEFAULT_CONFIG: HandyTranscriptionConfig = {
  baseUrl: 'http://localhost:5500',
  responseFormat: 'json',
  timestampGranularities: []
};

/**
 * Creates an evaluator that transcribes audio chunks using Handy's local API.
 * 
 * Handy is a free, open source, offline speech-to-text application that supports
 * both Whisper and Parakeet models. The local API must be enabled in Handy's settings.
 * 
 * @param session Agent session context
 * @param config Optional configuration for the transcription service
 * @returns Function that takes an audio chunk and returns an Observable of transcribed text chunks
 */
export function transcribeAudio(session: AgentSessionContext, config: HandyTranscriptionConfig = {}) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const apiUrl = `${mergedConfig.baseUrl}/v1/audio/transcriptions`;

  return (chunk: Chunk): Observable<Chunk> => {
    return new Observable(subscriber => {
      // Only process binary audio chunks
      if (chunk.contentType !== 'binary') {
        subscriber.next(chunk);
        subscriber.complete();
        return;
      }

      const binaryContent = chunk.content as { data: Uint8Array; mimeType: string };

      // Check if content is audio
      if (!binaryContent.mimeType.startsWith('audio/')) {
        subscriber.next(chunk);
        subscriber.complete();
        return;
      }

      // Transcribe audio
      transcribe(binaryContent.data, binaryContent.mimeType, mergedConfig, apiUrl)
        .then(text => {
          // Create text chunk with transcription
          const transcribedChunk = createTextChunk(text, 'com.rxcafe.handy-transcriber');
          
          // Add annotations with transcription metadata
          const annotatedChunk = annotateChunk(transcribedChunk, 'com.rxcafe.handling', {
            source: 'handy',
            apiUrl,
            mimeType: binaryContent.mimeType,
            audioSize: binaryContent.data.length,
            responseFormat: mergedConfig.responseFormat
          });

          // Set chat role to assistant
          const chunkWithRole = annotateChunk(annotatedChunk, 'chat.role', 'assistant');

          session.outputStream.next(chunkWithRole);
          subscriber.next(chunkWithRole);
          subscriber.complete();
        })
        .catch(error => {
          session.errorStream.next(error);
          subscriber.error(error);
        });
    });
  };
}

/**
 * Helper function to send audio data to Handy's transcription API
 */
async function transcribe(
  audioData: Uint8Array,
  mimeType: string,
  config: HandyTranscriptionConfig,
  apiUrl: string
): Promise<string> {
  // Create FormData for file upload
  const formData = new FormData();
  
  // Handy API only supports mp3 files
  const fileExtension = 'mp3';
  const blob = new Blob([audioData], { type: 'audio/mpeg' });
  formData.append('file', blob, `audio.${fileExtension}`);
  
  // Add optional parameters
  formData.append('response_format', config.responseFormat || 'json');
  if (config.timestampGranularities && config.timestampGranularities.length > 0) {
    config.timestampGranularities.forEach(granularity => {
      formData.append('timestamp_granularities[]', granularity);
    });
  }
  formData.append('model', 'handy-default'); // Handy ignores this but it's required by API format

  // Send request to Handy API
  const response = await fetch(apiUrl, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    let errorDetails = '';
    try {
      const errorData = await response.json();
      errorDetails = ` - ${JSON.stringify(errorData)}`;
    } catch (e) {
      try {
        const errorText = await response.text();
        errorDetails = ` - ${errorText}`;
      } catch {
        // Ignore
      }
    }
    throw new Error(`Handy API request failed: ${response.status} ${response.statusText}${errorDetails}`);
  }

  const data = await response.json();
  
  // Extract transcription from response
  if (typeof data.text === 'string') {
    return data.text;
  }

  throw new Error('Invalid response format from Handy API');
}