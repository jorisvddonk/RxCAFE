/**
 * RXCAFE Chat Application
 * Main entry point - HTTP server with API and frontend
 * 
 * This file demonstrates RXCAFE patterns:
 * - Chunks flow through reactive streams
 * - Evaluators transform chunks via map/flatMap operations
 * - Stream composition creates processing pipelines
 * - Multiple LLM backends (KoboldCPP, Ollama) via unified interface
 */

import { serve } from 'bun';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { 
  createTextChunk, 
  createNullChunk, 
  annotateChunk, 
  type Chunk,
  type Evaluator 
} from './lib/chunk.js';
import { ChunkStream, mergeStreams } from './lib/stream.js';
import { KoboldEvaluator } from './lib/kobold-api.js';
import { OllamaEvaluator } from './lib/ollama-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// =============================================================================
// Configuration
// =============================================================================

type LLMBackend = 'kobold' | 'ollama';

const BACKEND: LLMBackend = (process.env.LLM_BACKEND as LLMBackend) || 'kobold';
const KOBOLD_BASE_URL = process.env.KOBOLD_URL || 'http://localhost:5001';
const OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama2';
const PORT = parseInt(process.env.PORT || '3000');

console.log(`RXCAFE Chat Server`);
console.log(`Backend: ${BACKEND}`);
console.log(`KoboldCPP URL: ${KOBOLD_BASE_URL}`);
console.log(`Ollama URL: ${OLLAMA_BASE_URL}`);
console.log(`Ollama Model: ${OLLAMA_MODEL}`);
console.log(`Port: ${PORT}`);

// =============================================================================
// Unified LLM Evaluator Interface
// =============================================================================

interface LLMEvaluator {
  evaluateChunk(chunk: Chunk): AsyncGenerator<Chunk>;
  abort(): Promise<void>;
}

function createEvaluator(backend: LLMBackend, model?: string): LLMEvaluator {
  if (backend === 'ollama') {
    const ollama = new OllamaEvaluator(OLLAMA_BASE_URL, model || OLLAMA_MODEL);
    return {
      evaluateChunk: ollama.evaluateChunk.bind(ollama),
      abort: async () => {
        // Ollama doesn't have a direct abort API, but we can handle it via AbortController
      }
    };
  } else {
    const kobold = new KoboldEvaluator(KOBOLD_BASE_URL);
    return {
      evaluateChunk: kobold.evaluateChunk.bind(kobold),
      abort: async () => {
        await kobold.getAPI().abortGeneration();
      }
    };
  }
}

// =============================================================================
// Session Management
// =============================================================================

interface Session {
  id: string;
  stream: ChunkStream;
  history: Chunk[];
  llmEvaluator: LLMEvaluator;
  backend: LLMBackend;
  model?: string;
  abortController: AbortController | null;
}

const sessions = new Map<string, Session>();

function createSession(backend: LLMBackend = BACKEND, model?: string): Session {
  const id = `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  
  // Create the main input stream - this is where all user chunks flow in
  const inputStream = new ChunkStream();
  
  // Create LLM evaluator based on selected backend
  const llmEvaluator = createEvaluator(backend, model);
  
  const session: Session = {
    id,
    stream: inputStream,
    history: [],
    llmEvaluator,
    backend,
    model,
    abortController: null
  };
  
  // Archive all chunks to history
  inputStream.subscribe((chunk) => {
    session.history.push(chunk);
  });
  
  sessions.set(id, session);
  return session;
}

// =============================================================================
// RXCAFE Stream Processing Pipeline
// =============================================================================

/**
 * Create an evaluator that annotates chunks with their chat role
 * Pure transformer - adds metadata without changing content
 */
function createRoleAnnotator(role: string): Evaluator {
  return (chunk: Chunk) => {
    return annotateChunk(chunk, 'chat.role', role);
  };
}

/**
 * Create an evaluator that filters chunks by content type
 * Returns null chunks for non-matching items (which get filtered downstream)
 */
function createTypeFilter(allowedTypes: string[]): Evaluator {
  return (chunk: Chunk) => {
    if (!allowedTypes.includes(chunk.contentType)) {
      return createNullChunk('com.rxcafe.filter', {
        'filter.rejected': true,
        'filter.reason': `Type ${chunk.contentType} not in [${allowedTypes.join(', ')}]`
      });
    }
    return chunk;
  };
}

/**
 * Create an evaluator that wraps the LLM evaluator
 * This demonstrates flatMap pattern - one input chunk generates multiple output chunks
 */
function createLLMStreamEvaluator(
  llmEvaluator: LLMEvaluator,
  backend: LLMBackend,
  onToken: (token: string) => void,
  onFinish: () => void,
  abortSignal: AbortSignal
): Evaluator {
  return async (chunk: Chunk) => {
    // Only process text chunks from users
    if (chunk.contentType !== 'text') {
      return chunk;
    }
    
    if (chunk.annotations['chat.role'] !== 'user') {
      return chunk;
    }
    
    // Use flatMap semantics: one input chunk generates multiple output chunks
    const outputs: Chunk[] = [];
    
    // Emit marker that generation started
    outputs.push(createNullChunk('com.rxcafe.llm', {
      'llm.generation-started': true,
      'llm.backend': backend,
      'llm.parent-chunk-id': chunk.id
    }));
    
    try {
      // Stream tokens from LLM - each token becomes its own chunk
      for await (const tokenChunk of llmEvaluator.evaluateChunk(chunk)) {
        if (abortSignal.aborted) {
          break;
        }
        
        outputs.push(tokenChunk);
        
        // Callback for real-time streaming
        if (tokenChunk.contentType === 'text') {
          onToken(tokenChunk.content as string);
        }
      }
      
      onFinish();
    } catch (error) {
      outputs.push(createNullChunk('com.rxcafe.error', {
        'error.message': error instanceof Error ? error.message : 'LLM error',
        'error.source-chunk-id': chunk.id
      }));
    }
    
    return outputs;
  };
}

/**
 * Build a complete chat processing pipeline using stream composition
 * 
 * Pipeline: Input -> [Filter] -> [Annotate] -> [flatMap LLM] -> Output
 */
function buildChatPipeline(
  inputStream: ChunkStream,
  llmEvaluator: LLMEvaluator,
  backend: LLMBackend,
  onToken: (token: string) => void,
  onFinish: () => void,
  abortSignal: AbortSignal
): ChunkStream {
  // Step 1: Filter to only allow text chunks
  // stream.filter() operation
  const textOnlyStream = inputStream.pipe(createTypeFilter(['text']));
  
  // Step 2: Annotate user chunks
  // stream.map() operation  
  const annotatedStream = textOnlyStream.pipe(createRoleAnnotator('user'));
  
  // Step 3: Branch stream - user messages go to LLM
  // This demonstrates parallel processing: user chunks flow through,
  // and LLM responses are merged back into the stream
  const llmStream = new ChunkStream();
  
  // Set up the LLM evaluator on the annotated stream
  // flatMap pattern: one user chunk -> many LLM token chunks
  annotatedStream.pipe(
    createLLMStreamEvaluator(llmEvaluator, backend, onToken, onFinish, abortSignal)
  ).pipe((chunk: Chunk) => {
    // Forward all LLM outputs to the LLM stream
    llmStream.emit(chunk);
    return chunk;
  });
  
  // Step 4: Merge streams - combine user input with LLM responses
  // mergeStreams operator
  const combinedStream = mergeStreams(annotatedStream, llmStream);
  
  // Step 5: Final transformation - annotate assistant responses
  // stream.map() with conditional logic
  const outputStream = combinedStream.map((chunk: Chunk) => {
    // If it's a text chunk from the LLM evaluator, mark it as assistant
    if (chunk.contentType === 'text' && 
        (chunk.producer === 'com.rxcafe.kobold-evaluator' || 
         chunk.producer === 'com.rxcafe.ollama-evaluator')) {
      return annotateChunk(chunk, 'chat.role', 'assistant');
    }
    return chunk;
  });
  
  return outputStream;
}

// =============================================================================
// API Request Handlers
// =============================================================================

async function handleCreateSession(body?: any): Promise<Response> {
  const backend = body?.backend || BACKEND;
  const model = body?.model;
  
  const session = createSession(backend, model);
  
  return new Response(JSON.stringify({ 
    sessionId: session.id,
    backend: session.backend,
    model: session.model,
    message: 'Session created'
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleListModels(backend?: string): Promise<Response> {
  const targetBackend = backend || BACKEND;
  
  if (targetBackend === 'ollama') {
    try {
      const { OllamaAPI } = await import('./lib/ollama-api.js');
      const api = new OllamaAPI(OLLAMA_BASE_URL);
      const models = await api.listModels();
      return new Response(JSON.stringify({ models, backend: 'ollama' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ 
        error: 'Failed to list models',
        message: error instanceof Error ? error.message : 'Unknown error'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } else {
    return new Response(JSON.stringify({ 
      backend: 'kobold',
      message: 'KoboldCPP does not support model listing'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleGetHistory(sessionId: string): Promise<Response> {
  const session = sessions.get(sessionId);
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const textChunks = session.history.filter(c => c.contentType === 'text');
  
  return new Response(JSON.stringify({ 
    sessionId,
    backend: session.backend,
    model: session.model,
    chunks: textChunks
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleChatStream(
  sessionId: string, 
  message: string
): Promise<Response> {
  const session = sessions.get(sessionId);
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Create abort controller for this generation
  const abortController = new AbortController();
  session.abortController = abortController;
  
  // Build SSE response stream
  const stream = new ReadableStream({
    start(controller) {
      let fullResponse = '';
      
      // Create processing pipeline with callbacks for streaming
      const outputStream = buildChatPipeline(
        session.stream,
        session.llmEvaluator,
        session.backend,
        // onToken callback - called for each token
        (token: string) => {
          fullResponse += token;
          controller.enqueue(`data: ${JSON.stringify({
            type: 'token',
            token: token
          })}

`);
        },
        // onFinish callback - called when generation completes
        () => {
          // Create final assistant chunk with complete response
          const assistantChunk = createTextChunk(fullResponse, 'com.rxcafe.assistant', {
            'chat.role': 'assistant'
          });
          session.stream.emit(assistantChunk);
          
          controller.enqueue(`data: ${JSON.stringify({ type: 'finish' })}

`);
          controller.enqueue(`data: ${JSON.stringify({ type: 'done' })}

`);
          controller.close();
        },
        abortController.signal
      );
      
      // Subscribe to pipeline output for any additional processing
      outputStream.subscribe((chunk: Chunk) => {
        // Pipeline is running - chunks are being processed
        // Actual token streaming happens via the callbacks above
      });
      
      // Emit user message to start the pipeline
      const userChunk = createTextChunk(message, 'com.rxcafe.user', {
        'chat.role': 'user'
      });
      session.stream.emit(userChunk);
      
      // Send confirmation that user chunk was received
      controller.enqueue(`data: ${JSON.stringify({
        type: 'user',
        chunk: userChunk
      })}

`);
    },
    cancel() {
      abortController.abort();
    }
  });
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}

async function handleAbort(sessionId: string): Promise<Response> {
  const session = sessions.get(sessionId);
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  if (session.abortController) {
    session.abortController.abort();
    session.abortController = null;
  }
  
  await session.llmEvaluator.abort();
  
  return new Response(JSON.stringify({ message: 'Generation aborted' }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// =============================================================================
// Frontend Serving
// =============================================================================

function getFrontendHtml(): string {
  try {
    return readFileSync(join(__dirname, 'frontend', 'index.html'), 'utf-8');
  } catch {
    return `<!DOCTYPE html>
<html>
<head><title>RXCAFE Chat</title></head>
<body>
<h1>RXCAFE Chat</h1>
<p>Frontend not found.</p>
</body>
</html>`;
  }
}

function getFrontendJs(): string {
  try {
    return readFileSync(join(__dirname, 'frontend', 'app.js'), 'utf-8');
  } catch {
    return 'console.error("Frontend JS not found");';
  }
}

function getFrontendCss(): string {
  try {
    return readFileSync(join(__dirname, 'frontend', 'styles.css'), 'utf-8');
  } catch {
    return '';
  }
}

// =============================================================================
// HTTP Server
// =============================================================================

const server = serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    // Serve frontend
    if (pathname === '/' || pathname === '/index.html') {
      return new Response(getFrontendHtml(), {
        headers: { 'Content-Type': 'text/html', ...corsHeaders }
      });
    }
    
    if (pathname === '/app.js') {
      return new Response(getFrontendJs(), {
        headers: { 'Content-Type': 'application/javascript', ...corsHeaders }
      });
    }
    
    if (pathname === '/styles.css') {
      return new Response(getFrontendCss(), {
        headers: { 'Content-Type': 'text/css', ...corsHeaders }
      });
    }
    
    // API Routes
    if (pathname === '/api/session' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const response = await handleCreateSession(body);
      return addCors(response, corsHeaders);
    }
    
    if (pathname === '/api/models' && request.method === 'GET') {
      const backend = url.searchParams.get('backend') || undefined;
      const response = await handleListModels(backend);
      return addCors(response, corsHeaders);
    }
    
    if (pathname.match(/^\/api\/session\/[^/]+\/history$/) && request.method === 'GET') {
      const sessionId = pathname.split('/')[3];
      const response = await handleGetHistory(sessionId);
      return addCors(response, corsHeaders);
    }
    
    if (pathname.match(/^\/api\/chat\/[^/]+$/) && request.method === 'POST') {
      const sessionId = pathname.split('/')[3];
      const body = await request.json();
      const message = body.message;
      
      if (!message || typeof message !== 'string') {
        return new Response(JSON.stringify({ error: 'Message required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      const response = await handleChatStream(sessionId, message);
      return addCors(response, corsHeaders);
    }
    
    if (pathname.match(/^\/api\/chat\/[^/]+\/abort$/) && request.method === 'POST') {
      const sessionId = pathname.split('/')[3];
      const response = await handleAbort(sessionId);
      return addCors(response, corsHeaders);
    }
    
    if (pathname === '/api/health') {
      return new Response(JSON.stringify({ 
        status: 'ok',
        timestamp: Date.now(),
        backend: BACKEND,
        koboldUrl: KOBOLD_BASE_URL,
        ollamaUrl: OLLAMA_BASE_URL,
        ollamaModel: OLLAMA_MODEL
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    
    // 404
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
});

function addCors(response: Response, corsHeaders: Record<string, string>): Response {
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }
  return response;
}

console.log(`Server running at http://localhost:${PORT}`);
