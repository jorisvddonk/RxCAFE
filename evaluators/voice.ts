import type { AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { createBinaryChunk, annotateChunk } from '../lib/chunk.js';
import { filter, of, Observable } from '../lib/stream.js';
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
  backend: 'coqui' | 'voicebox';
  voicebox?: {
    engine?: 'qwen' | 'luxtts' | 'chatterbox' | 'chatterbox_turbo';
    normalize?: boolean;
    maxChunkChars?: number;
    crossfadeMs?: number;
  };
}

const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  voices: {
    text: 'Volition',
    quote: 'Volition',
    bold: 'Volition',
    emphasis: 'Volition',
    code: 'Volition',
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
  ttsEndpoint: 'http://127.0.0.1:17493',
  backend: 'voicebox',
  voicebox: {
    engine: 'qwen',
    normalize: true,
    maxChunkChars: 800,
    crossfadeMs: 50
  }
};

const profileCache: Map<string, Map<string, string>> = new Map();

async function resolveVoiceboxProfileId(endpoint: string, nameOrId: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nameOrId)) {
    return nameOrId;
  }

  const cacheKey = endpoint;
  if (!profileCache.has(cacheKey)) {
    const resp = await fetch(`${endpoint}/profiles`);
    if (!resp.ok) {
      throw new Error(`Failed to fetch voicebox profiles: ${resp.statusText}`);
    }
    const profiles = await resp.json() as Array<{ id: string; name: string }>;
    const map = new Map<string, string>();
    for (const p of profiles) {
      map.set(p.name.toLowerCase(), p.id);
    }
    profileCache.set(cacheKey, map);
  }

  const id = profileCache.get(cacheKey)!.get(nameOrId.toLowerCase());
  if (!id) {
    throw new Error(`Voicebox profile "${nameOrId}" not found at ${endpoint}/profiles`);
  }
  return id;
}

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

          console.log('[VoiceEvaluator] session id:', session.id);
          console.log('[VoiceEvaluator] session type:', typeof session);
          const runtimeConfig = session.runtimeConfig || {};
          console.log('[VoiceEvaluator] session.runtimeConfig:', JSON.stringify(runtimeConfig));
          console.log('[VoiceEvaluator] runtimeConfig.voice:', runtimeConfig.voice);
          console.log('[VoiceEvaluator] chunk.annotations[voice.config]:', chunk.annotations['voice.config']);
          const voiceConfig = chunk.annotations['voice.config'] ||
                              runtimeConfig.voice ||
                              DEFAULT_VOICE_SETTINGS;
          console.log('[VoiceEvaluator] voiceConfig (final):', JSON.stringify(voiceConfig.voices));

          const ttsEndpoint = voiceConfig.ttsEndpoint || DEFAULT_VOICE_SETTINGS.ttsEndpoint;
          console.log('[VoiceEvaluator] ttsEndpoint:', ttsEndpoint);

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
                ttsEndpoint,
                voiceConfig.backend,
                voiceConfig.voicebox
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
  voiceId: string,
  generation: VoiceSettings['generation'],
  endpoint: string,
  backend: VoiceSettings['backend'],
  voiceboxOptions?: VoiceSettings['voicebox']
): Promise<Uint8Array | null> {
  if (backend === 'voicebox') {
    const profileId = await resolveVoiceboxProfileId(endpoint, voiceId);
    const url = `${endpoint}/generate/stream`;
    const body = {
      profile_id: profileId,
      text,
      normalize: voiceboxOptions?.normalize ?? true,
      max_chunk_chars: voiceboxOptions?.maxChunkChars ?? 800,
      crossfade_ms: voiceboxOptions?.crossfadeMs ?? 50,
      engine: voiceboxOptions?.engine ?? 'qwen'
    };
    console.log('[VoiceEvaluator] voicebox request:', url, body);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    console.log('[VoiceEvaluator] voicebox response status:', response.status, response.statusText);
    if (!response.ok) {
      console.error('[VoiceEvaluator] Voicebox TTS request failed:', response.statusText);
      return null;
    }

    const blob = await response.blob();
    return new Uint8Array(await blob.arrayBuffer());
  }

  const body = {
    text,
    voice_mode: 'clone',
    reference_audio_filename: voiceId,
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
