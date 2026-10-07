'use strict';
// CATALOGUE STATE: PROJECT IDENTITY + NOTIFICATION PER SESSION - and.
//
// THE TWO MEASURED DEFECTS:
//   R10    The state file was keyed by PROJECT only. With two sessions in the same project, the read of
//          one CONSUMED the notification of the other: once A ran the prompt event and wrote the new
//          signature, nothing had changed as far as B was concerned and B never heard about the agent.
// The key was the RAW path string. In a live state file the same project was recorded twice --
//          once with backslashes, once with forward slashes. A session arriving with the other spelling
//          could not see a connection change.
//
// These tests expect the CORRECT behaviour and were written BEFORE the fix.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.join(__dirname, '..', 'tools', 'project-catalog.js');

function field(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.benchook', 'agents'), { recursive: true });
  return { root, data, project };
}

const definition = (name, extra = {}) => ['---', 'name: ' + name, 'description: what ' + name + ' is for',
  'account: ' + (extra.account || 'orchestrator'), 'model: ' + (extra.model || 'orchestrator'),
  '---', '', 'Read and report.', ''].join('\n');

const writeAgent = (project, name, extra) =>
  fs.writeFileSync(path.join(project, '.benchook', 'agents', name + '.md'), definition(name, extra));

/** A real run of the hook. The session identity comes from the environment; the environment is cleaned
  *  so the own session variables of THIS process do not leak in. */
function env(data, projectSpelling, session) {
  const o = { ...process.env };
  for (const k of Object.keys(o)) if (/^CLAUDE|^CODEX_|^BENCHOOK_|^WORKER_/i.test(k)) delete o[k];
  o.BENCHOOK_DATA_DIR = data;
  o.BENCHOOK_PROJECT = projectSpelling;
  o.CLAUDECODE = '1';                   // make the provider explicit so the connection state can be measured
  if (session) o.CLAUDE_CODE_SESSION_ID = session;
  return o;
}

function run({ data, project, session, event, spelling }) {
  const r = spawnSync(process.execPath, [script, event], {
    encoding: 'utf8', cwd: project, env: env(data, spelling || project, session),
  });
  assert.equal(r.status, 0, r.stderr);
  const raw = r.stdout.trim();
  return raw ? JSON.parse(raw).hookSpecificOutput.additionalContext : '';
}
const start = (a) => run({ ...a, event: '--session-start' });
const change = (a) => run({ ...a, event: '--prompt' });

/* ---- R10: THE READ OF ONE SESSION DOES NOT CONSUME THAT OF ANOTHER ---- */

test("two sessions in the same project hear about a new agent SEPARATELY", (t) => {
  const { data, project } = field(t);
  writeAgent(project, 'auditor');
  start({ data, project, session: 'A' });
  start({ data, project, session: 'B' });

  writeAgent(project, 'writer');
  const a = change({ data, project, session: 'A' });
  const b = change({ data, project, session: 'B' });

  assert.match(a, /writer/, 'A must hear about the new agent');
  assert.match(b, /writer/, 'B must hear it too: B cannot be silenced because A was told');
});

test("if A restarts, B does not go quiet", (t) => {
  const { data, project } = field(t);
  writeAgent(project, 'auditor');
  start({ data, project, session: 'A' });
  start({ data, project, session: 'B' });

  writeAgent(project, 'writer');
  start({ data, project, session: 'A' });        // A reopened: it already received the full list

  assert.match(change({ data, project, session: 'B' }), /writer/);
});

test("once it has heard it, the SAME session does not hear it again", (t) => {
  const { data, project } = field(t);
  writeAgent(project, 'auditor');
  start({ data, project, session: 'A' });
  writeAgent(project, 'writer');

  assert.match(change({ data, project, session: 'A' }), /writer/);
  assert.equal(change({ data, project, session: 'A' }), '', 'an unchanged list writes not a single character');
});

test("a connection setup is announced to each session SEPARATELY", (t) => {
  const { data, project } = field(t);
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'accounts.json'), JSON.stringify({
    accounts: [{ id: 'claude-second', name: 'Second', provider: 'claude', folder: null }],
  }));
  writeAgent(project, 'auditor', { account: 'claude-second', model: 'haiku' });
  start({ data, project, session: 'A' });
  start({ data, project, session: 'B' });

  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { worker: { command: 'node', args: [path.join(__dirname, '..', 'tools', 'mcp-server.js')] } },
  }));

  assert.match(change({ data, project, session: 'A' }), /connection is now configured/i);
  assert.match(change({ data, project, session: 'B' }), /connection is now configured/i,
    'a connection change is per session as well');
});

/* ---- PATH SPELLINGS COLLAPSE TO ONE IDENTITY ---- */

test("a backslash and a forward slash are the SAME project", (t) => {
  const { data, project } = field(t);
  const flat = project.replace(/\\/g, '/');
  writeAgent(project, 'auditor');
  start({ data, project, session: 'A', spelling: project });

  writeAgent(project, 'writer');
  assert.match(change({ data, project, session: 'A', spelling: flat }), /writer/,
    'a session arriving with the other spelling must see the change');
  assert.equal(change({ data, project, session: 'A', spelling: project }), '',
    'the two spellings are one record: the first spelling must not announce a second time');
});

test("a trailing separator and letter case do not create a second record", (t) => {
  const { data, project } = field(t);
  writeAgent(project, 'auditor');
  start({ data, project, session: 'A' });
  writeAgent(project, 'writer');

  const variant = process.platform === 'win32'
    ? project.replace(/^([A-Za-z]):/, (m, h) => h.toLowerCase() + ':') + path.sep
    : project + path.sep;
  assert.match(change({ data, project, session: 'A', spelling: variant }), /writer/);
  assert.equal(change({ data, project, session: 'A' }), '', 'a variant must not create a separate record');
});

test("different projects stay separate", (t) => {
  const { root, data, project } = field(t);
  const other = path.join(root, 'other');
  fs.mkdirSync(path.join(other, '.benchook', 'agents'), { recursive: true });
  writeAgent(project, 'auditor');
  writeAgent(other, 'someoneElse');
  start({ data, project, session: 'A' });
  start({ data, project: other, session: 'A' });

  writeAgent(project, 'writer');
  assert.match(change({ data, project, session: 'A' }), /writer/);
  assert.equal(change({ data, project: other, session: 'A' }), '',
    'a change in one project is not announced in the other');
});

/* ---- CONCURRENT WRITES ---- */

test("eight concurrent sessions do not swallow each other records", async (t) => {
  const { data, project } = field(t);
  writeAgent(project, 'auditor');
  const sessions = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];

  await Promise.all(sessions.map((o) => new Promise((finish, error) => {
    const p = spawn(process.execPath, [script, '--session-start'],
      { cwd: project, env: env(data, project, o), stdio: 'ignore' });
    p.on('error', error);
    p.on('exit', (code) => (code === 0 ? finish() : error(new Error('exit ' + code))));
  })));

  for (const o of sessions) {
    assert.equal(change({ data, project, session: o }), '',
      o + ' record was lost: concurrent writing is swallowing updates');
  }
});

/* ---- MIGRATING FROM THE OLD STATE ---- */

test("an old single-key state does not produce a false already-notified", (t) => {
  const { data, project } = field(t);
  writeAgent(project, 'auditor');
  fs.mkdirSync(data, { recursive: true });
  /* The old format: one record per project, a raw path key, the current signature. If a new session
     counted it as seen by itself it would never hear about the agent -- the error the card explicitly forbids. */
  const old = path.join(data, 'catalog-state.json');
  fs.writeFileSync(old, JSON.stringify({
    [project]: { signature: 'auditor|Same as orchestrator|Same as orchestrator|Same as orchestrator',
      connection: 'none' },
  }, null, 2));

  const first = change({ data, project, session: 'A' });

  assert.match(first, /auditor/, 'this session never saw the list; it must not be met with silence');
  assert.ok(fs.existsSync(old), 'the old record is not deleted');
});

test("a session with no baseline receives the FULL list and goes quiet afterwards", (t) => {
  const { data, project } = field(t);
  writeAgent(project, 'auditor');
  writeAgent(project, 'writer');

  const first = change({ data, project, session: 'A' });      // the start hook never ran
  assert.match(first, /Agents assigned to this project/,
    'with an unknown baseline the list is given as it is, not an invented diff');
  assert.match(first, /auditor/);
  assert.match(first, /writer/);
  assert.equal(change({ data, project, session: 'A' }), '', 'it repairs itself on the second round');
});

/* ---- WITH NO SESSION IDENTITY ---- */

test("with no session identity the hook still runs and behaves predictably", (t) => {
  const { data, project } = field(t);
  writeAgent(project, 'auditor');
  start({ data, project });                      // no environment variable supplies an identity
  writeAgent(project, 'writer');

  assert.match(change({ data, project }), /writer/);
  /* A DEFINED LIMIT: when the harness supplies no identity, every session without one shares ONE bucket;
     R10 is not fixed there. Inventing an identity would be worse -- every message would be taken for a
     new session and the full list rewritten every round. */
  assert.equal(change({ data, project }), '');
});

test("a session identity supplied by the panel counts too", (t) => {
  const { data, project } = field(t);
  writeAgent(project, 'auditor');
  const c = (o, event) => {
    const e = env(data, project, null);
    e.BENCHOOK_SESSION = o;
    const r = spawnSync(process.execPath, [script, event], { encoding: 'utf8', cwd: project, env: e });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
  };
  c('pane-1', '--session-start');
  c('pane-2', '--session-start');
  writeAgent(project, 'writer');

  assert.match(c('pane-1', '--prompt'), /writer/);
  assert.match(c('pane-2', '--prompt'), /writer/, 'panel panes are separate sessions as well');
});

/* ---- THE PANEL END: EVERY PANE OPENS WITH ITS OWN IDENTITY ---- */

test("the panel gives every terminal its own session identity", async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '..', 'panel', 'main.js'), 'utf8');
  const press = source.indexOf("  ipc.handle('terminal:open'");
  const last = source.indexOf('\n  });', press) + 7;

  let handler;
  const opened = [];
  let counter = 0;
  const box = {
    ipc: { handle: (_name, fn) => { handler = fn; } },
    process: { env: {} },
    randomUUID: () => 'id-' + (++counter),
    sessions: new Map(), terminals: new Map(),
    context: { snapshot: () => ({}) },
    cleanEnv: () => ({ PATH: 'x' }),
    os: { homedir: () => __dirname },
    accounts: { find: () => null },
    window: null,
    pty: { spawn: (_k, _a, option) => { opened.push(option.env); return { onData() {}, onExit() {} }; } },
  };
  vm.createContext(box);
  vm.runInContext('let nextId = 1;\n' + source.slice(press, last), box);

  // terminal:open is async (the login identity is read before the opening); the renderer already awaits it.
  const one = await handler(null, { provider: 'codex', workingDirectory: __dirname });
  const two = await handler(null, { provider: 'codex', workingDirectory: __dirname });

  assert.equal(opened[0].BENCHOOK_SESSION, one.connection, 'the identity of the pane must be written into the environment');
  assert.notEqual(opened[1].BENCHOOK_SESSION, opened[0].BENCHOOK_SESSION,
    'two panes must not count as the same session');
  assert.ok(two.connection, 'the second pane must have an identity too');
});

/* ---- THE MODULE: PROJECT IDENTITY AND SESSION IDENTITY ---- */

const status = require('../panel/catalog-state');

test("the project identity reduces spelling differences to a single value", () => {
  const a = status.projectId('C:\\Users\\example\\project');
  assert.equal(status.projectId('C:/Users/example/project'), a);
  assert.equal(status.projectId('C:\\Users\\example\\project\\'), a);
  assert.equal(status.projectId('C:\\Users\\example\\alt\\..\\project'), a);
  if (process.platform === 'win32') assert.equal(status.projectId('c:\\users\\example\\project'), a);
  assert.notEqual(status.projectId('C:\\Users\\example\\project2'), a);
});

test("an empty project identity is not invented", () => {
  assert.equal(status.projectId(''), '');
  assert.equal(status.projectId(null), '');
});

test("the record carries a READABLE path as well", (t) => {
  const { root, project } = field(t);
  status.write(root, project, 'A', { signature: 'x', connection: 'none', source: 'CLAUDE_CODE_SESSION_ID' });

  const body = JSON.parse(fs.readFileSync(status.storePath(root, project, 'A'), 'utf8'));
  assert.equal(body.filePath, project, 'which project the record belongs to must be readable from the file');
  assert.equal(body.id, status.projectId(project));
  assert.equal(body.source, 'CLAUDE_CODE_SESSION_ID', 'where the identity came from must be written down');
  assert.deepEqual(status.read(root, project, 'A'), { signature: 'x', connection: 'none' });
});

test("records of closed sessions are collected; live ones stay", (t) => {
  const { root, project } = field(t);
  status.write(root, project, 'old', { signature: 'x', connection: 'none' });
  status.write(root, project, 'created', { signature: 'x', connection: 'none' });
  const oldPath = status.storePath(root, project, 'old');
  const history = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldPath, history, history);

  assert.equal(status.cleanOld(root, project), 1);

  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(status.read(root, project, 'created').signature, 'x', 'the new record must not be touched');
});

test("the session identity is returned together with ITS SOURCE", () => {
  assert.deepEqual(status.sessionIdFromFile({ CLAUDE_CODE_SESSION_ID: 'x' }),
    { id: 'x', source: 'CLAUDE_CODE_SESSION_ID' });
  assert.deepEqual(status.sessionIdFromFile({ CODEX_SESSION_ID: 'y' }),
    { id: 'y', source: 'CODEX_SESSION_ID' });
  assert.deepEqual(status.sessionIdFromFile({ CODEX_THREAD_ID: 't' }),
    { id: 't', source: 'CODEX_THREAD_ID' }, 'the identity from an older Codex version counts too');
  assert.equal(status.sessionIdFromFile({ CODEX_THREAD_ID: 't', CLAUDE_CODE_SESSION_ID: 'x' }).id,
    'x', 'the harness identity comes before the panel one and the older one');
  assert.deepEqual(status.sessionIdFromFile({ BENCHOOK_SESSION: 'z' }),
    { id: 'z', source: 'BENCHOOK_SESSION' });
  assert.deepEqual(status.sessionIdFromFile({}), { id: null, source: null });
  assert.equal(status.sessionIdFromFile({ CLAUDE_CODE_SESSION_ID: '  ' }).id, null,
    'whitespace is not an id');
});

/* An argument this version does not know must print nothing. Before this rule, anything other
   than --prompt counted as a session start, so a hook installed by an older version (which
   passed a different flag on every prompt) put the full agent list into every prompt. */
test('an unknown argument or no argument prints nothing, on every call', (t) => {
  const { data, project } = field(t);
  writeAgent(project, 'reviewer');
  for (const args of [['--unknown-flag'], []]) {
    for (let call = 0; call < 3; call++) {
      const r = spawnSync(process.execPath, [script, ...args], {
        encoding: 'utf8', cwd: project, env: env(data, project, 'session-unknown'),
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '', 'args ' + JSON.stringify(args) + ', call ' + call + ' must be silent');
    }
  }
  // The explicit flag still announces the full list.
  assert.match(start({ data, project, session: 'session-known' }), /reviewer/);
});
