# session

Session metadata annotations.

## session.name

| Property | Value |
|----------|-------|
| Type | `string` |

Sets the display name for a session. Stored in a null chunk with `config.type: 'runtime'`.

**Example:**
```typescript
{
  contentType: 'null',
  annotations: {
    'config.type': 'runtime',
    'session.name': 'My Chat Session'
  }
}
```
