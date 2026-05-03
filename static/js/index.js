'use strict';

/**
 * Client-side plugin for ep_ai_chat.
 * Captures the user's current text selection in the pad editor
 * and attaches it to chat messages as customMetadata.selection.
 */

let padEditor = null;

/**
 * postAceInit: store a reference to the ace editor for selection access.
 */
exports.postAceInit = (hookName, context) => {
  padEditor = context.ace;
  // Suppress the browser's native spellcheck on the chat input — the @ai
  // trigger and other ad-hoc tokens otherwise get red-underlined as
  // misspellings, which is visually noisy and (more importantly) fights
  // the autocomplete UX.
  try {
    const chatInput = document.querySelector('#chatinput');
    if (chatInput) chatInput.setAttribute('spellcheck', 'false');
  } catch (e) { /* never break ace init */ }
};

/**
 * chatPrefillFromUser: when Etherpad core prefills "@<name> " in the chat
 * input on a user-list click, swap in the configured trigger string for
 * the AI's row. Without this, clicking the AI's chip in the user list
 * would prefill "@AI_Assistant " which doesn't match anything the
 * server-side mention extractor recognises.
 *
 * Requires the chatPrefillFromUser hook (Etherpad >= the version that
 * landed ether/etherpad#7660). On older cores this hook is silently
 * never called and clicks fall back to the default prefill.
 */
exports.chatPrefillFromUser = (hookName, context, cb) => {
  try {
    const ai = (window.clientVars && window.clientVars.ep_ai_chat) || {};
    if (ai.authorId && context && context.authorId === ai.authorId) {
      return cb(`${ai.trigger || '@ai'} `);
    }
  } catch (_e) { /* fall through to default */ }
  return cb();
};

/**
 * chatSendMessage: before a chat message is sent, capture the current
 * selection in the pad and attach it to the message.
 */
exports.chatSendMessage = (hookName, context) => {
  if (!padEditor || !context.message) return;

  try {
    // Get the current selection from the ace editor
    const rep = padEditor.callWithAce((ace) => ace.ace_getRep());
    if (!rep || !rep.selStart || !rep.selEnd) return;

    const [startLine, startCol] = rep.selStart;
    const [endLine, endCol] = rep.selEnd;

    // Only attach selection if something is actually selected
    if (startLine === endLine && startCol === endCol) return;

    // Extract the selected text from the rep lines
    const lines = rep.lines?.atIndex
      ? extractLinesFromRep(rep, startLine, endLine)
      : null;

    let selectedText = '';
    if (lines) {
      for (let i = startLine; i <= endLine; i++) {
        const line = lines[i - startLine] || '';
        const lineStart = (i === startLine) ? startCol : 0;
        const lineEnd = (i === endLine) ? endCol : line.length;
        selectedText += line.substring(lineStart, lineEnd);
        if (i < endLine) selectedText += '\n';
      }
    }

    if (selectedText.length > 0) {
      if (!context.message.customMetadata) {
        context.message.customMetadata = {};
      }
      context.message.customMetadata.selection = {
        text: selectedText,
        startLine,
        startCol,
        endLine,
        endCol,
      };
    }
  } catch (e) {
    // Don't break chat sending if selection capture fails
    console.warn('ep_ai_chat: failed to capture selection', e);
  }
};

/**
 * Extract text lines from the rep object.
 */
const extractLinesFromRep = (rep, startLine, endLine) => {
  const lines = [];
  try {
    for (let i = startLine; i <= endLine; i++) {
      const entry = rep.lines.atIndex(i);
      lines.push(entry ? entry.text : '');
    }
  } catch {
    return null;
  }
  return lines;
};
