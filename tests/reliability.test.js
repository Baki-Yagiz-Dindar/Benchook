'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const accounts = require('../panel/accounts');
const context = require('../panel/sessions');
const skills = require('../panel/skills');
const runner = require('../panel/subprocess');
const worker = require('../panel/worker');
const cli = require('../panel/cli-path');
const fixture = path.join(__dirname, 'fixtures/worker-process.cjs');
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchook-fix-'));
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
function put(root, relative, data) {
  const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data); return file;
}
function session(root, name, cwd, source = 'cli') {
  return put(root, 'sessions/' + name + '.jsonl', JSON.stringify({ type: 'session_meta', payload: { cwd, source } }) + '\n');
}
test('the default account does not use an inherited profile; the check and the run share one root', t => {
  const old = process.env.CODEX_HOME; process.env.CODEX_HOME = path.join(temp(t), 'wrong');
  t.after(() => { if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old; });
  const h = { provider: 'codex', folder: null };
  assert.equal(accounts.env(h).CODEX_HOME, accounts.folderPath(h));
  assert.equal(accounts.env({ provider: 'claude', folder: null }).CODEX_HOME, undefined);
});
test('a record from another project or a sub-agent is not picked as the new session', t => {
  const root = temp(t), project = path.join(root, 'A');
  const old = context.snapshot('codex', project, root);
  session(root, 'other', path.join(root, 'B'));
  session(root, 'subagent', project, { subagent: 'review' });
  assert.equal(context.findNewFile('codex', project, old, root), null);
  const own = session(root, 'own', project);
  assert.equal(context.findNewFile('codex', project, old, root), own);
  session(root, 'also-own-project', project);
  assert.equal(context.findNewFile('codex', project, old, root), null, 'no guess may be made between ambiguous candidates');
});
test('a known resume identity does not fall to a new record; with no file it waits', t => {
  const root = temp(t), project = path.join(root, 'A');
  const old = context.snapshot('codex', project, root);
  session(root, 'new', project);
  const state = { provider: 'codex', project: project, old: old, accountFolder: root, sessionId: 'known-id' };
  assert.equal(context.sessionFile(state), null);
  const own = session(root, 'rollout-known-id', project);
  assert.equal(context.sessionFile(state), own);
});
test('without a process-specific trace it does not fall into another Codex session', t => {
  const root = temp(t), project = path.join(root, 'A');
  const state = { provider: 'codex', project: project, old: new Set(), accountFolder: root, traceFile: path.join(root, 'own.log') };
  session(root, 'other', project);
  assert.equal(context.sessionFile(state), null);
  const id = '12345678-1234-1234-1234-123456789abc';
  const own = session(root, 'rollout-' + id, project);
  fs.writeFileSync(state.traceFile, 'INFO session_loop{thread_id=' + id + '}: codex_core::codex: new\n');
  assert.equal(context.sessionFile(state), own);
});
test('with equal mtimes the Codex copy keeps the longer or diverged target', t => {
  const root = temp(t), a = path.join(root, 'a'), b = path.join(root, 'b');
  const rel = 'sessions/rollout-known.jsonl';
  const source = put(a, rel, 'first\n'), target = put(b, rel, 'first\nnew work\n');
  const stamp = new Date('2026-01-01'); fs.utimesSync(source, stamp, stamp); fs.utimesSync(target, stamp, stamp);
  assert.throws(() => context.copySession('codex', root, 'known', a, b), /newer or divergent/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'first\nnew work\n');
  fs.writeFileSync(source, 'first\nnew work\nlatest\n');
  context.copySession('codex', root, 'known', a, b);
  assert.equal(fs.readFileSync(target, 'utf8'), fs.readFileSync(source, 'utf8'));
});
const skillText = '---\nname: x\ndescription: test\n---\nRead references/helper.txt\n';
test('if the Claude helper copy is corrupted the main target record is preserved', t => {
  const root = temp(t), a = path.join(root, 'a'), b = path.join(root, 'b');
  const ar = context.claudeFolder(root, a), br = context.claudeFolder(root, b);
  const source = put(ar, 'known.jsonl', 'old record\nnew record'), target = put(br, 'known.jsonl', 'old record');
  put(ar, 'known/subagents/agent.jsonl', 'new child');
  const child = put(br, 'known/subagents/agent.jsonl', 'old child');
  const stamp = new Date('2026-01-01'); fs.utimesSync(source, stamp, stamp); fs.utimesSync(target, stamp, stamp);
  t.mock.method(fs, 'cpSync', () => { throw new Error('injected auxiliary copy error'); });
  assert.throws(() => context.copySession('claude', root, 'known', a, b), /auxiliary/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old record');
  assert.equal(fs.readFileSync(child, 'utf8'), 'old child');
});

test('the new main session in the Codex trace is followed and the sub-agent is skipped', t => {
  const root = temp(t), project = path.join(root, 'A');
  const log = path.join(root, 'trace.log');
  const state = { provider: 'codex', project: project, accountFolder: root, traceFile: log };
  const ids = ['11111111', '22222222', '33333333'].map(x => x + '-1234-1234-1234-123456789abc');
  const first = session(root, 'rollout-' + ids[0], project);
  const line = id => 'INFO session_loop{thread_id=' + id + '}: codex_core::session: new\n';
  fs.writeFileSync(log, line(ids[0]));
  assert.equal(context.sessionFile(state), first);
  const next = session(root, 'rollout-' + ids[1], project);
  session(root, 'rollout-' + ids[2], project, { subagent: 'review' });
  fs.appendFileSync(log, line(ids[1]) + line(ids[2]));
  assert.equal(context.sessionFile(state), next);
  assert.equal(state.sessionId, ids[1]);
});

function bundle(root, side, helper = 'same') {
  put(root, side + '/skills/x/SKILL.md', skillText);
  return put(root, side + '/skills/x/references/helper.txt', helper);
}
test('a difference in the helper file is visible; an ambiguous save keeps both copies', t => {
  const root = temp(t); const a = bundle(root, '.claude', 'A'), b = bundle(root, '.agents', 'B');
  assert.equal(skills.existing(root)[0].divergent, true);
  assert.ok(skills.write(root, 'x', skillText).error);
  assert.equal(fs.readFileSync(a, 'utf8'), 'A'); assert.equal(fs.readFileSync(b, 'utf8'), 'B');
  assert.ok(!skills.write(root, 'x', skillText, 'codex').error);
  assert.equal(fs.readFileSync(a, 'utf8'), 'B');
  assert.equal(skills.existing(root)[0].divergent, false);
});
test('editing a skill that exists on one side carries the helper file too', t => {
  const root = temp(t); bundle(root, '.claude');
  assert.ok(!skills.write(root, 'x', skillText + 'edited').error);
  assert.equal(fs.readFileSync(path.join(root, '.agents/skills/x/references/helper.txt'), 'utf8'), 'same');
});
test('a copy error during sync preserves the old target', t => {
  const root = temp(t); bundle(root, '.claude', 'A'); const b = bundle(root, '.agents', 'B');
  t.mock.method(fs, 'copyFileSync', () => { throw new Error('injected copy error'); });
  assert.ok(skills.syncSkill(root, 'x', 'claude').error);
  assert.equal(fs.readFileSync(b, 'utf8'), 'B');
});
test('if installing the second target errors, the first target is rolled back as well', t => {
  const root = temp(t); bundle(root, '.claude'); bundle(root, '.agents');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (a, b) => {
    if (path.basename(a).startsWith('.benchook-new-') && b === path.join(root, '.agents/skills/x')) throw new Error('injected install error');
    return rename(a, b);
  });
  assert.ok(skills.write(root, 'x', skillText + 'changed').error);
  for (const side of ['.claude', '.agents']) assert.equal(fs.readFileSync(path.join(root, side, 'skills/x/SKILL.md'), 'utf8'), skillText);
});
test('a name that escapes the path is refused in every skill write', t => {
  const root = temp(t); bundle(root, '.claude');
  const name = '../../../escape';
  assert.ok(skills.write(root, name, skillText).error);
  assert.ok(skills.syncSkill(root, name, 'claude').error);
  assert.ok(skills.add(root, path.join(root, '.claude/skills/x'), name).error);
});
function fakeAccount(t, root, mode, provider = 'codex') {
  t.mock.method(accounts, 'find', () => ({ id: 'test', name: 'synthetic', provider, folder: root }));
  t.mock.method(accounts, 'hasSignIn', () => true);
  t.mock.method(cli, 'cliInvocation', () => ({ command: process.execPath, leadingArgs: [fixture] }));
  const environment = accounts.env;
  t.mock.method(accounts, 'env', h => ({ ...environment(h), BENCHOOK_TEST_MODE: mode }));
}
test('when a real process exits with a failure and writes JSON the worker returns the reason FROM THE PROVIDER and the exit code', async t => {
  const root = temp(t); fakeAccount(t, root, 'failure');
  // `codex exec` is the path of a LOCKED Codex agent; with no tools line it runs through the app-server
  // (25 September 2026, `codex-app-server.test.js`), so this exec test names the read-only lock.
  const r = await worker.run({ accountId: 'test', task: 'test', folder: root, tools: 'Read, Grep, Glob' });
  // Real Codex quota error: the cause was in the JSON line, only the exit code reached the screen.
  assert.match(r.error, /synthetic failure/);
  assert.match(r.error, /worker exit 7/);
});
test('a Claude JSON is_error is an error even when the process exits normally', async t => {
  const root = temp(t); fakeAccount(t, root, 'claude-failure', 'claude');
  const r = await worker.run({ accountId: 'test', task: 'test', folder: root });
  assert.match(r.error, /synthetic Claude failure/);
});
test('a path, model or task carrying spaces and shell characters is passed through verbatim', async t => {
  const root = path.join(temp(t), 'project & percent % test'); fs.mkdirSync(root);
  fakeAccount(t, root, 'success');
  const task = 'Türkçe "tırnak" & %PATH% $(literal)'; const model = 'model & literal';
  // `codex exec` is the path of a LOCKED Codex agent; with no tools line it runs through the app-server
  // (25 September 2026, `codex-app-server.test.js`), so this exec test names the read-only lock.
  const r = await worker.run({ accountId: 'test', model, task, folder: root, tools: 'Read, Grep, Glob' });
  assert.ok(!r.error, r.error);
  const result = JSON.parse(r.text);
  assert.equal(result.input, task); assert.equal(result.cwd, root); assert.equal(result.home, root);
  // After the verbatim part come the sandbox arguments of the agent's level (read-only here) and, on
  // Windows, the sandbox name (`codex-windows.js`); nothing else is added.
  assert.deepEqual(result.args, ['exec', '--json', '--skip-git-repo-check', '-m', model, '-C', root,
    '--sandbox', 'read-only', ...(process.platform === 'win32' ? ['-c', 'windows.sandbox="elevated"'] : [])]);
});
test('a timeout stops the grandchild in a real subprocess tree too', { timeout: 20000 }, async t => {
  const root = temp(t), beat = path.join(root, 'heartbeat.txt');
  const r = await runner.run({ command: process.execPath, arg: [fixture],
    env: { ...process.env, BENCHOOK_TEST_MODE: 'tree', BENCHOOK_TEST_BEAT: beat }, durationMs: 1000 });
  assert.match(r.error, /timed out/); assert.ok(!r.couldNotStop, r.error);
  assert.ok(fs.existsSync(beat), 'the grandchild process never started');
  const before = fs.readFileSync(beat, 'utf8');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(fs.readFileSync(beat, 'utf8'), before, 'the grandchild process is still writing');
});
/* NO TIME LIMIT ON THE USER'S ANSWER : while the agent waits on a permission prompt the
   limit does not run out; it runs out as before once nothing is waiting. */
test('the time limit does not run out while the job waits for the user', async () => {
  // The job lasts ~700 ms against a 400 ms limit; 600 ms of it is waiting, so only ~100 ms is counted.
  const until = Date.now() + 600;
  const r = await runner.run({ command: process.execPath, arg: ['-e', 'setTimeout(() => {}, 700)'],
    durationMs: 400, hold: () => Date.now() < until });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.code, 0);
  const stopped = await runner.run({ command: process.execPath, arg: ['-e', 'setTimeout(() => {}, 5000)'],
    durationMs: 200, hold: () => false });
  assert.match(stopped.error, /timed out/);
});
test('a cancelled job is never started', async () => {
  const abort = new AbortController(); abort.abort();
  const r = await runner.run({ command: 'does-not-exist', signal: abort.signal });
  assert.match(r.error, /cancelled/);
});
