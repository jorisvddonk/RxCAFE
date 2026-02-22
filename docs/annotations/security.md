# security

Security and trust-related annotations.

## security.trust-level

| Property | Value |
|----------|-------|
| Type | `object` |
| Properties | `trusted` (boolean), `source` (string) |

Tracks the trust status of a chunk. Chunks from untrusted sources (e.g., web fetch) are marked untrusted until explicitly trusted by the user.

**Structure:**
```typescript
{
  'security.trust-level': {
    trusted: true | false,
    source: 'manual' | 'web-fetch' | 'api' | 'telegram' | ...
  }
}
```

**Usage:** Used by security filters to determine if content should be sent to LLMs or requires user review.
