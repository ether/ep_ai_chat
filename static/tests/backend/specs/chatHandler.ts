'use strict';

import {strict as assert} from 'assert';

const chatHandler = require('../../../../chatHandler');

describe('ep_ai_chat - chatHandler', function () {
  describe('extractMention', function () {
    it('detects @ai at the start', function () {
      const r = chatHandler.extractMention('@ai what is this?', '@ai');
      assert.ok(r.mentioned);
      assert.equal(r.query, 'what is this?');
    });

    it('detects @ai in the middle', function () {
      const r = chatHandler.extractMention('hey @ai help', '@ai');
      assert.ok(r.mentioned);
      assert.ok(r.query.includes('hey'));
      assert.ok(r.query.includes('help'));
      assert.ok(!r.query.toLowerCase().includes('@ai'));
    });

    it('is case-insensitive', function () {
      const r = chatHandler.extractMention('@AI summarize', '@ai');
      assert.ok(r.mentioned);
      assert.equal(r.query, 'summarize');
    });

    it('returns false when trigger absent', function () {
      assert.equal(chatHandler.extractMention('normal msg', '@ai').mentioned, false);
    });

    it('handles custom trigger', function () {
      const r = chatHandler.extractMention('@assistant help', '@assistant');
      assert.ok(r.mentioned);
      assert.equal(r.query, 'help');
    });

    it('handles @ai with no text', function () {
      const r = chatHandler.extractMention('@ai', '@ai');
      assert.ok(r.mentioned);
      assert.equal(r.query.trim(), '');
    });

    it('returns override="apply" for "@ai apply: ..." messages', function () {
      const r = chatHandler.extractMention('@ai apply: rewrite the intro', '@ai');
      assert.equal(r.mentioned, true);
      assert.equal(r.override, 'apply');
      assert.equal(r.query, 'rewrite the intro');
    });

    it('returns override="suggest" for "@ai suggest: ..." messages', function () {
      const r = chatHandler.extractMention('@ai suggest: fix typos', '@ai');
      assert.equal(r.override, 'suggest');
      assert.equal(r.query, 'fix typos');
    });

    it('lowercases the override keyword and tolerates spacing', function () {
      const a = chatHandler.extractMention('@ai APPLY: do it', '@ai');
      const b = chatHandler.extractMention('@ai  Suggest : do it', '@ai');
      assert.equal(a.override, 'apply');
      assert.equal(b.override, 'suggest');
      assert.equal(a.query, 'do it');
      assert.equal(b.query, 'do it');
    });

    it('returns override=null when no keyword is present', function () {
      const r = chatHandler.extractMention('@ai please help me', '@ai');
      assert.equal(r.override, null);
      assert.equal(r.query, 'please help me');
    });

    it('does not match a keyword without the colon', function () {
      const r = chatHandler.extractMention('@ai apply this fix', '@ai');
      assert.equal(r.override, null);
      assert.equal(r.query, 'apply this fix');
    });
  });

  describe('detectEditIntent', function () {
    it('detects rewrite', function () { assert.ok(chatHandler.detectEditIntent('rewrite paragraph 3')); });
    it('detects insert', function () { assert.ok(chatHandler.detectEditIntent('add a summary at the end')); });
    it('detects replace', function () { assert.ok(chatHandler.detectEditIntent('replace "old" with "new"')); });
    it('returns false for questions', function () { assert.ok(!chatHandler.detectEditIntent('what is this about?')); });
    it('returns false for discussion', function () { assert.ok(!chatHandler.detectEditIntent('who wrote the intro?')); });
  });
});
