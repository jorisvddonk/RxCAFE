# llm

LLM-specific annotations for generation control.

## llm.stream

| Property | Value |
|----------|-------|
| Type | `boolean` |

Indicates that the chunk is part of a streaming LLM response. Chunks with this annotation are excluded from certain processing (e.g., Telegram relay).

## llm.full-prompt

| Property | Value |
|----------|-------|
| Type | `boolean` |

When set to `true`, indicates that the full conversation history should be sent as context, rather than just recent messages.

## llm.backend

| Property | Value |
|----------|-------|
| Type | `string` |

Records which LLM backend was used to generate a response (e.g., `ollama`, `koboldcpp`).
