'use strict';

// Worker run log - the MECHANISM beneath answer-key item 5.
// That the card looks yellow/red on screen is measured by eye; what is measured here is that the record
// the card reads is written correctly and comes back correctly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../panel/worker-records');

function temp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const record = (top) => ({
  id: 'k1', name: 'researcher', task: 'scan the panel folder', account: 'codex-default',
  model: 'gpt-5.6-luna', status: 'running', startedAt: '2026-09-05T10:00:00.000Z',
  updatedAt: '2026-09-05T10:00:00.000Z', result: '', tokens: null, seconds: null, ...top,
});

test('the record is written to the data folder of the panel, NOT to the project folder', (t) => {
  const root = temp(t, 'registry-root-'), project = temp(t, 'registry-project-');
  const filePath = registry.write(root, project, record());

  assert.ok(filePath.startsWith(path.join(root, 'worker-runs')), 'the record is not under the root: ' + filePath);
  assert.equal(fs.readdirSync(project).length, 0, 'a file leaked into the project folder');
});

test('writing the same run twice updates it and does not create a second row', (t) => {
  const root = temp(t, 'registry-root-'), project = temp(t, 'registry-project-');
  registry.write(root, project, record());
  registry.write(root, project, record({ status: 'done', result: 'panel/sessions.js:12', seconds: 7 }));

  const list = registry.list(root, project);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'done');
  assert.equal(list[0].seconds, 7);
});

test('a failed worker stays as error and does not count as done', (t) => {
  const root = temp(t, 'registry-root-'), project = temp(t, 'registry-project-');
  registry.write(root, project, record({ id: 'k9', status: 'error', error: 'account not found' }));

  const [k] = registry.list(root, project);
  assert.equal(k.status, 'error');
  assert.notEqual(k.status, 'done');
  assert.equal(k.error, 'account not found');
});

test('two projects do not see each other records', (t) => {
  const root = temp(t, 'registry-root-');
  const a = temp(t, 'registry-a-'), b = temp(t, 'registry-b-');
  registry.write(root, a, record({ id: 'ka' }));

  assert.equal(registry.list(root, a).length, 1);
  assert.equal(registry.list(root, b).length, 0);
});

test('the most recent run comes back first', (t) => {
  const root = temp(t, 'registry-root-'), project = temp(t, 'registry-project-');
  registry.write(root, project, record({ id: 'old', startedAt: '2026-09-05T09:00:00.000Z' }));
  registry.write(root, project, record({ id: 'created', startedAt: '2026-09-05T11:00:00.000Z' }));

  assert.deepEqual(registry.list(root, project).map((k) => k.id), ['created', 'old']);
});

test('a corrupt file is skipped silently and a sound record still comes through', (t) => {
  const root = temp(t, 'registry-root-'), project = temp(t, 'registry-project-');
  const filePath = registry.write(root, project, record());
  fs.writeFileSync(path.join(path.dirname(filePath), 'corrupt.json'), '{ half', 'utf8');

  const list = registry.list(root, project);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'k1');
});

test('with no runs at all an empty list is returned - no record is invented', (t) => {
  const root = temp(t, 'registry-root-'), project = temp(t, 'registry-project-');
  assert.deepEqual(registry.list(root, project), []);
});

/* A "RUNNING" RECORD WHOSE SERVER DIED. When a real worker server was killed, the record stayed
   'running' forever. The marker in main.js is taken from its source text and tested against a real log:
   live pid -> untouched, dead pid -> 'unknown' and written to disk; 'done' is never assumed. */
test("a running record whose server died becomes unknown and is written to disk; a live one is left alone", (t) => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '..', 'panel', 'main.js'), 'utf8');
  const press = source.indexOf('  function processAlive(pid)');
  const last = source.indexOf("\n  ipc.handle('workers:project'", press);
  assert.ok(press > 0 && last > press, 'the marker was not found inside main.js');
  const root = temp(t, 'worker-lost-');
  const project = path.join(root, 'project');
  const box = { process, Number, Date, workerRecords: registry, app: { getPath: () => root } };
  vm.createContext(box);
  vm.runInContext(source.slice(press, last) + '\nthis.mark = markServerLost;', box);
  registry.write(root, project, record({ id: 'olu', serverPid: 999999999 }));
  registry.write(root, project, record({ id: 'live', serverPid: process.pid }));
  registry.write(root, project, record({ id: 'noPid' }));
  registry.write(root, project, record({ id: 'finished', status: 'done', serverPid: 999999999 }));
  const list = registry.list(root, project);
  box.mark(list, project);
  const find = (id) => list.find((k) => k.id === id);
  assert.equal(find('olu').status, 'unknown');
  assert.equal(find('olu').endSource, 'server-lost');
  assert.match(find('olu').result, /unknown/i);
  assert.equal(find('live').status, 'running');
  assert.equal(find('noPid').status, 'running', 'pid bilinmiyorsa estimate none');
  assert.equal(find('finished').status, 'done');
  const onDisk = registry.list(root, project).find((k) => k.id === 'olu');
  assert.equal(onDisk.status, 'unknown', 'the mark must be written to disk as well');
});

/* THE LIVE RUN CARD READS A RUNNING AGENT'S OPEN QUESTIONS FROM ITS RECORD, AND THE ANSWER GOES BACK THE SAME WAY
   . A finished run has nothing to answer; a run id that is not a record answers nothing. */
test('a running record carries its open questions; the answer reaches the waiting agent', async (t) => {
  const approvals = require('../panel/approvals');
  const root = temp(t, 'registry-root-'), project = temp(t, 'registry-project-');
  registry.write(root, project, record());
  registry.write(root, project, record({ id: 'k2', status: 'done' }));
  const folder = registry.approvalsFolder(root, project, 'k1');
  const waiting = approvals.ask(folder, { kind: 'command', title: 'Run a command', detail: 'npm test' }, { pollMs: 10 });
  await new Promise((r) => setTimeout(r, 30));
  const list = registry.withQuestions(root, project, registry.list(root, project));
  const running = list.find((x) => x.id === 'k1');
  assert.equal(running.questions.length, 1);
  assert.equal(running.questions[0].detail, 'npm test');
  assert.deepEqual(list.find((x) => x.id === 'k2').questions, []);
  assert.match(registry.answer(root, project, 'k2', running.questions[0].id, 'allow').error, /not running/);
  assert.match(registry.answer(root, project, '../k1', running.questions[0].id, 'allow').error, /not found/);
  assert.deepEqual(registry.answer(root, project, 'k1', running.questions[0].id, 'allow'), { ok: true });
  assert.equal((await waiting).decision, 'allow');
});

test('the panel passes the questions to the page and the answer back', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'panel', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'panel', 'preload.js'), 'utf8');
  assert.match(main, /return \{ list: workerRecords\.withQuestions\(app\.getPath\('userData'\), project, list\) \}/);
  assert.match(main, /ipc\.handle\('workers:answer'[\s\S]{0,300}workerRecords\.answer\(app\.getPath\('userData'\), project, runId, questionId, decision\)/);
  assert.match(preload, /answerWorker: \(project, runId, questionId, decision\) => ipcRenderer\.invoke\('workers:answer', \{ project, runId, questionId, decision \}\)/);
});

test('a run written from a differently-cased project path is listed and answerable from the panel (Windows)', { skip: process.platform !== 'win32' }, (t) => {
  const root = temp(t, 'registry-root-'), project = temp(t, 'registry-project-');
  const typed = project.toUpperCase();   // e.g. the terminal's folder typed in another case
  registry.write(root, typed, record({ id: 'case1' }));
  const listed = registry.list(root, project);
  assert.deepEqual(listed.map((r) => r.id), ['case1'], 'the panel sees the run');
  assert.equal(registry.approvalsFolder(root, project, 'case1'), registry.approvalsFolder(root, typed, 'case1'),
    'both sides use the same question folder');
});

test('records already written under the old key are still listed and updated in place', (t) => {
  const root = temp(t, 'registry-root-'), project = temp(t, 'registry-project-');
  const crypto = require('node:crypto');
  const legacy = path.join(root, 'worker-runs', crypto.createHash('sha256').update(path.resolve(project)).digest('hex').slice(0, 24));
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'old1.json'), JSON.stringify(record({ id: 'old1', project })));
  assert.deepEqual(registry.list(root, project).map((r) => r.id), ['old1']);
  const written = registry.write(root, project, record({ id: 'old1', status: 'done' }));
  assert.equal(path.dirname(written), legacy, 'an update stays beside the existing record');
  assert.equal(registry.list(root, project).length, 1);
});
