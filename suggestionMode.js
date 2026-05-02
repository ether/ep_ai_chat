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

  const desired = requested === 'auto' ? (depAvailable ? 'suggest' : 'apply') : requested;

  if (desired === 'suggest' && !depAvailable) {
    return {mode: 'apply', fellBackFromSuggest: true};
  }
  return {mode: desired, fellBackFromSuggest: false};
};

exports.resolveSuggestionMode = resolveSuggestionMode;
