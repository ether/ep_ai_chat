# AI Suggestion Mode Design

**Date:** 2026-05-02
**Issue:** [ether/ep_ai_chat#4](https://github.com/ether/ep_ai_chat/issues/4)
**Status:** Approved for implementation
**Builds on:** Phase A (`docs/superpowers/specs/2026-05-02-author-aware-ai-phase-a-design.md`)

## Background

Today every AI edit goes straight into the pad. Issue #4 asks for a
review-before-apply flow so the document author can approve changes instead
of having them just happen. `ep_comments_page` already provides exactly that
UX for human-authored "suggestion" comments — `changeFrom`/`changeTo` text
shown in the comments sidebar with Accept and Revert controls. We reuse
that surface rather than building a parallel one.

## Scope

When `ep_comments_page` is installed, the AI defaults to creating a
suggestion comment instead of mutating the document. Without
`ep_comments_page` the plugin keeps its current direct-apply behavior with
warnings on explicit suggest requests. Users can override per-request with
`@ai apply: …` or `@ai suggest: …`. Pad admins can override per-pad in
`settings.json`. Per-user preferences are out of scope and tracked as a
follow-up.

## Configuration cascade

```json
"ep_ai_core": {
  "chat": {
    "suggestionMode": "auto",
    "suggestionModePads": { "padOne": "apply", "padTwo": "suggest" }
  }
}
```

`suggestionMode` values:

- `"auto"` (default) — suggest if `ep_comments_page` is installed, else apply.
- `"suggest"` — always suggest. Falls back to apply with a startup warning if
  the dep is missing.
- `"apply"` — always direct-edit (legacy).

Resolution cascade, highest priority first:

1. **Per-request override** — `apply:` or `suggest:` keyword in the chat
   message.
2. **Per-pad** — `chat.suggestionModePads[padId]`.
3. **Global** — `chat.suggestionMode`.
4. **Built-in** — `"auto"`.

A pure function `resolveSuggestionMode(padId, override, settings, depAvailable)`
performs the resolution and returns:

```js
{ mode: 'apply' | 'suggest', fellBackFromSuggest: boolean }
```

`fellBackFromSuggest` is `true` only when the resolved input mode was
`"suggest"` (from any cascade level) but `depAvailable` was `false`, forcing
`mode` to `"apply"`. The caller uses this flag to decide whether to emit
the per-request "missing dep" chat reply (see "Soft dep detection" below).
For all other paths it is `false`.

## Trigger parsing

`chatHandler.js`'s `extractMention(text, trigger)` grows a third return
field:

```js
{ mentioned: boolean, query: string, override: 'apply' | 'suggest' | null }
```

After the trigger is stripped, the remainder is matched against
`/^\s*(apply|suggest)\s*:\s*([\s\S]*)$/i`. On match, `override` is the
keyword (lowercased) and `query` is the captured rest. Otherwise `override`
is null and `query` is the unstripped remainder.

Examples:

- `@ai rewrite the intro` → `{override: null, query: "rewrite the intro"}`
- `@ai apply: rewrite the intro` → `{override: "apply", query: "rewrite the intro"}`
- `@ai SUGGEST:fix typos` → `{override: "suggest", query: "fix typos"}`

Existing callers that destructure `{mentioned, query}` keep working; the
new field is additive.

## Suggestion path

A new module `suggestEdit.js` exports one async function:

```js
suggestEdit(pad, edit, deps) → { success, commentId } | { success: false, error }
```

`deps` carries:

```js
{
  requesterAuthorId: string,    // from chat sender; written as provenance
  aiAuthorId: string,           // the AI author the edit is attributed to
  aiAuthorName: string,         // display name shown in comments sidebar
  commentManager: object,       // the cached ep_comments_page commentManager
  shared: object,               // the cached ep_comments_page shared module
  io: object,                   // socket.io reference for broadcast
}
```

Steps inside `suggestEdit`:

1. Locate `edit.findText` in `pad.text()`. Same logic as `applyEdit`. Return
   `{success: false, error: "Text not found: ..."}` if missing.
2. Generate a comment id via `shared.generateCommentId()`.
3. Build the comment record:

   ```js
   {
     commentId,
     name: aiAuthorName,
     author: aiAuthorId,
     text: edit.explanation || 'AI suggestion',
     changeFrom: edit.findText,
     changeTo: edit.replaceText,
     timestamp: Date.now(),
   }
   ```

   Persist via `commentManager.bulkAddComments(padId, [record])`.
4. Construct a changeset that adds `comment:c-{commentId}` to the matched
   span without changing text. Use `Changeset.builder(currentText.length)`:

   ```js
   const builder = Changeset.builder(currentText.length);
   const linesBefore = countNewlines(currentText.substring(0, idx));
   const linesInside = countNewlines(edit.findText);
   builder.keep(idx, linesBefore);
   builder.keep(
       edit.findText.length,
       linesInside,
       [
         ['comment', `c-${commentId}`],
         ['ep_ai_chat:requestedBy', requesterAuthorId],
       ],
       pad.pool);
   // remaining trailing chars are kept implicitly
   ```

   Note: phase A's `ep_ai_chat:requestedBy` provenance is applied to the
   suggestion span too, so the suggestion is provenance-tagged from the
   moment it lands. If the user later Accepts the suggestion,
   `ep_comments_page`'s client-side replace operates on the same span and
   the new text inherits the same author attribution model (handled by
   `ep_comments_page`).
5. `await pad.appendRevision(changeset, aiAuthorId)`.
6. `await padMessageHandler.updatePadClients(pad)` to broadcast the
   attribute-only edit.
7. `io.to(padId).emit('pushAddComment', commentId, comment)` so connected
   `ep_comments_page` clients see the suggestion in their sidebar without a
   refresh.

Returns `{success: true, commentId}`.

## Soft dep detection

On `loadSettings`, attempt to require both modules:

```js
let commentManagerRef = null;
let sharedRef = null;
try {
  commentManagerRef = require('ep_comments_page/commentManager');
  sharedRef = require('ep_comments_page/static/js/shared');
  logger.info('ep_comments_page detected; suggestion mode available');
} catch {
  logger.info('ep_comments_page not installed; suggestions disabled');
}
```

If `commentManagerRef` is `null` and the resolved global mode is `"suggest"`,
emit a one-time `logger.warn` at load time:

> `"ep_ai_chat: suggestionMode is set to 'suggest' but ep_comments_page is not installed; falling back to 'apply'"`

At per-request time:

- Effective mode is `"suggest"` from a per-request `@ai suggest: …` override
  AND dep is missing → reply in chat with:
  > `"Suggestions need ep_comments_page. Falling back to direct edit. Install the plugin to enable review-before-apply."`
  Then call `applyEdit` as if no override was given.
- Effective mode is `"suggest"` from cascade (not per-request) AND dep is
  missing → silent fallback to `applyEdit` (the warning was logged at
  startup, no need to spam chat).

`package.json` is not modified. `ep_comments_page` remains a soft dep
documented in the README.

## Index.js wiring

`handleMessage` is updated as follows:

1. Destructure `{mentioned, query, override}` from `extractMention`.
2. After deciding to call the LLM, compute
   `effectiveMode = resolveSuggestionMode(padId, override, aiSettings, depAvailable)`.
3. Pass `effectiveMode` along through the LLM round-trip (as a local
   variable; the LLM does not see it).
4. When the LLM returns an edit JSON block:
   - If `effectiveMode === 'suggest'` and dep available: call
     `suggestEdit(...)`. On success, send chat reply
     `"💡 Suggestion ready — review in the comments sidebar."`
   - If `effectiveMode === 'suggest'` and dep missing (only happens via
     per-request override; cascade would have downgraded to `apply`): send
     the dep-missing chat reply, then proceed with `applyEdit`.
   - If `effectiveMode === 'apply'`: call `applyEdit` exactly as today.
5. The system prompt sent to the LLM does NOT mention suggestions — the
   suggest-vs-apply choice is server-side. This keeps the LLM contract
   stable.

## Data flow

```
chat: "@ai suggest: rewrite intro"
  └─ extractMention → {override: "suggest", query: "rewrite intro"}
  └─ resolveSuggestionMode → "suggest" (with depAvailable=true)
  └─ buildContext + LLM call (unchanged)
  └─ AI returns {action: "edit", findText, replaceText, explanation}
  └─ suggestEdit:
        ├─ commentManager.bulkAddComments(padId, [record])
        ├─ pad.appendRevision(attribute-only changeset)
        ├─ padMessageHandler.updatePadClients(pad)
        └─ io.to(padId).emit('pushAddComment', id, comment)
  └─ chat reply: "💡 Suggestion ready — review in the comments sidebar."
```

```
chat: "@ai apply: fix typo"  // global mode is "suggest"
  └─ extractMention → {override: "apply", query: "fix typo"}
  └─ resolveSuggestionMode → "apply" (override wins over global)
  └─ ...same LLM round-trip...
  └─ applyEdit (unchanged from today)
  └─ chat reply: "✅ Fixed the typo." (existing behavior)
```

## Error handling

- `findText` not in pad → existing error chat reply.
- `commentManager.bulkAddComments` throws → log, fall back to `applyEdit`
  with a chat reply explaining the suggestion failed and was applied
  directly. Do not silently lose the AI's intent.
- Changeset construction throws → same fallback as above.
- `socketio` reference unavailable at runtime → still write the comment and
  the changeset; clients that joined later will fetch the comment from the
  server's existing `getComments` route. Do not throw.
- `ep_comments_page` module is required at startup but disappears at
  runtime (e.g., unloaded mid-session) → treat as soft-dep missing,
  warning-and-fallback path runs.

No new failure modes in the apply path.

## Testing

### Unit / backend tests (mandatory — gate the PR)

- **Modify `chatHandler.ts`**: cases for `apply:` and `suggest:` parsing,
  case variants (`APPLY:`, ` Suggest : `), and absence of override.
- **New `suggestionMode.ts`**: pure tests for `resolveSuggestionMode`. Each
  of the four cascade levels exercised; both `auto` branches (dep
  available vs missing); both fallbacks for `suggest`-without-dep.
- **New `suggestEdit.ts`**: with `ep_comments_page` available, assert (a)
  comment record persisted with correct fields, (b) pad's atext gains
  `comment:c-{id}` attribute on the right span, (c) pad text unchanged,
  (d) `ep_ai_chat:requestedBy` attribute also lands on the same span.
- **New `e2e_suggest.ts`**: drive `handleMessage` with `@ai suggest: improve
  this`; mock LLM returns the JSON edit; assert end-to-end: comment in DB,
  comment attribute on span, pad text unchanged, chat reply mentions
  suggestion.
- **New `e2e_apply_override.ts`**: with `suggestionMode: "suggest"`
  configured globally, send `@ai apply: improve this`; assert direct-apply
  happened (text changed, no comment created).

### Manual smoke test

In the dev server with both plugins installed, in a single browser
session:

1. Send `@ai improve this paragraph` and confirm a suggestion appears in
   the comments sidebar with `changeFrom`/`changeTo`. Click Accept and
   confirm the pad text updates. Click Revert and confirm it reverts.
2. Send `@ai apply: fix the typo in line 3` and confirm the edit lands
   directly without a comment.
3. With `suggestionMode: "apply"` set in `settings.json`, restart the
   server and confirm `@ai improve this` direct-applies. Then send
   `@ai suggest: improve this` and confirm a suggestion appears anyway.
4. Uninstall `ep_comments_page`, restart, and confirm the startup log
   shows the warning. Send `@ai suggest: improve this` and confirm the
   chat reply explains the missing dep and the edit is applied directly.

## i18n

The new chat reply strings (`"💡 Suggestion ready — review in the comments
sidebar."`, `"Suggestions need ep_comments_page. ..."`) are emitted as
literal strings, matching the existing pattern in `index.js` for
in-flight status messages (`✨ Thinking...`, `✅ ${explanation}`).
The plugin's `t(...)` helper is reserved for terminal error states
(`error_generic`, `error_rate_limit`, `error_auth`, `no_access`). A
follow-up could move all status strings under `t(...)` in one pass; that
is intentionally out of scope for this PR to keep the diff focused.

## Out of scope

- Per-user suggestion-mode preferences.
- Multi-edit suggestions in a single comment (each edit gets its own
  comment).
- A separate "AI suggestions" tab in the sidebar.
- Modifying `ep_comments_page` itself.
- A pad-creator UI for the per-pad setting (admin-only via `settings.json`).
- Migrating existing in-flight status strings to `t(...)` (see "i18n").
