'use strict';

import {strict as assert} from 'assert';
import http from 'http';

const common = require('ep_etherpad-lite/tests/backend/common');
const {generateJWTToken} = common;
const randomString = require('ep_etherpad-lite/static/js/pad_utils').randomString;
const padManager = require('ep_etherpad-lite/node/db/PadManager');
const Changeset = require('ep_etherpad-lite/static/js/Changeset');
const {attribsFromString} = require('ep_etherpad-lite/static/js/attributes');
const hooks = require('ep_etherpad-lite/static/js/pluginfw/hooks');
const commentManager = require('ep_comments_page/commentManager');

let mockLLM: http.Server;
let mockPort: number;

const startMockLLM = (): Promise<void> => new Promise((resolve) => {
  mockLLM = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      const editJson = JSON.stringify({
        action: 'edit',
        findText: 'Phrase to suggest on',
        replaceText: 'Phrase that was suggested',
        explanation: 'Polished phrasing.',
      });
      const responseText = `\`\`\`json\n${editJson}\n\`\`\``;
      const isAnthropic = req.headers['x-api-key'] !== undefined;
      res.writeHead(200, {'Content-Type': 'application/json'});
      if (isAnthropic) {
        res.end(JSON.stringify({
          content: [{type: 'text', text: responseText}],
          usage: {input_tokens: 10, output_tokens: 8},
        }));
      } else {
        res.end(JSON.stringify({
          choices: [{message: {content: responseText}}],
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

const stopMockLLM = (): Promise<void> => new Promise((resolve) => {
  mockLLM.close(() => resolve());
});

let agent: any;
const apiVersion = 1;

describe('ep_ai_chat - end-to-end @ai suggest:', function () {
  before(async function () {
    agent = await common.init();
    await startMockLLM();

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
    await hooks.aCallAll('loadSettings', {settings});
  });

  after(async function () {
    await stopMockLLM();
  });

  it('routes @ai suggest: through suggestEdit and leaves pad text unchanged',
      async function () {
        const padId = `test-e2e-suggest-${randomString(10)}`;
        await agent.get(
            `/api/${apiVersion}/createPad?padID=${padId}&text=Phrase to suggest on`)
            .set('Authorization', await generateJWTToken());

        const requester = `a.alice_e2e_suggest_${randomString(6)}`;
        const epAiChat = require('ep_ai_chat/index');
        const chatHeadBefore = (await padManager.getPad(padId)).chatHead;

        await epAiChat.handleMessage('handleMessage', {
          message: {
            type: 'COLLABROOM',
            data: {
              type: 'CHAT_MESSAGE',
              message: {
                text: '@ai suggest: improve this',
                authorId: requester,
                time: Date.now(),
              },
            },
          },
          sessionInfo: {authorId: requester, padId, readOnly: false},
          socket: {id: 'fake-socket'},
        });

        await new Promise((resolve) => setTimeout(resolve, 2000));

        const updated = await padManager.getPad(padId);
        assert.ok(updated.text().includes('Phrase to suggest on'),
            `pad text should retain original; got: "${updated.text()}"`);
        assert.ok(!updated.text().includes('Phrase that was suggested'),
            `pad text should NOT yet contain the suggestion; got: "${updated.text()}"`);

        const stored = await commentManager.getComments(padId);
        const ids = Object.keys(stored.comments);
        assert.equal(ids.length, 1, `expected exactly 1 comment, got ${ids.length}`);
        const comment = stored.comments[ids[0]];
        assert.equal(comment.changeFrom, 'Phrase to suggest on');
        assert.equal(comment.changeTo, 'Phrase that was suggested');

        const pool = updated.pool;
        let foundComment = false;
        for (const op of Changeset.deserializeOps(updated.atext.attribs)) {
          for (const [key, value] of attribsFromString(op.attribs, pool)) {
            if (key === 'comment' && value === ids[0]) foundComment = true;
          }
        }
        assert.ok(foundComment, 'comment attribute should anchor the matched span');

        const updatedAfterChat = await padManager.getPad(padId);
        const msgs = await updatedAfterChat.getChatMessages(
            chatHeadBefore + 1, updatedAfterChat.chatHead);
        const lastMsg = msgs[msgs.length - 1];
        assert.ok(/suggestion/i.test(lastMsg.text),
            `chat reply should mention "suggestion"; got: "${lastMsg.text}"`);
      });
});
