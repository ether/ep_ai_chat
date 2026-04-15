'use strict';

const log4js = require('ep_etherpad-lite/node_modules/log4js');
const authorManager = require('ep_etherpad-lite/node/db/AuthorManager');
const padManager = require('ep_etherpad-lite/node/db/PadManager');
const padMessageHandler = require('ep_etherpad-lite/node/handler/PadMessageHandler');
const {ChatMessage} = require('ep_etherpad-lite/static/js/ChatMessage');
const epAiCore = require('ep_ai_core/index');
const {t} = require('ep_ai_core/i18n');

const {extractMention} = require('./chatHandler');
const {buildContext} = require('./contextBuilder');
const {applyEdit} = require('./padEditor');

const logger = log4js.getLogger('ep_ai_chat');

const conversations = {};
const conversationLastAccess = {};
const MAX_TRACKED_PADS = 1000;
const CONVERSATION_TTL_MS = 60 * 60 * 1000; // 1 hour

// Evict stale conversations periodically
const evictStaleConversations = () => {
  const now = Date.now();
  const padIds = Object.keys(conversationLastAccess);
  // Evict expired entries
  for (const padId of padIds) {
    if (now - conversationLastAccess[padId] > CONVERSATION_TTL_MS) {
      delete conversations[padId];
      delete conversationLastAccess[padId];
    }
  }
  // If still over limit, evict oldest
  const remaining = Object.entries(conversationLastAccess);
  if (remaining.length > MAX_TRACKED_PADS) {
    remaining.sort((a, b) => a[1] - b[1]);
    const toEvict = remaining.length - MAX_TRACKED_PADS;
    for (let i = 0; i < toEvict; i++) {
      delete conversations[remaining[i][0]];
      delete conversationLastAccess[remaining[i][0]];
    }
  }
};
const evictionTimer = setInterval(evictStaleConversations, 5 * 60 * 1000);
evictionTimer.unref();

// Rate limiting: track last request time per pad
const rateLimits = {};
const RATE_LIMIT_MS = 5000; // Minimum 5 seconds between @ai requests per pad

const isRateLimited = (padId) => {
  const now = Date.now();
  const lastRequest = rateLimits[padId] || 0;
  if (now - lastRequest < RATE_LIMIT_MS) return true;
  rateLimits[padId] = now;
  return false;
};

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
  conversationLastAccess[padId] = Date.now();
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

  const chatMsg = message.data.message;
  const chatText = chatMsg?.text || message.data.text;
  if (!chatText) return;

  // Extract selection info if the client attached it
  const selection = chatMsg?.customMetadata?.selection || null;

  const {mentioned, query} = extractMention(chatText, chatSettings.trigger);
  if (!mentioned) return;

  const padId = context.sessionInfo?.padId;
  if (!padId) return;

  // Rate limit: prevent API cost abuse
  if (isRateLimited(padId)) {
    logger.info(`Rate limited @ai request on pad ${padId}`);
    return;
  }

  const aiSettings = epAiCore.getSettings();
  const accessMode = epAiCore.accessControl.getAccessMode(padId, aiSettings);
  if (accessMode === 'none') {
    await sendChatReply(padId, t('ep_ai_chat.no_access'));
    return;
  }

  // Audit log
  const requestAuthor = context.sessionInfo?.authorId || 'unknown';
  logger.info(`AI request: pad=${padId} author=${requestAuthor} query="${query.substring(0, 100)}"`);

  await sendChatReply(padId, '\u2728 Thinking...');

  setImmediate(async () => {
    try {
      const pad = await padManager.getPad(padId);
      const currentText = pad.text();
      const conversation = getConversation(padId);

      const llmConfig = {
        apiBaseUrl: aiSettings.apiBaseUrl,
        apiKey: aiSettings.apiKey,
        model: aiSettings.model,
        maxTokens: aiSettings.maxTokens,
        provider: aiSettings.provider,
      };
      const client = epAiCore.llmClient.create(llmConfig);

      // Step 1: Ask the AI to decide — respond with JSON that either
      // contains an edit action or just a chat reply
      const decideMessages = await buildContext(
          pad, padId, query, conversation, chatSettings, accessMode, selection,
      );

      // Augment system prompt to request structured decision
      const canEdit = accessMode === 'full';
      const editInstructions = canEdit
        ? `

When the user asks you to change, improve, edit, rewrite, fix, or modify the document in any way, you MUST respond with a JSON block containing your edit. Use this exact format:

\`\`\`json
{"action": "edit", "findText": "exact text from the document to replace", "replaceText": "the improved replacement text", "explanation": "brief explanation of what you changed"}
\`\`\`

The findText MUST be an exact substring from the current document. Be precise.

If the user is NOT asking for an edit (just asking a question, discussing content, etc.), respond normally with plain text — no JSON block.`
        : '\n\nYou have READ-ONLY access. You cannot edit the pad. Just answer questions.';

      decideMessages[0].content += editInstructions;

      const response = await client.complete(decideMessages);

      // Step 2: Check if the response contains an edit JSON block
      const jsonMatch = response.content.match(/```json\s*\n([\s\S]*?)\n```/);
      let applied = false;

      if (jsonMatch && canEdit) {
        try {
          const editData = JSON.parse(jsonMatch[1]);
          if (editData.action === 'edit' && editData.findText && editData.replaceText !== undefined) {
            editData.authorId = await getAiAuthorId();
            const editResult = await applyEdit(pad, editData);
            if (editResult.success) {
              applied = true;
              const explanation = editData.explanation || 'Edit applied.';
              logger.info(`AI edit applied: pad=${padId} find="${editData.findText.substring(0, 50)}" replace="${editData.replaceText.substring(0, 50)}"`);
              await sendChatReply(padId, `\u2705 ${explanation}`);
            } else {
              logger.warn(`Edit failed: ${editResult.error}`);
              // Fall through to send the raw response
            }
          }
        } catch (e) {
          logger.warn(`Failed to parse edit JSON: ${e.message}`);
          // Fall through to send the raw response
        }
      }

      if (!applied) {
        // Send the response as-is (strip any failed JSON blocks)
        const cleanResponse = response.content
            .replace(/```json[\s\S]*?```/g, '')
            .trim();
        await sendChatReply(padId, cleanResponse || response.content);
      }

      addToConversation(padId, 'user', query);
      addToConversation(padId, 'assistant', response.content);
    } catch (err) {
      logger.error(`AI chat error: ${err.message}`);
      let msg = t('ep_ai_chat.error_generic');
      if (err.message.includes('429')) msg = t('ep_ai_chat.error_rate_limit');
      else if (err.message.includes('401') || err.message.includes('403')) msg = t('ep_ai_chat.error_auth');
      try { await sendChatReply(padId, msg); } catch { logger.error('Failed to send error to chat'); }
    }
  });
};
