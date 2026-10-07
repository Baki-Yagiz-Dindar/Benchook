// A small run ledger, so workers started through the shared MCP server are visible in the panel.
// Records are written to the user data folder of the panel, never into project files.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const hash = (x) => crypto.createHash('sha256').update(x).digest('hex').slice(0, 24);

/* ONE FOLDER PER PROJECT, WHATEVER THE SPELLING. The writer (the worker server, from the terminal's
   folder) and the reader (the panel, from its saved project path) compute this key in two processes.
   The key used to hash the path as typed, so `c:\work\app` and `C:\Work\App` were two folders on
   Windows: the run never showed in the panel and its permission question could not be answered. The
   key is now the shared project identity (`catalog-state.projectId`: separators, trailing separator
   and, on Windows, letter case). Records already written under the old key are still read and kept
   where they are. */
function projectId(project) {
  return hash(require('./catalog-state').projectId(project || '.'));
}
function legacyId(project) { return hash(path.resolve(project || '.')); }

function folder(root, project) { return path.join(root, 'worker-runs', projectId(project)); }
function folders(root, project) {
  return [...new Set([projectId(project), legacyId(project)])].map((id) => path.join(root, 'worker-runs', id));
}
/** The folder that already holds this run's record, so an update never splits a run in two. */
function recordFolder(root, project, id) {
  for (const k of folders(root, project)) {
    if (fs.existsSync(path.join(k, id + '.json'))) return k;
  }
  return folder(root, project);
}

/* WRITTEN WHOLE OR NOT AT ALL. The panel reads these records every 1.2 s; a record written in place
   could be read half-written (or left so by a crash or a full disk), and the run vanished from the
   screen. The write goes to a temporary file that replaces the record in one step. */
function write(root, project, record) {
  const k = /^[a-z0-9-]+$/i.test(String(record.id)) ? recordFolder(root, project, record.id) : folder(root, project);
  fs.mkdirSync(k, { recursive: true });
  const target = path.join(k, record.id + '.json');
  require('./persistent-json').atomic(target, { ...record, project: path.resolve(project) });
  if (record.status === 'running') prune(k);
  return target;
}

/* THE RUN LEDGER DOES NOT GROW FOREVER. Every record was kept and every one was read on each 1.2-second
   round. When a new run starts, finished runs older than 30 days are removed together with their
   question folders; the newest 200 are always kept. Running records are never touched. */
const KEEP_DAYS = 30, KEEP_NEWEST = 200;
function prune(k, now = Date.now()) {
  let names;
  try { names = fs.readdirSync(k).filter((x) => x.endsWith('.json')); } catch { return; }
  const records = names.map((name) => {
    try { return { name, r: JSON.parse(fs.readFileSync(path.join(k, name), 'utf8')) }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => String(b.r.startedAt).localeCompare(String(a.r.startedAt)));
  for (const { name, r } of records.slice(KEEP_NEWEST)) {
    const at = Date.parse(r.updatedAt || r.startedAt || '');
    if (r.status === 'running' || !Number.isFinite(at) || now - at < KEEP_DAYS * 86400000) continue;
    try { fs.rmSync(path.join(k, name), { force: true }); } catch { /* next time */ }
    if (/^[a-z0-9-]+$/i.test(String(r.id))) {
      try { fs.rmSync(path.join(k, r.id + '.approvals'), { recursive: true, force: true }); } catch { /* next time */ }
    }
  }
}

function list(root, project) {
  const seen = new Set();
  const records = [];
  for (const k of folders(root, project)) {
    let names;
    try { names = fs.readdirSync(k).filter((x) => x.endsWith('.json')); } catch { continue; }
    for (const name of names) {
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(k, name), 'utf8')); } catch { continue; }
      if (!r || seen.has(r.id)) continue;
      seen.add(r.id);
      records.push(r);
    }
  }
  return records.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

/** Where the permission prompts of a run wait for the user (`approvals.js`), beside its record. */
function approvalsFolder(root, project, id) {
  if (!/^[a-z0-9-]+$/i.test(String(id))) throw new Error('Invalid run id');
  return path.join(recordFolder(root, project, id), id + '.approvals');
}

/** The open permission prompts of each running run, for the live run card. */
function withQuestions(root, project, records) {
  const approvals = require('./approvals');
  return records.map((r) => ({ ...r, questions: r.status === 'running' && /^[a-z0-9-]+$/i.test(String(r.id))
    ? approvals.pending(approvalsFolder(root, project, r.id)) : [] }));
}

/** The user's answer to a question of a running run; nothing else can be answered. */
function answer(root, project, runId, questionId, decision) {
  const record = /^[a-z0-9-]+$/i.test(String(runId)) ? list(root, project).find((r) => r.id === runId) : null;
  if (!record) return { error: 'That run was not found.' };
  if (record.status !== 'running') return { error: 'That run is not running any more.' };
  return require('./approvals').answer(approvalsFolder(root, project, runId), questionId, decision);
}

module.exports = { write, list, approvalsFolder, withQuestions, answer, prune };
