# Author-Aware AI — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell the LLM which author is asking on every chat request, and stamp every AI-applied edit with an `ep_ai_chat:requestedBy` provenance attribute so phase B can resolve "my writing" precisely.

**Architecture:** Two surgical changes inside the existing plugin: (1) `contextBuilder.js` accepts a `requester` object and appends an identity sentence to the document/authorship system message; (2) `padEditor.js` accepts `edit.requesterAuthorId` and adds a namespaced `ep_ai_chat:requestedBy` attribute alongside the existing `author` attribute. `index.js` threads the requester through both call sites. No new files of production code; tests added inline to the existing TS specs.

**Tech Stack:** Node.js (CommonJS), Etherpad core's Changeset API, Mocha + TS-based backend tests run via `npx cross-env NODE_ENV=production mocha --import=tsx`.

---

## File Structure

**Production code (modify):**
- `contextBuilder.js` — add `requester` parameter, append identity sentence
- `padEditor.js` — accept `edit.requesterAuthorId`, add namespaced attribute
- `index.js` — look up requester name, thread it into both calls

**Tests (modify, add cases to existing files):**
- `static/tests/backend/specs/contextBuilder.ts` — speaker identity assertions
- `static/tests/backend/specs/padEditor.ts` — provenance attribute assertions

No new files needed; the changes are small enough that adding files would be over-decomposition.

---

## Task 1: Speaker identity in `buildContext`

**Files:**
- Modify: `contextBuilder.js`
- Test:   `static/tests/backend/specs/contextBuilder.ts`

- [ ] **Step 1: Write the failing test (append to the `describe('buildContext', ...)` block in `static/tests/backend/specs/contextBuilder.ts`)**

```ts
    it('includes requester name and authorId in the system context', async function () {
      const padId = `test-ctx-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Hello`)
          .set('Authorization', await generateJWTToken());

      const pad = await padManager.getPad(padId);
      const settings = {systemPrompt: 'Helper.', maxContextChars: 50000, chatHistoryLength: 20};
      const requester = {authorId: 'a.alice123', name: 'Alice'};
      const messages = await contextBuilder.buildContext(
          pad, padId, 'edit my writing', [], settings, 'full', null, requester);

      const systemContent = messages
          .filter((m: any) => m.role === 'system')
          .map((m: any) => m.content)
          .join(' ');
      assert.ok(systemContent.includes('Alice'),
          `system content should mention requester name; got: ${systemContent}`);
      assert.ok(systemContent.includes('a.alice123'),
          `system content should mention requester authorId; got: ${systemContent}`);
    });

    it('falls back to Anonymous when requester name is missing', async function () {
      const padId = `test-ctx-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Hello`)
          .set('Authorization', await generateJWTToken());

      const pad = await padManager.getPad(padId);
      const settings = {systemPrompt: 'Helper.', maxContextChars: 50000, chatHistoryLength: 20};
      const requester = {authorId: 'a.unknown', name: null};
      const messages = await contextBuilder.buildContext(
          pad, padId, 'who am I?', [], settings, 'full', null, requester);

      const systemContent = messages
          .filter((m: any) => m.role === 'system')
          .map((m: any) => m.content)
          .join(' ');
      assert.ok(systemContent.includes('Anonymous'),
          `system content should fall back to "Anonymous"; got: ${systemContent}`);
    });

    it('omits the identity sentence when requester is undefined (back-compat)', async function () {
      const padId = `test-ctx-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Hello`)
          .set('Authorization', await generateJWTToken());

      const pad = await padManager.getPad(padId);
      const settings = {systemPrompt: 'Helper.', maxContextChars: 50000, chatHistoryLength: 20};
      const messages = await contextBuilder.buildContext(
          pad, padId, 'hi', [], settings, 'full');

      const systemContent = messages
          .filter((m: any) => m.role === 'system')
          .map((m: any) => m.content)
          .join(' ');
      assert.ok(!/currently chatting with you/i.test(systemContent),
          'should not include identity sentence when no requester is provided');
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run from the etherpad-lite checkout where the plugin is installed (see `memory/reference_running_tests.md`):

```bash
cd /home/jose/etherpad/etherpad-lite/src && \
  npx cross-env NODE_ENV=production mocha --import=tsx --timeout 120000 \
    node_modules/ep_ai_chat/static/tests/backend/specs/contextBuilder.ts
```

Expected: the three new tests fail. The first two should fail because the system content does not include "Alice"/"a.alice123"/"Anonymous"; the third should pass already (no identity sentence yet).

- [ ] **Step 3: Implement `requester` support in `contextBuilder.js`**

Replace the function signature and the document-content message in `contextBuilder.js`. Full replacement of `buildContext`:

```js
const buildContext = async (
    pad, padId, userMessage, conversationHistory, chatSettings,
    accessMode, selection, requester) => {
  const messages = [];
  const maxChars = chatSettings.maxContextChars || 50000;

  // System prompt with security boundary
  let systemPrompt = chatSettings.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  if (accessMode === 'readOnly') {
    systemPrompt += '\n\nIMPORTANT: You have READ-ONLY access to this pad. You cannot edit it. If asked to make changes, explain that you can only read and discuss the content.';
  }
  messages.push({role: 'system', content: systemPrompt});

  // Pad content (truncated if needed) — clearly delimited as data
  let padText = pad.text();
  const contentBudget = Math.floor(maxChars * 0.6);
  if (padText.length > contentBudget) {
    padText = padText.substring(0, contentBudget) + '\n...[truncated]';
  }

  // Authorship summary
  let authorshipSummary = '';
  try {
    const contributors = epAiCore.authorship.getPadContributors(pad);
    if (contributors.contributors.length > 0) {
      const lines = [];
      for (const c of contributors.contributors) {
        const name = c.authorId ? await authorManager.getAuthorName(c.authorId) || c.authorId : 'Unknown';
        lines.push(`- ${name}: ${c.percentage}% (${c.charCount} chars)`);
      }
      authorshipSummary = `\n\nAuthors:\n${lines.join('\n')}`;
    }
  } catch { /* proceed without authorship */ }

  // Speaker identity — only added when the caller supplies a requester.
  let identitySuffix = '';
  if (requester && requester.authorId) {
    const displayName = requester.name || 'Anonymous';
    identitySuffix =
        `\n\nThe user currently chatting with you is "${displayName}" ` +
        `(authorId: ${requester.authorId}). When they say "I", "me", or "my", ` +
        'they mean this user.';
  }

  // Wrap document content in clear boundaries
  messages.push({
    role: 'system',
    content:
        `--- BEGIN DOCUMENT (pad: ${padId}) ---\n${padText}\n--- END DOCUMENT ---` +
        `${authorshipSummary}${identitySuffix}`,
  });

  // Conversation history
  for (const entry of conversationHistory) {
    messages.push({role: entry.role, content: entry.content});
  }

  // If the user has text selected, include it as context
  let userContent = userMessage;
  if (selection && selection.text) {
    userContent = `[The user has selected the following text in the document: "${selection.text}"]\n\n${userMessage}`;
  }

  // User message (from chat)
  messages.push({role: 'user', content: userContent});

  return messages;
};
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/jose/etherpad/etherpad-lite/src && \
  npx cross-env NODE_ENV=production mocha --import=tsx --timeout 120000 \
    node_modules/ep_ai_chat/static/tests/backend/specs/contextBuilder.ts
```

Expected: all `buildContext` tests pass, including the three new ones and the three pre-existing ones.

- [ ] **Step 5: Commit**

```bash
cd /home/jose/etherpad/plugins/ep_ai_chat && \
  git add contextBuilder.js static/tests/backend/specs/contextBuilder.ts && \
  git commit -m "feat: pass requesting author identity into LLM context

Closes part 1 of phase A for #3."
```

---

## Task 2: Provenance attribute in `applyEdit`

**Files:**
- Modify: `padEditor.js`
- Test:   `static/tests/backend/specs/padEditor.ts`

- [ ] **Step 1: Write the failing tests (append to the `describe('applyEdit', ...)` block in `static/tests/backend/specs/padEditor.ts`)**

```ts
    it('stamps ep_ai_chat:requestedBy on the edited span when requesterAuthorId is provided',
        async function () {
          const padId = `test-edit-${randomString(10)}`;
          await agent.get(
              `/api/${apiVersion}/createPad?padID=${padId}&text=Provenance test text`)
              .set('Authorization', await generateJWTToken());

          const pad = await padManager.getPad(padId);
          const aiAuthor = 'a.test_ai_prov';
          const requester = 'a.alice_prov';
          const result = await padEditor.applyEdit(pad, {
            findText: 'Provenance test text',
            replaceText: 'Provenance applied here',
            authorId: aiAuthor,
            requesterAuthorId: requester,
          });
          assert.ok(result.success, `edit should succeed; got: ${JSON.stringify(result)}`);

          const updatedPad = await padManager.getPad(padId);
          const pool = updatedPad.pool;

          let foundProvenance = false;
          for (const key in pool.numToAttrib) {
            const [attrKey, attrVal] = pool.numToAttrib[key];
            if (attrKey === 'ep_ai_chat:requestedBy' && attrVal === requester) {
              foundProvenance = true;
            }
          }
          assert.ok(foundProvenance,
              'ep_ai_chat:requestedBy should be in the attribute pool with the requester id');

          // And the attribute should be on the edited span itself, not just in the pool.
          const atext = updatedPad.atext;
          let onSpan = false;
          for (const op of Changeset.deserializeOps(atext.attribs)) {
            for (const [key, value] of attribsFromString(op.attribs, pool)) {
              if (key === 'ep_ai_chat:requestedBy' && value === requester) {
                onSpan = true;
              }
            }
          }
          assert.ok(onSpan, 'ep_ai_chat:requestedBy should be applied to the edited span');
        });

    it('omits the provenance attribute when requesterAuthorId is missing',
        async function () {
          const padId = `test-edit-${randomString(10)}`;
          await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=No prov here`)
              .set('Authorization', await generateJWTToken());

          const pad = await padManager.getPad(padId);
          const result = await padEditor.applyEdit(pad, {
            findText: 'No prov here',
            replaceText: 'Replaced cleanly',
            authorId: 'a.test_ai_noprov',
          });
          assert.ok(result.success);

          const updatedPad = await padManager.getPad(padId);
          for (const key in updatedPad.pool.numToAttrib) {
            const [attrKey] = updatedPad.pool.numToAttrib[key];
            assert.notEqual(attrKey, 'ep_ai_chat:requestedBy',
                'no provenance attribute should be added when requesterAuthorId is absent');
          }
        });

    it('still applies the edit when requesterAuthorId is present but authorId is missing',
        async function () {
          const padId = `test-edit-${randomString(10)}`;
          await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Prov only here`)
              .set('Authorization', await generateJWTToken());

          const pad = await padManager.getPad(padId);
          const result = await padEditor.applyEdit(pad, {
            findText: 'Prov only here',
            replaceText: 'Replaced anyway',
            requesterAuthorId: 'a.alice_only',
          });
          assert.ok(result.success,
              `edit should succeed without authorId; got: ${JSON.stringify(result)}`);

          const updated = await padManager.getPad(padId);
          assert.ok(updated.text().includes('Replaced anyway'));
        });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/jose/etherpad/etherpad-lite/src && \
  npx cross-env NODE_ENV=production mocha --import=tsx --timeout 120000 \
    node_modules/ep_ai_chat/static/tests/backend/specs/padEditor.ts
```

Expected: the new "stamps ep_ai_chat:requestedBy" test fails because no such attribute is being written; the "omits" test passes already; the "still applies the edit when requesterAuthorId is present but authorId is missing" test may pass already (current code uses `attribs = undefined` when authorId is falsy, and the edit still goes through). Confirm by reading the output — the test must surface a real gap (the first one) before moving on.

- [ ] **Step 3: Implement provenance support in `padEditor.js`**

Replace the body of `applyEdit` in `padEditor.js`. Full replacement:

```js
const applyEdit = async (pad, edit) => {
  const currentText = pad.text();
  const authorId = edit.authorId || '';

  try {
    // Build attributes: author for color/attribution, ep_ai_chat:requestedBy
    // for provenance so phase B can resolve "my writing" later.
    const attribList = [];
    if (authorId) attribList.push(['author', authorId]);
    if (edit.requesterAuthorId) {
      attribList.push(['ep_ai_chat:requestedBy', edit.requesterAuthorId]);
    }
    const attribs = attribList.length ? attribList : undefined;
    const pool = attribs ? pad.pool : undefined;

    let changeset;

    if (edit.appendText) {
      const insertPos = currentText.length - 1;
      changeset = Changeset.makeSplice(currentText, insertPos, 0, edit.appendText, attribs, pool);
    } else if (edit.findText && edit.replaceText !== undefined) {
      const idx = currentText.indexOf(edit.findText);
      if (idx === -1) return {success: false, error: `Text not found: "${edit.findText.substring(0, 100)}"`};
      changeset = Changeset.makeSplice(currentText, idx, edit.findText.length, edit.replaceText, attribs, pool);
    } else {
      return {success: false, error: 'No valid edit operation specified'};
    }

    await pad.appendRevision(changeset, authorId);
    await padMessageHandler.updatePadClients(pad);

    // Announce AI as an author so it appears in the user list
    if (authorId) await announceAiAuthor(pad.id, authorId);

    return {success: true};
  } catch (err) {
    logger.error(`Edit failed: ${err.message}`);
    return {success: false, error: err.message};
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/jose/etherpad/etherpad-lite/src && \
  npx cross-env NODE_ENV=production mocha --import=tsx --timeout 120000 \
    node_modules/ep_ai_chat/static/tests/backend/specs/padEditor.ts
```

Expected: all `applyEdit` tests pass, including the three new provenance tests and all pre-existing ones.

- [ ] **Step 5: Commit**

```bash
cd /home/jose/etherpad/plugins/ep_ai_chat && \
  git add padEditor.js static/tests/backend/specs/padEditor.ts && \
  git commit -m "feat: stamp ep_ai_chat:requestedBy on AI-applied edits

Records which user requested each AI edit so a future phase B can
resolve 'my writing' to author + AI-on-behalf-of-author spans.
Closes part 2 of phase A for #3."
```

---

## Task 3: Thread requester through `index.js`

**Files:**
- Modify: `index.js`

This task wires the production path: look up the requesting author's name, pass it into `buildContext`, and pass `requesterAuthorId` into `applyEdit`. There is no new unit test for this task; the wiring is exercised end-to-end by the existing `e2e.ts` spec (which already drives chat → AI → edit) plus the manual smoke test below.

- [ ] **Step 1: Modify `index.js` — add a small name-lookup helper**

In `index.js`, after the existing `getAiAuthorId` definition (around line 77), add:

```js
const getRequesterDisplayName = async (authorId) => {
  if (!authorId) return 'Anonymous';
  try {
    const name = await authorManager.getAuthorName(authorId);
    return name || 'Anonymous';
  } catch {
    return 'Anonymous';
  }
};
```

- [ ] **Step 2: Modify `index.js` — pass `requester` into `buildContext`**

Find the `decideMessages = await buildContext(...)` call (around line 160). Replace the surrounding block so that the requester is built and passed through. Full replacement of the `setImmediate` body up to and including the `buildContext` call:

```js
  setImmediate(async () => {
    try {
      const pad = await padManager.getPad(padId);
      const currentText = pad.text();
      const conversation = getConversation(padId);

      const llmConfig = {
        apiBaseUrl: aiSettings.apiBaseUrl,
        apiKey: aiSettings.apiKey,
        model: aiSettings.model,
        maxTokens: aiSettings.maxTokens,
        provider: aiSettings.provider,
      };
      const client = epAiCore.llmClient.create(llmConfig);

      const requesterName = await getRequesterDisplayName(requestAuthor);
      const requester = {
        authorId: requestAuthor || 'unknown',
        name: requesterName,
      };

      // Step 1: Ask the AI to decide — respond with JSON that either
      // contains an edit action or just a chat reply
      const decideMessages = await buildContext(
          pad, padId, query, conversation, chatSettings, accessMode, selection, requester,
      );
```

(`requestAuthor` is already in scope from line 138.) Leave everything after this line unchanged until you reach the `applyEdit` call in the next step.

- [ ] **Step 3: Modify `index.js` — pass `requesterAuthorId` into `applyEdit`**

Find the `editData.authorId = await getAiAuthorId();` line (around line 192). Add the requester immediately after it:

```js
            editData.authorId = await getAiAuthorId();
            editData.requesterAuthorId = requestAuthor;
            const editResult = await applyEdit(pad, editData);
```

- [ ] **Step 4: Run the full backend suite to confirm nothing regressed**

```bash
cd /home/jose/etherpad/etherpad-lite/src && \
  npx cross-env NODE_ENV=production mocha --import=tsx --timeout 120000 \
    node_modules/ep_ai_chat/static/tests/backend/specs/**/*.ts
```

Expected: all tests pass — `chatHandler`, `contextBuilder` (with new cases), `padEditor` (with new cases), `selection`, `security`, and `e2e`.

- [ ] **Step 5: Lint**

```bash
cd /home/jose/etherpad/plugins/ep_ai_chat && pnpm run lint
```

Expected: clean. Fix anything reported.

- [ ] **Step 6: Manual smoke test (per memory: test localized output, not just element presence)**

Start the dev server with the plugin installed (see `memory/reference_running_tests.md`):

```bash
cd /home/jose/etherpad/etherpad-lite && pnpm run dev
```

Open two browser sessions to the same pad as different authors (set names via the user pane). From each, send a chat message: `@ai who am I and what should I call you?`. Verify each reply addresses the correct user by name. Then from one session send `@ai improve this text` and confirm the edit lands and is attributed to the AI in the user list.

Document the outcome in the PR description. If a manual step fails, do not mark the task complete — fix and re-test.

- [ ] **Step 7: Commit**

```bash
cd /home/jose/etherpad/plugins/ep_ai_chat && \
  git add index.js && \
  git commit -m "feat: thread requesting author through chat handler

Looks up the requesting author's name and passes both name and
authorId into buildContext, and forwards the requester's authorId
into applyEdit so AI edits carry provenance.
Closes phase A for #3."
```

---

## Task 4: Push branch and open PR

- [ ] **Step 1: Push the feature branch**

```bash
cd /home/jose/etherpad/plugins/ep_ai_chat && \
  git push -u origin feat/author-aware-ai-phase-a
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "Phase A: author-aware AI (speaker identity + edit provenance)" \
  --body "$(cat <<'EOF'
## Summary
- Pass the requesting author's name and authorId into the LLM context so the AI knows who is asking and can resolve "I"/"me"/"my" correctly.
- Stamp every AI-applied edit with an `ep_ai_chat:requestedBy` attribute so a future phase B can identify "my writing" precisely (own characters + AI-on-behalf-of-me characters).

Phase A of issue #3. Phase B (per-author span extraction in context) will follow in a separate PR.

## Test plan
- [ ] Backend tests pass — `contextBuilder.ts` (3 new cases), `padEditor.ts` (3 new cases), and the rest of the suite green.
- [ ] Manual smoke: two browser sessions chat as different authors; the AI addresses each by name; an edit by user A carries `ep_ai_chat:requestedBy = a.<A>` in the pad's attribute pool.
- [ ] `pnpm run lint` clean.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Wait for CI and triage**

Per memory: wait ~20s after push, check CI, fix failures immediately. Per memory: trust CI for major dep bumps, but for own changes investigate any failure root-cause-first.

```bash
sleep 20 && gh pr checks --watch
```

If anything fails, fix on the same branch and push again. Do not merge until both backend and frontend test workflows are green.

- [ ] **Step 4: Triage Qodo review (per memory)**

Once Qodo posts review comments, fetch them and either fix or reply to each:

```bash
gh api repos/ether/ep_ai_chat/pulls/$(gh pr view --json number -q .number)/comments
```

Address every Qodo comment before requesting human review.

---

## Self-Review

**Spec coverage:**

- "Speaker identity in LLM context" → Task 1 ✓
- "Provenance attribute on AI edits" → Task 2 ✓
- "Bob-edits-Alice → attribute to Bob" semantic → encoded in Task 2's attribute write (the requesterAuthorId is always the chat-message sender, regardless of whose text is edited) ✓
- "Anonymous fallback" → Task 1 step 1 has a dedicated test, Task 3 step 1 has the fallback in `getRequesterDisplayName` ✓
- "Best-effort, never block an edit" → Task 2 step 3 keeps `attribs = undefined` when nothing to write ✓
- "Backend tests gate the PR" → Task 3 step 4 runs the full suite, Task 4 waits on CI ✓
- "Manual smoke test" → Task 3 step 6 ✓

**Placeholder scan:** No TBDs, no "add appropriate error handling" hand-waving. Every code step has the actual code. Every command step has the actual command and the expected outcome.

**Type/signature consistency:**

- `buildContext(pad, padId, userMessage, conversationHistory, chatSettings, accessMode, selection, requester)` — same signature in Task 1 step 3 (impl), Task 1 step 1 (test calls it positionally), and Task 3 step 2 (production caller).
- `requester = {authorId, name}` — same shape in Task 1 step 1 tests, Task 1 step 3 implementation, and Task 3 step 2 production wiring.
- `edit.requesterAuthorId` — same property name in Task 2 step 1 tests, Task 2 step 3 implementation, and Task 3 step 3 production wiring.
- Attribute key `'ep_ai_chat:requestedBy'` — same string in Task 2 step 1 test assertions and Task 2 step 3 implementation.

No drift detected.
