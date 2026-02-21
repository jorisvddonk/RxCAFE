# RXCAFE Chat

A reactive chat application built with the RXCAFE architecture pattern, using Bun.js. Supports both KoboldCPP and Ollama LLM backends with advanced session management, modular agents, and multi-modal support.

## Features

- **RXCAFE Architecture**: Chunks, annotations, and evaluators following the RXCAFE spec.
- **Multiple LLM Backends**: Support for KoboldCPP and Ollama.
- **Advanced Session Management**: 
  - Permanent, collapsible sessions sidebar on desktop.
  - Full-screen mobile sidebar with safe-area optimizations.
  - URL hash synchronization for easy bookmarking and navigation.
  - Rename and delete sessions directly from the UI.
  - Automatic session naming based on conversation context via `session.name` annotations.
- **Modular Agent System**: 
  - **Interactive Agents**: Created on-demand via the UI.
  - **Background Agents**: Persistent agents that start on server boot and can run scheduled tasks (e.g., `time-ticker`, `news-reporter`).
  - **Declarative Pipelines**: Clean agent definitions using RxJS operators and higher-order evaluators.
  - **Custom Agent Paths**: Load agents from external directories via environment variables.
- **Multi-modal Support**: Handle text and **binary chunks** seamlessly.
  - **Image Painter**: Generates and renders random pixel art.
  - **Audio Generator**: Generates and plays back audio tones.
- **Telegram Bot**: Fully integrated with session switching and trust management.
- **Streaming Responses**: Real-time token streaming for both web and Telegram.
- **Security & Trust**: Untrusted web content is filtered from LLM context until explicitly trusted by the user.
- **PWA Ready**: Installable as a Progressive Web App on mobile and desktop.

## Architecture

This app implements the RXCAFE pattern:

- **Chunks** (`lib/chunk.ts`): Immutable data units (text, binary, or null) with producer IDs and annotations.
- **Streams** (`lib/stream.ts`): RxJS-based reactive streams that process chunks through agent-defined pipelines.
- **Agents** (`agents/`): Pipeline builders that subscribe to `inputStream` and emit to `outputStream`.
- **Evaluators** (`evaluators/`, `lib/evaluator-utils.ts`): Encapsulated logic for specific tasks like sentiment analysis or standard chat completion.
- **Persistence**: All sessions, configurations, and histories are saved to an SQLite database.
- **Security**: Trust-based filtering prevents untrusted content from reaching evaluators.

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
   # Run trust command to authorize your user
   bun start -- --trust-telegram <your_username_or_id>
   ```

4. **Run the server**:
   ```bash
   bun start
   ```

5. **Open the app**:
   Navigate to `http://localhost:3000`

## Agents and External Paths

Agents are discovered automatically in the `agents/` directory. You can also load agents from external directories by setting the `RXCAFE_AGENT_SEARCH_PATHS` variable:

```bash
export RXCAFE_AGENT_SEARCH_PATHS="/path/to/my/agents:/opt/custom-agents"
bun start
```

## API Endpoints

### Sessions
- `GET /api/sessions` - List all active and persisted sessions.
- `POST /api/session` - Create a new session.
- `GET /api/session/:id/history` - Get full session history (including metadata).
- `DELETE /api/session/:id` - Shut down and delete a session and its data.

### Messaging
- `POST /api/chat/:sessionId` - Send a message (returns token stream).
- `GET /api/session/:sessionId/stream` - Persistent SSE stream for all session activity.
- `POST /api/session/:id/chunk` - Add a generic chunk (text, binary, or null).
- `POST /api/session/:id/web` - Fetch web content as untrusted chunk.

### Security
- `POST /api/session/:id/chunk/:chunkId/trust` - Toggle trust status for a chunk.

## Environment Variables

- `LLM_BACKEND` - Default LLM backend: `kobold` or `ollama`.
- `KOBOLD_URL` - KoboldCPP server URL.
- `OLLAMA_URL` - Ollama server URL.
- `RXCAFE_AGENT_SEARCH_PATHS` - Colon-separated list of directories to scan for agents.
- `PORT` - HTTP server port (default: `3000`).
- `RXCAFE_TRACE` - Set to `1` to enable detailed logging of LLM context.
- `TELEGRAM_TOKEN` - Telegram bot token.
- `TRUST_DB_PATH` - Path to the SQLite trust and session database.

## Security Model

1. **Untrusted by Default**: Web content and external data are marked untrusted.
2. **Stream Filtering**: Agents or the core pipeline filter out untrusted chunks before they reach LLM evaluators.
3. **User in the Loop**: Users must explicitly click "Trust" on chunks to include them in the LLM's memory.
4. **Binary Safety**: Binary chunks (like images/audio) are rendered for users but excluded from text-only LLM context unless handled by a specific multi-modal evaluator.

## License

MIT
