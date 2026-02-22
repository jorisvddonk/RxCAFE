# telegram

Telegram-specific annotations.

## telegram.chatId

| Property | Value |
|----------|-------|
| Type | `number` |

The Telegram chat ID associated with a message. Used to route responses back to the correct Telegram conversation.

**Usage:** Present on chunks originating from Telegram users. The system uses this to send responses back via the Telegram bot.
