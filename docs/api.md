# API Reference

This document describes the ObservableCAFE REST API.

## Base URL

```
http://localhost:3000/api
```

## Authentication

All endpoints (except public endpoints) require a Bearer token:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" ...
```

Or use query parameter:

```
curl "?token=YOUR_TOKEN"
```

## Endpoints

### Sessions

#### Create Session

```
POST /api/session
```

Create a new chat session with a specific agent.

**Request:**
```json
{
  "agentId": "default",
  "backend": "ollama",
  "model": "gemma3:1b",
  "systemPrompt": "You are a helpful assistant",
  "llmParams": {
    "temperature": 0.7,
    "maxTokens": 500
  }
}
```

**Response:**
```json
{
  "id": "session-abc123",
  "agentId": "default",
  "backend": "ollama",
  "model": "gemma3:1b"
}
```

---

#### List Sessions

```
GET /api/sessions
```

List all active sessions.

**Response:**
```json
{
  "sessions": [
    {
      "id": "session-abc123",
      "agentId": "default",
      "name": "Chat",
      "isBackground": false,
      "createdAt": 1234567890
    }
  ]
}
```

---

#### Get Session History

```
GET /api/session/:id/history
GET /api/session/:id/history?binaryRefs=1
```

Get full conversation history for a session.

**Query Parameters:**

| Parameter | Description |
|-----------|-------------|
| `binaryRefs` | When set to `1`, binary chunks are replaced with lightweight `binary-ref` objects containing `chunkId`, `mimeType`, and `byteSize` instead of inline binary data. Useful for fast history loading when sessions contain large assets. |

**Response (default):**
```json
{
  "chunks": [
    {
      "id": "chunk-1",
      "contentType": "text",
      "content": "Hello",
      "producer": "user",
      "annotations": { "chat.role": "user" }
    },
    {
      "id": "chunk-2",
      "contentType": "binary",
      "content": { "data": [...], "mimeType": "image/png" },
      "producer": "assistant",
      "annotations": {}
    }
  ]
}
```

**Response with `?binaryRefs=1`:**
```json
{
  "chunks": [
    {
      "id": "chunk-1",
      "contentType": "text",
      "content": "Hello",
      "producer": "user",
      "annotations": { "chat.role": "user" }
    },
    {
      "id": "chunk-2",
      "contentType": "binary-ref",
      "content": { "chunkId": "chunk-2", "mimeType": "image/png", "byteSize": 204800 },
      "producer": "assistant",
      "annotations": {}
    }
  ]
}
```

---

#### Fetch Binary Chunk Data

```
GET /api/session/:sessionId/chunk/:chunkId/binary
```

Fetch the raw binary data for a specific chunk. Used by frontend widgets to load assets on demand when history was loaded in binary reference mode.

**Response:** Raw binary data with appropriate headers.

| Header | Value |
|--------|-------|
| `Content-Type` | The chunk's MIME type (e.g. `image/png`, `audio/mpeg`) |
| `Content-Length` | Byte size of the binary data |

**Error responses:**

| Status | Condition |
|--------|-----------|
| `404` | Session or chunk not found |
| `400` | Chunk exists but is not a binary chunk |
| `401` | Missing or invalid auth token |
| `500` | Binary data unavailable (corrupt chunk) |

---

#### Delete Session

```
DELETE /api/session/:id
```

Shut down and delete a session.

**Response:** `204 No Content`

---

### Messaging

#### Send Message

```
POST /api/chat/:sessionId
```

Send a message to a session. Returns streaming token response.

**Request:**
```json
{
  "content": "Hello, how are you?"
}
```

**Response:** Server-Sent Events (SSE)
```
data: {"content": "Hello", "type": "text"}
data: {"done": true}
```

---

#### Stream Session Events

```
GET /api/session/:sessionId/stream
```

Persistent SSE stream for all session activity.

**Response:** Server-Sent Events
```
event: chunk
data: {"id": "...", "content": "...", ...}

event: error
data: {"message": "..."}
```

---

#### Add Chunk

```
POST /api/session/:id/chunk
```

Add a generic chunk (text, binary, or null) to a session.

**Request (Text):**
```json
{
  "contentType": "text",
  "content": "Hello",
  "annotations": {
    "chat.role": "user"
  }
}
```

**Request (Binary):**
```json
{
  "contentType": "binary",
  "data": "base64-encoded-data",
  "mimeType": "image/png",
  "annotations": {
    "image.description": "A cat"
  }
}
```

**Request (Null):**
```json
{
  "contentType": "null",
  "annotations": {
    "config.type": "runtime",
    "config.backend": "ollama"
  }
}
```

---

#### Fetch Web Content

```
POST /api/session/:id/web
```

Fetch web content as an untrusted chunk.

**Request:**
```json
{
  "url": "https://example.com"
}
```

---

### Quickies

#### List Quickies

```
GET /api/quickies
```

List all available quickies (preset shortcuts).

**Response:**
```json
{
  "quickies": [
    {
      "id": 1,
      "name": "Creative Writer",
      "description": "Help me write creatively",
      "emoji": "✍️",
      "gradientStart": "#FF6B6B",
      "gradientEnd": "#4ECDC4",
      "starterChunk": "I want to write a short story about...",
      "uiMode": "chat"
    }
  ]
}
```

---

#### Create Quickie

```
POST /api/quickies
```

Create a new quickie.

**Request:**
```json
{
  "presetId": 1,
  "name": "Creative Writer",
  "description": "Help me write creatively",
  "emoji": "✍️",
  "gradientStart": "#FF6B6B",
  "gradientEnd": "#4ECDC4",
  "starterChunk": "I want to write a short story about...",
  "uiMode": "chat",
  "displayOrder": 0
}
```

---

#### Delete Quickie

```
DELETE /api/quickies/:id
```

Delete a quickie.

---

### Agents

#### List Agents

```
GET /api/agents
```

List all available agents.

**Response:**
```json
{
  "agents": [
    {
      "name": "default",
      "description": "Standard chat agent",
      "configSchema": {
        "type": "object",
        "properties": {
          "backend": { "type": "string" },
          "model": { "type": "string" }
        }
      }
    }
  ]
}
```

---

### Connected Agents

#### Register Connected Agent

```
POST /api/connected-agents
```

Register an external connected agent.

**Request:**
```json
{
  "name": "my-agent",
  "description": "My external agent",
  "url": "http://localhost:4000"
}
```

---

#### List Connected Agents

```
GET /api/connected-agents
```

---

#### Subscribe to Session

```
POST /api/connected-agents/:agentId/subscribe/:sessionId
```

Subscribe a connected agent to a session's output stream.

---

#### Join Session

```
POST /api/connected-agents/:agentId/join/:sessionId
```

Join a connected agent to a session as an input source.

---

### System (Admin-only)

#### Execute System Command

```
POST /api/system/command
```

Execute system administrative commands.

**Headers:**
```
Authorization: Bearer <admin-token>
```

**Request:**
```json
{
  "command": "!tokens"
}
```

**Commands:**

| Command | Description |
|---------|-------------|
| `!tokens` | List all API tokens |
| `!token-create [desc] [--admin]` | Create new token |
| `!token-revoke <id>` | Revoke a token |
| `!token-admin <id>` | Toggle admin status |
| `!telegram-users` | List trusted Telegram users |
| `!telegram-trust <id\|username> [desc]` | Trust Telegram user |
| `!telegram-untrust <id\|username>` | Untrust Telegram user |
| `!sessions` | List all sessions |
| `!session-kill <id>` | Delete a session |
| `!agents` | List connected agents |
| `!agent-kick <id>` | Unregister agent |
| `!status` | System health summary |
| `!reload [agents...]` | Reload agents |
| `!reload-force [agents...]` | Force reload agents |

---

### Presets

#### List Presets

```
GET /api/presets
```

List available agent presets.

---

### Errors

#### Error Stream

```
GET /api/session/:sessionId/errors
```

Get error stream for a session.

**Response:** Server-Sent Events
```
data: {"message": "Error description", "timestamp": 1234567890}
```

---

## Response Formats

### Chunk

```typescript
interface Chunk {
  id: string;
  timestamp: number;
  contentType: 'text' | 'binary' | 'binary-ref' | 'null';
  content: string | BinaryContent | BinaryRefContent | null;
  producer: string;
  annotations: Record<string, any>;
}

interface BinaryContent {
  data: Uint8Array;
  mimeType: string;
}

// Returned in place of BinaryContent when ?binaryRefs=1 is used on the history endpoint
interface BinaryRefContent {
  chunkId: string;   // Same as the chunk's id
  mimeType: string;  // e.g. "image/png"
  byteSize: number;  // Exact byte length of the binary data
}
```

### Error

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid or missing token"
  }
}
```

---

## SSE Events

The API uses Server-Sent Events for streaming:

```
event: chunk
data: {"id": "...", "contentType": "text", "content": "...", ...}

event: error
data: {"message": "...", "timestamp": 1234567890}

event: done
data: {}
```

---

## See Also

- [README](../README.md) - User documentation
- [Core Library](./core.md) - Library reference
