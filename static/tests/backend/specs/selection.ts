'use strict';

import {strict as assert} from 'assert';

const common = require('ep_etherpad-lite/tests/backend/common');
const {generateJWTToken} = common;
const randomString = require('ep_etherpad-lite/static/js/pad_utils').randomString;
const padManager = require('ep_etherpad-lite/node/db/PadManager');

const contextBuilder = require('../../../../contextBuilder');

let agent: any;
const apiVersion = 1;

describe('ep_ai_chat - selection-aware editing', function () {
  before(async function () {
    agent = await common.init();
  });

  describe('contextBuilder with selection', function () {
    it('includes selection text in user message when provided', async function () {
      const padId = `test-sel-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=The quick brown fox jumps over the lazy dog`)
          .set('Authorization', await generateJWTToken());

      const pad = await padManager.getPad(padId);
      const chatSettings = {maxContextChars: 50000};
      const selection = {text: 'quick brown fox', startLine: 0, startCol: 4, endLine: 0, endCol: 19};

      const messages = await contextBuilder.buildContext(
          pad, padId, 'improve this', [], chatSettings, 'full', selection,
      );

      // The user message should include the selection
      const userMsg = messages[messages.length - 1];
      assert.equal(userMsg.role, 'user');
      assert.ok(
          userMsg.content.includes('quick brown fox'),
          'User message should include selected text',
      );
      assert.ok(
          userMsg.content.includes('selected'),
          'User message should indicate this is a selection',
      );
      assert.ok(
          userMsg.content.includes('improve this'),
          'User message should include the original query',
      );
    });

    it('does not modify user message when no selection provided', async function () {
      const padId = `test-sel-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Hello`)
          .set('Authorization', await generateJWTToken());

      const pad = await padManager.getPad(padId);
      const chatSettings = {maxContextChars: 50000};

      const messages = await contextBuilder.buildContext(
          pad, padId, 'who wrote this?', [], chatSettings, 'full', null,
      );

      const userMsg = messages[messages.length - 1];
      assert.equal(userMsg.content, 'who wrote this?');
    });

    it('does not modify user message when selection has empty text', async function () {
      const padId = `test-sel-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Hello`)
          .set('Authorization', await generateJWTToken());

      const pad = await padManager.getPad(padId);
      const chatSettings = {maxContextChars: 50000};
      const selection = {text: '', startLine: 0, startCol: 0, endLine: 0, endCol: 0};

      const messages = await contextBuilder.buildContext(
          pad, padId, 'test', [], chatSettings, 'full', selection,
      );

      const userMsg = messages[messages.length - 1];
      assert.equal(userMsg.content, 'test');
    });
  });

  describe('handleMessage with selection', function () {
    it('passes selection from customMetadata to the AI', async function () {
      const padId = `test-sel-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Hello world`)
          .set('Authorization', await generateJWTToken());

      // Set up mock LLM settings
      const http = require('http');
      const mockServer = http.createServer((req: any, res: any) => {
        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          // Check if the messages include selection info
          const allContent = (parsed.messages || []).map((m: any) => m.content).join(' ');
          const hasSelection = allContent.includes('selected') && allContent.includes('Hello');
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({
            content: [{type: 'text', text: hasSelection
              ? 'I can see you selected "Hello" - I will improve it.'
              : 'No selection detected.'}],
            usage: {input_tokens: 10, output_tokens: 10},
          }));
        });
      });

      await new Promise<void>((resolve) => { mockServer.listen(0, () => resolve()); });
      const addr = mockServer.address();
      const mockPort = typeof addr === 'object' && addr ? addr.port : 0;

      // Override settings
      const settings = require('ep_etherpad-lite/node/utils/Settings');
      const hooks = require('ep_etherpad-lite/static/js/pluginfw/hooks');
      const originalSettings = settings.ep_ai_core;
      settings.ep_ai_core = {
        apiBaseUrl: `http://127.0.0.1:${mockPort}`,
        apiKey: 'test',
        model: 'test',
        provider: 'anthropic',
        access: {defaultMode: 'full', pads: {}},
        chat: {trigger: '@ai'},
      };
      await hooks.aCallAll('loadSettings', {settings});

      const epAiChat = require('ep_ai_chat/index');
      const pad = await padManager.getPad(padId);
      const chatHeadBefore = pad.chatHead;

      const context = {
        message: {
          type: 'COLLABROOM',
          data: {
            type: 'CHAT_MESSAGE',
            message: {
              text: '@ai improve this',
              authorId: 'a.testuser',
              time: Date.now(),
              customMetadata: {
                selection: {
                  text: 'Hello',
                  startLine: 0,
                  startCol: 0,
                  endLine: 0,
                  endCol: 5,
                },
              },
            },
          },
        },
        sessionInfo: {authorId: 'a.testuser', padId, readOnly: false},
        socket: {id: 'fake-socket'},
      };

      await epAiChat.handleMessage('handleMessage', context);
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const updatedPad = await padManager.getPad(padId);
      assert.ok(updatedPad.chatHead > chatHeadBefore, 'AI should have responded');

      // Check that the AI's response mentions the selection
      const msgs = await updatedPad.getChatMessages(chatHeadBefore + 1, updatedPad.chatHead);
      const aiResponses = msgs.filter((m: any) => !m.text.includes('Thinking'));
      assert.ok(aiResponses.length > 0, 'Should have AI response');
      assert.ok(
          aiResponses.some((m: any) => m.text.includes('selected') || m.text.includes('Hello')),
          `AI should acknowledge selection, got: "${aiResponses.map((m: any) => m.text).join('; ')}"`,
      );

      // Cleanup
      settings.ep_ai_core = originalSettings;
      await hooks.aCallAll('loadSettings', {settings});
      await new Promise<void>((resolve) => { mockServer.close(() => resolve()); });
    });
  });
});
