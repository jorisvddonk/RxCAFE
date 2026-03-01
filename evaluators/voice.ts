import type { AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { createBinaryChunk, annotateChunk } from '../lib/chunk.js';
import { filter, concatMap, of, Observable } from '../lib/stream.js';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';

interface VoiceSettings {
  voices: Record<string, string | null>;
  generation: {
    temperature?: number;
    exaggeration?: number;
    cfg_weight?: number;
    speed_factor?: number;
  };
  ttsEndpoint?: string;
}

const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  voices: {
    text: 'Robert.wav',
    quote: 'Robert.wav',
    bold: null,
    emphasis: null,
    code: null,
    tool_call: null,
    tool_result: null,
    reasoning: null
  },
  generation: {
    temperature: 0.8,
    exaggeration: 0.5,
    cfg_weight: 1.0,
    speed_factor: 1.0
  },
  ttsEndpoint: 'http://localhost:8000/tts'
};

export interface ParsedVoiceItem {
  type: string;
  content: string;
  start: number;
  end: number;
}

export function generateVoice(session: AgentSessionContext) {
  const voicesDir = join(process.cwd(), 'generated', 'voices');
  if (!existsSync(voicesDir)) {
    mkdirSync(voicesDir, { recursive: true });
  }

  return (source: Observable<Chunk>): Observable<Chunk> => {
    return new Observable(subscriber => {
      const subscription = source.subscribe({
        next: async (chunk: Chunk) => {
          if (
            chunk.contentType !== 'text' ||
            chunk.annotations['chat.role'] !== 'assistant'
          ) {
            subscriber.next(chunk);
            return;
          }

          const runtimeConfig = session.config.sessionConfig || {};
          const voiceConfig = chunk.annotations['voice.config'] ||
                              runtimeConfig['config.voice'] ||
                              DEFAULT_VOICE_SETTINGS;

          const ttsEndpoint = voiceConfig.ttsEndpoint || DEFAULT_VOICE_SETTINGS.ttsEndpoint;

          const parsedVoice = chunk.annotations['voice.parsed'] as ParsedVoiceItem[] | undefined;
          if (!parsedVoice || parsedVoice.length === 0) {
            subscriber.next(chunk);
            return;
          }

          const voiceItems: Array<{ type: string; content: string; status: string }> = [];

          for (const item of parsedVoice) {
            const voiceFile = voiceConfig.voices[item.type];
            if (!voiceFile) {
              voiceItems.push({ type: item.type, content: item.content, status: 'skipped' });
              continue;
            }

            try {
              const audioData = await generateTTS(
                item.content,
                voiceFile,
                voiceConfig.generation,
                ttsEndpoint
              );

              if (audioData) {
                const timestamp = Date.now();
                const filename = `${session.id}_voice_${timestamp}.wav`;
                const filePath = join(voicesDir, filename);

                writeFileSync(filePath, audioData);

                const audioChunk = createBinaryChunk(
                  audioData,
                  'audio/wav',
                  'com.rxcafe.voice',
                  {
                    'voice.text': item.content,
                    'voice.type': item.type,
                    'voice.file': filename,
                    'voice.parentChunk': chunk.id
                  }
                );

                session.outputStream.next(audioChunk);

                voiceItems.push({ type: item.type, content: item.content, status: 'generated' });
              } else {
                voiceItems.push({ type: item.type, content: item.content, status: 'failed' });
              }
            } catch (error) {
              console.error('[VoiceEvaluator] TTS error:', error);
              voiceItems.push({ type: item.type, content: item.content, status: 'failed' });
            }
          }

          const annotatedChunk = annotateChunk(chunk, 'voice.generated', {
            generated: true,
            items: voiceItems
          });

          subscriber.next(annotatedChunk);
        },
        error: (err) => subscriber.error(err),
        complete: () => subscriber.complete()
      });

      return () => subscription.unsubscribe();
    });
  };
}

async function generateTTS(
  text: string,
  voiceFile: string,
  generation: VoiceSettings['generation'],
  endpoint: string
): Promise<Uint8Array | null> {
  const body = {
    text,
    voice_mode: 'clone',
    reference_audio_filename: voiceFile,
    output_format: 'wav',
    ...generation
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    console.error('[VoiceEvaluator] TTS request failed:', response.statusText);
    return null;
  }

  const blob = await response.blob();
  return new Uint8Array(await blob.arrayBuffer());
}

export default generateVoice;
