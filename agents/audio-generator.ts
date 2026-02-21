import type { AgentDefinition, AgentSessionContext } from '../lib/agent.js';
import { createTextChunk, createBinaryChunk } from '../lib/chunk.js';
import { filter } from '../lib/stream.js';

/**
 * Audio Generator Agent
 * Responds to messages by generating a simple 1-second sine wave (WAV)
 */
export const audioGeneratorAgent: AgentDefinition = {
  name: 'audio-generator',
  description: 'Generates a simple 1-second audio tone in response to messages',
  
  initialize(session: AgentSessionContext) {
    console.log(`[AudioGenerator] Initializing for session ${session.id}`);
    
    const sub = session.inputStream.pipe(
      filter(c => c.contentType === 'text' && c.annotations['chat.role'] === 'user')
    ).subscribe(async chunk => {
      // Send a text response first
      session.outputStream.next(createTextChunk(
        `I'll generate a 1-second tone for you!`,
        'com.rxcafe.audio-generator',
        { 'chat.role': 'assistant' }
      ));
      
      // Generate a simple WAV file
      const sampleRate = 8000;
      const duration = 1.0;
      const frequency = 440; // A4 tone
      const wavData = createSineWaveWav(sampleRate, duration, frequency);
      
      // Send the audio as a binary chunk
      const audioChunk = createBinaryChunk(
        wavData,
        'audio/wav',
        'com.rxcafe.audio-generator',
        { 
          'chat.role': 'assistant',
          'audio.duration': duration,
          'audio.description': '1-second 440Hz sine wave tone'
        }
      );
      
      session.outputStream.next(audioChunk);

      await session.persistState();

      if (session.callbacks?.onFinish) {
        session.callbacks.onFinish();
      }
    });
    
    session.pipelineSubscription = sub;
  }
};

/**
 * Creates a minimal 16-bit Mono WAV file buffer with a sine wave
 */
function createSineWaveWav(sampleRate: number, duration: number, frequency: number): Uint8Array {
  const numSamples = Math.floor(sampleRate * duration);
  const dataSize = numSamples * 2; // 16-bit = 2 bytes per sample
  const fileSize = 44 + dataSize;
  const buffer = new Uint8Array(fileSize);
  const view = new DataView(buffer.buffer);
  
  // RIFF Header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, fileSize - 8, true);
  writeString(view, 8, 'WAVE');
  
  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // size of fmt chunk
  view.setUint16(20, 1, true);  // PCM format
  view.setUint16(22, 1, true);  // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // Byte rate
  view.setUint16(32, 2, true);  // Block align
  view.setUint16(34, 16, true); // Bits per sample
  
  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  
  // Generate sine wave samples
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * frequency * t);
    // Convert to 16-bit signed integer
    const val = Math.floor(sample * 32767);
    view.setInt16(44 + i * 2, val, true);
  }
  
  return buffer;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

export default audioGeneratorAgent;
