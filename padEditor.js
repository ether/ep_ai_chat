'use strict';

const Changeset = require('ep_etherpad-lite/static/js/Changeset');
const padMessageHandler = require('ep_etherpad-lite/node/handler/PadMessageHandler');
const authorManager = require('ep_etherpad-lite/node/db/AuthorManager');
const log4js = require('ep_etherpad-lite/node_modules/log4js');
const logger = log4js.getLogger('ep_ai_chat:editor');

/**
 * Broadcast AI author info to all clients on a pad so the AI
 * appears in the user/author list with name and color.
 *
 * `io` is the socket.io server reference. The plugin's index.js
 * captures it via the `socketio` hook and threads it down here so we
 * don't depend on a non-existent module-level export.
 */
const announceAiAuthor = async (padId, authorId, io) => {
  try {
    const authorInfo = await authorManager.getAuthor(authorId);
    if (!authorInfo || !io) {
      logger.warn(
          `announceAiAuthor: skipped — authorInfo=${!!authorInfo} io=${!!io}`);
      return;
    }
    io.sockets.in(padId).emit('message', {
      type: 'COLLABROOM',
      data: {
        type: 'USER_NEWINFO',
        userInfo: {
          colorId: authorInfo.colorId,
          name: authorInfo.name,
          userId: authorId,
        },
      },
    });
  } catch (err) {
    logger.warn(`Failed to announce AI author: ${err.message}`);
  }
};

const applyEdit = async (pad, edit, io = null) => {
  const currentText = pad.text();
  const authorId = edit.authorId || '';

  try {
    // Build attributes: author for color/attribution, ep_ai_chat:requestedBy
    // for provenance so phase B can resolve "my writing" later.
    const attribList = [];
    if (authorId) attribList.push(['author', authorId]);
    if (edit.requesterAuthorId) {
      attribList.push(['ep_ai_chat:requestedBy', edit.requesterAuthorId]);
    }
    const attribs = attribList.length ? attribList : undefined;
    const pool = attribs ? pad.pool : undefined;

    let changeset;

    if (edit.appendText) {
      const insertPos = currentText.length - 1;
      changeset = Changeset.makeSplice(currentText, insertPos, 0, edit.appendText, attribs, pool);
    } else if (edit.findText && edit.replaceText !== undefined) {
      const idx = currentText.indexOf(edit.findText);
      if (idx === -1) return {success: false, error: `Text not found: "${edit.findText.substring(0, 100)}"`};
      changeset = Changeset.makeSplice(currentText, idx, edit.findText.length, edit.replaceText, attribs, pool);
    } else {
      return {success: false, error: 'No valid edit operation specified'};
    }

    await pad.appendRevision(changeset, authorId);
    await padMessageHandler.updatePadClients(pad);

    // Announce AI as an author so it appears in the user list
    if (authorId) await announceAiAuthor(pad.id, authorId, io);

    return {success: true};
  } catch (err) {
    logger.error(`Edit failed: ${err.message}`);
    return {success: false, error: err.message};
  }
};

exports.applyEdit = applyEdit;
exports.announceAiAuthor = announceAiAuthor;
