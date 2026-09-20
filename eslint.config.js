'use strict';

module.exports = [
  ...require('eslint-config-etherpad/flat/plugin'),
  {
    // The shared browser profile parses at ES2017 (`env: {es2017: true}` with
    // no explicit ecmaVersion). This plugin's client code uses optional
    // chaining and optional catch binding, which are ES2020/ES2019 and have
    // been in every browser Etherpad supports for years, so parse at a
    // version that can read them rather than downgrading the source.
    files: ['static/js/**/*.js'],
    languageOptions: {ecmaVersion: 2022},
  },
  {
    // `test/` holds a standalone mock LLM server and the mocha spec that
    // drives it. The shared plugin config only knows about `static/tests/`,
    // so without this these files land in the plain Node profile: no mocha
    // globals, and no exemption for the signal handlers that stop the mock.
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        after: 'readonly',
        afterEach: 'readonly',
        before: 'readonly',
        beforeEach: 'readonly',
        describe: 'readonly',
        it: 'readonly',
      },
    },
    rules: {
      'n/no-process-exit': 'off',
    },
  },
];
