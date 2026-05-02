# AI Chat for Etherpad

AI chat participant for Etherpad. When users @mention the AI in pad chat, it
reads the document, understands who wrote what, and responds. It can also edit
the pad directly when asked.

## Installation

Requires `ep_ai_core`.

```bash
pnpm run plugins i ep_ai_core ep_ai_chat
```

Configure the LLM provider in `settings.json` under the `ep_ai_core` key.
See the [ep_ai_core README](https://github.com/ether/ep_ai_core#readme) for
full configuration details.

## Usage

Type `@ai` followed by your message in the pad's chat box:

```
@ai summarize this document
@ai who wrote the introduction?
@ai fix the spelling errors in paragraph 3
```

The AI will respond in chat. If you ask it to make changes and the pad has
`full` access mode, it will edit the document directly.

## Configuration

Chat-specific settings go under `ep_ai_core.chat` in `settings.json`:

```json
{
  "ep_ai_core": {
    "apiBaseUrl": "https://api.anthropic.com/v1",
    "apiKey": "sk-ant-...",
    "model": "claude-sonnet-4-20250514",
    "chat": {
      "trigger": "@ai",
      "authorName": "AI Assistant",
      "authorColor": "#7c4dff",
      "systemPrompt": "You are a helpful writing assistant.",
      "maxContextChars": 50000,
      "chatHistoryLength": 20,
      "conversationBufferSize": 10
    }
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `trigger` | `@ai` | Text that activates the AI in chat |
| `authorName` | `AI Assistant` | Display name in chat and authorship |
| `authorColor` | `#7c4dff` | Color for the AI's edits and chat messages |
| `systemPrompt` | _(built-in)_ | Custom system prompt for the LLM |
| `maxContextChars` | `50000` | Max characters of pad content sent to the LLM |
| `chatHistoryLength` | `20` | Number of recent chat messages included as context |
| `conversationBufferSize` | `10` | Number of conversation turns remembered per pad |
| `suggestionMode` | `auto` | Suggestion routing mode. See "Suggestion Mode" section. |
| `suggestionModePads` | `{}` | Per-pad suggestion-mode overrides. |

## Suggestion Mode (with `ep_comments_page`)

When [`ep_comments_page`](https://github.com/ether/ep_comments_page) is also
installed, the AI defaults to creating a **suggestion comment** instead of
editing the pad directly. The comment shows up in the comments sidebar with
Accept and Revert controls — the document author reviews each change before
it lands.

If `ep_comments_page` is not installed, the AI falls back to direct editing
exactly as before.

### Overrides per request

You can override the configured mode for a single chat message:

```
@ai apply: fix the typo in line 3
@ai suggest: rewrite the introduction
```

`@ai apply:` always edits the pad directly. `@ai suggest:` always creates a
suggestion comment (or, if `ep_comments_page` is missing, replies in chat
explaining the missing dep and applies directly).

### Configuration

Add to `ep_ai_core.chat` in `settings.json`:

```json
{
  "ep_ai_core": {
    "chat": {
      "suggestionMode": "auto",
      "suggestionModePads": { "important-pad": "suggest" }
    }
  }
}
```

| Setting | Values | Default | Description |
|---|---|---|---|
| `suggestionMode` | `"auto"`, `"suggest"`, `"apply"` | `"auto"` | Global default. `auto` = suggest if `ep_comments_page` is installed, else apply. |
| `suggestionModePads` | `{ "padId": mode }` | `{}` | Per-pad overrides keyed by pad id. |

The resolution cascade (highest priority wins): per-request override → per-pad → global → built-in default.

## How Editing Works

When a user asks the AI to change the document, the AI responds with a
structured edit (find text, replace with new text). The plugin:

1. Locates the exact text in the pad
2. Applies the change as a native Etherpad changeset
3. Attributes the edit to the AI author (with the configured color)
4. Broadcasts the update to all connected clients
5. Announces the AI in the user list so its color appears in the author palette

If the pad's access mode is `readOnly`, the AI will answer questions but
decline edit requests. If access is `none`, the AI will not respond at all.

## Conversation Memory

The AI maintains a short conversation buffer per pad. Follow-up messages
can reference earlier exchanges without repeating context. The buffer is
kept in memory and resets when the server restarts.

## License

Apache-2.0
