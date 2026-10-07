'use strict';
/* Start the actual approval server process and answer requests through approvals.answer. Provider prompts use text JSON with allow/updatedInput or deny/message responses. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const approvals = require('../panel/approvals');
const server = path.join(__dirname, '..', 'tools', 'approval-server.js');

function start(t) {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-server-'));
  const folder = path.join(k, 'run.approvals');
  const p = spawn(process.execPath, [server], { env: { ...process.env, BENCHOOK_APPROVALS: folder }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { try { p.kill(); } catch {} fs.rmSync(k, { recursive: true, force: true }); });
  let buffer = '';
  const waiting = new Map();
  p.stdout.on('data', (d) => {
    buffer += d; let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const m = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
      if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    }
  });
  let n = 0;
  const call = (method, params) => new Promise((r) => { const id = ++n; waiting.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  return { folder, call };
}
const until = async (check) => { for (let i = 0; i < 200; i++) { const v = check(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timed out'); };

test('the server offers one tool, the one the worker names', async (t) => {
  const s = start(t);
  await s.call('initialize', { protocolVersion: '2025-06-18' });
  const list = await s.call('tools/list', {});
  assert.deepEqual(list.result.tools.map((x) => x.name), ['ask']);
});

test('an allowed question returns allow with the input unchanged', async (t) => {
  const s = start(t);
  await s.call('initialize', {});
  const input = { command: 'npm test', description: 'Run tests' };
  const reply = s.call('tools/call', { name: 'ask', arguments: { tool_name: 'Bash', input } });
  const q = await until(() => approvals.pending(s.folder)[0]);
  assert.equal(q.title, 'Run a command');
  assert.equal(q.detail, 'npm test');
  approvals.answer(s.folder, q.id, 'allow');
  const r = await reply;
  assert.deepEqual(JSON.parse(r.result.content[0].text), { behavior: 'allow', updatedInput: input });
});

test('a denied question returns deny with a message the agent can read', async (t) => {
  const s = start(t);
  await s.call('initialize', {});
  const reply = s.call('tools/call', { name: 'ask', arguments: { tool_name: 'Write', input: { file_path: 'a.txt', content: 'x' } } });
  const q = await until(() => approvals.pending(s.folder)[0]);
  approvals.answer(s.folder, q.id, 'deny');
  const answer = JSON.parse((await reply).result.content[0].text);
  assert.equal(answer.behavior, 'deny');
  assert.match(answer.message, /denied/i);
});
