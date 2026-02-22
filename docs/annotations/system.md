# system

System-level annotations for prompts and responses.

## system.prompt

| Property | Value |
|----------|-------|
| Type | `boolean` |

Marks a text chunk as a system prompt. System prompts are used to configure LLM behavior.

**Example:**
```typescript
{
  contentType: 'text',
  content: 'You are a helpful assistant.',
  annotations: {
    'chat.role': 'system',
    'system.prompt': true
  }
}
```

## system.response

| Property | Value |
|----------|-------|
| Type | `boolean` |

Marks a chunk as a system agent response (non-LLM).

## system.error

| Property | Value |
|----------|-------|
| Type | `boolean` |

Marks a chunk as containing error information from the system agent.
