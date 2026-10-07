// CATALOGUE STATE - the one place that answers "what did THIS SESSION last hear in THIS PROJECT".
//
// WHY A SEPARATE FILE AND A SEPARATE SCHEMA
//
// The state used to be a single JSON file keyed by PROJECT PATH. It carried two defects at once:
//
//   R10 - with two sessions open in one project, one CONSUMED the notification of the other. Once
//         session A ran the change hook and wrote the new signature, nothing had changed as far as
//         B was concerned; the user added an agent and session B never heard about it. A
//         notification belongs to a session, not to a project.
//
// - the key was the RAW path string. In a real file the same project was recorded TWICE:
//         once with backslashes, once with forward slashes. The signature of the second was empty
//         and the connection state had never been written, so a session arriving with that spelling
//         could not see a connection change.
//
// A THIRD RISK, SOLVED BY THE SCHEMA: independent processes that read-modify-write one file swallow
// each other's updates. Here every (project, session) pair writes to ITS OWN file - no process
// touches the record of another, so the race disappears structurally.
//
// WHAT "ONE RECORD" DOES NOT MEAN: a single project identity does NOT mean every session meets at a
// single point of consumption. The identity is one; the notification state is per session.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const persistentJson = require('./persistent-json');

/* SCHEMA VERSION. A record with an unrecognised version IS NOT TAKEN AS A BASELINE: the caller
   treats it as "no record at all" and gives the full list once. Parsing an old signature shape with
   the new rule would produce an invented difference - agents that do not exist being announced as
   added or removed.
   3 = the signature is now the behaviour-carrying fields sorted by name. */
const VERSION = 3;
const FOLDER = 'catalog-state';          // older single-file store: `katalog-durum.json` (left untouched)
const STALE_DAYS = 30;                   // records of closed sessions must not linger forever

/* THE ENVIRONMENT VARIABLES THAT SUPPLY A SESSION IDENTITY, in order of trust. The evidence for
   each is written down separately, because none of the three was taken on the strength of its name:
     CLAUDE_CODE_SESSION_ID  SEEN in the environment of the child processes Claude Code opens.
     CODEX_SESSION_ID        present in the strings of the installed codex binary; whether it REACHES
                             the environment of a hook WAS NOT MEASURED - that needs a real Codex run.
     CODEX_THREAD_ID         existed in older Codex versions: the panel set this variable itself and
                             it was inherited. The current binary has no such string.
     BENCHOOK_SESSION        the pane identity the panel writes itself (`main.js terminal:open`).
                             Even when the harness supplies no identity at all, panel terminals stay
                             distinct.
   The order matters: if the harness gives its own identity that one is used; the panel one is the
   fallback. */
const SESSION_KEYS = [
  'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'BENCHOOK_SESSION',
];

/** The bucket used when the harness supplies no identity at all. AN IDENTITY IS NOT INVENTED:
 *  generating a fresh one per run would mean mistaking every message for a new session and
 *  rewriting the full list every time. */
const ANONYMOUS = 'session-unknown';

/**
 * The single identity of a project. Spelling differences (separator direction, a trailing separator,
 * `..`, letter case on Windows) collapse to the same value; different projects stay separate.
 */
function projectId(filePath) {
  const raw = String(filePath == null ? '' : filePath).trim();
  if (!raw) return '';
  let x;
  try { x = path.resolve(raw); } catch { x = raw; }
  x = x.replace(/[\\/]+/g, '/').replace(/(.)\/+$/, '$1');
  return process.platform === 'win32' ? x.toLowerCase() : x;
}

/**
 * Which session triggered this run.
 * @returns {{id:string|null, source:string|null}} source = the name of the variable that supplied the
 *   value; with no identity both are `null` and the caller handles that EXPLICITLY.
 */
function sessionIdFromFile(env) {
  const o = env || {};
  for (const name of SESSION_KEYS) {
    const d = String(o[name] == null ? '' : o[name]).trim();
    if (d) return { id: d, source: name };
  }
  return { id: null, source: null };
}

const digest = (s) => crypto.createHash('sha1').update(String(s), 'utf8').digest('hex').slice(0, 16);
const readable = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** The folder holding every session record of a project. */
function projectFolder(root, project) {
  return path.join(root, FOLDER, digest(projectId(project)));
}

/** The OWN file of a (project, session) pair. The name is readable; its uniqueness comes from the digest. */
function storePath(root, project, session) {
  const sid = session || ANONYMOUS;
  const name = readable(sid);
  return path.join(projectFolder(root, project), (name ? name + '-' : '') + digest(sid) + '.json');
}

/**
 * What this session last heard in this project.
 * @returns {{signature:string|null, connection:string|null}} with no record, both are `null`.
 */
function read(root, project, session) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(storePath(root, project, session), 'utf8')); }
  catch { return { signature: null, connection: null }; }
  if (!raw || typeof raw !== 'object') return { signature: null, connection: null };
  if (raw.version !== VERSION) return { signature: null, connection: null };
  return {
    signature: typeof raw.signature === 'string' ? raw.signature : null,
    connection: typeof raw.connection === 'string' ? raw.connection : null,
  };
}

/**
 * Write the record. If it cannot be written it is skipped SILENTLY: the hook still runs, it just
 * announces the same thing again on the next round. Missing an announcement is worse than repeating one.
 * @returns {boolean} whether it was written
 */
function write(root, project, session, record) {
  const body = {
    version: VERSION,
    filePath: String(project == null ? '' : project),
    id: projectId(project),
    session: session || null,
    source: (record && record.source) || null,
    signature: (record && record.signature) || '',
    connection: (record && record.connection) || null,
    time: new Date().toISOString(),
  };
  try {
    persistentJson.atomicText(storePath(root, project, session), JSON.stringify(body, null, 2) + '\n');
    return true;
  } catch { return false; }
}

/**
 * Collects the records of closed sessions. Only the start hook calls this; deleting the record of a
 * live session makes it speak once more than it should, so the cutoff is kept long.
 * @returns {number} the number of files deleted
 */
function cleanOld(root, project, day = STALE_DAYS) {
  const folder = projectFolder(root, project);
  const limit = Date.now() - day * 24 * 60 * 60 * 1000;
  let removedPaths = 0;
  let signIns;
  try { signIns = fs.readdirSync(folder); } catch { return 0; }
  for (const name of signIns) {
    if (!name.endsWith('.json')) continue;
    const y = path.join(folder, name);
    try {
      if (fs.statSync(y).mtimeMs >= limit) continue;
      fs.unlinkSync(y);
      removedPaths += 1;
    } catch { /* someone else deleted it, or it cannot be read */ }
  }
  return removedPaths;
}

module.exports = {
  VERSION, FOLDER, ANONYMOUS, STALE_DAYS, SESSION_KEYS,
  projectId, sessionIdFromFile, projectFolder, storePath, read, write, cleanOld,
};
