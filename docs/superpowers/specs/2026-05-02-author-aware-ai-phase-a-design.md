# Author-Aware AI — Phase A Design

**Date:** 2026-05-02
**Issue:** [ether/ep_ai_chat#3](https://github.com/ether/ep_ai_chat/issues/3)
**Status:** Approved for implementation

## Background

Today the plugin asks the LLM to respond to chat messages without telling it
*which* author sent the message. The user example "edit my writing to make me
sound smarter" cannot work, because the LLM has no way to resolve "my".

The plugin also writes AI edits to the pad with a single `author` attribute
pointing at the AI's author ID. Once the AI rewrites a span, all trace of the
human who originally wrote (or requested the change to) that span is gone.

## Scope

This spec covers **phase A**:

1. **Speaker identity.** Tell the LLM which author is asking on every request.
2. **Provenance recording.** Stamp every AI-applied edit with the requesting
   author's ID, so a future phase B can answer "which spans count as Alice's
   writing?" precisely.

A follow-up **phase B** spec will use the provenance attribute (plus the
existing `author` attribute) to feed per-author text spans into the LLM
context, enabling reliable scoping of edits like "rewrite my paragraphs."

Phase B is explicitly out of scope here.

## Design

### Semantic model: what counts as "my writing"

When phase B ships, "Alice's writing" will be defined as the union of:

- characters whose `author` attribute equals Alice's authorId, **plus**
- characters whose `author` is the AI **and** whose `ep_ai_chat:requestedBy`
  attribute equals Alice's authorId.

Implication for the requester-vs-source case: when **Bob** asks the AI to
rewrite **Alice's** paragraph, the resulting characters have
`author = AI, requestedBy = Bob`. Under the model above they count as Bob's
writing, not Alice's. Bob took responsibility by requesting the edit.

We commit to this model now (in phase A) so that provenance recorded today is
usable by phase B without a backfill.

### Component 1 — Speaker identity in LLM context

`buildContext(pad, padId, userMessage, conversationHistory, chatSettings, accessMode, selection)`
gains one new parameter, `requester`, an object of the shape:

```js
{ authorId: string, name: string }
```

`name` is looked up via `authorManager.getAuthorName(authorId)` on every
request (no caching) so renames are reflected immediately. If the lookup
returns nothing, `name` falls back to `'Anonymous'`.

`buildContext` injects a single sentence into the existing system message that
carries the document content and authorship summary, immediately after the
authorship summary block:

```
The user currently chatting with you is "<name>" (authorId: <authorId>).
When they say "I", "me", or "my", they mean this user.
```

Rationale for piggybacking on the existing system message rather than adding a
new one: keeps the message count stable, keeps the speaker statement adjacent
to the authorship summary it references, and avoids a per-message LLM
overhead.

`handleMessage` already extracts `requestAuthor = context.sessionInfo?.authorId`
for audit logging. We reuse that, look up the name, and pass the pair into
`buildContext`. If `authorId` is missing (anonymous transport, edge case), we
pass `{ authorId: 'unknown', name: 'Anonymous' }` rather than skipping the
identity statement — the LLM should always be told who's asking.

### Component 2 — Provenance attribute on AI edits

`applyEdit(pad, edit)` already accepts `edit.authorId` and uses it to build
the changeset attribute list:

```js
const attribs = authorId ? [['author', authorId]] : undefined;
```

We extend `edit` to also carry `requesterAuthorId` and add a second attribute
when present. The existing code passes `attribs = undefined` and
`pool = undefined` when there is no `authorId`; we preserve that pattern:

```js
const attribList = [];
if (authorId) attribList.push(['author', authorId]);
if (edit.requesterAuthorId) {
  attribList.push(['ep_ai_chat:requestedBy', edit.requesterAuthorId]);
}
const attribs = attribList.length ? attribList : undefined;
const pool = attribs ? pad.pool : undefined;
```

Notes:

- The key `ep_ai_chat:requestedBy` is namespaced to avoid collisions with
  `author`, the `lmkr` line markers, or any other plugin's attributes.
- The value is the requesting user's authorId (an opaque string). We store the
  authorId rather than the name because names can change; resolution to a
  display name is a presentation concern for phase B.
- If `requesterAuthorId` is missing for any reason, we still apply the edit
  with just the `author` attribute — provenance is best-effort and must never
  block an edit.
- Attributes flow through `Changeset.makeSplice` into the pad's attribute
  pool, so they survive revisions and are queryable later by walking the pool.

`handleMessage` threads the requesting authorId into the edit:

```js
editData.authorId = await getAiAuthorId();
editData.requesterAuthorId = requestAuthor;   // already in scope
const editResult = await applyEdit(pad, editData);
```

### Data flow

```
chat message arrives
  └─ handleMessage extracts requestAuthor (= sessionInfo.authorId)
       ├─ resolves name via authorManager.getAuthorName
       ├─ buildContext({...known args, requester: {authorId, name}})
       │     └─ system message gains "user is <name> (authorId: <id>)"
       └─ if AI returns an edit:
             └─ applyEdit(pad, {authorId: AI, requesterAuthorId: requestAuthor, ...})
                   └─ changeset carries ['author', AI] and
                                        ['ep_ai_chat:requestedBy', requestAuthor]
```

### Error handling

- `getAuthorName` returning null/undefined → display as `Anonymous`. No throw.
- `requestAuthor` undefined → identity sentence still rendered with
  `Anonymous`/`unknown`; no provenance attribute added to any subsequent edit.
- A malformed `requesterAuthorId` (defensive: we expect a string from session
  info) → skip the provenance attribute, do not throw.

No new failure modes are introduced relative to today's behavior.

## Testing

### Unit / backend tests (mandatory — gate the PR)

Two new tests under `test/`:

**`test/speaker_identity.js`**
Stub the LLM client. Send a chat message via `handleMessage` from a known
author. Assert the system message passed to the stubbed client contains both
the author's display name and authorId.

**`test/provenance_attribute.js`**
Apply an AI edit through `applyEdit` with both `authorId` and
`requesterAuthorId`. Walk the resulting pad's attribute pool and assert that
the `ep_ai_chat:requestedBy` attribute exists on the edited span with the
correct value. Also assert that omitting `requesterAuthorId` produces an edit
with only the `author` attribute and no thrown error.

### Manual smoke test

In the dev server, with two browser sessions logged in as different authors,
ask "edit my writing" from each. Confirm:

1. Each user is addressed by their own name in the AI's reply.
2. Subsequent AI edits are attributed to the AI in the user list (existing
   behavior, regression check).
3. (Optional, dev-only) `pad.atext.attribs` for the edited span includes the
   provenance attribute, inspected via the admin console.

The smoke test cannot directly verify phase B's "scoped to my writing" claim
yet — that's phase B's job — but it should verify the LLM's *reply* uses the
right pronouns/names.

## Open questions

None. All design decisions are settled above.

## Out of scope

- Phase B (per-author span extraction in LLM context).
- UI surfacing of "this AI edit was made on behalf of Alice".
- Backfilling provenance on AI edits made before this change ships.
- Per-pad or per-user AI configuration (issue #2).
- Suggesting edits via `ep_comments_page` instead of applying them (issue #4).
