/**
 * RXCAFE Test - Automated playback testing for the pipeline
 * 
 * Usage:
 *   bun test                        # Run built-in tests with default backend
 *   bun test tests.json             # Run tests from JSON file
 *   cat tests.json | bun test -     # Run tests from stdin
 *   bun test -- --backend ollama    # Run with specific backend
 *   bun test -- --verbose           # Show detailed output
 */

import { 
  getDefaultConfig, 
  createSession,
  loadAgentsFromDisk,
  addChunkToSession,
  type Session,
  type CoreConfig,
  type Chunk
} from './core.js';
import { Subject } from './lib/stream.js';
import { readFileSync } from 'fs';

const args = process.argv.slice(2);

interface TestOptions {
  backend?: string;
  model?: string;
  verbose?: boolean;
  timeout?: number;
  testFile?: string;
}

interface TestCase {
  name: string;
  chunks: Array<{
    content: string;
    annotations?: Record<string, any>;
    producer?: string;
    emit?: boolean;
    delay?: number;
  }>;
  expect?: {
    minChunks?: number;
    containsText?: string;
    roles?: string[];
  };
}

interface TestFile {
  name?: string;
  backend?: string;
  model?: string;
  timeout?: number;
  tests: TestCase[];
}

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  outputChunks: Chunk[];
  error?: string;
}

function parseArgs(): { options: TestOptions; testFile?: string } {
  const options: TestOptions = { backend: 'ollama', timeout: 30000 };
  let testFile: string | undefined;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--backend' && args[i + 1]) {
      options.backend = args[i + 1];
      i++;
    } else if (args[i] === '--model' && args[i + 1]) {
      options.model = args[i + 1];
      i++;
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      options.verbose = true;
    } else if (args[i] === '--timeout' && args[i + 1]) {
      options.timeout = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '-') {
      testFile = args[i];
    } else if (!args[i].startsWith('--') && !args[i].startsWith('-')) {
      testFile = args[i];
    }
  }
  
  return { options, testFile };
}

class TestRunner {
  private session: Session;
  private options: TestOptions;
  private outputChunks: Chunk[] = [];
  private errors: Error[] = [];
  
  static async create(options: TestOptions): Promise<TestRunner> {
    const config = getDefaultConfig();
    if (options.backend) {
      config.backend = options.backend as 'ollama' | 'kobold';
    }
    
    await loadAgentsFromDisk();
    
    const session = await createSession(config, {
      backend: options.backend as 'ollama' | 'kobold',
      model: options.model,
    });
    
    const runner = new TestRunner();
    runner.options = options;
    runner.session = session;
    
    session.outputStream.subscribe({
      next: (chunk) => {
        runner.outputChunks.push(chunk);
        if (options.verbose) {
          const role = chunk.annotations['chat.role'] || chunk.producer;
          const preview = chunk.contentType === 'text' 
            ? (chunk.content as string).substring(0, 60)
            : `[${chunk.contentType}]`;
          console.log(`  [${role}] ${preview}...`);
        }
      }
    });
    
    session.errorStream.subscribe({
      next: (err) => {
        runner.errors.push(err);
        if (options.verbose) {
          console.log(`  [ERROR] ${err.message}`);
        }
      }
    });
    
    return runner;
  }
  
  private constructor() {}
  
  async runTest(test: TestCase): Promise<TestResult> {
    const startTime = Date.now();
    this.outputChunks = [];
    this.errors = [];
    
    console.log(`\n▶ ${test.name}`);
    
    const responsePromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Test timed out after ${this.options.timeout}ms`));
      }, this.options.timeout);
      
      const originalOnFinish = this.session.callbacks?.onFinish;
      
      this.session.callbacks = {
        onToken: () => {},
        onFinish: () => {
          clearTimeout(timeout);
          this.session.callbacks = null;
          resolve();
        },
        onError: (err) => {
          clearTimeout(timeout);
          this.session.callbacks = null;
          reject(err);
        }
      };
    });
    
    try {
      for (const chunkSpec of test.chunks) {
        if (chunkSpec.delay) {
          await this.delay(chunkSpec.delay);
        }
        
        addChunkToSession(this.session, {
          content: chunkSpec.content,
          producer: chunkSpec.producer || 'com.rxcafe.test',
          annotations: chunkSpec.annotations,
          emit: chunkSpec.emit !== false
        });
      }
      
      const hasUserMessage = test.chunks.some(c => 
        c.annotations?.['chat.role'] === 'user' || c.emit !== false
      );
      
      if (hasUserMessage) {
        await responsePromise;
      }
      
      const passed = this.validate(test);
      const duration = Date.now() - startTime;
      
      return {
        name: test.name,
        passed,
        duration,
        outputChunks: this.outputChunks,
        error: passed ? undefined : 'Validation failed'
      };
    } catch (error) {
      return {
        name: test.name,
        passed: false,
        duration: Date.now() - startTime,
        outputChunks: this.outputChunks,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
  
  private validate(test: TestCase): boolean {
    if (test.expect) {
      if (test.expect.minChunks !== undefined) {
        if (this.outputChunks.length < test.expect.minChunks) {
          if (this.options.verbose) {
            console.log(`  ✗ Expected at least ${test.expect.minChunks} chunks, got ${this.outputChunks.length}`);
          }
          return false;
        }
      }
      
      if (test.expect.containsText) {
        const allText = this.outputChunks
          .filter(c => c.contentType === 'text')
          .map(c => c.content as string)
          .join(' ');
        
        if (!allText.toLowerCase().includes(test.expect.containsText.toLowerCase())) {
          if (this.options.verbose) {
            console.log(`  ✗ Expected text containing "${test.expect.containsText}"`);
          }
          return false;
        }
      }
      
      if (test.expect.roles) {
        const actualRoles = this.outputChunks.map(c => c.annotations['chat.role']).filter(Boolean);
        for (const expectedRole of test.expect.roles) {
          if (!actualRoles.includes(expectedRole)) {
            if (this.options.verbose) {
              console.log(`  ✗ Missing expected role: ${expectedRole}`);
            }
            return false;
          }
        }
      }
    }
    
    return this.errors.length === 0;
  }
  
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  clearHistory() {
    this.session.history.length = 0;
    this.session.systemPrompt = null;
    this.session.trustedChunks.clear();
    this.outputChunks = [];
    this.errors = [];
  }
}

const TESTS: TestCase[] = [
  {
    name: 'Simple greeting',
    chunks: [
      { content: 'Hello, reply with just "Hi"', annotations: { 'chat.role': 'user' }, emit: true }
    ],
    expect: {
      minChunks: 1,
      roles: ['assistant']
    }
  },
  
  {
    name: 'System prompt + query',
    chunks: [
      { content: 'You are a pirate. Always respond like a pirate.', annotations: { 'chat.role': 'system' } },
      { content: 'What is 2+2?', annotations: { 'chat.role': 'user' }, emit: true }
    ],
    expect: {
      minChunks: 1,
      roles: ['assistant']
    }
  },
  
  {
    name: 'Multi-turn conversation',
    chunks: [
      { content: 'My name is Alice', annotations: { 'chat.role': 'user' }, emit: true },
      { content: 'What is my name?', annotations: { 'chat.role': 'user' }, emit: true, delay: 500 }
    ],
    expect: {
      minChunks: 2,
      roles: ['assistant', 'assistant']
    }
  },
  
  {
    name: 'Context with added chunk',
    chunks: [
      { 
        content: 'Important fact: The secret code is BLUE42', 
        annotations: {}, 
        producer: 'com.rxcafe.test-context'
      },
      { content: 'What is the secret code?', annotations: { 'chat.role': 'user' }, emit: true }
    ],
    expect: {
      minChunks: 1,
      containsText: 'BLUE42'
    }
  }
];

async function loadTests(testFile: string | undefined, options: TestOptions): Promise<{ tests: TestCase[]; name?: string }> {
  if (!testFile) {
    return { tests: TESTS };
  }
  
  let jsonContent: string;
  
  if (testFile === '-') {
    try {
      jsonContent = await readStdin();
      if (!jsonContent.trim()) {
        console.error('Error: stdin is empty');
        process.exit(1);
      }
    } catch (err) {
      console.error(`Error reading stdin: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  } else {
    try {
      jsonContent = readFileSync(testFile, 'utf-8');
    } catch (err) {
      console.error(`Error reading file ${testFile}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }
  
  let testFileData: TestFile;
  try {
    testFileData = JSON.parse(jsonContent);
  } catch (err) {
    console.error(`Error parsing JSON: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  
  if (!testFileData.tests || !Array.isArray(testFileData.tests)) {
    console.error('Error: JSON must contain a "tests" array');
    process.exit(1);
  }
  
  if (testFileData.backend && !options.backend) {
    options.backend = testFileData.backend;
  }
  if (testFileData.model && !options.model) {
    options.model = testFileData.model;
  }
  if (testFileData.timeout && !options.timeout) {
    options.timeout = testFileData.timeout;
  }
  
  return { 
    tests: testFileData.tests, 
    name: testFileData.name 
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    
    process.stdin.resume();
    
    process.stdin.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    
    process.stdin.on('end', () => {
      const result = Buffer.concat(chunks).toString('utf-8');
      resolve(result);
    });
    
    process.stdin.on('error', (err) => {
      reject(err);
    });
  });
}

async function runAllTests(tests: TestCase[], options: TestOptions, suiteName?: string) {
  console.log('RXCAFE Test Runner');
  if (suiteName) console.log(`Suite: ${suiteName}`);
  console.log(`Backend: ${options.backend || 'default'}`);
  if (options.model) console.log(`Model: ${options.model}`);
  console.log(`Tests: ${tests.length}`);
  console.log('');
  
  const runner = await TestRunner.create(options);
  const results: TestResult[] = [];
  
  for (const test of tests) {
    runner.clearHistory();
    const result = await runner.runTest(test);
    results.push(result);
    
    const status = result.passed ? '✓' : '✗';
    console.log(`  ${status} ${result.name} (${result.duration}ms)`);
    
    if (!result.passed && result.error) {
      console.log(`    Error: ${result.error}`);
    }
  }
  
  console.log('\n--- Results ---');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  
  console.log(`Passed: ${passed}/${results.length}`);
  console.log(`Failed: ${failed}/${results.length}`);
  
  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }
  
  process.exit(0);
}

const { options, testFile } = parseArgs();
loadTests(testFile, options).then(({ tests, name }) => runAllTests(tests, options, name));
