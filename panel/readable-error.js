'use strict';
/* TRANSLATE THE ERROR INTO THE LANGUAGE OF THE USER - a defect found during a screen review.
   Two separate problems: a raw Node error is not the language of the user, and the `.tmp` file in it
   is the OWN internal business of the panel - the user cannot know what it is, and it makes their
   file look as if something odd were in it. The mechanism was right; the sentence was not.

   Shared by agent and skill publishing: skills used to show the raw Node text, including the panel's
   own staging folder names.

   THE RAW TEXT IS NOT THROWN AWAY by callers that keep a `detail` field. Only the sentence shown on
   screen is simplified. */
const product = require('./product');

const REASONS = {
  EPERM: "Benchook does not have permission to write there.",
  EACCES: "Benchook does not have permission to write there.",
  EROFS: "That location is read-only.",
  ENOSPC: "There is not enough disk space.",
  EBUSY: "The file is open in another program.",
  ENOENT: "That folder no longer exists.",
};
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OWN_FOLDERS = new RegExp('(' + escape(product.STAGING_PREFIX) + '|' + escape(product.BACKUP_PREFIX) + ')[0-9a-fA-F-]{36}', 'g');

/** The names of the panel's own temporary files and folders are not shown to the user. */
const noTemp = (m) => String(m == null ? '' : m)
  .replace(/\.[0-9a-fA-F-]{36}\.tmp/g, '')
  .replace(OWN_FOLDERS, '')
  .trim();

function readableError(e, operation = 'write') {
  return operation === 'read' && ['EPERM', 'EACCES'].includes(e && e.code)
    ? 'Benchook does not have permission to read this file.'
    : REASONS[e && e.code] || noTemp(e && e.message) || noTemp(typeof e === 'string' ? e : '') || 'Unknown error';
}

module.exports = { readableError, noTemp };
