'use strict';

import {strict as assert} from 'assert';

const common = require('ep_etherpad-lite/tests/backend/common');
const {generateJWTToken} = common;
const randomString = require('ep_etherpad-lite/static/js/pad_utils').randomString;
const padManager = require('ep_etherpad-lite/node/db/PadManager');

const contextBuilder = require('../../../../contextBuilder');

let agent: any;
const apiVersion = 1;

describe('ep_ai_chat - contextBuilder', function () {
  before(async function () {
    agent = await common.init();
  });

  describe('buildContext', function () {
    it('returns messages with system prompt and pad content', async function () {
      const padId = `test-ctx-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Test content here`)
          .set('Authorization', await generateJWTToken());

      const pad = await padManager.getPad(padId);
      const settings = {systemPrompt: 'You are a helpful editor.', maxContextChars: 50000, chatHistoryLength: 20};
      const messages = await contextBuilder.buildContext(pad, padId, 'What is this?', [], settings, 'full');

      assert.ok(Array.isArray(messages));
      assert.equal(messages[0].role, 'system');
      assert.ok(messages[0].content.includes('helpful editor'));
      const all = messages.map((m: any) => m.content).join(' ');
      assert.ok(all.includes('Test content here'));
      assert.equal(messages[messages.length - 1].role, 'user');
    });

    it('includes readOnly constraint in system prompt', async function () {
      const padId = `test-ctx-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Read only`)
          .set('Authorization', await generateJWTToken());

      const pad = await padManager.getPad(padId);
      const settings = {systemPrompt: 'Helper.', maxContextChars: 50000, chatHistoryLength: 20};
      const messages = await contextBuilder.buildContext(pad, padId, 'Edit this', [], settings, 'readOnly');

      assert.ok(messages[0].content.includes('READ-ONLY'));
    });

    it('includes conversation history', async function () {
      const padId = `test-ctx-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Pad`)
          .set('Authorization', await generateJWTToken());

      const pad = await padManager.getPad(padId);
      const settings = {systemPrompt: 'Hi.', maxContextChars: 50000, chatHistoryLength: 20};
      const history = [{role: 'user', content: 'Prev Q'}, {role: 'assistant', content: 'Prev A'}];
      const messages = await contextBuilder.buildContext(pad, padId, 'Follow up', history, settings, 'full');

      const all = messages.map((m: any) => m.content).join(' ');
      assert.ok(all.includes('Prev Q'));
      assert.ok(all.includes('Prev A'));
    });

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
  });
});
