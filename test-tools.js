import { createTextChunk, annotateChunk } from './lib/chunk.js';
import { detectToolCalls } from './evaluators/tool-call-detector.js';
import { executeTools } from './evaluators/tool-executor.js';

async function testToolDetection() {
  console.log('=== Testing Tool Detection ===\n');
  
  // Test 1: Basic tool call
  const chunk1 = createTextChunk(
    'Please roll a die: <|tool_call|>{"name":"rollDice","parameters":{"expression":"1d6"}}<|tool_call_end|>',
    'com.rxcafe.test',
    { 'chat.role': 'assistant' }
  );
  
  console.log('Test 1 - Basic tool call:');
  await testPipeline(chunk1);
  console.log();
  
  // Test 2: Multiple tool calls
  const chunk2 = createTextChunk(
    'Roll 2d6 and 1d10: <|tool_call|>{"name":"rollDice","parameters":{"expression":"2d6"}}<|tool_call_end|> ' +
    '<|tool_call|>{"name":"rollDice","parameters":{"expression":"1d10"}}<|tool_call_end|>',
    'com.rxcafe.test',
    { 'chat.role': 'assistant' }
  );
  
  console.log('Test 2 - Multiple tool calls:');
  await testPipeline(chunk2);
  console.log();
  
  // Test 3: Tool call with modifier
  const chunk3 = createTextChunk(
    'Roll 1d8+2: <|tool_call|>{"name":"rollDice","parameters":{"expression":"1d8+2"}}<|tool_call_end|>',
    'com.rxcafe.test',
    { 'chat.role': 'assistant' }
  );
  
  console.log('Test 3 - Tool call with modifier:');
  await testPipeline(chunk3);
  console.log();
  
  // Test 4: No tool calls
  const chunk4 = createTextChunk(
    'Hello, how are you?',
    'com.rxcafe.test',
    { 'chat.role': 'assistant' }
  );
  
  console.log('Test 4 - No tool calls:');
  await testPipeline(chunk4);
}

async function testPipeline(chunk) {
  let results = [];
  
  // First, test detection
  let detectedChunk = null;
  await new Promise((resolve) => {
    const sub = detectToolCalls()(chunk).subscribe({
      next: (c) => {
        detectedChunk = c;
        console.log('  Detection complete');
        if (c.annotations?.['com.rxcafe.tool-detection']) {
          console.log(`  Tool calls found: ${c.annotations['com.rxcafe.tool-detection'].toolCalls.length}`);
          if (c.annotations['com.rxcafe.tool-detection'].toolCalls.length > 0) {
            c.annotations['com.rxcafe.tool-detection'].toolCalls.forEach((call, i) => {
              console.log(`  Tool ${i + 1}: ${call.name} - ${JSON.stringify(call.parameters)}`);
            });
          }
        }
        resolve();
      }
    });
  });
  
  if (!detectedChunk) {
    console.log('  Detection failed');
    return;
  }
  
  // Then, test execution
  const executePromise = new Promise((resolve) => {
    executeTools()(detectedChunk).subscribe({
      next: (result) => {
        results.push(result);
      },
      complete: () => {
        console.log(`  Results received: ${results.length}`);
        results.forEach((r, i) => {
          console.log(`\n  Chunk ${i + 1}:`);
          if (r) {
            console.log(`    Producer: ${r.producer}`);
            if (r.annotations) {
              console.log(`    Role: ${r.annotations['chat.role'] || 'N/A'}`);
              if (r.annotations['tool.name']) {
                console.log(`    Tool: ${r.annotations['tool.name']}`);
              }
            }
            if (r.contentType === 'text') {
              console.log(`    Content: ${r.content}`);
            }
          } else {
            console.log('    Null result');
          }
        });
        resolve();
      }
    });
  });
  
  await executePromise;
}

testToolDetection().catch(console.error);
