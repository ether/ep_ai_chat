'use strict';

const Changeset = require('ep_etherpad-lite/static/js/Changeset');
const {Builder} = require('ep_etherpad-lite/static/js/Builder');
const padMessageHandler = require('ep_etherpad-lite/node/handler/PadMessageHandler');
const authorManager = require('ep_etherpad-lite/node/db/AuthorManager');
const log4js = require('ep_etherpad-lite/node_modules/log4js');
const {diffOps, countNewlines} = require('./surgicalDiff');
const logger = log4js.getLogger('ep_ai_chat:editor');

// Fallback author used when the caller doesn't supply edit.authorId. An insert
// op with no author attribute desyncs pad.atext.text vs pad.atext.attribs and
// breaks every later client load in ace2_inner.ts:setDocAText. Using a stable
// system author keeps the AText well-formed without forcing every plugin entry
// point to allocate one up-front. Mirrors core Pad.SYSTEM_AUTHOR_ID.
const SYSTEM_AUTHOR_ID = 'a.ep-ai-chat-system';

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

/**
 * Construct a changeset that turns currentText into currentText with
 * findText (at idx) replaced by replaceText, but ONLY tagging the
 * inserted runs with the AI's author attributes. Runs that already
 * existed verbatim in findText keep their original authorship.
 */
const buildSurgicalChangeset = ({currentText, idx, edit, attribs, pool}) => {
  const builder = new Builder(currentText.length);
  const before = currentText.substring(0, idx);
  const after = currentText.substring(idx + edit.findText.length);
  if (before.length) builder.keepText(before);
  for (const op of diffOps(edit.findText, edit.replaceText)) {
    if (op.type === 'keep') {
      builder.keepText(op.text);
    } else if (op.type === 'remove') {
      builder.remove(op.text.length, countNewlines(op.text));
    } else if (op.type === 'insert') {
      builder.insert(op.text, attribs, pool);
    }
  }
  if (after.length) builder.keepText(after);
  return builder.toString();
};

const applyEdit = async (pad, edit, io = null) => {
  const currentText = pad.text();
  // Callers that don't supply an authorId still need the resulting insert ops
  // to carry an 'author' attribute, otherwise pad.atext.text and
  // pad.atext.attribs end up with different lengths and the pad becomes
  // unloadable. Fall back to a stable system author so the changeset is
  // always well-formed.
  const effectiveAuthorId = edit.authorId || SYSTEM_AUTHOR_ID;

  try {
    // Build attributes: author for color/attribution, ep_ai_chat:requestedBy
    // for provenance so phase B can resolve "my writing" later.
    const attribList = [['author', effectiveAuthorId]];
    if (edit.requesterAuthorId) {
      attribList.push(['ep_ai_chat:requestedBy', edit.requesterAuthorId]);
    }
    const attribs = attribList;
    const pool = pad.pool;

    let changeset;

    if (edit.appendText) {
      const insertPos = currentText.length - 1;
      changeset = Changeset.makeSplice(currentText, insertPos, 0, edit.appendText, attribs, pool);
    } else if (edit.findText && edit.replaceText !== undefined) {
      const idx = currentText.indexOf(edit.findText);
      if (idx === -1) return {success: false, error: `Text not found: "${edit.findText.substring(0, 100)}"`};
      // Diff findText -> replaceText so we only re-author the genuinely-
      // changed runs. A single makeSplice would tag every char of
      // replaceText with our author attribute even where the AI didn't
      // actually rewrite anything (e.g. "we would <love> to play" ->
      // "we would <deeply...> to play" must keep "we would" / "to play"
      // attributed to whoever originally wrote them).
      changeset = buildSurgicalChangeset({
        currentText, idx, edit, attribs, pool,
      });
    } else {
      return {success: false, error: 'No valid edit operation specified'};
    }

    await pad.appendRevision(changeset, effectiveAuthorId);
    await padMessageHandler.updatePadClients(pad);

    // Announce AI as an author so it appears in the user list. Gated on the
    // caller-supplied authorId, not the system fallback — the system author
    // is intentionally invisible in the user list.
    if (edit.authorId) await announceAiAuthor(pad.id, edit.authorId, io);

    return {success: true};
  } catch (err) {
    logger.error(`Edit failed: ${err.message}`);
    return {success: false, error: err.message};
  }
};

exports.applyEdit = applyEdit;
exports.announceAiAuthor = announceAiAuthor;
