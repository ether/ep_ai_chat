'use strict';

import {strict as assert} from 'assert';
import http from 'http';

const common = require('ep_etherpad-lite/tests/backend/common');
const {generateJWTToken} = common;
const randomString = require('ep_etherpad-lite/static/js/pad_utils').randomString;
const padManager = require('ep_etherpad-lite/node/db/PadManager');
const padMessageHandler = require('ep_etherpad-lite/node/handler/PadMessageHandler');
const {ChatMessage} = require('ep_etherpad-lite/static/js/ChatMessage');
const hooks = require('ep_etherpad-lite/static/js/pluginfw/hooks');

// Mock LLM server
let mockLLM: http.Server;
let mockPort: number;

const startMockLLM = (): Promise<void> => {
  return new Promise((resolve) => {
    mockLLM = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        // Check if it's Anthropic format (has 'system' field) or OpenAI format
        const isAnthropic = req.headers['x-api-key'] !== undefined;
        if (isAnthropic) {
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({
            content: [{type: 'text', text: 'This pad was written by the test author.'}],
            usage: {input_tokens: 10, output_tokens: 8},
          }));
        } else {
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({
            choices: [{message: {content: 'This pad was written by the test author.'}}],
            usage: {prompt_tokens: 10, completion_tokens: 8, total_tokens: 18},
          }));
        }
      });
    });
    mockLLM.listen(0, () => {
      const addr = mockLLM.address();
      mockPort = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
};

const stopMockLLM = (): Promise<void> => {
  return new Promise((resolve) => {
    mockLLM.close(() => resolve());
  });
};

let agent: any;
const apiVersion = 1;

describe('ep_ai_chat - end-to-end', function () {
  before(async function () {
    agent = await common.init();
    await startMockLLM();

    // Override AI settings to point to our mock LLM
    const settings = require('ep_etherpad-lite/node/utils/Settings');
    settings.ep_ai_core = {
      apiBaseUrl: `http://127.0.0.1:${mockPort}`,
      apiKey: 'test-key',
      model: 'test-model',
      provider: 'openai',
      access: {defaultMode: 'full', pads: {}},
      chat: {
        trigger: '@ai',
        authorName: 'AI Assistant',
        maxContextChars: 50000,
        chatHistoryLength: 20,
        conversationBufferSize: 10,
      },
    };

    // Trigger loadSettings hooks so plugins pick up the new settings
    await hooks.aCallAll('loadSettings', {settings});
  });

  after(async function () {
    await stopMockLLM();
  });

  describe('handleMessage hook', function () {
    it('detects @ai in chat and calls LLM', async function () {
      const padId = `test-e2e-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Hello from the test`)
          .set('Authorization', await generateJWTToken());

      const pad = await padManager.getPad(padId);
      const chatHeadBefore = pad.chatHead;

      // Simulate what the handleMessage hook receives
      const epAiChat = require('ep_ai_chat/index');
      const context = {
        message: {
          type: 'COLLABROOM',
          data: {
            type: 'CHAT_MESSAGE',
            message: {
              text: '@ai who wrote this?',
              authorId: 'a.testuser',
              time: Date.now(),
            },
          },
        },
        sessionInfo: {
          authorId: 'a.testuser',
          padId,
          readOnly: false,
        },
        socket: {id: 'fake-socket'},
      };

      // Call the hook directly
      await epAiChat.handleMessage('handleMessage', context);

      // The response is sent via setImmediate, so wait a bit
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Check that the AI responded in chat
      const updatedPad = await padManager.getPad(padId);
      assert.ok(
          updatedPad.chatHead > chatHeadBefore,
          `Expected chatHead to increase from ${chatHeadBefore}, got ${updatedPad.chatHead}`,
      );

      // Verify the chat messages — expecting "Thinking..." then actual response
      const messages = await updatedPad.getChatMessages(chatHeadBefore + 1, updatedPad.chatHead);
      assert.ok(messages.length >= 2, `Should have at least 2 messages (thinking + response), got ${messages.length}`);
      assert.ok(
          messages[0].text.includes('Thinking'),
          `First message should be thinking indicator, got: "${messages[0].text}"`,
      );
      // The actual AI response is the last message
      const aiResponse = messages[messages.length - 1];
      assert.ok(
          aiResponse.text.includes('test author'),
          `AI response should mention test author, got: "${aiResponse.text}"`,
      );
    });

    it('ignores non-@ai messages', async function () {
      const padId = `test-e2e-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Some text`)
          .set('Authorization', await generateJWTToken());

      const pad = await padManager.getPad(padId);
      const chatHeadBefore = pad.chatHead;

      const epAiChat = require('ep_ai_chat/index');
      const context = {
        message: {
          type: 'COLLABROOM',
          data: {
            type: 'CHAT_MESSAGE',
            message: {
              text: 'just a normal chat message',
              authorId: 'a.testuser',
              time: Date.now(),
            },
          },
        },
        sessionInfo: {
          authorId: 'a.testuser',
          padId,
          readOnly: false,
        },
        socket: {id: 'fake-socket'},
      };

      await epAiChat.handleMessage('handleMessage', context);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const updatedPad = await padManager.getPad(padId);
      assert.equal(
          updatedPad.chatHead,
          chatHeadBefore,
          'Chat head should not change for non-@ai messages',
      );
    });

    it('respects access control none mode', async function () {
      const padId = `secret-e2e-${randomString(10)}`;
      await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=Secret content`)
          .set('Authorization', await generateJWTToken());

      // Set access control to block secret-* pads
      const settings = require('ep_etherpad-lite/node/utils/Settings');
      const originalPads = settings.ep_ai_core.access.pads;
      settings.ep_ai_core.access.pads = {'secret-*': 'none'};
      await hooks.aCallAll('loadSettings', {settings});

      const pad = await padManager.getPad(padId);
      const chatHeadBefore = pad.chatHead;

      const epAiChat = require('ep_ai_chat/index');
      const context = {
        message: {
          type: 'COLLABROOM',
          data: {
            type: 'CHAT_MESSAGE',
            message: {
              text: '@ai what is in this pad?',
              authorId: 'a.testuser',
              time: Date.now(),
            },
          },
        },
        sessionInfo: {
          authorId: 'a.testuser',
          padId,
          readOnly: false,
        },
        socket: {id: 'fake-socket'},
      };

      await epAiChat.handleMessage('handleMessage', context);
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const updatedPad = await padManager.getPad(padId);
      if (updatedPad.chatHead > chatHeadBefore) {
        const msgs = await updatedPad.getChatMessages(chatHeadBefore + 1, updatedPad.chatHead);
        // Should be an access denied message, not actual content
        assert.ok(
            msgs[0].text.includes('access') || msgs[0].text.includes('Access'),
            'Response should be an access denied message',
        );
      }

      // Restore settings
      settings.ep_ai_core.access.pads = originalPads;
      await hooks.aCallAll('loadSettings', {settings});
    });
  });
});
