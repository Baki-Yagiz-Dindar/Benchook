'use strict';
/* Exercise the Codex app-server approval protocol with a stand-in server and no model calls. Omit explicit sandbox and approval overrides so account settings can apply. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const appServer = require('../panel/codex-app-server');
const fake = path.join(__dirname, 'fixtures', 'fake-codex-app-server.cjs');

function setup(t, scenario) {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-'));
  t.after(() => fs.rmSync(k, { recursive: true, force: true }));
  const log = path.join(k, 'log.jsonl');
  const asked = [];
  const run = (over = {}) => appServer.run({ command: process.execPath, args: [fake], cwd: k,
    env: { ...process.env, FAKE_SCENARIO: scenario, FAKE_LOG: log }, model: 'gpt-test', task: 'Unicode "quote" & %PATH% $(literal) 日本',
    ask: async (q) => { asked.push(q); return over.decision || 'allow'; }, durationMs: 10000, ...over });
  const sent = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { k, run, sent, asked };
}
const reply = (sent, id) => sent.find((m) => m.id === id && !m.method);

test('the thread starts with the account\'s own settings, and the task goes through verbatim', async (t) => {
  const s = setup(t, 'plain');
  const r = await s.run();
  assert.equal(r.error, null);
  assert.equal(r.text, 'all done');
  const start = s.sent().find((m) => m.method === 'thread/start');
  assert.deepEqual(start.params, { cwd: s.k, model: 'gpt-test' }, 'no approval policy, no sandbox: the account decides');
  const turn = s.sent().find((m) => m.method === 'turn/start');
  assert.deepEqual(turn.params.input, [{ type: 'text', text: 'Unicode "quote" & %PATH% $(literal) 日本' }]);
  assert.equal(r.threadId, 'thread-1');
  assert.deepEqual(r.tokens, { fresh: 400, cacheRead: 600, cacheWritten: 0, output: 200, input: 1000 }, 'the whole run, same shape as exec');
});

test('with no model chosen no model is sent', async (t) => {
  const s = setup(t, 'plain');
  await s.run({ model: null });
  assert.deepEqual(s.sent().find((m) => m.method === 'thread/start').params, { cwd: s.k });
});

test('a command request is asked, and allow becomes accept', async (t) => {
  const s = setup(t, 'command');
  const r = await s.run();
  assert.deepEqual(s.asked, [{ kind: 'command', title: 'Run a command', detail: 'npm test' }]);
  assert.equal(reply(s.sent(), 1001).result.decision, 'accept');
  assert.match(r.text, /accept/);
});

test('deny becomes decline, and the agent continues its turn', async (t) => {
  const s = setup(t, 'command');
  const r = await s.run({ decision: 'deny' });
  assert.equal(reply(s.sent(), 1001).result.decision, 'decline');
  assert.equal(r.error, null);
});

test('a file change is asked with the files it changes', async (t) => {
  const s = setup(t, 'file');
  await s.run();
  assert.deepEqual(s.asked, [{ kind: 'edit', title: 'Change files', detail: 'src/a.js, src/b.js' }]);
  assert.equal(reply(s.sent(), 1001).result.decision, 'accept');
});

test('a request for more access grants exactly what was asked, or nothing', async (t) => {
  const allow = setup(t, 'permissions');
  await allow.run();
  assert.deepEqual(reply(allow.sent(), 1001).result, { permissions: { network: { enabled: true } }, scope: 'turn' });
  const deny = setup(t, 'permissions');
  await deny.run({ decision: 'deny' });
  assert.deepEqual(reply(deny.sent(), 1001).result, { permissions: {}, scope: 'turn' });
});

test('a request Benchook cannot show is refused, not left hanging', async (t) => {
  const s = setup(t, 'unknown');
  const r = await s.run();
  assert.ok(reply(s.sent(), 1001).error, 'an error reply');
  assert.equal(r.error, null);
  assert.equal(s.asked.length, 0);
});

test('a failed turn returns the provider\'s own words', async (t) => {
  const s = setup(t, 'fail');
  const r = await s.run();
  assert.match(r.error, /usage limit/);
});

test('a server that dies returns an error', async (t) => {
  const s = setup(t, 'crash');
  const r = await s.run();
  assert.match(r.error, /exited/);
});

test('the time limit stops a hung run', async (t) => {
  const s = setup(t, 'hang');
  const r = await s.run({ durationMs: 300 });
  assert.match(r.error, /timed out/);
});

test('the time limit does not run out while a question waits for the user', async (t) => {
  const s = setup(t, 'slow-question');
  const r = await s.run({ durationMs: 200, ask: () => new Promise((ok) => setTimeout(() => ok('allow'), 600)) });
  assert.equal(r.error, null, 'waiting three times the limit for an answer is not a timeout');
  assert.match(r.text, /accept/);
});

test('cancelling stops the run', async (t) => {
  const s = setup(t, 'hang');
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 100);
  const r = await s.run({ signal: stop.signal });
  assert.match(r.error, /cancelled/i);
});

test('a letter split across two output chunks arrives intact', async (t) => {
  const s = setup(t, 'split-utf8');
  const r = await s.run();
  assert.equal(r.error, null);
  assert.equal(r.text, 'café déjà 日本 done');
});
