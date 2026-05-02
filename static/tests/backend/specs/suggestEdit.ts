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
      io: null,
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
        if (key === 'comment' && value === result.commentId) {
          foundComment = true;
        }
        if (key === 'ep_ai_chat:requestedBy' && value === requester) {
          foundProvenance = true;
        }
      }
    }
    assert.ok(foundComment, `comment attribute ${result.commentId} should anchor the span`);
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
