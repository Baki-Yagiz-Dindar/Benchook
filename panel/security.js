'use strict';
const { pathToFileURL } = require('node:url');

function externalUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href : null;
  } catch { return null; }
}

function trustedSender(event, window, file) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents
      || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) return false;
  try {
    const url = new URL(event.senderFrame.url);
    url.search = ''; url.hash = '';
    return url.href === pathToFileURL(file).href;
  } catch { return false; }
}

module.exports = { externalUrl, trustedSender };
