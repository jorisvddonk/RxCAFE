# anki

Anki flashcard agent annotations.

## anki.saved-state

| Property | Value |
|----------|-------|
| Type | `object` |

Persisted state for the Anki study session, including card deck, progress, and statistics. Stored in a null chunk for session restoration.

## anki.card-front

| Property | Value |
|----------|-------|
| Type | `string` |

The front (question) side of the current flashcard.

## anki.card-back

| Property | Value |
|----------|-------|
| Type | `string` |

The back (answer) side of the current flashcard.
