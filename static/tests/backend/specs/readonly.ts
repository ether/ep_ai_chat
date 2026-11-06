'use strict';

import {strict as assert} from 'assert';
import http from 'http';

const common = require('ep_etherpad-lite/tests/backend/common');
const {generateJWTToken} = common;
const randomString = require('ep_etherpad-lite/static/js/pad_utils').randomString;
const padManager = require('ep_etherpad-lite/node/db/PadManager');
const padMessageHandler = require('ep_etherpad-lite/node/handler/PadMessageHandler');
const hooks = require('ep_etherpad-lite/static/js/pluginfw/hooks');

// The mock LLM always answers with an edit that rewrites "original text".
let mockLLM: http.Server;
let mockPort: number;
let llmCalls = 0;
let llmDelayMs = 0;
let onLlmRequest: (() => void) | null = null;

const startMockLLM = (): Promise<void> => new Promise((resolve) => {
  mockLLM = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', async () => {
      llmCalls++;
      if (onLlmRequest) onLlmRequest();
      if (llmDelayMs) await new Promise((resolve) => setTimeout(resolve, llmDelayMs));
      const editJson = JSON.stringify({
        action: 'edit',
        findText: 'original text',
        replaceText: 'EDITED BY AI',
        explanation: 'Edited.',
      });
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({
        choices: [{message: {content: `\`\`\`json\n${editJson}\n\`\`\``}}],
        usage: {prompt_tokens: 10, completion_tokens: 8, total_tokens: 18},
      }));
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const chatMessage = (text: string) => ({
  component: 'pad',
  type: 'COLLABROOM',
  data: {type: 'CHAT_MESSAGE', message: {text}},
});

let agent: any;
const apiVersion = 1;

const createPad = async () => {
  const padId = `test-ro-${randomString(10)}`;
  await agent.get(`/api/${apiVersion}/createPad?padID=${padId}&text=original text`)
      .set('Authorization', await generateJWTToken());
  return padId;
};

const getReadOnlyId = async (padId: string) => {
  const res = await agent.get(`/api/${apiVersion}/getReadOnlyID?padID=${padId}`)
      .set('Authorization', await generateJWTToken());
  return res.body.data.readOnlyID;
};

const joinPad = async (id: string) => {
  const res = await agent.get(`/p/${id}`).expect(200);
  const socket = await common.connect(res);
  const clientVars = await common.handshake(socket, id);
  assert.equal(clientVars.type, 'CLIENT_VARS');
  return {socket, clientVars};
};

describe('ep_ai_chat - read-only sessions', function () {
  this.timeout(30000);

  before(async function () {
    agent = await common.init();
    await startMockLLM();
    const settings = require('ep_etherpad-lite/node/utils/Settings');
    settings.ep_ai_core = {
      apiBaseUrl: `http://127.0.0.1:${mockPort}`,
      apiKey: 'test-key',
      model: 'test-model-1',
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

  beforeEach(function () {
    llmCalls = 0;
    llmDelayMs = 0;
    onLlmRequest = null;
  });

  it('a socket on the read-only pad ID cannot edit through @ai apply:', async function () {
    const padId = await createPad();
    const roId = await getReadOnlyId(padId);
    const {socket, clientVars} = await joinPad(roId);
    try {
      assert.equal(clientVars.data.readonly, true);
      socket.emit('message', chatMessage('@ai apply: improve original text'));
      await sleep(2000);
      const pad = await padManager.getPad(padId);
      assert.equal(pad.text(), 'original text\n');
      assert.equal(pad.getHeadRevisionNumber(), 0);
      assert.equal(llmCalls, 0, 'the LLM must not be called for a read-only session');
    } finally {
      socket.close();
    }
  });

  it('a socket on the writable pad ID can still edit (control)', async function () {
    const padId = await createPad();
    const {socket} = await joinPad(padId);
    // Capture what core really hands the handleMessage hook for this socket.
    const seen: any[] = [];
    const hookFns = require('ep_etherpad-lite/static/js/pluginfw/plugin_defs').hooks;
    const spy = {
      hook_name: 'handleMessage',
      hook_fn_name: 'readonly.ts:spy',
      part: {name: 'readonly-spy', plugin: 'readonly-spy'},
      hook_fn: (hookName: string, ctx: any) => { seen.push(ctx.sessionInfo); },
    };
    hookFns.handleMessage = [spy, ...(hookFns.handleMessage || [])];
    try {
      socket.emit('message', chatMessage('@ai apply: improve original text'));
      await sleep(2000);
      const pad = await padManager.getPad(padId);
      assert.ok(pad.text().includes('EDITED BY AI'), `got: ${JSON.stringify(pad.text())}`);
      assert.equal(llmCalls, 1);
      // Hook context uses camelCase `readOnly`; the live session uses `readonly`.
      const chatCtx = seen.find((si) => si && si.padId === padId);
      assert.ok(chatCtx, 'spy should have seen the chat message');
      assert.equal(chatCtx.readOnly, false);
      assert.equal(chatCtx.readonly, undefined);
      const live: any = Object.values(padMessageHandler.sessioninfos)
          .find((si: any) => si && si.padId === padId);
      assert.equal(live.readonly, false);
    } finally {
      hookFns.handleMessage = hookFns.handleMessage.filter((h: any) => h !== spy);
      socket.close();
    }
  });

  it('drops the edit if the session turns read-only while the AI is working',
      async function () {
        const padId = await createPad();
        const {socket} = await joinPad(padId);
        try {
          llmDelayMs = 500;
          onLlmRequest = () => {
            for (const si of Object.values(padMessageHandler.sessioninfos) as any[]) {
              if (si && si.padId === padId) si.readonly = true;
            }
          };
          const pad = await padManager.getPad(padId);
          const chatHeadBefore = pad.chatHead;
          socket.emit('message', chatMessage('@ai apply: improve original text'));
          await sleep(2500);
          assert.equal(llmCalls, 1);
          assert.equal(pad.text(), 'original text\n');
          assert.equal(pad.getHeadRevisionNumber(), 0);
          // Only the user's own message and "Thinking..." — no edit reply.
          assert.ok(pad.chatHead - chatHeadBefore <= 2,
              `unexpected chat messages: ${pad.chatHead - chatHeadBefore}`);
        } finally {
          socket.close();
        }
      });

  it('the hook ignores sessions that are read-only or have no readOnly flag', async function () {
    const epAiChat = require('ep_ai_chat/index');
    for (const sessionInfo of [{readOnly: true}, {}]) {
      const padId = await createPad();
      await epAiChat.handleMessage('handleMessage', {
        message: chatMessage('@ai apply: improve original text'),
        sessionInfo: {authorId: 'a.readonlytest', padId, ...sessionInfo},
        socket: {id: `fake-${randomString(6)}`},
      });
      await sleep(1000);
      const pad = await padManager.getPad(padId);
      assert.equal(pad.text(), 'original text\n', `sessionInfo=${JSON.stringify(sessionInfo)}`);
    }
    assert.equal(llmCalls, 0);
  });

  it('requesterCanWrite rechecks the live session', async function () {
    const {requesterCanWrite} = require('ep_ai_chat/index');
    const socketId = `fake-live-${randomString(6)}`;
    const ctx = {sessionInfo: {readOnly: false, padId: 'p1'}, socket: {id: socketId}};
    assert.equal(requesterCanWrite(ctx, 'p1'), true);
    padMessageHandler.sessioninfos[socketId] = {padId: 'p1', readonly: true};
    try {
      assert.equal(requesterCanWrite(ctx, 'p1'), false);
      padMessageHandler.sessioninfos[socketId] = {padId: 'other', readonly: false};
      assert.equal(requesterCanWrite(ctx, 'p1'), false);
      padMessageHandler.sessioninfos[socketId] = {padId: 'p1', readonly: false};
      assert.equal(requesterCanWrite(ctx, 'p1'), true);
    } finally {
      delete padMessageHandler.sessioninfos[socketId];
    }
  });
});
