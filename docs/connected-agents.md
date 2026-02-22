# Connected Agents

Connected agents are external agents that connect to ObservableCAFE via a REST API. They can observe and optionally participate in sessions.

## Overview

Unlike hosted agents (which run inside the runtime), connected agents are external processes that:
- Register themselves with the server
- Subscribe to sessions to observe activity (read chunks)
- Join sessions to produce chunks

> **Important**: Subscribing and joining are **orthogonal** actions. You must do **both** if you want to read and write chunks. Joining alone does NOT grant read access.

## Authentication

Connected agents authenticate using an API key passed in the `X-API-Key` header:

```bash
curl -H "X-API-Key: YOUR_AGENT_API_KEY" ...
```

## API Endpoints Summary

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/connected-agents` | POST | Register connected agent |
| `/api/connected-agents/:agentId` | DELETE | Unregister |
| `/api/connected-agents/:agentId/sessions` | GET | List subscriptions |
| `/api/connected-agents/:agentId/subscribe/:sessionId` | POST | Subscribe (read) |
| `/api/connected-agents/:agentId/subscribe/:sessionId` | DELETE | Unsubscribe |
| `/api/connected-agents/:agentId/join/:sessionId` | POST | Join (write) |
| `/api/connected-agents/:agentId/join/:sessionId` | DELETE | Leave |
| `/api/session/:sessionId/stream/agent` | GET | **Live chunk stream (SSE)** |
| `/api/session/:sessionId/history` | GET | Historical chunks |
| `/api/session/:sessionId/connected-agents` | GET | List agents in session |
| `/api/session/:sessionId/agent-chunk` | POST | Produce chunk |

## API Endpoints

### Register a Connected Agent

```bash
POST /api/connected-agents
```

**Request:**
```json
{
  "name": "my-external-agent",
  "description": "Monitors sessions for anomalies"
}
```

**Response:**
```json
{
  "agentId": "agent-abc123",
  "apiKey": "sk-agent-xyz789",
  "name": "my-external-agent"
}
```

> **Important**: Save the `apiKey` securely. It won't be shown again.

---

### Unregister a Connected Agent

```bash
DELETE /api/connected-agents/:agentId
```

**Response:** `204 No Content`

---

### Subscribe to a Session (Read-Only)

Subscribe to receive all chunks from a session's output stream. Subscribed agents cannot produce chunks.

```bash
POST /api/connected-agents/:agentId/subscribe/:sessionId
```

**Response:** `200 OK`

When a connected agent subscribes, a **null chunk** is emitted to the session:

```json
{
  "content": null,
  "contentType": "null",
  "producer": "com.observablecafe.connected-agent",
  "annotations": {
    "com.observablecafe.connected-agent": {
      "event": "subscribed",
      "agentId": "agent-abc123",
      "agentName": "my-external-agent",
      "sessionId": "session-xyz"
    }
  }
}
```

---

### Unsubscribe from a Session

```bash
DELETE /api/connected-agents/:agentId/subscribe/:sessionId
```

**Response:** `200 OK`

When unsubscribing, a null chunk is emitted:

```json
{
  "content": null,
  "contentType": "null",
  "annotations": {
    "com.observablecafe.connected-agent": {
      "event": "unsubscribed",
      "agentId": "agent-abc123",
      "sessionId": "session-xyz"
    }
  }
}
```

---

### Join a Session (Read-Write)

Join a session to produce chunks. Joined agents can inject content into the session.

```bash
POST /api/connected-agents/:agentId/join/:sessionId
```

**Response:** `200 OK`

When joining, a null chunk is emitted:

```json
{
  "content": null,
  "contentType": "null",
  "annotations": {
    "com.observablecafe.connected-agent": {
      "event": "joined",
      "agentId": "agent-abc123",
      "agentName": "my-external-agent",
      "sessionId": "session-xyz"
    }
  }
}
```

---

### Leave a Session

```bash
DELETE /api/connected-agents/:agentId/join/:sessionId
```

**Response:** `200 OK`

When leaving, a null chunk is emitted:

```json
{
  "content": null,
  "contentType": "null",
  "annotations": {
    "com.observablecafe.connected-agent": {
      "event": "left",
      "agentId": "agent-abc123",
      "sessionId": "session-xyz"
    }
  }
}
```

---

### List Agent's Sessions

```bash
GET /api/connected-agents/:agentId/sessions
```

**Response:**
```json
{
  "agentId": "agent-abc123",
  "sessions": [
    {
      "sessionId": "session-xyz",
      "mode": "joined"
    },
    {
      "sessionId": "session-abc",
      "mode": "subscribed"
    }
  ]
}
```

---

### List Connected Agents in a Session

```bash
GET /api/session/:sessionId/connected-agents
```

**Response:**
```json
{
  "sessionId": "session-xyz",
  "agents": [
    {
      "agentId": "agent-abc123",
      "agentName": "my-external-agent",
      "mode": "joined"
    }
  ]
}
```

---

## Reading Chunks (Live Stream)

Connected agents read chunks via **Server-Sent Events (SSE)**. This provides real-time, push-based delivery — **do not poll** for chunks.

### Subscribe to Session Stream

```bash
GET /api/session/:sessionId/stream/agent
```

**Headers:**
```
X-API-Key: YOUR_AGENT_API_KEY
Accept: text/event-stream
```

**Response:** `200 OK` with SSE stream

Each chunk is sent as an SSE event:

```
event: chunk
data: {"id":"chunk-123","content":"Hello","contentType":"text","producer":"user","annotations":{},"trusted":false,"timestamp":1700000000000}

event: chunk
data: {"id":"chunk-124","content":"Hi there!","contentType":"text","producer":"assistant","annotations":{"chat.role":"assistant"},"trusted":true,"timestamp":1700000001000}
```

**Event types:**
- `chunk` — A chunk was emitted to the session
- `error` — An error occurred in the session
- `close` — The agent was unsubscribed or the session ended

### Example: Reading Chunks in JavaScript

```javascript
const response = await fetch('http://localhost:3000/api/session/session-xyz/stream/agent', {
  headers: {
    'X-API-Key': 'sk-agent-xyz789',
    'Accept': 'text/event-stream'
  }
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  const text = decoder.decode(value);
  const lines = text.split('\n');
  
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = JSON.parse(line.slice(6));
      console.log('Received chunk:', data);
    }
  }
}
```

### Reading Historical Chunks

To get historical chunks (e.g., on reconnection), fetch the session history:

```bash
GET /api/session/:sessionId/history
```

**Headers:**
```
X-API-Key: YOUR_AGENT_API_KEY
```

**Response:** Array of chunk objects since session creation.

> **Note**: After reading history, resume the SSE stream from the last chunk's timestamp to avoid duplicates.

---

### Produce a Chunk (Joined Agents Only)

Only joined agents can produce chunks. Subscribed agents are read-only.

```bash
POST /api/session/:sessionId/agent-chunk
```

**Headers:**
```
X-API-Key: YOUR_AGENT_API_KEY
Content-Type: application/json
```

**Request:**
```json
{
  "content": "Hello from external agent!",
  "contentType": "text",
  "annotations": {
    "com.myagent.custom": {
      "source": "external"
    }
  }
}
```

**Response:** `200 OK`

The chunk will be added to the session and processed by the hosted agent pipeline.

---

## Chunk Events Reference

| Event | Trigger | Can Read Chunks | Can Produce Chunks |
|-------|---------|-----------------|---------------------|
| `subscribed` | Agent subscribes to session | Yes | No |
| `unsubscribed` | Agent unsubscribes from session | No | No |
| `joined` | Agent joins session | No | Yes |
| `left` | Agent leaves session | No | No |

> **Note**: To read AND write chunks, you must BOTH subscribe AND join. These are independent actions.

## Use Cases

1. **Monitoring**: External services subscribe to sessions to monitor activity (logging, analytics).
2. **Automation**: Bots join sessions to inject automated responses or triggers.
3. **Integration**: Connect ObservableCAFE to external systems (GitHub, Slack, etc.).

## See Also

- [Hosted Agents](./hosted-agents.md) - Agents embedded in the runtime
- [API Overview](../README.md#api-endpoints) - General API documentation
