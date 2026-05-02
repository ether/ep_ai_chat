# AI Suggestion Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `ep_comments_page` is installed, route AI edits through a `changeFrom`/`changeTo` suggestion comment by default, anchored on the matched span via a no-text-change `comment` attribute changeset. Per-request (`@ai apply:` / `@ai suggest:`), per-pad (`settings.json`), global, and built-in `auto` resolution cascade. Soft dep — if the comments plugin isn't installed everything degrades to today's apply path.

**Architecture:** One pure resolver (`suggestionMode.js`) settles which mode wins. One new pad-mutator (`suggestEdit.js`) anchors a comment via `Changeset.Builder.keepText` and persists the comment via `commentManager.bulkAddComments`. `chatHandler.js`'s `extractMention` grows an `override` field. `index.js` does the wiring: detect the dep at load time, parse the override, resolve the mode, dispatch to `suggestEdit` or the existing `applyEdit`. Both paths share the same upstream LLM round-trip.

**Tech Stack:** Node.js (CommonJS), `ep_etherpad-lite/static/js/Builder` for the changeset, `ep_comments_page/commentManager` + `.../static/js/shared` for the comment record, `socket.io` for the broadcast. Mocha + tsx for the backend tests, run from `etherpad-lite/src` against the symlinked plugin install.

---

## File Structure

**Production code (modify):**
- `chatHandler.js` — add `override` to `extractMention`
- `index.js` — dep detection on `loadSettings`, route on resolved mode

**Production code (create):**
- `suggestionMode.js` — pure resolver `resolveSuggestionMode(padId, override, settings, depAvailable) → {mode, fellBackFromSuggest}`
- `suggestEdit.js` — `suggestEdit(pad, edit, deps) → {success, commentId} | {success: false, error}`

**Tests (modify):**
- `static/tests/backend/specs/chatHandler.ts` — override parsing cases

**Tests (create):**
- `static/tests/backend/specs/suggestionMode.ts` — resolver unit tests
- `static/tests/backend/specs/suggestEdit.ts` — suggestion module unit tests
- `static/tests/backend/specs/e2e_suggest.ts` — `@ai suggest:` end-to-end
- `static/tests/backend/specs/e2e_apply_override.ts` — global suggest mode + per-request apply

**Docs (modify):**
- `README.md` — document `suggestionMode`, `suggestionModePads`, and the override syntax

No splits of existing files; each existing file stays focused on its current responsibility.

---

## Task 1: Override parsing in `extractMention`

**Files:**
- Modify: `chatHandler.js`
- Test:   `static/tests/backend/specs/chatHandler.ts`

- [ ] **Step 1: Append failing tests to `static/tests/backend/specs/chatHandler.ts`**

Find the existing `describe('extractMention', ...)` block and add these cases inside it (immediately before the closing `});` of that describe):

```ts
    it('returns override="apply" for "@ai apply: ..." messages', function () {
      const result = extractMention('@ai apply: rewrite the intro', '@ai');
      assert.equal(result.mentioned, true);
      assert.equal(result.override, 'apply');
      assert.equal(result.query, 'rewrite the intro');
    });

    it('returns override="suggest" for "@ai suggest: ..." messages', function () {
      const result = extractMention('@ai suggest: fix typos', '@ai');
      assert.equal(result.override, 'suggest');
      assert.equal(result.query, 'fix typos');
    });

    it('lowercases the override keyword and tolerates spacing', function () {
      const a = extractMention('@ai APPLY: do it', '@ai');
      const b = extractMention('@ai  Suggest : do it', '@ai');
      assert.equal(a.override, 'apply');
      assert.equal(b.override, 'suggest');
      assert.equal(a.query, 'do it');
      assert.equal(b.query, 'do it');
    });

    it('returns override=null when no keyword is present', function () {
      const result = extractMention('@ai please help me', '@ai');
      assert.equal(result.override, null);
      assert.equal(result.query, 'please help me');
    });

    it('does not match a keyword without the colon', function () {
      const result = extractMention('@ai apply this fix', '@ai');
      assert.equal(result.override, null);
      assert.equal(result.query, 'apply this fix');
    });
```

If the existing test file does not already destructure `extractMention` from a require, the existing imports will already cover it — leave imports alone.

- [ ] **Step 2: Run tests to verify the new cases fail**

```bash
cd /home/jose/etherpad/etherpad-lite/src && \
  npx cross-env NODE_ENV=production mocha --import=tsx --timeout 120000 \
    node_modules/ep_ai_chat/static/tests/backend/specs/chatHandler.ts
```

Expected: 5 new failures with messages about `result.override` being `undefined`, plus all pre-existing tests passing.

- [ ] **Step 3: Implement override parsing in `chatHandler.js`**

Replace the entire body of `extractMention` in `chatHandler.js`. The full new file body (preserving `detectEditIntent` which is still used elsewhere):

```js
'use strict';

const OVERRIDE_RE = /^\s*(apply|suggest)\s*:\s*([\s\S]*)$/i;

const extractMention = (text, trigger) => {
  const escapedTrigger = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const triggerRe = new RegExp(escapedTrigger, 'gi');
  if (!triggerRe.test(text)) return {mentioned: false, query: '', override: null};
  const remainder = text.replace(new RegExp(escapedTrigger, 'gi'), '').trim();
  const overrideMatch = remainder.match(OVERRIDE_RE);
  if (overrideMatch) {
    return {
      mentioned: true,
      override: overrideMatch[1].toLowerCase(),
      query: overrideMatch[2].trim(),
    };
  }
  return {mentioned: true, query: remainder, override: null};
};

const detectEditIntent = (query) => {
  const editPatterns = [
    /\b(rewrite|reword|rephrase|revise)\b/i,
    /\b(add|insert|append|prepend)\b.*\b(to|at|before|after)\b/i,
    /\b(replace|change|update|fix|correct)\b.*\b(with|to)\b/i,
    /\b(delete|remove)\b.*\b(paragraph|section|line|sentence|word)\b/i,
    /\b(write|draft|create)\b.*\b(paragraph|section|summary|introduction|conclusion)\b/i,
  ];
  return editPatterns.some((pattern) => pattern.test(query));
};

exports.extractMention = extractMention;
exports.detectEditIntent = detectEditIntent;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/jose/etherpad/etherpad-lite/src && \
  npx cross-env NODE_ENV=production mocha --import=tsx --timeout 120000 \
    node_modules/ep_ai_chat/static/tests/backend/specs/chatHandler.ts
```

Expected: all `extractMention` tests pass — both the 6 pre-existing and the 5 new ones — and all `detectEditIntent` tests still pass.

- [ ] **Step 5: Commit**

```bash
cd /home/jose/etherpad/plugins/ep_ai_chat && \
  git add chatHandler.js static/tests/backend/specs/chatHandler.ts && \
  git commit -m "feat: parse @ai apply: / suggest: per-request override

Closes part 1 of #4."
```

---

## Task 2: `resolveSuggestionMode` resolver

**Files:**
- Create: `suggestionMode.js`
- Test:   `static/tests/backend/specs/suggestionMode.ts`

- [ ] **Step 1: Create the failing test file `static/tests/backend/specs/suggestionMode.ts`**

```ts
'use strict';

import {strict as assert} from 'assert';

const {resolveSuggestionMode} = require('../../../../suggestionMode');

describe('ep_ai_chat - resolveSuggestionMode', function () {
  describe('built-in default', function () {
    it('returns suggest when auto and dep available', function () {
      const out = resolveSuggestionMode('p1', null, {}, true);
      assert.deepEqual(out, {mode: 'suggest', fellBackFromSuggest: false});
    });

    it('returns apply when auto and dep missing', function () {
      const out = resolveSuggestionMode('p1', null, {}, false);
      assert.deepEqual(out, {mode: 'apply', fellBackFromSuggest: false});
    });
  });

  describe('global setting', function () {
    it('respects global "apply"', function () {
      const out = resolveSuggestionMode('p1', null, {chat: {suggestionMode: 'apply'}}, true);
      assert.equal(out.mode, 'apply');
      assert.equal(out.fellBackFromSuggest, false);
    });

    it('respects global "suggest" when dep available', function () {
      const out = resolveSuggestionMode('p1', null, {chat: {suggestionMode: 'suggest'}}, true);
      assert.equal(out.mode, 'suggest');
      assert.equal(out.fellBackFromSuggest, false);
    });

    it('falls back when global "suggest" but dep missing', function () {
      const out = resolveSuggestionMode('p1', null, {chat: {suggestionMode: 'suggest'}}, false);
      assert.equal(out.mode, 'apply');
      assert.equal(out.fellBackFromSuggest, true);
    });
  });

  describe('per-pad override of global', function () {
    it('per-pad apply wins over global suggest', function () {
      const settings = {chat: {suggestionMode: 'suggest', suggestionModePads: {p1: 'apply'}}};
      const out = resolveSuggestionMode('p1', null, settings, true);
      assert.equal(out.mode, 'apply');
    });

    it('per-pad suggest wins over global apply', function () {
      const settings = {chat: {suggestionMode: 'apply', suggestionModePads: {p1: 'suggest'}}};
      const out = resolveSuggestionMode('p1', null, settings, true);
      assert.equal(out.mode, 'suggest');
    });

    it('per-pad suggest falls back when dep missing', function () {
      const settings = {chat: {suggestionModePads: {p1: 'suggest'}}};
      const out = resolveSuggestionMode('p1', null, settings, false);
      assert.equal(out.mode, 'apply');
      assert.equal(out.fellBackFromSuggest, true);
    });
  });

  describe('per-request override', function () {
    it('per-request apply beats per-pad suggest', function () {
      const settings = {chat: {suggestionModePads: {p1: 'suggest'}}};
      const out = resolveSuggestionMode('p1', 'apply', settings, true);
      assert.equal(out.mode, 'apply');
    });

    it('per-request suggest beats global apply', function () {
      const out = resolveSuggestionMode('p1', 'suggest', {chat: {suggestionMode: 'apply'}}, true);
      assert.equal(out.mode, 'suggest');
    });

    it('per-request suggest falls back when dep missing', function () {
      const out = resolveSuggestionMode('p1', 'suggest', {}, false);
      assert.equal(out.mode, 'apply');
      assert.equal(out.fellBackFromSuggest, true);
    });
  });

  describe('robustness', function () {
    it('treats unknown global mode as auto', function () {
      const out = resolveSuggestionMode('p1', null, {chat: {suggestionMode: 'wat'}}, true);
      assert.equal(out.mode, 'suggest');
    });

    it('handles missing chat block', function () {
      const out = resolveSuggestionMode('p1', null, undefined, true);
      assert.equal(out.mode, 'suggest');
    });

    it('handles missing pads map', function () {
      const out = resolveSuggestionMode('p1', null, {chat: {suggestionMode: 'apply'}}, true);
      assert.equal(out.mode, 'apply');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/jose/etherpad/etherpad-lite/src && \
  npx cross-env NODE_ENV=production mocha --import=tsx --timeout 120000 \
    node_modules/ep_ai_chat/static/tests/backend/specs/suggestionMode.ts
```

Expected: every test fails — module `../../../../suggestionMode` cannot be resolved.

- [ ] **Step 3: Create `suggestionMode.js`**

```js
'use strict';

const VALID_MODES = new Set(['apply', 'suggest', 'auto']);

const normalize = (raw) => {
  if (typeof raw !== 'string') return 'auto';
  const lc = raw.toLowerCase();
  return VALID_MODES.has(lc) ? lc : 'auto';
};

const resolveSuggestionMode = (padId, override, settings, depAvailable) => {
  const chat = (settings && settings.chat) || {};
  const padMap = chat.suggestionModePads || {};
  const requested =
      override != null
        ? normalize(override)
        : padMap[padId] != null
          ? normalize(padMap[padId])
          : normalize(chat.suggestionMode);

  // Resolve "auto" against the dep availability.
  const desired = requested === 'auto' ? (depAvailable ? 'suggest' : 'apply') : requested;

  if (desired === 'suggest' && !depAvailable) {
    return {mode: 'apply', fellBackFromSuggest: true};
  }
  return {mode: desired, fellBackFromSuggest: false};
};

exports.resolveSuggestionMode = resolveSuggestionMode;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/jose/etherpad/etherpad-lite/src && \
  npx cross-env NODE_ENV=production mocha --import=tsx --timeout 120000 \
    node_modules/ep_ai_chat/static/tests/backend/specs/suggestionMode.ts
```

Expected: all 13 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/jose/etherpad/plugins/ep_ai_chat && \
  git add suggestionMode.js static/tests/backend/specs/suggestionMode.ts && \
  git commit -m "feat: resolveSuggestionMode cascade resolver

Closes part 2 of #4."
```

---

## Task 3: `suggestEdit` module

**Files:**
- Create: `suggestEdit.js`
- Test:   `static/tests/backend/specs/suggestEdit.ts`

This task does the substantive work — anchors a comment on the right span via a no-text-change changeset and persists the comment record.

- [ ] **Step 1: Create the failing test file `static/tests/backend/specs/suggestEdit.ts`**

```ts
'use strict';

import {strict as assert} from 'assert';

const common = require('ep_etherpad-lite/tests/backend/common');
const {generateJWTToken} = common;
const randomString = require('ep_etherpad-lite/static/js/pad_utils').randomString;
const padManager = require('ep_etherpad-lite/node/db/PadManager');
const Changeset = require('ep_etherpad-lite/static/js/Changeset');
const {attribsFromString} = require('ep_etherpad-lite/static/js/attributes');

const commentManager = require('ep_comments_page/commentManager');
const shared = require('ep_comments_page/static/js/shared');

const suggestEdit = require('../../../../suggestEdit');

let agent: any;
const apiVersion = 1;

describe('ep_ai_chat - suggestEdit', function () {
  before(async function () {
    agent = await common.init();
  });

  it('persists a comment record with changeFrom/changeTo and explanation', async function () {
    const padId = `test-suggest-${randomString(10)}`;
    await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Some original sentence here`)
        .set('Authorization', await generateJWTToken());

    const pad = await padManager.getPad(padId);
    const result = await suggestEdit.suggestEdit(pad, {
      findText: 'original sentence',
      replaceText: 'rewritten sentence',
      explanation: 'Improved clarity.',
    }, {
      requesterAuthorId: 'a.alice_suggest',
      aiAuthorId: 'a.test_ai_suggest',
      aiAuthorName: 'AI Assistant',
      commentManager,
      shared,
      io: null, // broadcast is skipped when io is null; persistence still works
    });

    assert.ok(result.success, `suggest should succeed; got: ${JSON.stringify(result)}`);
    assert.ok(result.commentId, 'should return the new commentId');

    const stored = await commentManager.getComments(padId);
    const comment = stored.comments[result.commentId];
    assert.ok(comment, `comment record ${result.commentId} should exist`);
    assert.equal(comment.changeFrom, 'original sentence');
    assert.equal(comment.changeTo, 'rewritten sentence');
    assert.equal(comment.text, 'Improved clarity.');
    assert.equal(comment.author, 'a.test_ai_suggest');
  });

  it('does not change pad text', async function () {
    const padId = `test-suggest-${randomString(10)}`;
    await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Untouched paragraph here`)
        .set('Authorization', await generateJWTToken());

    const pad = await padManager.getPad(padId);
    await suggestEdit.suggestEdit(pad, {
      findText: 'Untouched paragraph here',
      replaceText: 'Replaced paragraph here',
      explanation: 'no-op text',
    }, {
      requesterAuthorId: 'a.alice_text',
      aiAuthorId: 'a.test_ai_text',
      aiAuthorName: 'AI Assistant',
      commentManager,
      shared,
      io: null,
    });

    const updated = await padManager.getPad(padId);
    assert.equal(updated.text().trim(), 'Untouched paragraph here',
        `pad text must not change when suggesting; got: "${updated.text()}"`);
  });

  it('anchors comment + provenance attributes on the matched span', async function () {
    const padId = `test-suggest-${randomString(10)}`;
    await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Anchor target text`)
        .set('Authorization', await generateJWTToken());

    const pad = await padManager.getPad(padId);
    const requester = 'a.alice_anchor';
    const result = await suggestEdit.suggestEdit(pad, {
      findText: 'target',
      replaceText: 'goal',
      explanation: 'word change',
    }, {
      requesterAuthorId: requester,
      aiAuthorId: 'a.test_ai_anchor',
      aiAuthorName: 'AI Assistant',
      commentManager,
      shared,
      io: null,
    });
    assert.ok(result.success);

    const updated = await padManager.getPad(padId);
    const pool = updated.pool;

    let foundComment = false;
    let foundProvenance = false;
    for (const op of Changeset.deserializeOps(updated.atext.attribs)) {
      for (const [key, value] of attribsFromString(op.attribs, pool)) {
        if (key === 'comment' && value === `c-${result.commentId.replace(/^c-/, '')}`) {
          foundComment = true;
        }
        if (key === 'ep_ai_chat:requestedBy' && value === requester) {
          foundProvenance = true;
        }
      }
    }
    assert.ok(foundComment, `comment attribute c-... should anchor the span`);
    assert.ok(foundProvenance, `ep_ai_chat:requestedBy=${requester} should also anchor the span`);
  });

  it('returns failure when findText is not in the pad', async function () {
    const padId = `test-suggest-${randomString(10)}`;
    await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Hello`)
        .set('Authorization', await generateJWTToken());

    const pad = await padManager.getPad(padId);
    const result = await suggestEdit.suggestEdit(pad, {
      findText: 'nonexistent',
      replaceText: 'whatever',
    }, {
      requesterAuthorId: 'a.alice_404',
      aiAuthorId: 'a.test_ai_404',
      aiAuthorName: 'AI Assistant',
      commentManager,
      shared,
      io: null,
    });
    assert.equal(result.success, false);
    assert.ok(/not found/i.test(result.error || ''),
        `error should mention "not found"; got: "${result.error}"`);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/jose/etherpad/etherpad-lite/src && \
  npx cross-env NODE_ENV=production mocha --import=tsx --timeout 120000 \
    node_modules/ep_ai_chat/static/tests/backend/specs/suggestEdit.ts
```

Expected: all four tests fail with `Cannot find module '../../../../suggestEdit'`.

- [ ] **Step 3: Create `suggestEdit.js`**

```js
'use strict';

const padMessageHandler = require('ep_etherpad-lite/node/handler/PadMessageHandler');
const {Builder} = require('ep_etherpad-lite/static/js/Builder');
const log4js = require('ep_etherpad-lite/node_modules/log4js');
const logger = log4js.getLogger('ep_ai_chat:suggest');

const suggestEdit = async (pad, edit, deps) => {
  const {requesterAuthorId, aiAuthorId, aiAuthorName, commentManager, shared, io} = deps;
  const currentText = pad.text();

  const idx = currentText.indexOf(edit.findText);
  if (idx === -1) {
    return {success: false, error: `Text not found: "${edit.findText.substring(0, 100)}"`};
  }

  let commentId;
  let comment;
  try {
    const generated = shared.generateCommentId(); // returns "c-..."
    commentId = generated;
    comment = {
      commentId,
      name: aiAuthorName,
      author: aiAuthorId,
      text: edit.explanation || 'AI suggestion',
      changeFrom: edit.findText,
      changeTo: edit.replaceText,
      timestamp: Date.now(),
    };
    await commentManager.bulkAddComments(pad.id, [comment]);
  } catch (err) {
    logger.error(`Failed to persist suggestion comment: ${err.message}`);
    return {success: false, error: `comment persistence failed: ${err.message}`};
  }

  try {
    const builder = new Builder(currentText.length);
    const before = currentText.substring(0, idx);
    const match = edit.findText;
    const after = currentText.substring(idx + match.length);
    if (before.length) builder.keepText(before);
    const attribs = [['comment', commentId]];
    if (requesterAuthorId) {
      attribs.push(['ep_ai_chat:requestedBy', requesterAuthorId]);
    }
    builder.keepText(match, attribs, pad.pool);
    if (after.length) builder.keepText(after);
    const changeset = builder.toString();
    await pad.appendRevision(changeset, aiAuthorId);
    await padMessageHandler.updatePadClients(pad);
  } catch (err) {
    logger.error(`Failed to anchor suggestion changeset: ${err.message}`);
    return {success: false, error: `anchor failed: ${err.message}`};
  }

  if (io) {
    try {
      io.to(pad.id).emit('pushAddComment', commentId, comment);
    } catch (err) {
      // Broadcast is best-effort; the comment is already persisted and clients
      // that load later will see it via the existing getComments route.
      logger.warn(`pushAddComment broadcast failed: ${err.message}`);
    }
  }

  return {success: true, commentId};
};

exports.suggestEdit = suggestEdit;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/jose/etherpad/etherpad-lite/src && \
  npx cross-env NODE_ENV=production mocha --import=tsx --timeout 120000 \
    node_modules/ep_ai_chat/static/tests/backend/specs/suggestEdit.ts
```

Expected: all 4 tests pass. The "anchors comment + provenance" test asserts the `comment` attribute equals `c-{commentId-without-c-prefix}` — but since `shared.generateCommentId()` already returns a value starting with `c-`, the test's `.replace(/^c-/, '')` strips the prefix and reattaches it, so the assertion is robust whether the id has the prefix or not.

- [ ] **Step 5: Commit**

```bash
cd /home/jose/etherpad/plugins/ep_ai_chat && \
  git add suggestEdit.js static/tests/backend/specs/suggestEdit.ts && \
  git commit -m "feat: suggestEdit anchors AI suggestions as comment attributes

Persists a changeFrom/changeTo comment via ep_comments_page and
applies a no-text-change changeset that anchors the comment + the
phase A ep_ai_chat:requestedBy attribute on the matched span.

Closes part 3 of #4."
```

---

## Task 4: Wire dep detection + routing in `index.js`

**Files:**
- Modify: `index.js`

This task threads the resolver and the new module through the chat-handling pipeline. There are no new unit tests added in this task; the wiring is exercised by the e2e tests in Tasks 5 and 6.

- [ ] **Step 1: Add module-level state for the soft dep cache near the top of `index.js`**

Find the existing `let aiAuthorId = null;` line. Add immediately after it:

```js
let commentsModulesCache = {commentManager: null, shared: null, depAvailable: false};
```

- [ ] **Step 2: Add a helper that probes `ep_comments_page` once per `loadSettings`**

In `index.js`, immediately above the existing `exports.loadSettings = ...` definition, add:

```js
const probeCommentsModule = () => {
  try {
    const commentManager = require('ep_comments_page/commentManager');
    const shared = require('ep_comments_page/static/js/shared');
    commentsModulesCache = {commentManager, shared, depAvailable: true};
    logger.info('ep_comments_page detected; suggestion mode available');
  } catch {
    commentsModulesCache = {commentManager: null, shared: null, depAvailable: false};
    logger.info('ep_comments_page not installed; suggestions disabled');
  }
};
```

- [ ] **Step 3: Call the probe and emit the startup warning at the end of `loadSettings`**

Replace the existing `exports.loadSettings = async (hookName, {settings}) => { ... };` with:

```js
exports.loadSettings = async (hookName, {settings}) => {
  const aiSettings = settings.ep_ai_core || {};
  const chat = aiSettings.chat || {};
  chatSettings = {...chatSettings, ...chat};
  logger.info(`ep_ai_chat loaded. Trigger: "${chatSettings.trigger}"`);
  aiAuthorId = null;
  probeCommentsModule();
  if (!commentsModulesCache.depAvailable && (chat.suggestionMode || '').toLowerCase() === 'suggest') {
    logger.warn(
        "ep_ai_chat: suggestionMode is set to 'suggest' but ep_comments_page is " +
        "not installed; falling back to 'apply'");
  }
};
```

- [ ] **Step 4: Add the require for the new modules near the top of `index.js`**

Find the existing `const {extractMention} = require('./chatHandler');` line and the lines around it. Replace the block:

```js
const {extractMention} = require('./chatHandler');
const {buildContext} = require('./contextBuilder');
const {applyEdit} = require('./padEditor');
```

with:

```js
const {extractMention} = require('./chatHandler');
const {buildContext} = require('./contextBuilder');
const {applyEdit} = require('./padEditor');
const {suggestEdit} = require('./suggestEdit');
const {resolveSuggestionMode} = require('./suggestionMode');
```

- [ ] **Step 5: Read the override out of `extractMention` and use it for routing**

Find the line `const {mentioned, query} = extractMention(chatText, chatSettings.trigger);` and change it to:

```js
const {mentioned, query, override} = extractMention(chatText, chatSettings.trigger);
```

- [ ] **Step 6: Resolve the effective mode once per request, after the access check**

Find the `await sendChatReply(padId, '✨ Thinking...');` line. Immediately *before* it (after the `logger.info` audit line), add:

```js
    const {mode: effectiveMode, fellBackFromSuggest} =
        resolveSuggestionMode(padId, override, aiSettings, commentsModulesCache.depAvailable);
    if (override === 'suggest' && fellBackFromSuggest) {
      await sendChatReply(padId,
          'Suggestions need ep_comments_page. Falling back to direct edit. ' +
          'Install the plugin to enable review-before-apply.');
    }
```

- [ ] **Step 7: Route the edit-JSON path to `suggestEdit` or `applyEdit` based on `effectiveMode`**

Find the block (currently inside `setImmediate`):

```js
            editData.authorId = await getAiAuthorId();
            editData.requesterAuthorId = requestAuthor;
            const editResult = await applyEdit(pad, editData);
            if (editResult.success) {
              applied = true;
              const explanation = editData.explanation || 'Edit applied.';
              logger.info(`AI edit applied: pad=${padId} find="${editData.findText.substring(0, 50)}" replace="${editData.replaceText.substring(0, 50)}"`);
              await sendChatReply(padId, `✅ ${explanation}`);
            } else {
              logger.warn(`Edit failed: ${editResult.error}`);
              // Fall through to send the raw response
            }
```

Replace it with:

```js
            editData.authorId = await getAiAuthorId();
            editData.requesterAuthorId = requestAuthor;

            const useSuggest =
                effectiveMode === 'suggest' && commentsModulesCache.depAvailable;

            let editResult;
            if (useSuggest) {
              const socketio = require('ep_etherpad-lite/node/hooks/express').socketio;
              editResult = await suggestEdit(pad, editData, {
                requesterAuthorId: requestAuthor,
                aiAuthorId: editData.authorId,
                aiAuthorName: chatSettings.authorName,
                commentManager: commentsModulesCache.commentManager,
                shared: commentsModulesCache.shared,
                io: socketio || null,
              });
              if (editResult.success) {
                applied = true;
                logger.info(`AI suggestion created: pad=${padId} commentId=${editResult.commentId}`);
                await sendChatReply(padId,
                    '💡 Suggestion ready — review in the comments sidebar.');
              } else {
                logger.warn(`Suggest failed, falling back to apply: ${editResult.error}`);
                editResult = await applyEdit(pad, editData);
                if (editResult.success) {
                  applied = true;
                  const explanation = editData.explanation || 'Edit applied.';
                  await sendChatReply(padId, `✅ ${explanation} (suggestion failed; applied directly)`);
                }
              }
            } else {
              editResult = await applyEdit(pad, editData);
              if (editResult.success) {
                applied = true;
                const explanation = editData.explanation || 'Edit applied.';
                logger.info(`AI edit applied: pad=${padId} find="${editData.findText.substring(0, 50)}" replace="${editData.replaceText.substring(0, 50)}"`);
                await sendChatReply(padId, `✅ ${explanation}`);
              } else {
                logger.warn(`Edit failed: ${editResult.error}`);
                // Fall through to send the raw response
              }
            }
```

- [ ] **Step 8: Run the existing backend suite to confirm no regressions**

```bash
cd /home/jose/etherpad/etherpad-lite/src && \
  npx cross-env NODE_ENV=production mocha --import=tsx --timeout 120000 \
    'node_modules/ep_ai_chat/static/tests/backend/specs/**/*.ts'
```

Expected: all pre-existing tests still pass. New `suggestionMode` and `suggestEdit` specs pass. The existing `e2e.ts` test that already drives `handleMessage` continues to pass — it doesn't request suggestions, so it still routes to `applyEdit`.

- [ ] **Step 9: Lint**

```bash
cd /home/jose/etherpad/plugins/ep_ai_chat && pnpm run lint
```

Expected: count of issues unchanged from before this task (52 baseline, all pre-existing). Fix any new issues you introduced.

- [ ] **Step 10: Commit**

```bash
cd /home/jose/etherpad/plugins/ep_ai_chat && \
  git add index.js && \
  git commit -m "feat: route AI edits through suggestEdit when suggestion mode is on

loadSettings probes ep_comments_page once and caches the modules.
handleMessage resolves the effective mode per-request via
resolveSuggestionMode and dispatches to suggestEdit or applyEdit.
On per-request 'suggest:' overrides without the dep available,
the user gets a chat reply explaining the fallback.

Closes part 4 of #4."
```

---

## Task 5: End-to-end test for `@ai suggest:`

**Files:**
- Create: `static/tests/backend/specs/e2e_suggest.ts`

- [ ] **Step 1: Create the test**

```ts
'use strict';

import {strict as assert} from 'assert';
import http from 'http';

const common = require('ep_etherpad-lite/tests/backend/common');
const {generateJWTToken} = common;
const randomString = require('ep_etherpad-lite/static/js/pad_utils').randomString;
const padManager = require('ep_etherpad-lite/node/db/PadManager');
const Changeset = require('ep_etherpad-lite/static/js/Changeset');
const {attribsFromString} = require('ep_etherpad-lite/static/js/attributes');
const hooks = require('ep_etherpad-lite/static/js/pluginfw/hooks');
const commentManager = require('ep_comments_page/commentManager');

let mockLLM: http.Server;
let mockPort: number;

const startMockLLM = (): Promise<void> => new Promise((resolve) => {
  mockLLM = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      const editJson = JSON.stringify({
        action: 'edit',
        findText: 'Phrase to suggest on',
        replaceText: 'Phrase that was suggested',
        explanation: 'Polished phrasing.',
      });
      const responseText = `\`\`\`json\n${editJson}\n\`\`\``;
      const isAnthropic = req.headers['x-api-key'] !== undefined;
      res.writeHead(200, {'Content-Type': 'application/json'});
      if (isAnthropic) {
        res.end(JSON.stringify({
          content: [{type: 'text', text: responseText}],
          usage: {input_tokens: 10, output_tokens: 8},
        }));
      } else {
        res.end(JSON.stringify({
          choices: [{message: {content: responseText}}],
          usage: {prompt_tokens: 10, completion_tokens: 8, total_tokens: 18},
        }));
      }
    });
  });
  mockLLM.listen(0, () => {
    const addr = mockLLM.address();
    mockPort = typeof addr === 'object' && addr ? addr.port : 0;
    resolve();
  });
});

const stopMockLLM = (): Promise<void> => new Promise((resolve) => {
  mockLLM.close(() => resolve());
});

let agent: any;
const apiVersion = 1;

describe('ep_ai_chat - end-to-end @ai suggest:', function () {
  before(async function () {
    agent = await common.init();
    await startMockLLM();

    const settings = require('ep_etherpad-lite/node/utils/Settings');
    settings.ep_ai_core = {
      apiBaseUrl: `http://127.0.0.1:${mockPort}`,
      apiKey: 'test-key',
      model: 'test-model',
      provider: 'openai',
      access: {defaultMode: 'full', pads: {}},
      chat: {
        trigger: '@ai',
        authorName: 'AI Assistant',
        maxContextChars: 50000,
        chatHistoryLength: 20,
        conversationBufferSize: 10,
        // Default global mode is "auto"; per-request override drives this test.
      },
    };
    await hooks.aCallAll('loadSettings', {settings});
  });

  after(async function () {
    await stopMockLLM();
  });

  it('routes @ai suggest: through suggestEdit and leaves pad text unchanged',
      async function () {
        const padId = `test-e2e-suggest-${randomString(10)}`;
        await agent.get(
            `/api/${apiVersion}/createPad?padID=${padId}&text=Phrase to suggest on`)
            .set('Authorization', await generateJWTToken());

        const requester = `a.alice_e2e_suggest_${randomString(6)}`;
        const epAiChat = require('ep_ai_chat/index');
        const chatHeadBefore = (await padManager.getPad(padId)).chatHead;

        await epAiChat.handleMessage('handleMessage', {
          message: {
            type: 'COLLABROOM',
            data: {
              type: 'CHAT_MESSAGE',
              message: {
                text: '@ai suggest: improve this',
                authorId: requester,
                time: Date.now(),
              },
            },
          },
          sessionInfo: {authorId: requester, padId, readOnly: false},
          socket: {id: 'fake-socket'},
        });

        await new Promise((resolve) => setTimeout(resolve, 2000));

        const updated = await padManager.getPad(padId);
        // Pad text must NOT change for a suggestion.
        assert.ok(updated.text().includes('Phrase to suggest on'),
            `pad text should retain original; got: "${updated.text()}"`);
        assert.ok(!updated.text().includes('Phrase that was suggested'),
            `pad text should NOT yet contain the suggestion; got: "${updated.text()}"`);

        // A comment record should exist with the right changeFrom/changeTo.
        const stored = await commentManager.getComments(padId);
        const ids = Object.keys(stored.comments);
        assert.equal(ids.length, 1, `expected exactly 1 comment, got ${ids.length}`);
        const comment = stored.comments[ids[0]];
        assert.equal(comment.changeFrom, 'Phrase to suggest on');
        assert.equal(comment.changeTo, 'Phrase that was suggested');

        // The comment attribute should anchor the matched span.
        const pool = updated.pool;
        let foundComment = false;
        for (const op of Changeset.deserializeOps(updated.atext.attribs)) {
          for (const [key, value] of attribsFromString(op.attribs, pool)) {
            if (key === 'comment' && value === ids[0]) foundComment = true;
          }
        }
        assert.ok(foundComment, 'comment attribute should anchor the matched span');

        // Chat reply should mention the suggestion.
        const updatedAfterChat = await padManager.getPad(padId);
        const msgs = await updatedAfterChat.getChatMessages(
            chatHeadBefore + 1, updatedAfterChat.chatHead);
        const lastMsg = msgs[msgs.length - 1];
        assert.ok(/suggestion/i.test(lastMsg.text),
            `chat reply should mention "suggestion"; got: "${lastMsg.text}"`);
      });
});
```

- [ ] **Step 2: Run the test**

```bash
cd /home/jose/etherpad/etherpad-lite/src && \
  npx cross-env NODE_ENV=production mocha --import=tsx --timeout 120000 \
    node_modules/ep_ai_chat/static/tests/backend/specs/e2e_suggest.ts
```

Expected: 1 passing.

- [ ] **Step 3: Commit**

```bash
cd /home/jose/etherpad/plugins/ep_ai_chat && \
  git add static/tests/backend/specs/e2e_suggest.ts && \
  git commit -m "test: e2e — @ai suggest: creates comment, leaves pad unchanged

Closes part 5 of #4."
```

---

## Task 6: End-to-end test for per-request `@ai apply:` override

**Files:**
- Create: `static/tests/backend/specs/e2e_apply_override.ts`

- [ ] **Step 1: Create the test**

```ts
'use strict';

import {strict as assert} from 'assert';
import http from 'http';

const common = require('ep_etherpad-lite/tests/backend/common');
const {generateJWTToken} = common;
const randomString = require('ep_etherpad-lite/static/js/pad_utils').randomString;
const padManager = require('ep_etherpad-lite/node/db/PadManager');
const hooks = require('ep_etherpad-lite/static/js/pluginfw/hooks');
const commentManager = require('ep_comments_page/commentManager');

let mockLLM: http.Server;
let mockPort: number;

const startMockLLM = (): Promise<void> => new Promise((resolve) => {
  mockLLM = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      const editJson = JSON.stringify({
        action: 'edit',
        findText: 'Apply override target',
        replaceText: 'Apply override succeeded',
        explanation: 'Direct edit forced via override.',
      });
      const responseText = `\`\`\`json\n${editJson}\n\`\`\``;
      const isAnthropic = req.headers['x-api-key'] !== undefined;
      res.writeHead(200, {'Content-Type': 'application/json'});
      if (isAnthropic) {
        res.end(JSON.stringify({
          content: [{type: 'text', text: responseText}],
          usage: {input_tokens: 10, output_tokens: 8},
        }));
      } else {
        res.end(JSON.stringify({
          choices: [{message: {content: responseText}}],
          usage: {prompt_tokens: 10, completion_tokens: 8, total_tokens: 18},
        }));
      }
    });
  });
  mockLLM.listen(0, () => {
    const addr = mockLLM.address();
    mockPort = typeof addr === 'object' && addr ? addr.port : 0;
    resolve();
  });
});

const stopMockLLM = (): Promise<void> => new Promise((resolve) => {
  mockLLM.close(() => resolve());
});

let agent: any;
const apiVersion = 1;

describe('ep_ai_chat - end-to-end @ai apply: override', function () {
  before(async function () {
    agent = await common.init();
    await startMockLLM();

    const settings = require('ep_etherpad-lite/node/utils/Settings');
    settings.ep_ai_core = {
      apiBaseUrl: `http://127.0.0.1:${mockPort}`,
      apiKey: 'test-key',
      model: 'test-model',
      provider: 'openai',
      access: {defaultMode: 'full', pads: {}},
      chat: {
        trigger: '@ai',
        authorName: 'AI Assistant',
        maxContextChars: 50000,
        chatHistoryLength: 20,
        conversationBufferSize: 10,
        suggestionMode: 'suggest',  // global default is suggest …
      },
    };
    await hooks.aCallAll('loadSettings', {settings});
  });

  after(async function () {
    await stopMockLLM();
  });

  it('per-request "apply:" beats the global "suggest" setting', async function () {
    const padId = `test-e2e-apply-${randomString(10)}`;
    await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Apply override target`)
        .set('Authorization', await generateJWTToken());

    const requester = `a.alice_apply_${randomString(6)}`;
    const epAiChat = require('ep_ai_chat/index');

    await epAiChat.handleMessage('handleMessage', {
      message: {
        type: 'COLLABROOM',
        data: {
          type: 'CHAT_MESSAGE',
          message: {
            text: '@ai apply: just do it',
            authorId: requester,
            time: Date.now(),
          },
        },
      },
      sessionInfo: {authorId: requester, padId, readOnly: false},
      socket: {id: 'fake-socket'},
    });

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const updated = await padManager.getPad(padId);
    // Direct apply: text changed.
    assert.ok(updated.text().includes('Apply override succeeded'),
        `pad text should be the post-edit version; got: "${updated.text()}"`);

    // Direct apply: NO comment was created.
    const stored = await commentManager.getComments(padId);
    const ids = Object.keys(stored.comments);
    assert.equal(ids.length, 0,
        `expected no comments to be created when apply: overrides; got ${ids.length}`);
  });
});
```

- [ ] **Step 2: Run the test**

```bash
cd /home/jose/etherpad/etherpad-lite/src && \
  npx cross-env NODE_ENV=production mocha --import=tsx --timeout 120000 \
    node_modules/ep_ai_chat/static/tests/backend/specs/e2e_apply_override.ts
```

Expected: 1 passing.

- [ ] **Step 3: Commit**

```bash
cd /home/jose/etherpad/plugins/ep_ai_chat && \
  git add static/tests/backend/specs/e2e_apply_override.ts && \
  git commit -m "test: e2e — @ai apply: overrides global suggestionMode

Closes part 6 of #4."
```

---

## Task 7: Document the new settings + override syntax in README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a new section to `README.md` documenting suggestion mode**

Find the line in `README.md` that starts the "How Editing Works" section. Immediately *before* it, insert this new section:

```markdown
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
```

- [ ] **Step 2: Update the existing settings table**

Find the table in the existing "Configuration" section that lists `trigger`, `authorName`, etc. Add two new rows at the bottom:

```markdown
| `suggestionMode` | `auto` | Suggestion routing mode. See "Suggestion Mode" section. |
| `suggestionModePads` | `{}` | Per-pad suggestion-mode overrides. |
```

- [ ] **Step 3: Commit**

```bash
cd /home/jose/etherpad/plugins/ep_ai_chat && \
  git add README.md && \
  git commit -m "docs: explain suggestionMode + per-request overrides

Closes part 7 of #4."
```

---

## Task 8: Push the branch and open the PR

- [ ] **Step 1: Push**

```bash
cd /home/jose/etherpad/plugins/ep_ai_chat && \
  git push -u origin feat/ai-suggestion-mode
```

- [ ] **Step 2: Open the PR**

The branch is stacked on top of `feat/author-aware-ai-phase-a` (PR #5). Open the PR against `main` and explicitly note the dependency in the body so reviewers know to merge phase A first:

```bash
gh pr create --title "AI suggestion mode: review-before-apply via ep_comments_page" \
  --body "$(cat <<'EOF'
## Summary
- When `ep_comments_page` is installed, the AI now defaults to creating a `changeFrom`/`changeTo` suggestion comment instead of mutating the pad directly. Authors review changes via the existing Accept / Revert UI.
- New per-request override syntax: `@ai apply: …` always direct-edits, `@ai suggest: …` always suggests.
- New per-pad and global settings (`suggestionMode`, `suggestionModePads`) under `ep_ai_core.chat`. Cascade: per-request > per-pad > global > built-in `auto`.
- Soft dep — if `ep_comments_page` isn't installed, everything degrades to today's apply behavior with a one-line startup warning, and per-request `@ai suggest:` gets a chat reply explaining the missing dep.
- Builds on phase A (#5): the same `ep_ai_chat:requestedBy` provenance attribute is written on the suggestion span.

**Stacked on PR #5 — please merge phase A first.**

## Test plan
- [x] New backend tests: `chatHandler` (5 cases for override parsing), `suggestionMode` (13 cases for the resolver), `suggestEdit` (4 cases for anchor + persistence), `e2e_suggest` (handleMessage end-to-end), `e2e_apply_override` (per-request override beats global setting).
- [x] Pre-existing backend tests still pass.
- [x] Lint count unchanged.
- [ ] Manual smoke (deferred — requires real LLM credentials): exercise each branch in the spec's "Manual smoke test" section.

## Out of scope
- Per-user suggestion-mode preferences (deferred per design discussion).
- Multi-edit-per-comment grouping (each edit gets its own suggestion).
- A pad-creator UI for the per-pad setting (admin-only via `settings.json` for now).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Wait for CI and triage**

Per memory: wait ~20s after push, then check CI. If anything fails (and the failure is *new* — frontend tests have a pre-existing breakage on main; backend is intentionally skipped for same-repo PRs), root-cause and push a fix.

```bash
gh pr checks --watch
```

---

## Self-Review

**Spec coverage:**

- "Configuration cascade" → Task 2 (resolver) + Task 4 step 6 (calling it) ✓
- "Trigger parsing" → Task 1 ✓
- "Suggestion path" (suggestEdit + comment record + attribute changeset) → Task 3 ✓
- "Soft dep detection" → Task 4 steps 2–3 (probe + warn) and Task 4 step 6 (per-request fallback chat reply) ✓
- "Index.js wiring" → Task 4 ✓
- "Data flow" diagrams → covered implicitly across Tasks 1, 2, 3, 4
- "Error handling" — `findText` not in pad → Task 3 step 3; `commentManager` throws → Task 3 step 3 (wrapped try/catch); changeset throws → same; `socketio` missing → Task 3 step 3 (optional `io` parameter, broadcast guarded) ✓
- "Testing" — every test file in the spec has a creator/modifier task ✓
- "i18n" — explicitly out of scope; new strings stay literal to match existing pattern (no task needed) ✓
- "Out of scope" — none of these items appear in any task ✓

No spec gaps.

**Placeholder scan:** No `TBD`, no `add appropriate error handling`, no `similar to Task N`. Every code step shows the actual code; every command step shows the command and the expected output. The README block was templated rather than waved at.

**Type/signature consistency:**

- `extractMention(text, trigger) → {mentioned, query, override}` — same shape in Task 1 step 1 (test), Task 1 step 3 (impl), Task 4 step 5 (caller).
- `resolveSuggestionMode(padId, override, settings, depAvailable) → {mode, fellBackFromSuggest}` — same signature in Task 2 step 1 (tests), Task 2 step 3 (impl), Task 4 step 6 (caller).
- `suggestEdit(pad, edit, deps) → {success, commentId} | {success: false, error}` — same signature in Task 3 step 1 (tests), Task 3 step 3 (impl), Task 4 step 7 (caller).
- `commentsModulesCache = {commentManager, shared, depAvailable}` — same shape in Task 4 step 1 (declaration), step 2 (writer), step 3 (warning check), step 6 (resolver argument), step 7 (deps construction).
- Property name `requesterAuthorId` — same string in suggestEdit's deps (Task 3) and the index.js call site (Task 4 step 7).
- Attribute key `'ep_ai_chat:requestedBy'` — written in Task 3 step 3, asserted in Task 3 step 1 and the e2e_suggest spec (Task 5 step 1).

No drift detected.
