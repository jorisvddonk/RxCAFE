# web

Web content annotations.

## web.source-url

| Property | Value |
|----------|-------|
| Type | `string` |

The URL from which web content was fetched. Present on chunks produced by web fetch operations.

**Usage:** Used to identify and label content retrieved from the web, enabling trust decisions and source attribution.

## web.error

| Property | Value |
|----------|-------|
| Type | `boolean` |

Indicates that a web fetch operation failed. Chunks with this annotation contain error information instead of actual content.
