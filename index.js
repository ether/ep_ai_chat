'use strict';

const log4js = require('ep_etherpad-lite/node_modules/log4js');
const authorManager = require('ep_etherpad-lite/node/db/AuthorManager');
const padManager = require('ep_etherpad-lite/node/db/PadManager');
const padMessageHandler = require('ep_etherpad-lite/node/handler/PadMessageHandler');
const {ChatMessage} = require('ep_etherpad-lite/static/js/ChatMessage');
const epAiCore = require('ep_ai_core/index');

const {extractMention, detectEditIntent} = require('./chatHandler');
const {buildContext} = require('./contextBuilder');
const {applyEdit} = require('./padEditor');

const logger = log4js.getLogger('ep_ai_chat');

const conversations = {};
let chatSettings = {
  trigger: '@ai',
  authorName: 'AI Assistant',
  authorColor: '#7c4dff',
  systemPrompt: null,
  maxContextChars: 50000,
  chatHistoryLength: 20,
  conversationBufferSize: 10,
};

let aiAuthorId = null;

const getAiAuthorId = async () => {
  if (aiAuthorId) return aiAuthorId;
  const result = await authorManager.createAuthor(chatSettings.authorName);
  aiAuthorId = result.authorID;
  if (chatSettings.authorColor) await authorManager.setAuthorColorId(aiAuthorId, chatSettings.authorColor);
  return aiAuthorId;
};

const sendChatReply = async (padId, text) => {
  const authorId = await getAiAuthorId();
  const msg = new ChatMessage(text, authorId, Date.now());
  await padMessageHandler.sendChatMessageToPadClients(msg, padId);
};

const getConversation = (padId) => {
  if (!conversations[padId]) conversations[padId] = [];
  return conversations[padId];
};

const addToConversation = (padId, role, content) => {
  const conv = getConversation(padId);
  conv.push({role, content});
  const maxSize = chatSettings.conversationBufferSize * 2;
  while (conv.length > maxSize) conv.shift();
};

exports.loadSettings = async (hookName, {settings}) => {
  const aiSettings = settings.ep_ai_core || {};
  const chat = aiSettings.chat || {};
  chatSettings = {...chatSettings, ...chat};
  logger.info(`ep_ai_chat loaded. Trigger: "${chatSettings.trigger}"`);
  aiAuthorId = null;
};

exports.handleMessage = async (hookName, context) => {
  const {message} = context;
  if (!message || !message.data) return;
  if (message.type !== 'COLLABROOM' || message.data.type !== 'CHAT_MESSAGE') return;

  // Chat message text is nested inside message.data.message
  const chatMsg = message.data.message;
  const chatText = chatMsg?.text || message.data.text;
  if (!chatText) return;

  const {mentioned, query} = extractMention(chatText, chatSettings.trigger);
  if (!mentioned) return;

  const padId = context.sessionInfo?.padId;
  if (!padId) return;

  const aiSettings = epAiCore.getSettings();
  const accessMode = epAiCore.accessControl.getAccessMode(padId, aiSettings);
  if (accessMode === 'none') {
    await sendChatReply(padId, "I don't have access to this pad.");
    return;
  }

  // Send immediate thinking indicator so user knows AI heard them
  await sendChatReply(padId, '\u2728 Thinking...');

  setImmediate(async () => {
    try {
      const pad = await padManager.getPad(padId);
      const conversation = getConversation(padId);
      const messages = await buildContext(pad, padId, query, conversation, chatSettings, accessMode);

      const isEdit = detectEditIntent(query);
      if (isEdit && accessMode === 'readOnly') {
        await sendChatReply(padId, 'I can only read this pad, not edit it.');
        return;
      }

      if (isEdit) {
        messages[0].content += '\n\nThe user is asking you to edit the pad. Respond with a JSON block:\n```json\n{"findText": "text to find", "replaceText": "replacement"}\n```\nor\n```json\n{"appendText": "text to add"}\n```\nAlso include a brief explanation.';
      }

      const llmConfig = {
        apiBaseUrl: aiSettings.apiBaseUrl,
        apiKey: aiSettings.apiKey,
        model: aiSettings.model,
        maxTokens: aiSettings.maxTokens,
      };
      const client = epAiCore.llmClient.create(llmConfig);
      const response = await client.complete(messages);

      if (isEdit && accessMode === 'full') {
        const jsonMatch = response.content.match(/```json\s*\n([\s\S]*?)\n```/);
        if (jsonMatch) {
          try {
            const editData = JSON.parse(jsonMatch[1]);
            editData.authorId = await getAiAuthorId();
            const editResult = await applyEdit(pad, editData);
            if (!editResult.success) await sendChatReply(padId, `Edit failed: ${editResult.error}`);
          } catch (e) { logger.warn(`Parse edit JSON failed: ${e.message}`); }
        }
        const explanation = response.content.replace(/```json[\s\S]*?```/g, '').trim();
        if (explanation) await sendChatReply(padId, explanation);
      } else {
        await sendChatReply(padId, response.content);
      }

      addToConversation(padId, 'user', query);
      addToConversation(padId, 'assistant', response.content);
    } catch (err) {
      logger.error(`AI chat error: ${err.message}`);
      let msg = 'Sorry, I encountered an error.';
      if (err.message.includes('429')) msg = 'AI service rate limited. Try again shortly.';
      else if (err.message.includes('401') || err.message.includes('403')) msg = 'AI service rejected request. Check API key.';
      try { await sendChatReply(padId, msg); } catch { logger.error('Failed to send error to chat'); }
    }
  });
};
