'use strict';
/* Approval requests are written to the run folder, displayed on the live card, and resolved through a response file. Waiting continues until an answer or cancellation. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const approvals = require('../panel/approvals');

const folder = (t) => {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-'));
  t.after(() => fs.rmSync(k, { recursive: true, force: true }));
  return path.join(k, 'run-1.approvals');
};

test('a question waits until it is answered, and the answer reaches the asker', async (t) => {
  const f = folder(t);
  const asked = approvals.ask(f, { kind: 'command', title: 'Run a command', detail: 'npm test' }, { pollMs: 10 });
  await new Promise((r) => setTimeout(r, 60));
  const open = approvals.pending(f);
  assert.equal(open.length, 1);
  assert.equal(open[0].detail, 'npm test');
  assert.equal(approvals.waiting(f), true);
  let settled = false; asked.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(settled, false, 'no answer, no decision - it keeps waiting');
  assert.deepEqual(approvals.answer(f, open[0].id, 'allow'), { ok: true });
  const r = await asked;
  assert.equal(r.decision, 'allow');
  assert.equal(approvals.pending(f).length, 0);
  assert.equal(approvals.waiting(f), false);
});

test('deny reaches the asker as deny', async (t) => {
  const f = folder(t);
  const asked = approvals.ask(f, { kind: 'edit', title: 'Edit a file', detail: 'a.js' }, { pollMs: 10 });
  await new Promise((r) => setTimeout(r, 40));
  approvals.answer(f, approvals.pending(f)[0].id, 'deny');
  assert.equal((await asked).decision, 'deny');
});

test('an answer is accepted once, only for a real open question, and only allow or deny', async (t) => {
  const f = folder(t);
  const asked = approvals.ask(f, { kind: 'command', title: 'Run a command', detail: 'x' }, { pollMs: 10 });
  await new Promise((r) => setTimeout(r, 40));
  const id = approvals.pending(f)[0].id;
  assert.match(approvals.answer(f, id, 'always').error, /allow or deny/);
  assert.match(approvals.answer(f, '../../evil', 'allow').error, /not found/);
  assert.match(approvals.answer(f, 'q-1-abcdef', 'allow').error, /not found/);
  assert.deepEqual(approvals.answer(f, id, 'deny'), { ok: true });
  assert.match(approvals.answer(f, id, 'allow').error, /already answered/, 'a second click cannot turn deny into allow');
  assert.equal((await asked).decision, 'deny');
});

test('a cancelled run stops waiting and counts as denied', async (t) => {
  const f = folder(t);
  const stop = new AbortController();
  const asked = approvals.ask(f, { kind: 'command', title: 'Run a command', detail: 'x' }, { pollMs: 10, signal: stop.signal });
  await new Promise((r) => setTimeout(r, 30));
  stop.abort();
  assert.equal((await asked).decision, 'deny');
  assert.equal(approvals.pending(f).length, 0, 'a question nobody waits for is not left on the card');
});

/* WHAT THE CARD SAYS - in the words the providers' own prompts use, with the command or file shown. */
test('a Claude question is described in the terms of the tool', () => {
  const d = approvals.describeClaude;
  assert.deepEqual(d('Bash', { command: 'npm test', description: 'Run tests' }), { kind: 'command', title: 'Run a command', detail: 'npm test' });
  assert.deepEqual(d('PowerShell', { command: 'Get-ChildItem' }), { kind: 'command', title: 'Run a command', detail: 'Get-ChildItem' });
  assert.deepEqual(d('Edit', { file_path: 'C:\\p\\a.js', old_string: 'a', new_string: 'b' }), { kind: 'edit', title: 'Edit a file', detail: 'C:\\p\\a.js' });
  assert.deepEqual(d('Write', { file_path: 'b.txt', content: 'x' }), { kind: 'edit', title: 'Write a file', detail: 'b.txt' });
  assert.deepEqual(d('WebFetch', { url: 'https://example.com' }), { kind: 'network', title: 'Fetch a web page', detail: 'https://example.com' });
  assert.equal(d('mcp__github__create_issue', { title: 't' }).title, 'Use the tool mcp__github__create_issue');
});

test('a Codex question is described from its request', () => {
  const d = approvals.describeCodex;
  assert.deepEqual(d('item/commandExecution/requestApproval', { command: 'npm test', cwd: 'C:\\p' }, null),
    { kind: 'command', title: 'Run a command', detail: 'npm test' });
  assert.deepEqual(d('item/fileChange/requestApproval', { itemId: 'i1', reason: null }, ['a.js', 'b.js']),
    { kind: 'edit', title: 'Change files', detail: 'a.js, b.js' });
  assert.deepEqual(d('item/permissions/requestApproval', { reason: 'needs network', permissions: { network: { enabled: true } } }, null),
    { kind: 'permissions', title: 'Grant more access', detail: 'needs network' });
});

test('long details are shortened for the card', () => {
  const long = 'x'.repeat(5000);
  const r = approvals.describeClaude('Bash', { command: long });
  assert.ok(r.detail.length <= 2000 && r.detail.startsWith('xxx'));
});
