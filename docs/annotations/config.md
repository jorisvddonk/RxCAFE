# config

Runtime configuration annotations for sessions.

## config.type

| Property | Value |
|----------|-------|
| Type | `string` |
| Values | `runtime` |

Identifies a null chunk as containing runtime configuration. Config chunks are persisted with sessions and can be changed dynamically.

## config.backend

| Property | Value |
|----------|-------|
| Type | `string` |

The LLM backend to use (e.g., `ollama`, `koboldcpp`).

## config.model

| Property | Value |
|----------|-------|
| Type | `string` |

The model name to use (e.g., `gemma3:1b`, `mistral`).

## config.systemPrompt

| Property | Value |
|----------|-------|
| Type | `string` |

The system prompt to use for the session.
