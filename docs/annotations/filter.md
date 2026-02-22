# filter

Content filter annotations for rejected chunks.

## filter.rejected

| Property | Value |
|----------|-------|
| Type | `boolean` |

Marks a chunk as rejected by the content filter. Chunks with this annotation were blocked from reaching the LLM.

## filter.reason

| Property | Value |
|----------|-------|
| Type | `string` |

Human-readable reason for why the chunk was rejected.

**Example:**
```typescript
{
  contentType: 'null',
  annotations: {
    'filter.rejected': true,
    'filter.reason': 'Untrusted content - requires user review'
  }
}
```
