'use strict';

const Changeset = require('ep_etherpad-lite/static/js/Changeset');
const log4js = require('ep_etherpad-lite/node_modules/log4js');
const logger = log4js.getLogger('ep_ai_chat:editor');

const applyEdit = async (pad, edit) => {
  const currentText = pad.text();
  const authorId = edit.authorId || '';

  try {
    if (edit.appendText) {
      const insertPos = currentText.length - 1;
      const changeset = Changeset.makeSplice(currentText, insertPos, 0, edit.appendText);
      await pad.appendRevision(changeset, authorId);
      return {success: true};
    }

    if (edit.findText && edit.replaceText !== undefined) {
      const idx = currentText.indexOf(edit.findText);
      if (idx === -1) return {success: false, error: `Text not found: "${edit.findText.substring(0, 100)}"`};
      const changeset = Changeset.makeSplice(currentText, idx, edit.findText.length, edit.replaceText);
      await pad.appendRevision(changeset, authorId);
      return {success: true};
    }

    return {success: false, error: 'No valid edit operation specified'};
  } catch (err) {
    logger.error(`Edit failed: ${err.message}`);
    return {success: false, error: err.message};
  }
};

exports.applyEdit = applyEdit;
