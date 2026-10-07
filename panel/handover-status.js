'use strict';
// Shows the user WHETHER THE HANDOVER NOTE IS CURRENT while the provider is being switched.
//
// WHY IT EXISTS: the panel used to write only "make sure it is current", which forced the user
// to confirm something they had no way of knowing. The panel therefore DOES NOT DECIDE and DOES
// NOT TOUCH the file; it shows the two timestamps and the user decides.
//
// NO GUESS IS WRITTEN FOR SOMETHING UNKNOWN: if a time cannot be read, stale comes back as null
// and the line says so plainly. That is safety contract.

const path = require('node:path');

/** Where the handoff notes are looked for when the user has not chosen a file. */
const DEFAULT_FILE = 'docs/HANDOVER.md';

/** The handoff-notes file for a project, from the user's setting. Only a path inside the
    project is accepted: an absolute path or one that climbs out with `..` gives null, and the
    panel then says the notes are unavailable rather than reading a file elsewhere. */
function notePath(project, setting) {
  if (!project) return null;
  const relative = String(setting || '').trim() || DEFAULT_FILE;
  if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) return null;
  const root = path.resolve(project);
  const file = path.resolve(root, relative);
  const inside = path.relative(root, file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return file;
}

function hour(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, '0');
  return two(d.getHours()) + ':' + two(d.getMinutes());
}

function elapsed(ms, now) {
  const minutes = Math.round((now - ms) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return minutes + " minutes ago";
  const sa = Math.floor(minutes / 60);
  return sa + " h " + (minutes % 60) + " minutes ago";
}

/** @returns {{lines: string[], stale: boolean|null}} stale === null means THE TWO COULD NOT BE COMPARED. */
function digest(handoverTime, sessionHead, now) {
  const lines = [];

  if (!handoverTime) lines.push("Handoff notes are unavailable. The file may be missing or moved.");
  else lines.push("Handoff notes last updated: " + hour(handoverTime) + ' (' + elapsed(handoverTime, now) + ')');

  if (!sessionHead) lines.push("Session start time is unavailable.");
  else lines.push("Session started: " + hour(sessionHead) + ' (' + elapsed(sessionHead, now) + ')');

  if (!handoverTime || !sessionHead) {
    lines.push("Cannot determine whether the handoff notes are current.");
    return { lines, stale: null };
  }

  const stale = handoverTime < sessionHead;
  lines.push(stale
    ? "The notes predate this session and may not include its latest work."
    : "The notes were updated after this session started.");
  return { lines, stale };
}

module.exports = { digest, notePath, DEFAULT_FILE };
