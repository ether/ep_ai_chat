'use strict';

const Changeset = require('ep_etherpad-lite/static/js/Changeset');
const padMessageHandler = require('ep_etherpad-lite/node/handler/PadMessageHandler');
const log4js = require('ep_etherpad-lite/node_modules/log4js');
const logger = log4js.getLogger('ep_ai_chat:editor');

const applyEdit = async (pad, edit) => {
  const currentText = pad.text();
  const authorId = edit.authorId || '';

  try {
    let changeset;

    if (edit.appendText) {
      const insertPos = currentText.length - 1;
      changeset = Changeset.makeSplice(currentText, insertPos, 0, edit.appendText);
    } else if (edit.findText && edit.replaceText !== undefined) {
      const idx = currentText.indexOf(edit.findText);
      if (idx === -1) return {success: false, error: `Text not found: "${edit.findText.substring(0, 100)}"`};
      changeset = Changeset.makeSplice(currentText, idx, edit.findText.length, edit.replaceText);
    } else {
      return {success: false, error: 'No valid edit operation specified'};
    }

    await pad.appendRevision(changeset, authorId);
    // Broadcast the changeset to all connected clients so they see the update live
    await padMessageHandler.updatePadClients(pad);
    return {success: true};
  } catch (err) {
    logger.error(`Edit failed: ${err.message}`);
    return {success: false, error: err.message};
  }
};

exports.applyEdit = applyEdit;
