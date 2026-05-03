'use strict';

import {strict as assert} from 'assert';

/**
 * The chatPrefillFromUser client hook — exercised here as a plain
 * function (it's a CommonJS export from static/js/index.js) with a
 * stubbed `window.clientVars`. Lets us cover the AI-vs-human branch
 * without standing up a browser.
 *
 * The companion frontend test in Etherpad core (#7660) covers what
 * the browser actually does with the returned string.
 */

const Module = require('module');

// The static/js client bundle requires nothing Node-specific, so we
// can require it directly. But it reads `window.clientVars`; install
// a global shim before requiring.
const installWindowShim = (clientVars: any) => {
  // @ts-ignore
  global.window = {clientVars};
};

const clearWindowShim = () => {
  // @ts-ignore
  delete global.window;
  // Drop the client module from the require cache so a follow-up
  // require() re-reads it under the new shim.
  const path = require.resolve('../../../../static/js/index');
  delete Module._cache[path];
};

describe('ep_ai_chat - chatPrefillFromUser hook handler', function () {
  afterEach(() => clearWindowShim());

  it('returns the configured trigger when the clicked user is the AI', function (done) {
    installWindowShim({ep_ai_chat: {trigger: '@ai', authorId: 'a.ai_42'}});
    const {chatPrefillFromUser} = require('../../../../static/js/index');
    chatPrefillFromUser('chatPrefillFromUser', {
      authorId: 'a.ai_42',
      name: 'AI Assistant',
      prefill: '@AI_Assistant ',
    }, (out: any) => {
      assert.equal(out, '@ai ');
      done();
    });
  });

  it('respects a custom trigger string', function (done) {
    installWindowShim({ep_ai_chat: {trigger: '@bot', authorId: 'a.ai_99'}});
    const {chatPrefillFromUser} = require('../../../../static/js/index');
    chatPrefillFromUser('chatPrefillFromUser', {
      authorId: 'a.ai_99',
      name: 'AI Assistant',
      prefill: '@AI_Assistant ',
    }, (out: any) => {
      assert.equal(out, '@bot ');
      done();
    });
  });

  it('falls back to default ("@ai ") if trigger is missing', function (done) {
    installWindowShim({ep_ai_chat: {authorId: 'a.ai_42'}});
    const {chatPrefillFromUser} = require('../../../../static/js/index');
    chatPrefillFromUser('chatPrefillFromUser', {
      authorId: 'a.ai_42', name: 'AI Assistant', prefill: '@AI_Assistant ',
    }, (out: any) => {
      assert.equal(out, '@ai ');
      done();
    });
  });

  it('returns nothing for a non-AI author so core uses its default', function (done) {
    installWindowShim({ep_ai_chat: {trigger: '@ai', authorId: 'a.ai_42'}});
    const {chatPrefillFromUser} = require('../../../../static/js/index');
    chatPrefillFromUser('chatPrefillFromUser', {
      authorId: 'a.alice_1', name: 'Alice', prefill: '@Alice ',
    }, (out: any) => {
      assert.equal(out, undefined);
      done();
    });
  });

  it('returns nothing when clientVars.ep_ai_chat is missing', function (done) {
    installWindowShim({});
    const {chatPrefillFromUser} = require('../../../../static/js/index');
    chatPrefillFromUser('chatPrefillFromUser', {
      authorId: 'a.ai_42', name: 'AI Assistant', prefill: '@AI_Assistant ',
    }, (out: any) => {
      assert.equal(out, undefined);
      done();
    });
  });
});
