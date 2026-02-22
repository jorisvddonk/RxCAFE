# client

Client information annotations.

## client.type

| Property | Value |
|----------|-------|
| Type | `string` |
| Values | `telegram`, `web`, `api` |

Identifies the type of client that originated a chunk. Used for access control and client-specific behavior.

**Example:**
```typescript
{ 'client.type': 'telegram' }
{ 'client.type': 'web' }
{ 'client.type': 'api' }
```
