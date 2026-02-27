# Hosted Agents

Hosted agents are the original agent type in ObservableCAFE. They are embedded in the runtime and run as part of the server process.

## Characteristics

- **Embedded**: Hosted agents run within the server process.
- **Session-bound**: Each session has exactly one hosted agent (either interactive or background).
- **Pipeline-based**: They define RxJS pipelines that process chunks from the input stream and emit to the output stream.
- **Auto-discovery**: Hosted agents are automatically discovered from the `agents/` directory (or custom paths via `ObservableCAFE_AGENT_SEARCH_PATHS`).

## Session Association

A session is always created with a hosted agent:

```
Session = {
  id: string,
  agentName: string,    // The hosted agent ID (e.g., "default", "rss-summarizer")
  isBackground: boolean,
  inputStream: Subject<Chunk>,
  outputStream: Subject<Chunk>,
  ...
}
```

- **Interactive agents**: Created on-demand via the UI or API. They process user messages.
- **Background agents**: Start automatically on server boot (if `startInBackground: true`). They can run scheduled tasks.

## Creating a Session with a Hosted Agent

```bash
curl -X POST http://localhost:3000/api/session \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "agentId": "default",
    "backend": "ollama",
    "model": "gemma3:1b"
  }'
```

## Background Agents

Background agents start automatically when the server boots. They are useful for:

- Periodic tasks (e.g., RSS fetching, time reporting)
- Long-running computations
- Event-driven processing

Example background agent in `agents/news-reporter.ts`:

```typescript
export const newsReporter: AgentDefinition = {
  name: 'news-reporter',
  startInBackground: true,
  initialize(session) {
    // Schedule daily news fetch at 7 AM
    session.schedule('0 7 * * *', () => {
      // Fetch and process news...
    });
  }
};
```

## Agent Reloading

Agents can be reloaded at runtime using the System agent (`!reload` command). This allows you to update agent code without restarting the server.

### allowsReload

By default, agents can be reloaded. To prevent reloading (useful for agents with in-memory state):

```typescript
export const myStatefulAgent: AgentDefinition = {
  name: 'my-stateful-agent',
  allowsReload: false,  // Existing sessions keep old code, new sessions get updated code
  async initialize(session) {
    // Agent maintains state in memory...
  }
};
```

When `allowsReload: false`:
- Existing sessions continue using the old agent code (preserving state)
- New sessions use the updated code
- Sessions are NOT re-initialized with new code

This is ideal for agents like `anki` that maintain flashcard progress or other in-memory state.

## See Also

- [Connected Agents](./connected-agents.md) - External agents connecting via API
- [Agent Development](../agents/) - Creating custom agents
