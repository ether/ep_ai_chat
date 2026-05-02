'use strict';

/**
 * Local i18n loader for ep_ai_chat.
 *
 * The shared helper in ep_ai_core/i18n.js calls
 *   require.resolve(`${pluginName}/locales/${lang}.json`)
 * which only succeeds if `pluginName` is reachable from ep_ai_core's own
 * node_modules. In every real install ep_ai_core and ep_ai_chat are
 * sibling plugins, so that lookup silently fails for ep_ai_chat keys
 * and `t()` falls back to returning the literal key — meaning users
 * see strings like "ep_ai_chat.error_auth" in chat instead of the
 * translated message.
 *
 * Loading our own locale file by absolute path (rooted at this plugin's
 * directory) avoids the cross-plugin resolution mess entirely.
 */

const fs = require('fs');
const path = require('path');

const cache = {};

const loadLocale = (lang = 'en') => {
  if (cache[lang]) return cache[lang];
  const file = path.join(__dirname, 'locales', `${lang}.json`);
  try {
    cache[lang] = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    cache[lang] = {};
  }
  return cache[lang];
};

const t = (key, lang = 'en') => loadLocale(lang)[key] || key;

exports.t = t;
exports.loadLocale = loadLocale;
