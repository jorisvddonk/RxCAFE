# RXCAFE Chat

A reactive chat application built with the RXCAFE architecture pattern, using Bun.js. Supports both KoboldCPP and Ollama LLM backends.

## Features

- **RXCAFE Architecture**: Chunks, annotations, and evaluators following the RXCAFE spec
- **Multiple LLM Backends**: KoboldCPP and Ollama support
- **Streaming LLM responses**: Real-time token streaming
- **Session management**: Multiple concurrent chat sessions with backend selection
- **Simple REST API**: JSON endpoints + Server-Sent Events for streaming
- **Web frontend**: Clean, responsive chat interface with backend selector

## Architecture

This app implements the RXCAFE pattern:

- **Chunks** (`lib/chunk.ts`): Immutable data units with content, producer ID, and annotations
- **Streams** (`lib/stream.ts`): Reactive streams that process chunks through evaluators
- **Evaluators** (`lib/kobold-api.ts`, `lib/ollama-api.ts`): LLM evaluators that transform user input into assistant responses

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
   export OLLAMA_MODEL=llama2  # or any model you have pulled
   ```

3. **Run the server**:
   ```bash
   bun run main.ts
   # or
   bun start
   ```

4. **Open the app**:
   Navigate to `http://localhost:3000`

   When creating a session, you can choose between KoboldCPP and Ollama backends in the UI.

## API Endpoints

- `POST /api/session` - Create a new chat session (accepts `backend` and `model` in body)
- `GET /api/models` - List available models (Ollama only)
- `GET /api/session/:id/history` - Get session chat history
- `POST /api/chat/:sessionId` - Send a message (returns SSE stream)
- `POST /api/chat/:sessionId/abort` - Abort ongoing generation
- `GET /api/health` - Health check

## Project Structure

```
.
├── main.ts                 # Main HTTP server
├── lib/
│   ├── chunk.ts           # RXCAFE chunk primitives
│   ├── stream.ts          # Reactive stream utilities
│   ├── kobold-api.ts      # KoboldCPP API client & evaluator
│   └── ollama-api.ts      # Ollama API client & evaluator
├── frontend/
│   ├── index.html         # Chat UI
│   ├── app.js             # Frontend logic
│   └── styles.css         # Styles
└── package.json
```

## Environment Variables

- `LLM_BACKEND` - Default LLM backend: `kobold` or `ollama` (default: `kobold`)
- `KOBOLD_URL` - KoboldCPP server URL (default: `http://localhost:5001`)
- `OLLAMA_URL` - Ollama server URL (default: `http://localhost:11434`)
- `OLLAMA_MODEL` - Default Ollama model (default: `llama2`)
- `PORT` - HTTP server port (default: `3000`)

## Using Ollama

1. Install Ollama: https://ollama.com
2. Pull a model: `ollama pull llama2` (or any model you prefer)
3. Start Ollama: `ollama serve`
4. Run this app with `LLM_BACKEND=ollama`

## Using KoboldCPP

1. Download KoboldCPP: https://github.com/LostRuins/koboldcpp
2. Start KoboldCPP with your GGUF model
3. Run this app (KoboldCPP is the default)

## License

MIT
