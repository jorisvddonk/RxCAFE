/**
 * RXCAFE Chat Application
 * Main entry point - HTTP server with API and frontend
 * 
 * This file demonstrates RXCAFE patterns:
 * - Chunks flow through reactive streams
 * - Evaluators transform chunks via map/flatMap operations
 * - Stream composition creates processing pipelines
 * - Security filtering for untrusted web content
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
const RXCAFE_TRACE = process.env.RXCAFE_TRACE === '1';

console.log(`RXCAFE Chat Server`);
console.log(`Backend: ${BACKEND}`);
console.log(`KoboldCPP URL: ${KOBOLD_BASE_URL}`);
console.log(`Ollama URL: ${OLLAMA_BASE_URL}`);
console.log(`Ollama Model: ${OLLAMA_MODEL}`);
console.log(`Port: ${PORT}`);
console.log(`Tracing: ${RXCAFE_TRACE ? 'ENABLED' : 'disabled'}`);

// =============================================================================
// Unified LLM Evaluator Interface
// =============================================================================

interface LLMEvaluator {
  evaluateChunk(chunk: Chunk): AsyncGenerator<Chunk>;
  abort(): Promise<void>;
}

function createEvaluator(backend: LLMBackend, model?: string): LLMEvaluator {
  if (backend === 'ollama') {
    const ollama = new OllamaEvaluator(OLLAMA_BASE_URL, model);
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
  trustedChunks: Set<string>; // Track which chunk IDs are trusted
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
    abortController: null,
    trustedChunks: new Set()
  };
  
  // Archive all chunks to history (avoid duplicates by checking chunk ID)
  inputStream.subscribe((chunk) => {
    const existingIndex = session.history.findIndex(c => c.id === chunk.id);
    if (existingIndex !== -1) {
      // Update existing chunk (e.g., when trust status changes)
      session.history[existingIndex] = chunk;
    } else {
      // Add new chunk
      session.history.push(chunk);
    }
  });
  
  sessions.set(id, session);
  return session;
}

// =============================================================================
// Security and Trust Management
// =============================================================================

/**
 * Mark a chunk as untrusted (web content, external sources)
 */
function markUntrusted(chunk: Chunk, source: string): Chunk {
  return annotateChunk(chunk, 'security.trust-level', {
    trusted: false,
    source: source,
    requiresReview: true
  });
}

/**
 * Mark a chunk as trusted
 */
function markTrusted(chunk: Chunk): Chunk {
  return annotateChunk(chunk, 'security.trust-level', {
    trusted: true,
    source: chunk.annotations['security.trust-level']?.source || 'manual',
    requiresReview: false
  });
}

/**
 * Check if a chunk is trusted
 */
function isTrusted(chunk: Chunk): boolean {
  return chunk.annotations['security.trust-level']?.trusted === true;
}

/**
 * Fetch web content and create an untrusted chunk
 */
async function fetchWebContent(url: string): Promise<Chunk> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'RXCAFE-Bot/1.0'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const contentType = response.headers.get('content-type') || 'text/plain';
    
    if (contentType.includes('text/html')) {
      // For HTML, we should extract text content
      const html = await response.text();
      // Simple HTML tag stripping (in production, use a proper HTML parser)
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 10000); // Limit to 10k chars
      
      const chunk = createTextChunk(text, 'com.rxcafe.web-fetch', {
        'web.source-url': url,
        'web.content-type': contentType,
        'web.fetch-time': Date.now()
      });
      
      return markUntrusted(chunk, `web:${url}`);
    } else {
      // For other content types, store as text
      const text = await response.text();
      const chunk = createTextChunk(text.slice(0, 10000), 'com.rxcafe.web-fetch', {
        'web.source-url': url,
        'web.content-type': contentType,
        'web.fetch-time': Date.now()
      });
      
      return markUntrusted(chunk, `web:${url}`);
    }
  } catch (error) {
    const errorChunk = createTextChunk(
      `Failed to fetch ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'com.rxcafe.web-fetch',
      {
        'web.source-url': url,
        'web.error': true
      }
    );
    return markUntrusted(errorChunk, `web:${url}`);
  }
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
 * Create an evaluator that filters out untrusted chunks for LLM context
 * Only trusted chunks flow through to the LLM
 */
function createTrustFilter(): Evaluator {
  return (chunk: Chunk) => {
    // Check if chunk has trust-level annotation
    const trustLevel = chunk.annotations['security.trust-level'];
    
    if (trustLevel && trustLevel.trusted === false) {
      // Return null chunk with annotation indicating it was filtered
      return createNullChunk('com.rxcafe.security-filter', {
        'filter.rejected': true,
        'filter.reason': 'Untrusted content - requires user review',
        'filter.source-chunk-id': chunk.id
      });
    }
    
    return chunk;
  };
}

/**
 * Build conversation context from session history
 * Only includes trusted chunks (user messages, assistant responses, trusted web content)
 * Excludes the current chunk (which will be appended separately)
 */
function buildConversationContext(history: Chunk[], excludeChunkId?: string): string {
  const contextParts: string[] = [];
  
  for (const chunk of history) {
    // Skip the current chunk being processed
    if (chunk.id === excludeChunkId) continue;
    
    // Skip non-text chunks
    if (chunk.contentType !== 'text') continue;
    
    const role = chunk.annotations['chat.role'];
    const trustLevel = chunk.annotations['security.trust-level'];
    const isTrusted = !trustLevel || trustLevel.trusted === true;
    
    // Skip untrusted content
    if (!isTrusted) continue;
    
    const content = chunk.content as string;
    
    if (role === 'user') {
      contextParts.push(`User: ${content}`);
    } else if (role === 'assistant') {
      contextParts.push(`Assistant: ${content}`);
    } else if (chunk.producer === 'com.rxcafe.web-fetch' || chunk.annotations['web.source-url']) {
      // Web content that has been trusted
      const url = chunk.annotations['web.source-url'] || 'unknown';
      contextParts.push(`[Web content from ${url}]: ${content}`);
    }
  }
  
  return contextParts.join('\n\n');
}

/**
 * Create an evaluator that wraps the LLM evaluator
 * This demonstrates flatMap pattern - one input chunk generates multiple output chunks
 * Now includes full conversation context from trusted chunks
 */
function createLLMStreamEvaluator(
  llmEvaluator: LLMEvaluator,
  backend: LLMBackend,
  sessionHistory: Chunk[],
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
    
    // Build full conversation context including trusted web content
    // Exclude current chunk since we'll append it separately
    const context = buildConversationContext(sessionHistory, chunk.id);
    const currentMessage = chunk.content as string;
    
    // Create prompt with full context
    const prompt = context 
      ? `${context}\n\nUser: ${currentMessage}\nAssistant:`
      : `User: ${currentMessage}\nAssistant:`;
    
    // RXCAFE_TRACE: Log the context being sent to LLM
    if (RXCAFE_TRACE) {
      console.log('\n═══════════════════════════════════════════════════════════');
      console.log('RXCAFE_TRACE: LLM Context');
      console.log('═══════════════════════════════════════════════════════════');
      console.log(`Chunk ID: ${chunk.id}`);
      console.log(`Producer: ${chunk.producer}`);
      console.log(`Context Length: ${context.length} chars`);
      console.log(`Current Message Length: ${currentMessage.length} chars`);
      console.log(`Total Prompt Length: ${prompt.length} chars`);
      console.log('\n--- FULL CONTEXT SENT TO LLM ---');
      console.log(prompt);
      console.log('--- END CONTEXT ---\n');
      
      console.log('Trusted chunks in history:');
      let trustedCount = 0;
      for (const h of sessionHistory) {
        const trust = h.annotations['security.trust-level'];
        if (h.contentType === 'text' && (!trust || trust.trusted === true)) {
          trustedCount++;
          const role = h.annotations['chat.role'] || h.producer;
          console.log(`  - ${role}: ${(h.content as string).substring(0, 50)}...`);
        }
      }
      console.log(`Total trusted chunks: ${trustedCount}`);
      console.log('═══════════════════════════════════════════════════════════\n');
    }
    
    // Create a context chunk with the full prompt
    const contextChunk = createTextChunk(prompt, chunk.producer, {
      ...chunk.annotations,
      'llm.context-length': context.length,
      'llm.full-prompt': true
    });
    
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
      for await (const tokenChunk of llmEvaluator.evaluateChunk(contextChunk)) {
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
 * Pipeline: Input -> [Filter] -> [Annotate] -> [Security Filter] -> [flatMap LLM] -> Output
 */
function buildChatPipeline(
  inputStream: ChunkStream,
  llmEvaluator: LLMEvaluator,
  backend: LLMBackend,
  sessionHistory: Chunk[],
  onToken: (token: string) => void,
  onFinish: () => void,
  abortSignal: AbortSignal
): ChunkStream {
  // Step 1: Filter to only allow text chunks
  const textOnlyStream = inputStream.pipe(createTypeFilter(['text']));
  
  // Step 2: Annotate user chunks
  const annotatedStream = textOnlyStream.pipe(createRoleAnnotator('user'));
  
  // Step 3: SECURITY FILTER - Only trusted chunks flow to LLM
  // This implements the RXCAFE security pattern from section 4.3
  const trustedStream = annotatedStream.pipe(createTrustFilter());
  
  // Step 4: Branch stream - trusted user messages go to LLM
  const llmStream = new ChunkStream();
  
  // Set up the LLM evaluator on the trusted stream with full history
  trustedStream.pipe(
    createLLMStreamEvaluator(llmEvaluator, backend, sessionHistory, onToken, onFinish, abortSignal)
  ).pipe((chunk: Chunk) => {
    llmStream.emit(chunk);
    return chunk;
  });
  
  // Step 5: Merge streams - combine all input with LLM responses
  // Note: We merge from annotatedStream (all chunks) not just trusted ones
  // This way untrusted chunks still appear in UI but don't go to LLM
  const combinedStream = mergeStreams(annotatedStream, llmStream);
  
  // Step 6: Final transformation - annotate assistant responses
  const outputStream = combinedStream.map((chunk: Chunk) => {
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

async function handleFetchWeb(sessionId: string, url: string): Promise<Response> {
  const session = sessions.get(sessionId);
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    const chunk = await fetchWebContent(url);
    session.stream.emit(chunk);
    
    return new Response(JSON.stringify({
      success: true,
      chunk: chunk,
      message: 'Web content fetched and added as untrusted chunk'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch URL'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleToggleTrust(sessionId: string, chunkId: string, trusted: boolean): Promise<Response> {
  const session = sessions.get(sessionId);
  
  if (!session) {
    return new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Find the chunk in history
  const chunkIndex = session.history.findIndex(c => c.id === chunkId);
  if (chunkIndex === -1) {
    return new Response(JSON.stringify({ error: 'Chunk not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const chunk = session.history[chunkIndex];
  
  // Update trust status
  if (trusted) {
    session.trustedChunks.add(chunkId);
    const trustedChunk = markTrusted(chunk);
    session.history[chunkIndex] = trustedChunk;
    
    // Re-emit the chunk to the stream so downstream evaluators see the update
    session.stream.emit(trustedChunk);
    
    return new Response(JSON.stringify({
      success: true,
      chunkId,
      trusted: true,
      message: 'Chunk marked as trusted and added to LLM context'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } else {
    session.trustedChunks.delete(chunkId);
    const untrustedChunk = markUntrusted(chunk, chunk.annotations['security.trust-level']?.source || 'manual');
    session.history[chunkIndex] = untrustedChunk;
    session.stream.emit(untrustedChunk);
    
    return new Response(JSON.stringify({
      success: true,
      chunkId,
      trusted: false,
      message: 'Chunk marked as untrusted'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
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
      // Pass session.history so the LLM can see all trusted context including web content
      const outputStream = buildChatPipeline(
        session.stream,
        session.llmEvaluator,
        session.backend,
        session.history,
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
    
    // NEW: Web fetch endpoint
    if (pathname.match(/^\/api\/session\/[^/]+\/web$/) && request.method === 'POST') {
      const sessionId = pathname.split('/')[3];
      const body = await request.json();
      const urlToFetch = body.url;
      
      if (!urlToFetch) {
        return new Response(JSON.stringify({ error: 'URL required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      const response = await handleFetchWeb(sessionId, urlToFetch);
      return addCors(response, corsHeaders);
    }
    
    // NEW: Trust toggle endpoint
    if (pathname.match(/^\/api\/session\/[^/]+\/chunk\/[^/]+\/trust$/) && request.method === 'POST') {
      const parts = pathname.split('/');
      const sessionId = parts[3];
      const chunkId = parts[5];
      const body = await request.json();
      const trusted = body.trusted === true;
      
      const response = await handleToggleTrust(sessionId, chunkId, trusted);
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
