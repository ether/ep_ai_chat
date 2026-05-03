'use strict';

import {strict as assert} from 'assert';

const common = require('ep_etherpad-lite/tests/backend/common');
const {generateJWTToken} = common;
const randomString = require('ep_etherpad-lite/static/js/pad_utils').randomString;
const padManager = require('ep_etherpad-lite/node/db/PadManager');

const padMessageHandler = require('ep_etherpad-lite/node/handler/PadMessageHandler');
const Changeset = require('ep_etherpad-lite/static/js/Changeset');
const {attribsFromString} = require('ep_etherpad-lite/static/js/attributes');

const padEditor = require('../../../../padEditor');

let agent: any;
const apiVersion = 1;

// Track updatePadClients calls
let updatePadClientsCalled = false;
const origUpdatePadClients = padMessageHandler.updatePadClients;


describe('ep_ai_chat - padEditor', function () {
  before(async function () {
    agent = await common.init();
  });

  describe('applyEdit', function () {
    it('replaces matched text', async function () {
      const padId = `test-edit-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=The quick brown fox`)
          .set('Authorization', await generateJWTToken());

      const pad = await padManager.getPad(padId);
      const result = await padEditor.applyEdit(pad, {findText: 'quick brown', replaceText: 'slow red'});

      assert.ok(result.success);
      const updated = await padManager.getPad(padId);
      assert.ok(updated.text().includes('slow red'));
      assert.ok(!updated.text().includes('quick brown'));
    });

    it('returns false when text not found', async function () {
      const padId = `test-edit-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Hello`)
          .set('Authorization', await generateJWTToken());

      const pad = await padManager.getPad(padId);
      const result = await padEditor.applyEdit(pad, {findText: 'nope', replaceText: 'x'});

      assert.equal(result.success, false);
      assert.ok(result.error.includes('not found'));
    });

    it('attributes edit to specified author', async function () {
      const padId = `test-edit-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Original text`)
          .set('Authorization', await generateJWTToken());

      const pad = await padManager.getPad(padId);
      await padEditor.applyEdit(pad, {findText: 'Original', replaceText: 'Modified', authorId: 'a.test_ai'});

      const rev = pad.getHeadRevisionNumber();
      const revAuthor = await pad.getRevisionAuthor(rev);
      assert.equal(revAuthor, 'a.test_ai');
    });

    it('handles append', async function () {
      const padId = `test-edit-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=First line`)
          .set('Authorization', await generateJWTToken());

      const pad = await padManager.getPad(padId);
      await padEditor.applyEdit(pad, {appendText: '\nSecond line'});

      const updated = await padManager.getPad(padId);
      assert.ok(updated.text().includes('Second line'));
    });

    it('calls updatePadClients to broadcast changes to connected clients', async function () {
      const padId = `test-edit-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Broadcast test`)
          .set('Authorization', await generateJWTToken());

      // Spy on updatePadClients
      updatePadClientsCalled = false;
      padMessageHandler.updatePadClients = async (pad: any) => {
        updatePadClientsCalled = true;
        // Call original so it doesn't break anything
        return origUpdatePadClients(pad);
      };

      const pad = await padManager.getPad(padId);
      await padEditor.applyEdit(pad, {findText: 'Broadcast', replaceText: 'Live'});

      assert.ok(updatePadClientsCalled, 'updatePadClients should be called after edit');

      // Restore original
      padMessageHandler.updatePadClients = origUpdatePadClients;
    });

    it('calls updatePadClients for append edits too', async function () {
      const padId = `test-edit-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Start`)
          .set('Authorization', await generateJWTToken());

      updatePadClientsCalled = false;
      padMessageHandler.updatePadClients = async (pad: any) => {
        updatePadClientsCalled = true;
        return origUpdatePadClients(pad);
      };

      const pad = await padManager.getPad(padId);
      await padEditor.applyEdit(pad, {appendText: '\nAppended'});

      assert.ok(updatePadClientsCalled, 'updatePadClients should be called after append');

      padMessageHandler.updatePadClients = origUpdatePadClients;
    });

    it('does NOT call updatePadClients when edit fails', async function () {
      const padId = `test-edit-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Hello`)
          .set('Authorization', await generateJWTToken());

      updatePadClientsCalled = false;
      padMessageHandler.updatePadClients = async (pad: any) => {
        updatePadClientsCalled = true;
        return origUpdatePadClients(pad);
      };

      const pad = await padManager.getPad(padId);
      await padEditor.applyEdit(pad, {findText: 'nonexistent', replaceText: 'x'});

      assert.ok(!updatePadClientsCalled, 'updatePadClients should NOT be called when edit fails');

      padMessageHandler.updatePadClients = origUpdatePadClients;
    });

    it('applies author attributes so replaced text is colored', async function () {
      const padId = `test-edit-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Color me`)
          .set('Authorization', await generateJWTToken());

      const pad = await padManager.getPad(padId);
      const authorId = 'a.ai_color_test';
      await padEditor.applyEdit(pad, {findText: 'Color me', replaceText: 'Colored!', authorId});

      // Check that the pad's atext has author attributes for the new text
      const updatedPad = await padManager.getPad(padId);
      const atext = updatedPad.atext;
      const pool = updatedPad.pool;

      // Walk the attribs and find author attribution
      let foundAuthor = false;
      for (const op of Changeset.deserializeOps(atext.attribs)) {
        for (const [key, value] of attribsFromString(op.attribs, pool)) {
          if (key === 'author' && value === authorId) {
            foundAuthor = true;
          }
        }
      }
      assert.ok(foundAuthor, `Author ${authorId} should be in the atext attributes`);
    });

    it('preserves the original author on unchanged words inside an AI edit',
        async function () {
          // Seed the pad with text written by Alice. Then ask the AI to do a
          // surgical rewrite that swaps two short phrases. Words that exist
          // verbatim in both findText and replaceText must keep Alice's
          // author attribution — only the genuinely-changed runs should be
          // tagged with the AI author.
          const padId = `test-edit-${randomString(10)}`;
          const aliceId = 'a.alice_surgical';
          const aiId = 'a.ai_surgical';

          // Create empty pad, then write Alice's content via her own
          // changeset so her author attribute lands on every char.
          await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=`)
              .set('Authorization', await generateJWTToken());
          const seed = 'we would love to play more football at recess';
          {
            const pad = await padManager.getPad(padId);
            const cs = Changeset.makeSplice(
                pad.text(), 0, pad.text().length - 1, seed,
                [['author', aliceId]], pad.pool);
            await pad.appendRevision(cs, aliceId);
          }

          // AI rewrites: only "love" -> "deeply appreciate the chance" and
          // "at" -> "during" change. Surrounding words are byte-identical.
          const rewritten =
              'we would deeply appreciate the chance to play more football during recess';
          const pad = await padManager.getPad(padId);
          const result = await padEditor.applyEdit(pad, {
            findText: seed,
            replaceText: rewritten,
            authorId: aiId,
          });
          assert.ok(result.success, `edit should succeed; got ${JSON.stringify(result)}`);

          const updated = await padManager.getPad(padId);
          assert.ok(updated.text().includes(rewritten),
              `replacement should be visible; got "${updated.text()}"`);

          // Walk the atext and group consecutive runs by their author
          // attribute. We expect Alice's author to be present on at least
          // one run, the AI's on at least one run, and the unchanged
          // tail "recess" to live in an Alice-authored run.
          const pool = updated.pool;
          const text = updated.text();
          let cursor = 0;
          const runs: Array<{text: string; author: string}> = [];
          for (const op of Changeset.deserializeOps(updated.atext.attribs)) {
            let author = '';
            for (const [key, value] of attribsFromString(op.attribs, pool)) {
              if (key === 'author') author = value;
            }
            const slice = text.substring(cursor, cursor + op.chars);
            cursor += op.chars;
            runs.push({text: slice, author});
          }

          const findRunCovering = (substr: string) =>
              runs.find((r) => r.text.includes(substr));

          // Unchanged words must still be Alice's.
          assert.equal(findRunCovering('we would')?.author, aliceId,
              'unchanged "we would" should still be authored by Alice');
          assert.equal(findRunCovering('to play more football')?.author, aliceId,
              'unchanged "to play more football" should still be authored by Alice');
          assert.equal(findRunCovering('recess')?.author, aliceId,
              'unchanged "recess" should still be authored by Alice');

          // The genuinely-new phrases must be the AI's.
          assert.equal(findRunCovering('deeply appreciate')?.author, aiId,
              'new "deeply appreciate" run should be authored by the AI');
          assert.equal(findRunCovering('during')?.author, aiId,
              'new "during" run should be authored by the AI');
        });

    it('applies author attributes for appended text', async function () {
      const padId = `test-edit-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Base`)
          .set('Authorization', await generateJWTToken());

      const pad = await padManager.getPad(padId);
      const authorId = 'a.ai_append_test';
      await padEditor.applyEdit(pad, {appendText: '\nNew content', authorId});

      const updatedPad = await padManager.getPad(padId);
      const pool = updatedPad.pool;

      // Check that the author is in the pool
      let foundInPool = false;
      for (const key in pool.numToAttrib) {
        const [attrKey, attrVal] = pool.numToAttrib[key];
        if (attrKey === 'author' && attrVal === authorId) {
          foundInPool = true;
        }
      }
      assert.ok(foundInPool, `Author ${authorId} should be in the attribute pool`);
    });

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
  });
});
