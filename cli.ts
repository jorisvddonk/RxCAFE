/**
 * ObservableCAFE CLI - Command-line interface for chat inference
 * 
 * Usage:
 *   bun run cli.ts
 *   bun run cli.ts --backend ollama --model gemma3:1b
 */

import * as readline from 'readline';
import { getDefaultConfig, createSession, loadAgentsFromDisk, addChunkToSession, type Session, type CoreConfig } from './core.js';

const args = process.argv.slice(2);

function parseArgs(): { backend?: string; model?: string } {
  const result: { backend?: string; model?: string } = {};
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--backend' && args[i + 1]) {
      result.backend = args[i + 1];
      i++;
    } else if (args[i] === '--model' && args[i + 1]) {
      result.model = args[i + 1];
      i++;
    }
  }
  
  return result;
}

async function main() {
  const cliOptions = parseArgs();
  const config: CoreConfig = getDefaultConfig();

  if (cliOptions.backend) {
    config.backend = cliOptions.backend as 'kobold' | 'ollama' | 'llamacpp';
  }

  await loadAgentsFromDisk();
  
  const runtimeConfig: { backend?: string; model?: string } = {};
  if (cliOptions.backend) runtimeConfig.backend = cliOptions.backend;
  if (cliOptions.model) runtimeConfig.model = cliOptions.model;
  
  const session: Session = await createSession(config, { runtimeConfig });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('ObservableCAFE CLI');
  console.log(`Backend: ${session.backend}`);
  if (session.model) console.log(`Model: ${session.model}`);
  console.log('');
  console.log('Commands:');
  console.log('  /system <prompt>  - Set system prompt');
  console.log('  /add <content>    - Add chunk to context');
  console.log('  /history          - Show conversation history');
  console.log('  /clear            - Clear history');
  console.log('  /quit             - Exit');
  console.log('');
  console.log('Type a message and press Enter to chat.');
  console.log('');

  session.outputStream.subscribe({
    next: (chunk) => {
      const role = chunk.annotations['chat.role'];
      if (role === 'assistant' && chunk.contentType === 'text') {
        process.stdout.write('\n');
      }
    },
    error: (err) => {
      console.error('\n[Error]', err.message);
      prompt();
    }
  });

  session.errorStream.subscribe({
    next: (err) => {
      console.error('\n[Pipeline Error]', err.message);
    }
  });

function prompt() {
  rl.question('> ', async (input) => {
    const trimmed = input.trim();
    
    if (!trimmed) {
      prompt();
      return;
    }
    
    if (trimmed === '/quit' || trimmed === '/exit') {
      console.log('Goodbye!');
      rl.close();
      process.exit(0);
    }
    
    if (trimmed === '/history') {
      console.log('\n--- Conversation History ---');
      for (const chunk of session.history) {
        if (chunk.contentType !== 'text') continue;
        const role = chunk.annotations['chat.role'] || 'unknown';
        const content = (chunk.content as string).substring(0, 100);
        console.log(`[${role}] ${content}${(chunk.content as string).length > 100 ? '...' : ''}`);
      }
      console.log('----------------------------\n');
      prompt();
      return;
    }
    
    if (trimmed === '/clear') {
      session.history.length = 0;
      session.systemPrompt = null;
      session.trustedChunks.clear();
      console.log('History cleared.\n');
      prompt();
      return;
    }
    
    if (trimmed.startsWith('/system ')) {
      const prompt_text = trimmed.slice(8);
      addChunkToSession(session, {
        content: prompt_text,
        producer: 'com.rxcafe.system-prompt',
        annotations: { 'chat.role': 'system', 'system.prompt': true }
      });
      console.log(`System prompt set: ${prompt_text.substring(0, 50)}...\n`);
      prompt();
      return;
    }
    
    if (trimmed.startsWith('/add ')) {
      const content = trimmed.slice(5);
      addChunkToSession(session, {
        content,
        producer: 'com.rxcafe.cli',
        annotations: {}
      });
      console.log(`Chunk added to context.\n`);
      prompt();
      return;
    }
    
    if (trimmed.startsWith('/')) {
      console.log('Unknown command. Available: /system, /add, /history, /clear, /quit\n');
      prompt();
      return;
    }
    
    const userChunk = {
      content: trimmed,
      producer: 'com.rxcafe.user',
      annotations: { 'chat.role': 'user' }
    };
    
    addChunkToSession(session, { ...userChunk, emit: true });
    
    session.callbacks = {
      onToken: (token, _chunkId) => {
        process.stdout.write(token);
      },
      onFinish: () => {
        console.log('\n');
        prompt();
      },
      onError: (err) => {
        console.error(`\nError: ${err.message}\n`);
        prompt();
      }
    };
  });
}

prompt();

process.on('SIGINT', () => {
  console.log('\nGoodbye!');
  rl.close();
  process.exit(0);
});
}

main().catch(err => {
  console.error('Failed to start CLI:', err);
  process.exit(1);
});
