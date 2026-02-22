# config.llm

LLM parameter configuration annotations.

## config.llm.temperature

| Property | Value |
|----------|-------|
| Type | `number` |
| Range | `0` - `2` |

Controls randomness in generation. Higher values produce more diverse outputs.

## config.llm.maxTokens

| Property | Value |
|----------|-------|
| Type | `number` |

Maximum number of tokens to generate.

## config.llm.topP

| Property | Value |
|----------|-------|
| Type | `number` |
| Range | `0` - `1` |

Nucleus sampling threshold. Controls diversity via cumulative probability cutoff.

## config.llm.topK

| Property | Value |
|----------|-------|
| Type | `number` |

Limits vocabulary to top K tokens.

## config.llm.repeatPenalty

| Property | Value |
|----------|-------|
| Type | `number` |

Penalty for repeating tokens. Higher values reduce repetition.

## config.llm.stop

| Property | Value |
|----------|-------|
| Type | `string[]` |

Stop sequences that halt generation.

## config.llm.seed

| Property | Value |
|----------|-------|
| Type | `number` |

Random seed for deterministic generation.

## config.llm.maxContextLength

| Property | Value |
|----------|-------|
| Type | `number` |

Maximum context length (KoboldCPP).

## config.llm.numCtx

| Property | Value |
|----------|-------|
| Type | `number` |

Context window size (Ollama).
