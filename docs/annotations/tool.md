# tool

Tool execution annotations for tool call detection and execution.

## com.rxcafe.tool-detection

| Property | Value |
|----------|-------|
| Type | `object` |

Added by the tool call detector evaluator. Contains detected tool calls from LLM responses.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `toolCalls` | `array` | Array of detected tool calls |
| `hasToolCalls` | `boolean` | Whether any tool calls were detected |

### Tool Call Object

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Name of the tool to execute |
| `parameters` | `object` | Parameters to pass to the tool |
| `start` | `number` | Start position in the source text |
| `end` | `number` | End position in the source text |

## com.rxcafe.tool.{toolName}

| Property | Value |
|----------|-------|
| Type | `text` |

Tool execution result chunks. The suffix `{toolName}` is replaced with the actual tool name (e.g., `com.rxcafe.tool.rollDice`).

### Annotations

| Annotation | Description |
|------------|-------------|
| `chat.role` | Always set to `assistant` |
| `tool.name` | Name of the tool that was executed |
| `tool.results` | The result returned by the tool |

## Tool Call Format

LLMs must use a specific XML-like format to trigger tool calls:

```
<|tool_call|>{"name":"rollDice","parameters":{"expression":"2d6+1"}}<|tool_call_end|>
```

The format consists of:
- `<|tool_call|>` - Opening tag
- JSON object with `name` and `parameters` fields
- `<|tool_call_end|>` - Closing tag

## Built-in Tools

### rollDice

Rolls virtual dice using standard dice notation.

**Parameters:**
- `expression`: Die roll expression (e.g., "1d6", "2d10+3", "3d8-2")
  - Format: `[number of dice]d[die type][modifier]`

**Examples:**
- `"1d6"` - Roll 1 six-sided die
- `"2d10+3"` - Roll 2 ten-sided dice and add 3
- `"3d8-2"` - Roll 3 eight-sided dice and subtract 2

**Result:**
```
2d6+1: 4 + 6 + 1 = 11
```
