import type { AgentSessionContext } from '../lib/agent.js';
import type { Chunk } from '../lib/chunk.js';
import { createBinaryChunk, annotateChunk } from '../lib/chunk.js';
import { Observable } from '../lib/stream.js';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';

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

export interface VoicePlainConfig {
  backend?: 'voicebox' | 'coqui';
  profile: string;
  ttsEndpoint?: string;
  voicebox?: {
    engine?: string;
    normalize?: boolean;
    maxChunkChars?: number;
    crossfadeMs?: number;
  };
}

export function generateVoicePlain(session: AgentSessionContext) {
  const voicesDir = join(process.cwd(), 'generated', 'voices');
  if (!existsSync(voicesDir)) {
    mkdirSync(voicesDir, { recursive: true });
  }

  return (source: Observable<Chunk>): Observable<Chunk> => {
    return new Observable(subscriber => {
      const subscription = source.subscribe({
        next: async (chunk: Chunk) => {
          console.log('[VoicePlain] received chunk:', chunk.contentType, chunk.annotations['chat.role']);
          if (chunk.contentType !== 'text' || chunk.annotations['chat.role'] !== 'assistant') {
            console.log('[VoicePlain] skipping: not assistant text');
            subscriber.next(chunk);
            return;
          }

          const runtimeConfig = session.runtimeConfig || {};
          const voiceConfig = chunk.annotations['voice.config'] ||
                              runtimeConfig.voice as VoicePlainConfig | undefined;

          console.log('[VoicePlain] voiceConfig from annotation:', chunk.annotations['voice.config']);
          console.log('[VoicePlain] voiceConfig from runtime:', runtimeConfig.voice);

          if (!voiceConfig) {
            console.log('[VoicePlain] skipping: no voice config');
            subscriber.next(chunk);
            return;
          }

          const text = chunk.content as string;
          if (!text || text.trim().length === 0) {
            console.log('[VoicePlain] skipping: empty text');
            subscriber.next(chunk);
            return;
          }

          const endpoint = voiceConfig.ttsEndpoint || 'http://127.0.0.1:17493';
          const backend = voiceConfig.backend || 'voicebox';
          const profile = voiceConfig.profile;

          console.log('[VoicePlain] generating TTS:', { endpoint, backend, profile, textLength: text.length });

          try {
            let audioData: Uint8Array | null = null;

            if (backend === 'voicebox') {
              const profileId = await resolveVoiceboxProfileId(endpoint, profile);
              const vb = voiceConfig.voicebox || {};
              const body = {
                profile_id: profileId,
                text,
                normalize: vb.normalize ?? true,
                max_chunk_chars: vb.maxChunkChars ?? 800,
                crossfade_ms: vb.crossfadeMs ?? 50,
                engine: vb.engine ?? 'qwen'
              };

              const response = await fetch(`${endpoint}/generate/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              });

              if (!response.ok) {
                console.error('[VoicePlain] TTS request failed:', response.status, response.statusText);
                subscriber.next(chunk);
                return;
              }

              const blob = await response.blob();
              audioData = new Uint8Array(await blob.arrayBuffer());
            }

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
                  'voice.text': text,
                  'voice.file': filename,
                  'voice.parentChunk': chunk.id
                }
              );

              session.outputStream.next(audioChunk);

              subscriber.next(annotateChunk(chunk, 'voice.generated', {
                generated: true,
                file: filename
              }));
            } else {
              subscriber.next(chunk);
            }
          } catch (error) {
            console.error('[VoicePlain] TTS error:', error);
            subscriber.next(chunk);
          }
        },
        error: (err) => subscriber.error(err),
        complete: () => subscriber.complete()
      });

      return () => subscription.unsubscribe();
    });
  };
}

export default generateVoicePlain;
