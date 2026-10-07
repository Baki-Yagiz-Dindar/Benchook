'use strict';
// THE CATALOGUE SIGNATURE: WHAT CHANGE IS ANNOUNCED.
// 
// THE MEASURED DEFECT: the signature was built only from the name, account, provider and model. When the
// When-to-use description the orchestrator reads to CHOOSE an agent changed, nothing was announced; an
// open session carried on with the old description.
// 
// THE RULE: only BEHAVIOUR-CARRYING fields go into the signature.
// in  - name, description, account, provider, model, resolution reason, sign-in warning
// out - the PATH of the definition file (informational; an agent is called by name) and the TASK BODY
// (never shown in the catalogue; not broadcast to the orchestrator just for a signature)
// Order stays out too: the entries are sorted by name, so re-sorting after a file rename announces nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.join(__dirname, '..', 'tools', 'project-catalog.js');

function field(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-description-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.benchook', 'agents'), { recursive: true });
  return { root, data, project };
}

const folder = (project) => path.join(project, '.benchook', 'agents');
const definition = (name, extra = {}) => ['---', 'name: ' + name,
  'description: ' + (extra.description || (name + ' is for this')),
  'account: ' + (extra.account || 'orchestrator'), 'model: ' + (extra.model || 'orchestrator'),
  '---', '', (extra.task || 'Read and report.'), ''].join('\n');

const writeAgent = (project, name, extra, file) =>
  fs.writeFileSync(path.join(folder(project), (file || name) + '.md'), definition(name, extra));

function run({ data, project, session, event }) {
  const o = { ...process.env };
  for (const k of Object.keys(o)) if (/^CLAUDE|^CODEX_|^BENCHOOK_|^WORKER_/i.test(k)) delete o[k];
  o.BENCHOOK_DATA_DIR = data;
  o.BENCHOOK_PROJECT = project;
  o.CLAUDECODE = '1';
  o.CLAUDE_CODE_SESSION_ID = session;
  const r = spawnSync(process.execPath, [script, event], { encoding: 'utf8', cwd: project, env: o });
  assert.equal(r.status, 0, r.stderr);
  const raw = r.stdout.trim();
  return raw ? JSON.parse(raw).hookSpecificOutput.additionalContext : '';
}
const start = (a) => run({ ...a, event: '--session-start' });
const change = (a) => run({ ...a, event: '--prompt' });

/* ---- A DESCRIPTION CHANGE IS ANNOUNCED ---- */

test("even when only the description changes both sessions get the new description", (t) => {
  const { data, project } = field(t);
  writeAgent(project, 'auditor', { description: 'Review code' });
  start({ data, project, session: 'A' });
  start({ data, project, session: 'B' });

  writeAgent(project, 'auditor', { description: 'Use only for database migrations' });

  const a = change({ data, project, session: 'A' });
  const b = change({ data, project, session: 'B' });
  assert.match(a, /Use only for database migrations/, 'A must receive the new description');
  assert.match(b, /Use only for database migrations/, 'B must receive it too');
});

test("a description change is not repeated on the second round", (t) => {
  const { data, project } = field(t);
  writeAgent(project, 'auditor', { description: 'Review code' });
  start({ data, project, session: 'A' });
  writeAgent(project, 'auditor', { description: 'Review migrations' });

  assert.match(change({ data, project, session: 'A' }), /Review migrations/);
  assert.equal(change({ data, project, session: 'A' }), '', 'silence must stay the default');
});

test("if nothing changed not a single character is written", (t) => {
  const { data, project } = field(t);
  writeAgent(project, 'auditor', { description: 'Review code' });
  start({ data, project, session: 'A' });

  // Rewrite the file with the SAME content: the mtime changes, the meaning does not.
  writeAgent(project, 'auditor', { description: 'Review code' });
  assert.equal(change({ data, project, session: 'A' }), '', 'mtime is not a signature');
});

/* ---- DIFFERENCES WITH NO MEANING ARE NOT ANNOUNCED ---- */

test("renaming the definition file produces no announcement", (t) => {
  const { data, project } = field(t);
  writeAgent(project, 'auditor', { description: 'Review code' }, 'a-auditor');
  writeAgent(project, 'writer', { description: 'Write docs' }, 'b-writer');
  start({ data, project, session: 'A' });

  /* The same two agents with the same fields; only a file name changed. The order flips, but an agent is
     called by name and the path is informational: there is nothing to announce. */
  fs.renameSync(path.join(folder(project), 'a-auditor.md'), path.join(folder(project), 'z-auditor.md'));

  assert.equal(change({ data, project, session: 'A' }), '');
});

test("the task body does not enter the signature and is not broadcast to the orchestrator", (t) => {
  const { data, project } = field(t);
  writeAgent(project, 'auditor', { description: 'Review code', task: 'An older hidden task.' });
  start({ data, project, session: 'A' });

  writeAgent(project, 'auditor', { description: 'Review code', task: 'A NEW HIDDEN TASK TEXT.' });

  assert.equal(change({ data, project, session: 'A' }), '',
    'a task text that is not shown in the catalogue must produce no announcement');
});

/* ---- THE EXISTING ANNOUNCEMENTS ARE PRESERVED ---- */

test("a change of account or model is still announced", (t) => {
  const { data, project } = field(t);
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'accounts.json'), JSON.stringify({
    accounts: [{ id: 'claude-second', name: 'Second', provider: 'claude', folder: null }],
  }));
  writeAgent(project, 'auditor', { description: 'Review code' });
  start({ data, project, session: 'A' });

  writeAgent(project, 'auditor', { description: 'Review code', account: 'claude-second', model: 'haiku' });

  const c = change({ data, project, session: 'A' });
  assert.match(c, /Project agent settings changed/, 'the routing changed; the full list must be given');
  assert.match(c, /haiku/);
});

test("the announcements for adding and removing an agent are not broken", (t) => {
  const { data, project } = field(t);
  writeAgent(project, 'auditor', { description: 'Review code' });
  start({ data, project, session: 'A' });

  writeAgent(project, 'writer', { description: 'Write docs' });
  assert.match(change({ data, project, session: 'A' }), /Agent added to this project/);

  fs.unlinkSync(path.join(folder(project), 'writer.md'));
  assert.match(change({ data, project, session: 'A' }), /Agent removed from this project: writer/);
});

/* ---- SCHEMA VERSION ---- */

test("a record with an old version does not produce a wrong diff", (t) => {
  const { data, project } = field(t);
  const status = require('../panel/catalog-state');
  writeAgent(project, 'auditor', { description: 'Review code' });
  start({ data, project, session: 'A' });

  // Downgrade the record on disk to the previous schema version.
  const filePath = status.storePath(data, project, 'A');
  const body = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  body.version = status.VERSION - 1;
  fs.writeFileSync(filePath, JSON.stringify(body, null, 2));

  const first = change({ data, project, session: 'A' });
  assert.match(first, /Agents assigned to this project/,
    'an unrecognised version is no baseline; the full list is given instead of an invented diff');
  assert.equal(change({ data, project, session: 'A' }), '', 'it must go quiet afterwards');
});

test("when an unrecognised version is read there is no baseline", (t) => {
  const { root, project } = field(t);
  const status = require('../panel/catalog-state');
  status.write(root, project, 'A', { signature: 'x', connection: 'none' });
  const filePath = status.storePath(root, project, 'A');
  const body = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  assert.equal(status.read(root, project, 'A').signature, 'x');
  fs.writeFileSync(filePath, JSON.stringify({ ...body, version: 1 }, null, 2));
  assert.deepEqual(status.read(root, project, 'A'), { signature: null, connection: null });
});
