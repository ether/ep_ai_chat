'use strict';

import {strict as assert} from 'assert';

const common = require('ep_etherpad-lite/tests/backend/common');
const {generateJWTToken} = common;
const randomString = require('ep_etherpad-lite/static/js/pad_utils').randomString;
const padManager = require('ep_etherpad-lite/node/db/PadManager');

const padEditor = require('../../../../padEditor');

let agent: any;
const apiVersion = 1;

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
  });
});
