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
