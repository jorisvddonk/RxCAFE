/**
 * Stream API Handlers
 * 
 * SSE (Server-Sent Events) endpoints for real-time streaming:
 * - GET  /api/session/:id/stream  Stream session output chunks
 * - GET  /api/session/:id/errors  Stream session errors
 * - POST /api/system/command      Execute system commands
 * 
 * SSE Event Types:
 * - { type: 'connected', sessionId }    - Connection established
 * - { type: 'chunk', chunk: {...} }    - New chunk emitted
 * - { type: 'error', error: '...' }    - Error occurred
 * - 'close' event                       - Connection closed
 */

import type { Chunk } from '../chunk.js';
import { getSession } from '../../core.js';

export function handleSessionStream(sessionId: string, binaryRefs: boolean = false): Response {
  const session = getSession(sessionId);
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`));
      
      const outputSub = session.outputStream.subscribe({
        next: (chunk: Chunk) => {
          // Include text, binary, null chunks with visualization or error annotations
          const isVisualization = chunk.contentType === 'null' && chunk.annotations?.['visualizer.type'] === 'rx-marbles';
          const isError = chunk.contentType === 'null' && chunk.annotations?.['error.message'];
          if (chunk.contentType === 'text' || chunk.contentType === 'binary' || isVisualization || isError) {
            try {
              let serializedChunk: any = chunk;
              if (chunk.contentType === 'binary') {
                if (binaryRefs) {
                  const binaryContent = chunk.content as any;
                  serializedChunk = {
                    ...chunk,
                    contentType: 'binary-ref',
                    content: {
                      chunkId: chunk.id,
                      mimeType: binaryContent.mimeType,
                      byteSize: binaryContent.data.byteLength,
                    },
                  };
                } else {
                  serializedChunk = {
                    ...chunk,
                    content: { ...chunk.content, data: Array.from((chunk.content as any).data) }
                  };
                }
              }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'chunk', chunk: serializedChunk })}
\n`));
            } catch (error) {
              console.error('[SSE] Failed to serialize chunk:', chunk.id, error);
            }
          }
        },
        error: (err: Error) => {
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`)); } catch { /* ignore */ }
        }
      });
      
      const errorSub = session.errorStream.subscribe({
        next: (err: Error) => {
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`)); } catch { /* ignore */ }
        }
      });
      
      cleanup = () => { outputSub.unsubscribe(); errorSub.unsubscribe(); };
    },
    cancel() { if (cleanup) { cleanup(); cleanup = null; } }
  });
  
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
  });
}

export async function handleErrorStream(sessionId: string): Promise<Response> {
  const session = getSession(sessionId);
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  
  const { observableToStream } = await import('../stream.js');
  
  const errorStream = observableToStream(
    session.errorStream.asObservable(),
    (err: Error) => `data: ${JSON.stringify({ type: 'error', message: err.message, timestamp: Date.now() })}\n\n`
  );
  
  return new Response(errorStream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
  });
}

export async function handleSystemCommand(request: Request): Promise<Response> {
  const { getSession } = await import('../../core.js');
  const { createTextChunk } = await import('../chunk.js');
  
  const systemSession = getSession('system');
  
  if (!systemSession) {
    return new Response(JSON.stringify({ error: 'System agent not running' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  
  const body = await request.json().catch(() => ({}));
  const command = body.command;
  
  if (!command || typeof command !== 'string') {
    return new Response(JSON.stringify({ error: 'Command required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  
  return new Promise((resolve) => {
    let responseText = '';
    let responded = false;
    
    const timeout = setTimeout(() => {
      if (!responded) {
        responded = true;
        sub.unsubscribe();
        resolve(new Response(JSON.stringify({ error: 'Command timeout' }), { status: 504, headers: { 'Content-Type': 'application/json' } }));
      }
    }, 10000);
    
    const sub = systemSession.outputStream.subscribe({
      next: (chunk: Chunk) => {
        if (chunk.annotations['system.response'] || chunk.annotations['system.error']) {
          responseText = chunk.content as string;
        }
        
        if (chunk.annotations['system.response'] || chunk.annotations['system.error']) {
          if (!responded) {
            responded = true;
            clearTimeout(timeout);
            sub.unsubscribe();
            resolve(new Response(JSON.stringify({
              success: !chunk.annotations['system.error'],
              response: responseText
            }), { headers: { 'Content-Type': 'application/json' } }));
          }
        }
      }
    });
    
    systemSession.inputStream.next(createTextChunk(command, 'com.rxcafe.api', {
      'chat.role': 'user',
      'client.type': 'api',
      'admin.authorized': true
    }));
  });
}
