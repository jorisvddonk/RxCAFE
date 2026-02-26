# Tools

Tools allow LLMs to perform actions and return results during a conversation. The tool system uses a detection-execution pipeline pattern.

## Overview

Tools are implemented in two parts:

1. **Tool Call Detector** - Parses LLM output for tool call patterns
2. **Tool Executor** - Executes detected tool calls and returns results

## Tool Call Format

LLMs trigger tool calls using a special XML-like format:

```
<|tool_call|>{"name":"toolName","parameters":{...}}<|tool_call_end|>
```

### Format Specification

| Component | Description |
|-----------|-------------|
| `<|tool_call|>` | Opening delimiter |
| `{"name":"...", "parameters":{...}}` | JSON object with tool name and parameters |
| `<|tool_call_end|>` | Closing delimiter |

## Available Tools

### rollDice

Rolls virtual dice using standard dice notation.

**Parameters:**
- `expression` (string): Die roll expression

**Expression Format:**
```
[count]d[sides][+|-modifier]
```

**Examples:**

| Expression | Description |
|------------|-------------|
| `1d6` | Roll 1 six-sided die |
| `2d10+3` | Roll 2 ten-sided dice, add 3 |
| `3d8-2` | Roll 3 eight-sided dice, subtract 2 |
| `4d6` | Roll 4 six-sided dice |

**Usage:**
```
<|tool_call|>{"name":"rollDice","parameters":{"expression":"2d6+1"}}<|tool_call_end|>
```

**Result:**
```
2d6+1: 4 + 6 + 1 = 11
```

## Adding New Tools

1. Create a new file in `tools/` implementing a tool class
2. Register the tool in `evaluators/tool-executor.ts`
3. Add the tool's system prompt to `TOOLS_SYSTEM_PROMPT` in `tool-executor.ts`

### Tool Class Template

```typescript
export class MyTool {
  readonly name = 'myTool';

  execute(parameters: MyParams): MyResult {
    // Tool implementation
    return { ... };
  }
}

export const MY_TOOL_SYSTEM_PROMPT = `
Tool: myTool
Description: What the tool does
Parameters:
- param1: Description
`;
```

## Evaluators

### detectToolCalls()

Evaluates text chunks and detects tool call patterns. Adds `com.rxcafe.tool-detection` annotation with detected calls.

### executeTools()

Executes detected tool calls and emits result chunks. Looks up tools by name and calls their `execute()` method.

## Annotations

See [Annotations: tool](./annotations/tool.md) for detailed annotation reference.
