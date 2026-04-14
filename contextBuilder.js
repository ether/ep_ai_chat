'use strict';

const authorManager = require('ep_etherpad-lite/node/db/AuthorManager');
const epAiCore = require('ep_ai_core/index');

const DEFAULT_SYSTEM_PROMPT = 'You are an AI assistant collaborating in an Etherpad document. You can see the pad\'s content and who wrote each part. When users @mention you in chat, respond helpfully. You can answer questions about the document, its authors, and its history. When asked to edit, describe what you\'ll change and then do it.';

const buildContext = async (pad, padId, userMessage, conversationHistory, chatSettings, accessMode) => {
  const messages = [];
  const maxChars = chatSettings.maxContextChars || 50000;

  // System prompt
  let systemPrompt = chatSettings.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  if (accessMode === 'readOnly') {
    systemPrompt += '\n\nIMPORTANT: You have READ-ONLY access to this pad. You cannot edit it. If asked to make changes, explain that you can only read and discuss the content.';
  }
  messages.push({role: 'system', content: systemPrompt});

  // Pad content (truncated if needed)
  let padText = pad.text();
  const contentBudget = Math.floor(maxChars * 0.6);
  if (padText.length > contentBudget) {
    padText = padText.substring(0, contentBudget) + '\n...[truncated]';
  }

  // Authorship summary
  let authorshipSummary = '';
  try {
    const contributors = epAiCore.authorship.getPadContributors(pad);
    if (contributors.contributors.length > 0) {
      const lines = [];
      for (const c of contributors.contributors) {
        const name = c.authorId ? await authorManager.getAuthorName(c.authorId) || c.authorId : 'Unknown';
        lines.push(`- ${name}: ${c.percentage}% (${c.charCount} chars)`);
      }
      authorshipSummary = `\n\nAuthors:\n${lines.join('\n')}`;
    }
  } catch { /* proceed without authorship */ }

  messages.push({role: 'system', content: `Current pad content (pad ID: ${padId}):\n\n${padText}${authorshipSummary}`});

  // Conversation history
  for (const entry of conversationHistory) {
    messages.push({role: entry.role, content: entry.content});
  }

  // User message
  messages.push({role: 'user', content: userMessage});

  return messages;
};

exports.buildContext = buildContext;
