RXCAFE: A Reactive Architecture for Chunk-Based Evaluation Pipelines
====================================================================

Version 2.1

1. Overview
-----------

RXCAFE is an architectural pattern for building systems where data flows through reactive streams as discrete units called _chunks_, processed by composable functions called _evaluators_ and organized into high-level _pipelines_ by _agents_. It is designed to support LLM-assisted applications, background agents, media processing pipelines, and data analysis workflows using a unified set of primitives.

RXCAFE is built on four key insights:

1. **Reactive composition enables complex behavior from simple parts.** By expressing all routing, sequencing, and parallelism through standard reactive stream operators, systems remain comprehensible and debuggable.

2. **Annotations enable multi-stage processing without context bloat.** Metadata and derived information attach to chunks as they flow, allowing downstream evaluators to consume structured interpretations rather than reprocessing raw content.

3. **Agents as Pipeline Builders decouple orchestration from implementation.** Agents define the "What" (the data flow) by constructing reactive pipelines at initialization, while evaluators handle the "How" (the specific processing logic).

4. **Leveraging well-known primitives maximizes productivity.** By building on Reactive Extensions patterns already present in LLM training data, systems can be designed, debugged, and extended by both developers and AI coding assistants with minimal learning overhead.

RXCAFE does not prescribe a specific runtime. It defines concepts and constraints that map onto existing reactive stream systems (RxJS, Reactor, Rx.NET, etc.).

---

2. Core Primitives
------------------

### 2.1 Chunks

A _chunk_ is the fundamental unit of data in RXCAFE.

Each chunk has:

- **Content type**: one of
  - `text` - textual data
  - `binary` - opaque bytes with a MIME type (e.g., images, audio)
  - `null` - metadata marker with no content (used for state updates or signaling)

- **Producer identifier**: a fully qualified domain name (FQDN) indicating the origin (e.g., `com.example.sentiment-analyzer`)

- **Content**: depending on type (`string`, `Uint8Array`, or `null`)

- **Annotations**: key-value pairs where keys are FQDNs and values are JSON-compatible.

Chunks are **immutable**. Any conceptual modification produces a new chunk.

**Null Chunks for Metadata:**
Null chunks are the recommended carrier for session-level state changes (e.g., renaming a session via a `session.name` annotation). They persist in history but are ignored by standard chat renderers.

### 2.2 Annotations

Annotations attach metadata to chunks without modifying their content.

Properties:
- Keys are FQDNs.
- Values are JSON-compatible.
- Annotations enable **context reduction**. Instead of passing full raw content to every stage, one evaluator parses content and emits a structured annotation for downstream consumption.

### 2.3 Streams

RXCAFE systems typically define three primary stream types:

1. **Input Stream**: Receives external events (user messages, webhooks, timer ticks).
2. **Output Stream**: The authoritative, append-only feed of all processed chunks. This stream is typically used for history persistence and UI rendering.
3. **Error Stream**: A separate channel for exceptions and pipeline failures, ensuring UI stability.

---

3. Agents and Pipelines
-----------------------

### 3.1 The Agent Pattern

An _Agent_ is a high-level orchestrator responsible for initializing a session's reactive pipeline.

**Responsibilities:**
- Create specialized evaluators (e.g., deterministic for analysis, creative for chat).
- Subscribe to the `inputStream`.
- Construct a pipeline using reactive operators (filter, map, mergeMap).
- Pipe processed results to the `outputStream`.

### 3.2 Higher-Order Evaluators (Processors)

To maintain clean and readable agent code, specialized logic should be encapsulated into **higher-order evaluator functions**.

These functions:
1. Accept the `AgentSessionContext` (allowing them to create their own specialized evaluators internally).
2. Return a reactive operator (typically a function returning an `Observable<Chunk>`).

**The "One-Liner" Goal:**
Agents should read like a declarative list of operations:
```javascript
session.inputStream.pipe(
  filter(isUserMessage),
  mergeMap(analyzeSentiment(session)), // Encapsulated one-liner
  mergeMap(translateTo(session, 'es')), // Reusable module
  mergeMap(generateResponse(session))   // Core assistant logic
).subscribe(chunk => session.outputStream.next(chunk));
```

---

4. Multi-modal and Metadata Patterns
------------------------------------

### 4.1 Binary Content Handling

Binary chunks enable multi-modal interactions (Image Generation, TTS, STT).
- **MIME Types**: Must be specified in the chunk's content metadata.
- **Rendering**: UIs should detect MIME types (e.g., `image/*`, `audio/*`) and provide appropriate playback components.
- **Persistence**: Binary data should be Base64-encoded for JSON-based database storage and restored to `Uint8Array` upon loading.

### 4.2 State Management via History Scanning

Persistent state (like the "Name" of a session) should be derived from the `outputStream` history rather than separate database columns where possible.

**Pattern:** To find the current session name, scan the history chunks in reverse order and pick the value from the most recent chunk containing the `session.name` annotation. This ensures the history remains the single source of truth for the session state.

---

5. Implementation Guidance
---------------------------

### 5.1 Ergonomic Evaluator Creation

Systems should provide a `createEvaluator` utility that allows for easy overrides:
```javascript
// Inherit session defaults but force deterministic output
const analyzer = session.createEvaluator({ temperature: 0, maxTokens: 100 });
```

### 5.2 Error Boundaries

Each stage in a pipeline should be wrapped in an error handler that emits to the `errorStream` without terminating the primary session pipeline.

---

6. Design Principles Summary
-----------------------------

1. **Chunks are immutable** - never modify, always create new.
2. **Evaluators are modular** - encapsulate specialized LLM settings (prompts, temperature) inside evaluator utilities.
3. **Pipelines are declarative** - Agents should define the flow, not the implementation.
4. **History is the source of truth** - Derive state (including metadata) from the append-only chunk sequence.
5. **Multi-modal by design** - Binary, text, and null chunks are handled by the same reactive primitives.

---

Document Version: 2.1  
Last Updated: 2025-05-20
