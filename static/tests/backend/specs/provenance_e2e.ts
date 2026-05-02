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

// Mock LLM that always returns an edit JSON block — drives the
// handleMessage -> applyEdit path so we can verify provenance lands
// end-to-end on the resulting pad attributes.
let mockLLM: http.Server;
let mockPort: number;

const startMockLLM = (): Promise<void> => new Promise((resolve) => {
  mockLLM = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      const editJson = JSON.stringify({
        action: 'edit',
        findText: 'Original sentence here',
        replaceText: 'Improved sentence here',
        explanation: 'Polished the prose.',
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

describe('ep_ai_chat - end-to-end provenance', function () {
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

  it('threads requesterAuthorId from sessionInfo into the edited pad attributes',
      async function () {
        const padId = `test-prov-e2e-${randomString(10)}`;
        await agent.get(
            `/api/${apiVersion}/createPad?padID=${padId}&text=Original sentence here`)
            .set('Authorization', await generateJWTToken());

        const requester = `a.alice_e2e_${randomString(6)}`;

        const epAiChat = require('ep_ai_chat/index');
        await epAiChat.handleMessage('handleMessage', {
          message: {
            type: 'COLLABROOM',
            data: {
              type: 'CHAT_MESSAGE',
              message: {
                // Use "apply:" override so this test exercises the direct
                // apply path even when ep_comments_page is also installed
                // (which would otherwise route through suggestEdit).
                text: '@ai apply: improve this',
                authorId: requester,
                time: Date.now(),
              },
            },
          },
          sessionInfo: {authorId: requester, padId, readOnly: false},
          socket: {id: 'fake-socket'},
        });

        // Edit happens in setImmediate; wait for it.
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const updatedPad = await padManager.getPad(padId);
        assert.ok(updatedPad.text().includes('Improved sentence here'),
            `expected pad text to be updated; got: "${updatedPad.text()}"`);

        // Provenance attribute should be on the edited span.
        const pool = updatedPad.pool;
        let onSpan = false;
        for (const op of Changeset.deserializeOps(updatedPad.atext.attribs)) {
          for (const [key, value] of attribsFromString(op.attribs, pool)) {
            if (key === 'ep_ai_chat:requestedBy' && value === requester) {
              onSpan = true;
            }
          }
        }
        assert.ok(onSpan,
            `ep_ai_chat:requestedBy=${requester} should be on the AI-edited span`);
      });
});
