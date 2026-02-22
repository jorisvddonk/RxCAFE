#!/usr/bin/env bun

const SERVER_URL = process.env.CAFE_SERVER_URL || 'http://localhost:3000';
const SESSION_ID = process.env.CAFE_SESSION_ID;
const API_TOKEN = process.env.CAFE_API_TOKEN;

if (!SESSION_ID) {
  console.error('Usage: CAFE_SESSION_ID=<session-id> CAFE_API_TOKEN=<token> bun run index.ts');
  console.error('   or: bun run index.ts --session <session-id> --token <token>');
  process.exit(1);
}

function rot13(str: string): string {
  return str.replace(/[a-zA-Z]/g, (char) => {
    const code = char.charCodeAt(0);
    const base = code >= 65 && code <= 90 ? 65 : 97;
    return String.fromCharCode(((code - base + 13) % 26) + base);
  });
}

async function registerAgent(name: string, apiToken: string): Promise<{ agentId: string; apiKey: string }> {
  const res = await fetch(`${SERVER_URL}/api/connected-agents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiToken}`,
    },
    body: JSON.stringify({ name, description: 'Applies ROT13 to user messages' }),
  });
  
  if (!res.ok) {
    throw new Error(`Failed to register: ${res.status} ${await res.text()}`);
  }
  
  return res.json();
}

async function subscribe(agentId: string, apiKey: string, sessionId: string): Promise<void> {
  const res = await fetch(`${SERVER_URL}/api/connected-agents/${agentId}/subscribe/${sessionId}`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey },
  });
  
  if (!res.ok) {
    throw new Error(`Failed to subscribe: ${res.status} ${await res.text()}`);
  }
}

async function join(agentId: string, apiKey: string, sessionId: string): Promise<void> {
  const res = await fetch(`${SERVER_URL}/api/connected-agents/${agentId}/join/${sessionId}`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey },
  });
  
  if (!res.ok) {
    throw new Error(`Failed to join: ${res.status} ${await res.text()}`);
  }
}

async function produceChunk(apiKey: string, sessionId: string, content: string): Promise<void> {
  const res = await fetch(`${SERVER_URL}/api/session/${sessionId}/agent-chunk`, {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content,
      contentType: 'text',
      annotations: { 
        'chat.role': 'assistant',
        'rot13.transformed': true 
      },
    }),
  });
  
  if (!res.ok) {
    throw new Error(`Failed to produce chunk: ${res.status}`);
  }
}

async function streamChunks(
  apiKey: string,
  sessionId: string,
  onChunk: (chunk: any) => void,
): Promise<void> {
  const res = await fetch(`${SERVER_URL}/api/session/${sessionId}/stream/agent`, {
    headers: {
      'X-API-Key': apiKey,
      'Accept': 'text/event-stream',
    },
  });
  
  if (!res.ok) {
    throw new Error(`Failed to connect to stream: ${res.status}`);
  }
  
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const chunk = JSON.parse(line.slice(6));
          onChunk(chunk);
        } catch (e) {
          // Ignore parse errors
        }
      }
    }
  }
}

async function main() {
  const sessionId = process.argv.includes('--session')
    ? process.argv[process.argv.indexOf('--session') + 1]
    : SESSION_ID;
  
  const apiToken = process.argv.includes('--token')
    ? process.argv[process.argv.indexOf('--token') + 1]
    : API_TOKEN;
  
  if (!apiToken) {
    console.error('Error: API token required. Set CAFE_API_TOKEN or use --token');
    process.exit(1);
  }
  
  console.log(`Registering ROT13 agent...`);
  const { agentId, apiKey } = await registerAgent('rot13-agent', apiToken);
  console.log(`Agent registered: ${agentId}`);
  
  console.log(`Subscribing to session ${sessionId}...`);
  await subscribe(agentId, apiKey, sessionId);
  
  console.log(`Joining session ${sessionId}...`);
  await join(agentId, apiKey, sessionId);
  
  console.log(`Listening for user messages (Ctrl+C to exit)...\n`);
  
  const cleanup = async () => {
    console.log('\nUnregistering agent...');
    await fetch(`${SERVER_URL}/api/connected-agents/${agentId}`, {
      method: 'DELETE',
      headers: { 'X-API-Key': apiKey },
    });
    process.exit(0);
  };
  
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  
  await streamChunks(apiKey, sessionId, (chunk) => {
    if (chunk.annotations?.['chat.role'] === 'user' && chunk.contentType === 'text') {
      const original = chunk.content;
      const transformed = rot13(original);
      
      console.log(`User: ${original}`);
      console.log(`ROT13: ${transformed}\n`);
      
      produceChunk(apiKey, sessionId, `[ROT13] ${transformed}`).catch(console.error);
    }
  });
}

main().catch(console.error);
