# ObservableCAFE Chat

A reactive chat application built with the ObservableCAFE architecture pattern, using Bun.js. Supports both KoboldCPP and Ollama LLM backends with advanced session management, background agents, and multi-modal support.

## Philosophy

ObservableCAFE takes a minimalist approach to LLM-powered agents. The core premise is that LLMs should do as little as possible within the agentic loop—instead of iteratively reasoning and acting, they should provide their entire plan (as code) upfront.

This approach has several advantages:

- **Avoids semantic collapse**: Agents stay on track by following explicit code rather than drifting through repeated LLM reasoning.
- **Smaller context sizes**: A single script is far smaller than a multi-turn reasoning trace.
- **Resistant to prompt injection**: Poisoning attacks like "ignore previous instructions" have no effect because the LLM isn't executing commands at runtime—it's generating a script that runs independently.
- **Enables flow reuse**: Generated scripts can be reviewed, tweaked, reused, and composed.
- **Better performance**: Most tasks are more reliably solved by code than by hoping the LLM reasons correctly through multiple steps.

For example, "delete all spam in my inbox" would have an LLM generate a script that fetches emails, runs a classifier against each one, presents the candidates for confirmation, and deletes on approval. Only two LLM calls are needed: one to generate the script, one to classify emails. The rest is deterministic code.

This contrasts with frameworks like OpenClaw that allow free-form agentic loops but have bloated initial context and variable success rates. ObservableCAFE enforces these constraints by design.

ObservableCAFE is particularly useful for highly repetitive workflows. Daily spaced repetition learning, for instance, is completely scripted—the LLM only provides summaries and recommendations at the end. This makes the system reliable enough to run unattended.

ObservableCAFE uses **ReactiveX (RxJS)** for its pipeline architecture—and there's a good reason. LLMs are already fluent in RxJS. They understand operators like `map`, `filter`, `mergeMap`, `catchError`, and they generate clean, declarative code that reads almost like English.

This makes agents remarkably concise and readable. A typical agent is just a dozen lines of RxJS operators describing the data flow:

```typescript
session.inputStream.pipe(
  filter(c => c.annotations['chat.role'] === 'user'),
  mergeMap(chunk => processWithEvaluator(chunk, session.createEvaluator())),
  catchError(err => { session.errorStream.next(err); return EMPTY; })
).subscribe({ next: c => session.outputStream.next(c) });
```

Agents are declarative by nature—they say *what* should happen to data, not *how* each step is implemented. This aligns perfectly with the philosophy of generating scripts upfront rather than reasoning at runtime.

**Traditional agents still supported**: If you prefer the classic iterative reasoning-and-acting pattern, you can still build agents that call the LLM in loops. ObservableCAFE doesn't force any particular approach—it's just optimized for the script-generating style.

## Features

- **ObservableCAFE Architecture**: Chunks, annotations, and evaluators following the ObservableCAFE spec.
- **Multiple LLM Backends**: Support for KoboldCPP and Ollama.
- **Advanced Session Management**: 
  - Permanent, collapsible sessions sidebar on desktop.
  - Full-screen mobile sidebar with safe-area optimizations.
  - **URL Hash Synchronization**: Active session is reflected in the URL for easy bookmarking and navigation.
  - Rename and delete sessions directly from the UI.
  - **Cross-Platform Synchronization**: Seamlessly switch between Web and Telegram.
- **Modular Agent System**:
  - **Interactive Agents**: Created on-demand via the UI.
  - **Background Agents**: Persistent agents that start on server boot and can run scheduled tasks.
    - `rss-summarizer`: Fetches and summarizes RSS feeds (e.g., Hacker News) daily at 07:00.
    - `time-ticker`: Periodically outputs the current time.
  - **Agent Factory**: An interactive agent that generates new agents from natural language descriptions using LLM code generation and automatic TypeScript validation.
  - **Declarative Pipelines**: Clean agent definitions using RxJS operators and higher-order evaluators.
  - **Custom Agent Paths**: Load agents from external directories via environment variables.
   - **Tool System**: Agents can call tools using `<|tool_call|>` syntax
     - **Die Roller**: `rollDice` tool for rolling virtual dice (1d6, 2d10+3, etc.)
     - **Tool Detection**: Auto-detects and executes tool calls in LLM responses
- **Multi-modal Support**: Handle text and **binary chunks** seamlessly.
  - **Image Painter**: Generates and renders random pixel art images.
  - **Audio Generator**: Generates and plays back audio tones.
  - **Telegram Media**: Images and audio are delivered directly as photos and voice messages.
- **Telegram Bot**: 
  - **Inline Keyboards**: Interactive session switcher via `/sessions`.
  - **Auto-Subscriptions**: Receive automatic updates from specific sessions using `/subscribe <id>`. Subscriptions are persisted in SQLite.
  - **Sharing**: Use `/id` to get session IDs, `/join <id>` to continue web chats on mobile, and `/share` for web links.
  - **Automatic Cleanup**: Temporary "Thinking..." status messages are automatically deleted.
- **Security & Trust**: Untrusted web content is filtered from LLM context until explicitly trusted.
- **PWA Ready**: Installable as a Progressive Web App on mobile and desktop.

## Architecture

This app implements the ObservableCAFE pattern:

- **Chunks** (`lib/chunk.ts`): Immutable data units (text, binary, or null) with producer IDs and annotations.
- **Streams** (`lib/stream.ts`): RxJS-based reactive streams that process chunks through agent-defined pipelines.
- **Agents** (`agents/`): Pipeline builders that subscribe to `inputStream` and emit to `outputStream`.
- **Evaluators** (`evaluators/`, `lib/evaluator-utils.ts`): Encapsulated logic for specific tasks like sentiment analysis, RSS parsing, or chat completion.
- **Persistence**: All sessions, configurations, and histories are saved to an SQLite database.

## Setup

1. **Install dependencies**:
   ```bash
   bun install
   ```

2. **Configure your LLM backend**:

   **Option A: KoboldCPP**
   ```bash
   export LLM_BACKEND=kobold
   export KOBOLD_URL=http://localhost:5001
   ```

   **Option B: Ollama**
   ```bash
   export LLM_BACKEND=ollama
   export OLLAMA_URL=http://localhost:11434
   export OLLAMA_MODEL=gemma3:1b  # or any model you have pulled
   ```

3. **(Optional) Configure Telegram Bot**:
   ```bash
   export TELEGRAM_TOKEN=your_bot_token_here
   # Authorize your user
   bun start -- --trust-telegram <your_username_or_id>
   ```

4. **Run the server**:
   ```bash
   bun start
   ```

5. **Open the app**:
   Navigate to `http://localhost:3000`

## Cross-Platform Sharing

You can seamlessly move conversations between the Web UI and Telegram:

1.  **Web to Telegram**: Click the **🆔** icon in the Web header to copy the Session ID. In Telegram, type `/join [pasted-id]`.
2.  **Telegram to Web**: Type `/share` in Telegram to get a direct browser link to your current session.
3.  **Default Session**: New Telegram users start in the `default-telegram` session by default.

### Telegram Auto-Subscriptions

You can turn your Telegram bot into a real-time notification feed for specific sessions:

- `/subscribe <session_id>`: Automatically receive all new messages and media from that session.
- `/unsubscribe <session_id>`: Stop receiving automatic updates.
- `/subscriptions`: List your active auto-subscriptions.

Subscriptions are stored in the database and automatically restored when the server restarts. You can subscribe to multiple sessions simultaneously (e.g., your main chat and a background agent like `rss-summarizer`).

## Agents and External Paths

Agents are discovered automatically in the `agents/` directory. You can also load agents from external directories by setting the `ObservableCAFE_AGENT_SEARCH_PATHS` variable:

```bash
export ObservableCAFE_AGENT_SEARCH_PATHS="/path/to/my/agents:/opt/custom-agents"
bun start
```

## API Endpoints

### Sessions
- `GET /api/sessions` - List all active and persisted sessions.
- `POST /api/session` - Create a new session.
- `GET /api/session/:id/history` - Get full session history.
- `DELETE /api/session/:id` - Shut down and delete a session.

### Messaging
- `POST /api/chat/:sessionId` - Send a message (returns token stream).
- `GET /api/session/:sessionId/stream` - Persistent SSE stream for all session activity.
- `POST /api/session/:id/chunk` - Add a generic chunk (text, binary, or null).
- `POST /api/session/:id/web` - Fetch web content as untrusted chunk.

## Environment Variables

- `LLM_BACKEND`: Default LLM backend: `kobold` or `ollama`.
- `KOBOLD_URL` - KoboldCPP server URL.
- `OLLAMA_URL` - Ollama server URL.
- `ObservableCAFE_AGENT_SEARCH_PATHS`: Colon-separated list of directories to scan for agents.
- `PORT`: HTTP server port (default: `3000`).
- `ObservableCAFE_TRACE`: Set to `1` to enable detailed logging of LLM context.
- `TELEGRAM_TOKEN`: Telegram bot token.
- `TRUST_DB_PATH`: Path to the SQLite trust and session database.

## Security Model

1. **Untrusted by Default**: Web content and external data are marked untrusted.
2. **Stream Filtering**: Agents filter out untrusted chunks before they reach LLM evaluators.
3. **User in the Loop**: Users must explicitly click "Trust" on chunks to include them in the LLM's memory.
4. **Binary Safety**: Binary chunks (like images/audio) are rendered for users but excluded from text-only context unless handled by a multi-modal evaluator.

## License

MIT
