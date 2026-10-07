'use strict';
// A stand-in for `codex app-server` (newline-delimited JSON-RPC), shaped after the messages measured on Codex
// provider protocol and generated schema. FAKE_SCENARIO selects the response path.
// turn does; every message received is appended to FAKE_LOG so a test can read what Benchook sent.
const fs = require('node:fs');
const scenario = process.env.FAKE_SCENARIO || 'plain';
const log = process.env.FAKE_LOG;
const note = (m) => { if (log) fs.appendFileSync(log, JSON.stringify(m) + '\n'); };
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
let buffer = '', serverId = 1000, threadId = 'thread-1', turnId = 'turn-1';
const replies = new Map();
const request = (method, params) => new Promise((r) => { const id = ++serverId; replies.set(id, r); send({ id, method, params }); });

function finish(text) {
  send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: 'm1', text, phase: 'final_answer' } } });
  send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: {
    total: { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 600, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 10 },
    last: { totalTokens: 300, inputTokens: 250, cachedInputTokens: 100, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 0 },
    modelContextWindow: 258400 } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [], error: null } } });
}

async function turn() {
  send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
  if (scenario === 'plain') return finish('all done');
  if (scenario === 'command') {
    const r = await request('item/commandExecution/requestApproval', { threadId, turnId, itemId: 'c1', command: 'npm test', cwd: process.cwd(), startedAtMs: Date.now() });
    return finish('command answer: ' + JSON.stringify(r));
  }
  if (scenario === 'file') {
    send({ method: 'item/started', params: { threadId, turnId, item: { type: 'fileChange', id: 'f1', status: 'inProgress',
      changes: [{ path: 'src/a.js', kind: { type: 'update' }, diff: '' }, { path: 'src/b.js', kind: { type: 'add' }, diff: '' }] } } });
    const r = await request('item/fileChange/requestApproval', { threadId, turnId, itemId: 'f1', reason: null, startedAtMs: Date.now() });
    return finish('file answer: ' + JSON.stringify(r));
  }
  if (scenario === 'permissions') {
    const permissions = { network: { enabled: true } };
    const r = await request('item/permissions/requestApproval', { threadId, turnId, itemId: 'p1', cwd: process.cwd(), reason: 'needs the network', permissions, startedAtMs: Date.now() });
    return finish('permissions answer: ' + JSON.stringify(r));
  }
  if (scenario === 'unknown') {
    const r = await request('item/tool/requestUserInput', { threadId, turnId, itemId: 'u1', questions: [] });
    return finish('unknown answer: ' + JSON.stringify(r));
  }
  if (scenario === 'fail') {
    return send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'failed', items: [],
      error: { message: "You've hit your usage limit." } } } });
  }
  if (scenario === 'split-utf8') {
    // The final message is written in two raw chunks that cut a two-byte letter in half.
    const line = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId, turnId,
      item: { type: 'agentMessage', id: 'm1', text: 'café déjà 日本 done', phase: 'final_answer' } } }) + '\n');
    const cut = line.indexOf(Buffer.from('é')) + 1;
    process.stdout.write(line.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 50));
    process.stdout.write(line.subarray(cut));
    return send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [], error: null } } });
  }
  if (scenario === 'crash') process.exit(3);
  if (scenario === 'hang') return;
  if (scenario === 'slow-question') {
    const r = await request('item/commandExecution/requestApproval', { threadId, turnId, itemId: 'c1', command: 'slow', cwd: process.cwd(), startedAtMs: Date.now() });
    return finish('slow answer: ' + JSON.stringify(r));
  }
}

process.stdin.on('data', (d) => {
  buffer += d; let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    note(m);
    if (m.id != null && !m.method && replies.has(m.id)) { const r = replies.get(m.id); replies.delete(m.id); r(m.result !== undefined ? m.result : { error: m.error }); continue; }
    if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake' } });
    else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: threadId }, model: m.params.model || 'fake-default',
      approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } } });
    else if (m.method === 'turn/start') { send({ id: m.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } }); turn(); }
  }
});
