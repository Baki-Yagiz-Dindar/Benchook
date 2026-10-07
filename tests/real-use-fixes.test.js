'use strict';

/* FIXES FROM THE OCTOBER REAL-USE SWEEP that live outside the page script. Each test names the
   behaviour a long-running user would have met. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-use-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a growing session is scanned from where it was, and finds a completion written later', (t) => {
  const runs = require('../panel/agent-runs');
  const file = path.join(temp(t), 'session.jsonl');
  const id = (n) => 'toolu_' + 'A'.repeat(20) + n;
  const done = (n) => '<task-notification><tool-use-id>' + id(n) + '</tool-use-id><status>completed</status></task-notification>';
  fs.writeFileSync(file, JSON.stringify({ x: 'a'.repeat(5000) }) + '\n' + JSON.stringify({ m: done(1) }) + '\n');
  const old = Date.now() - 10000;
  fs.utimesSync(file, old / 1000, old / 1000);
  const first = runs.finished(file);
  assert.ok(first.has(id(1)));
  fs.appendFileSync(file, JSON.stringify({ x: 'b'.repeat(3000) }) + '\n' + JSON.stringify({ m: done(2) }) + '\n');
  fs.utimesSync(file, (old + 5000) / 1000, (old + 5000) / 1000);
  const second = runs.finished(file);
  assert.ok(second.has(id(1)), 'the earlier finding is kept');
  assert.ok(second.has(id(2)), 'the appended completion is found');
});

test('context files of closed terminals are removed after a week; live and foreign files stay', (t) => {
  const { cleanupContext } = require('../panel/log-cleanup');
  const dir = temp(t);
  const old = '11111111-2222-3333-4444-555555555555.json', live = 'aaaaaaaa-2222-3333-4444-555555555555.json';
  for (const f of [old, live, 'notes.json']) {
    fs.writeFileSync(path.join(dir, f), '{}');
    fs.utimesSync(path.join(dir, f), new Date(0), new Date(0));
  }
  cleanupContext(dir, [path.join(dir, live)]);
  assert.deepEqual(fs.readdirSync(dir).sort(), [live, 'notes.json'].sort());
});

test('the worker ledger keeps running and recent runs, and drops old finished ones beyond the newest 200', (t) => {
  const records = require('../panel/worker-records');
  const dir = temp(t);
  const at = (days) => new Date(Date.now() - days * 86400000).toISOString();
  for (let i = 0; i < 205; i++) {
    const id = 'run-' + String(i).padStart(3, '0');
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, status: 'done', startedAt: at(400 - i), updatedAt: at(400 - i) }));
  }
  fs.writeFileSync(path.join(dir, 'run-old-running.json'), JSON.stringify({ id: 'run-old-running', status: 'running', startedAt: at(500) }));
  fs.mkdirSync(path.join(dir, 'run-000.approvals'));
  records.prune(dir);
  const left = fs.readdirSync(dir);
  assert.ok(left.includes('run-old-running.json'), 'a running record is never removed');
  assert.ok(!left.includes('run-000.json') && !left.includes('run-000.approvals'), 'an old finished run goes with its questions');
  assert.equal(left.filter((x) => x.endsWith('.json')).length, 201, 'the newest 200 finished runs and the running one remain');
});

test('a worker record is replaced whole, never left half-written', (t) => {
  const records = require('../panel/worker-records');
  const root = temp(t);
  records.write(root, root, { id: 'r1', status: 'running', startedAt: new Date().toISOString() });
  records.write(root, root, { id: 'r1', status: 'done', startedAt: new Date().toISOString() });
  const list = records.list(root, root);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'done');
  const folder = path.dirname(path.join(root, 'worker-runs', 'x'));
  assert.ok(fs.readdirSync(path.join(folder, fs.readdirSync(folder)[0])).every((x) => !x.endsWith('.tmp')), 'no temporary file is left');
});

test('Claude identity is read again when the credential file changes, and reused while it does not', async (t) => {
  const identity = require('../panel/account-identity');
  const cli = require('../panel/cli-path');
  const runner = require('../panel/subprocess');
  const folder = temp(t);
  const creds = path.join(folder, '.credentials.json');
  fs.writeFileSync(creds, 'x');
  t.mock.method(cli, 'cliInvocation', () => ({ command: 'fixture', leadingArgs: [] }));
  let calls = 0, email = 'a@example.test';
  t.mock.method(runner, 'run', async () => { calls++; return { code: 0, output: JSON.stringify({ loggedIn: true, email }) }; });
  assert.equal((await identity.claude(folder)).email, 'a@example.test');
  assert.equal((await identity.claude(folder)).email, 'a@example.test');
  assert.equal(calls, 1, 'an unchanged credential file is not asked about again within a minute');
  email = 'b@example.test';
  fs.writeFileSync(creds, 'xy');
  assert.equal((await identity.claude(folder)).email, 'b@example.test', 'a changed file forces a fresh reading');
  assert.equal(calls, 2);
});

test('a Codex connection that asks for setup to run again keeps its setup button usable', () => {
  const source = fs.readFileSync(path.join(__dirname, '../panel/mcp-status.js'), 'utf8');
  assert.match(source, /needsRerun: !!extra\.needsRerun/);
  assert.equal((source.match(/needsRerun: true/g) || []).length, 3, 'each "run setup again" answer carries the flag');
  const page = fs.readFileSync(path.join(__dirname, '../panel/panel.js'), 'utf8');
  assert.equal((page.match(/g\('mcpSetup'\)\.disabled = !!d\.installed && !d\.needsRerun;/g) || []).length, 2);
});

test('a skill description with ": " or quotes survives the header round trip', () => {
  const skills = require('../panel/skills');
  const description = 'Use when: the "release" step # starts';
  const content = ['---', 'name: x', 'description: ' + JSON.stringify(description), '---', '', 'body', ''].join('\n');
  assert.equal(skills.readTitle(content, 'x').description, description);
});

test('cancelling a worker run is recorded as cancelled, not as a failure', () => {
  const server = fs.readFileSync(path.join(__dirname, '../tools/mcp-server.js'), 'utf8');
  assert.match(server, /status: signal\?\.aborted \? 'cancelled'/);
  const page = fs.readFileSync(path.join(__dirname, '../panel/panel.js'), 'utf8');
  assert.match(page, /if \(status === 'cancelled'\) return "Cancelled";/);
});

test('a project path longer than Claude Code allows maps to its cut-and-hashed folder name', () => {
  const { claudeFolderName } = require('../panel/sessions');
  const short = 'C:/work/project';
  assert.equal(claudeFolderName(short), 'C--work-project');
  const long = 'D:/' + 'segment-'.repeat(40) + 'end';
  // Java-style string hash computed independently (31 * h + c), as Claude Code's own helper does.
  let h = 0;
  for (const c of long) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  const sanitized = long.replace(/[^a-zA-Z0-9]/g, '-');
  assert.equal(claudeFolderName(long), sanitized.slice(0, 200) + '-' + Math.abs(h).toString(36));
});

test('a subagent that was stopped, killed or failed is not left "Running"', (t) => {
  const runs = require('../panel/agent-runs');
  const file = path.join(temp(t), 'session.jsonl');
  const id = (n) => 'toolu_' + 'B'.repeat(20) + n;
  // The shape read from real Claude Code session files: the id tag, a line break, the status tag.
  const note = (n, status) => '<task-notification><tool-use-id>' + id(n) + '</tool-use-id>\n<status>' + status + '</status></task-notification>';
  fs.writeFileSync(file, ['completed', 'stopped', 'failed', 'killed'].map((s, i) => JSON.stringify({ m: note(i, s) })).join('\n') + '\n');
  const old = Date.now() - 10000;
  fs.utimesSync(file, old / 1000, old / 1000);
  const set = runs.finished(file);
  assert.ok(set.has(id(0)));
  assert.equal(set.endedAs.get(id(1)), 'stopped');
  assert.equal(set.endedAs.get(id(2)), 'failed');
  assert.equal(set.endedAs.get(id(3)), 'killed');
  const source = fs.readFileSync(path.join(__dirname, '../panel/agent-runs.js'), 'utf8');
  assert.match(source, /a\.outcome === 'failed' \? 'error' : a\.outcome \? 'cancelled' : 'done'/);
});
