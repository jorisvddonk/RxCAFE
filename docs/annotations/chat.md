# chat

Chat-related annotations for message roles and metadata.

## chat.role

| Property | Value |
|----------|-------|
| Type | `string` |
| Values | `user`, `system`, `assistant` |
| Required | No |

Identifies the role of a text chunk in a conversation. Used by agents to distinguish between user messages, system prompts, and assistant responses.

**Example:**
```typescript
{ 'chat.role': 'user' }
{ 'chat.role': 'system' }
{ 'chat.role': 'assistant' }
```

**Usage:** All chat agents filter and process chunks based on this annotation to determine conversation flow.
