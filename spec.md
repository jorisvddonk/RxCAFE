ObservableCAFE: A Reactive Architecture for Chunk-Based Evaluation Pipelines
===================================================================

Version 2.2

1. Overview
-----------

ObservableCAFE is an architectural pattern for building systems where data flows through reactive streams as discrete units called _chunks_, processed by composable functions called _evaluators_ and organized into high-level _pipelines_ by _agents_. It is designed to support LLM-assisted applications, background agents, media processing pipelines, and data analysis workflows using a unified set of primitives.

ObservableCAFE is built on four key insights:

1. **Reactive composition enables complex behavior from simple parts.** By expressing all routing, sequencing, and parallelism through standard reactive stream operators, systems remain comprehensible and debuggable.

2. **Annotations enable multi-stage processing without context bloat.** Metadata and derived information attach to chunks as they flow, allowing downstream evaluators to consume structured interpretations rather than reprocessing raw content.

3. **Agents as Pipeline Builders decouple orchestration from implementation.** Agents define the "What" (the data flow) by constructing reactive pipelines at initialization, while evaluators handle the "How" (the specific processing logic).

4. **Leveraging well-known primitives maximizes productivity.** By building on Reactive Extensions patterns already present in LLM training data, systems can be designed, debugged, and extended by both developers and AI coding assistants with minimal learning overhead.

ObservableCAFE does not prescribe a specific runtime. It defines concepts and constraints that map onto existing reactive stream systems (RxJS, Reactor, Rx.NET, etc.).

---

2. Core Concepts
----------------

### 2.1 What is a Chunk?

A **chunk** is the fundamental unit of data in ObservableCAFE. It's an immutable container that carries:

- **Content** - The actual data (text string, binary bytes, or nothing for metadata)
- **Content type** - One of `text`, `binary`, or `null`
- **Producer** - A fully qualified domain name identifying the source (e.g., `com.example.sentiment-analyzer`)
- **Annotations** - Key-value metadata attached to the chunk

Think of a chunk like a letter: it has content (the message), a type (what kind of letter), a return address (producer), and notes written on it (annotations).

**Conceptually immutable:** Chunks should be treated as immutable - evaluators don't modify chunks, they produce *new* chunks with additional annotations. In RxJS terms, `mergeMap` transforms the upstream chunk into downstream chunks, effectively replacing it. This pattern ensures each processing stage works with its own copy.

**Null chunks** are special - they carry no content but are crucial for signaling. Use them for configuration changes, state updates, or flow control signals.

### 2.2 What is an Evaluator?

An **evaluator** is a function that processes chunks and produces new chunks. It's the "worker" that transforms data as it flows through the pipeline.

Evaluators come in two flavors:

1. **LLM Evaluators** - Wrap interaction with language models, handling prompt construction, streaming token handling, and response parsing
2. **Transform Evaluators** - Pure processing functions that modify or annotate chunks (e.g., sentiment analysis, translation, format conversion)

Evaluators are typically implemented as async generators, yielding chunks as they're produced (important for streaming responses from LLMs).

### 2.3 What is an Agent?

An **agent** is a pipeline builder. It's not responsible for doing the actual work - instead, it orchestrates *what* happens to data by composing evaluators into a reactive pipeline.

When a session starts, the agent's `initialize` method receives a session context with streams and configuration. The agent then:
1. Subscribes to the input stream
2. Pipes chunks through a chain of operators and evaluators
3. Sends results to the output stream

This separation is powerful: you can create entirely different behaviors just by wiring up different evaluators, without changing the agent's structure.

### 2.4 What is a Pipeline?

A **pipeline** is the reactive flow connecting input to output through operators and evaluators. Built using standard reactive stream operators:

- `filter` - Pass only chunks matching a condition
- `map` - Transform each chunk into another chunk
- `mergeMap` - Transform each chunk into a stream of chunks (for async operations)
- `catchError` - Handle errors without terminating the pipeline

The pipeline is where declarativity shines: you describe *what* should happen (filter user messages, analyze sentiment, generate response) rather than *how* to implement each step.

### 2.5 Streams

ObservableCAFE defines three streams:

1. **Input Stream** - The entry point for external events (user messages, webhooks, timer ticks, file uploads)
2. **Output Stream** - The authoritative feed of processed chunks, used for history persistence and UI rendering
3. **Error Stream** - A separate channel for exceptions, ensuring errors don't corrupt the main data flow

---

3. Agents Deep Dive
-------------------

### 3.1 Agent Lifecycle

1. **Definition** - Agent is registered with a unique name and configuration schema
2. **Initialization** - When a session starts, `initialize(session)` is called to build the pipeline
3. **Operation** - Pipeline processes chunks until session ends
4. **Destruction** - Optional `destroy(session)` cleanup (e.g., clearing intervals, closing connections)

### 3.2 Agent Properties

- **name** - Unique identifier (used as session ID for background agents)
- **description** - Human-readable explanation of what the agent does
- **startInBackground** - If true, agent auto-starts when server boots
- **allowsReload** - Whether the agent can be hot-reloaded (default true; set false for stateful agents)
- **persistsState** - Whether session history is saved to database (default true)
- **configSchema** - JSON Schema defining what configuration the agent accepts
- **initialize(session)** - Build the reactive pipeline
- **destroy(session)** - Optional cleanup function

### 3.3 Session Context

When `initialize` runs, the agent receives a session context containing:

- **Streams**: `inputStream`, `outputStream`, `errorStream` for data flow
- **history**: Array of all chunks processed so far
- **config**: Server/agent configuration (backend, model, etc.)
- **sessionConfig**: Runtime configuration passed when session was created
- **systemPrompt**: The LLM system prompt
- **createLLMChunkEvaluator(params?)**: Factory for creating LLM evaluators
- **schedule(cronExpr, callback)**: For background agents to schedule tasks
- **persistState() / loadState()**: For agents that manage persistent data

### 3.4 Configuration

Agents declare what configuration they need using JSON Schema (draft-07). This enables:
- Runtime validation when sessions are created
- Auto-generated UI forms
- Documentation of available options

Runtime configuration (backend, model, LLM parameters, system prompt) is stored as null chunks with `config.type: 'runtime'` annotation. This allows configuration to be:
1. Persisted with the session
2. Changed dynamically during a session
3. Tracked in history

### 3.5 Agent Examples

**Simple chat agent:**
```typescript
initialize(session) {
  session.inputStream.pipe(
    filter(c => c.contentType === 'text'),
    map(c => c.annotations['chat.role'] ? c : annotateChunk(c, 'chat.role', 'user')),
    filter(c => !c.annotations['security.trust-level']?.trusted === false),
    mergeMap(c => c.annotations['chat.role'] === 'user' 
      ? completeTurnWithLLM(c, session.createLLMChunkEvaluator(), session) 
      : [c]),
    catchError(e => { session.errorStream.next(e); return EMPTY; })
  ).subscribe(c => session.outputStream.next(c));
}
```

**Background agent (periodic tasks):**
```typescript
startInBackground: true,
persistsState: false,
initialize(session) {
  const id = setInterval(() => {
    session.outputStream.next(createTextChunk(new Date().toLocaleTimeString(), 'time-ticker', { 'chat.role': 'assistant' }));
  }, 2000);
  session.pipelineSubscription = { unsubscribe: () => clearInterval(id) };
}
```

---

4. Multi-modal and Metadata Patterns
------------------------------------

### 4.1 Binary Content

Binary chunks carry opaque data with a MIME type. This enables:
- Image generation and display
- Audio transcription and synthesis
- File uploads and downloads

The same pipeline operators work with binary chunks - just filter by `contentType === 'binary'` and check the MIME type.

### 4.2 Annotations as Context Reduction

Instead of reprocessing raw content at every stage, use annotations to communicate results:

```
User message → Sentiment evaluator → chunk with 'sentiment: positive' annotation
                                        ↓
                               Translation evaluator (reads annotation, not text)
                                        ↓
                               LLM (sees translated text + sentiment context)
```

This pattern dramatically reduces redundant computation.

### 4.3 State from History

The append-only history is the single source of truth. To find current state:
- Scan history in reverse
- Pick the most recent chunk with the relevant annotation

For example, session name: find the newest chunk with `session.name` annotation.

---

5. Design Principles
--------------------

1. **Chunks are immutable** - never modify, always create new chunks
2. **Evaluators are modular** - encapsulate specific processing logic
3. **Pipelines are declarative** - describe what, not how
4. **History is the source of truth** - derive state from the chunk sequence
5. **Multi-modal by design** - text, binary, and null chunks use the same primitives

---

Document Version: 2.2  
Last Updated: 2026-03-02
