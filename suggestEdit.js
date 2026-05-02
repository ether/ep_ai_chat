'use strict';

const padMessageHandler = require('ep_etherpad-lite/node/handler/PadMessageHandler');
const {Builder} = require('ep_etherpad-lite/static/js/Builder');
const log4js = require('ep_etherpad-lite/node_modules/log4js');
const logger = log4js.getLogger('ep_ai_chat:suggest');

const suggestEdit = async (pad, edit, deps) => {
  const {requesterAuthorId, aiAuthorId, aiAuthorName, commentManager, shared, io} = deps;
  const currentText = pad.text();

  const idx = currentText.indexOf(edit.findText);
  if (idx === -1) {
    return {success: false, error: `Text not found: "${edit.findText.substring(0, 100)}"`};
  }

  let commentId;
  let comment;
  try {
    commentId = shared.generateCommentId();
    comment = {
      commentId,
      name: aiAuthorName,
      author: aiAuthorId,
      text: edit.explanation || 'AI suggestion',
      changeFrom: edit.findText,
      changeTo: edit.replaceText,
      timestamp: Date.now(),
    };
    await commentManager.bulkAddComments(pad.id, [comment]);
  } catch (err) {
    logger.error(`Failed to persist suggestion comment: ${err.message}`);
    return {success: false, error: `comment persistence failed: ${err.message}`};
  }

  try {
    const builder = new Builder(currentText.length);
    const before = currentText.substring(0, idx);
    const match = edit.findText;
    const after = currentText.substring(idx + match.length);
    if (before.length) builder.keepText(before);
    const attribs = [['comment', commentId]];
    if (requesterAuthorId) {
      attribs.push(['ep_ai_chat:requestedBy', requesterAuthorId]);
    }
    builder.keepText(match, attribs, pad.pool);
    if (after.length) builder.keepText(after);
    const changeset = builder.toString();
    await pad.appendRevision(changeset, aiAuthorId);
    await padMessageHandler.updatePadClients(pad);
  } catch (err) {
    logger.error(`Failed to anchor suggestion changeset: ${err.message}`);
    return {success: false, error: `anchor failed: ${err.message}`};
  }

  if (io) {
    try {
      io.to(pad.id).emit('pushAddComment', commentId, comment);
    } catch (err) {
      logger.warn(`pushAddComment broadcast failed: ${err.message}`);
    }
  }

  return {success: true, commentId};
};

exports.suggestEdit = suggestEdit;
