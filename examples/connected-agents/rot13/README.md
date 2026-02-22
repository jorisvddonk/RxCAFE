# ROT13 Connected Agent Example

A minimal connected agent that applies ROT13 cipher to user messages.

## Usage

1. Start the ObservableCAFE server:
   ```bash
   bun start
   ```

2. Generate a client token (needed only for registration):
   ```bash
   bun start -- --generate-token rot13-example
   ```

3. Create a session (via UI or API) and note the session ID

4. Run the agent:
   ```bash
   CAFE_SESSION_ID=<session-id> CAFE_API_TOKEN=<client-token> bun run index.ts
   ```

   Or with flags:
   ```bash
   bun run index.ts --session <session-id> --token <client-token>
   ```

## Auth Flow

1. **Registration** - Uses your client token (must be trusted)
2. **All other operations** - Uses the agent's API key (returned from registration)

The agent only needs your client token once during registration. After that, it authenticates with its own API key.

## What It Does

- Registers as a connected agent
- Subscribes (to read) and joins (to write) the session
- Listens for user messages (`chat.role === 'user'`)
- Applies ROT13 transformation
- Produces a new chunk with `[ROT13] <transformed text>`

## Example

If a user sends:
```
Hello, World!
```

The agent will produce:
```
[ROT13] Uryyb, Jbeyq!
```
