'use strict';
// A CODEX RUN THAT CAN ASK - `codex app-server` for agents on the default level .
// 
// `codex exec` runs with approvals off: it cannot ask anyone, so a background agent either had a sandbox that
// refused or one that allowed without asking. `codex app-server` (newline-delimited JSON-RPC; experimental in
// Codex 0.154.0) sends Codex's own approval requests to its client. Benchook is that client: each request is
// asked on the live run card through `ask`, and the answer goes back to Codex.
// 
// THE ACCOUNT DECIDES: the thread starts with no approval policy and no sandbox, so the account's own Codex
// settings apply - exactly what the user gets in their terminal. Measured with the panel's Codex account:
// on-request + workspace-write; a command inside the project ran without a question, as it does there.
// 
// Flow (measured): initialize -> initialized -> thread/start {cwd, model} -> turn/start {threadId, input} ->
// server requests *Approval -> item/completed agentMessage -> thread/tokenUsage/updated -> turn/completed.

const { spawn } = require('node:child_process');
const { stopTree, limit } = require('./subprocess');
const approvals = require('./approvals');

const DECISION = {
  'item/commandExecution/requestApproval': (ok) => ({ decision: ok ? 'accept' : 'decline' }),
  'item/fileChange/requestApproval': (ok) => ({ decision: ok ? 'accept' : 'decline' }),
  // Exactly what was asked, for this turn only, or nothing.
  'item/permissions/requestApproval': (ok, params) => ({ permissions: ok ? (params.permissions || {}) : {}, scope: 'turn' }),
};

/** The run's token use in the same shape as the `codex exec` parser: the whole run, not the last call. */
function tokensOf(usage) {
  const k = usage && usage.total;
  if (!k || (k.inputTokens == null && k.outputTokens == null)) return null;
  const cache = k.cachedInputTokens || 0;
  return { fresh: Math.max(0, (k.inputTokens || 0) - cache), cacheRead: cache,
    cacheWritten: k.cacheWriteInputTokens || 0, output: k.outputTokens || 0, input: k.inputTokens || 0 };
}

/**
 * Runs one task as one turn.
 * @param {{command, args, cwd, env, model, task, ask: (q) => Promise<'allow'|'deny'>, durationMs, signal}} o
 * @returns {Promise<{text, tokens, threadId, error, errorOutput}>}
 */
function run({ command, args = [], cwd, env, model, task, ask, durationMs = 600000, signal }) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ text: '', tokens: null, threadId: null, error: 'Task cancelled', errorOutput: '' });
    let p;
    try { p = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ text: '', tokens: null, threadId: null, error: 'Could not start Codex: ' + e.message, errorOutput: '' }); }

    let buffer = '', stderr = '', id = 0, done = false, exited = false, open = 0, timer = null;
    let threadId = null, text = '', tokens = null;
    const replies = new Map();
    const files = new Map();        // itemId -> paths of a pending file change

    const finish = (error) => {
      if (done) return;
      done = true;
      if (timer) timer();
      signal?.removeEventListener('abort', cancel);
      for (const r of replies.values()) r({ error: { message: 'closed' } });
      const result = { text: text.trim(), tokens, threadId, error: error || null, errorOutput: stderr.slice(-4000) };
      // The server is stopped BEFORE the result is returned: a finished run leaves no Codex process behind.
      if (exited) return resolve(result);
      const gone = new Promise((r) => { p.once('close', r); setTimeout(r, 3000); });
      stopTree(p).catch(() => {}).then(() => gone).then(() => resolve(result));
    };
    const cancel = () => finish('Task cancelled');
    // Exclude time waiting for approval from execution timeout accounting.
    const arm = () => { timer = limit(durationMs, () => open > 0, () => finish('Worker timed out')); };

    const send = (m) => { try { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n'); } catch { /* closed; the close event decides */ } };
    const call = (method, params) => new Promise((r) => { const n = ++id; replies.set(n, r); send({ id: n, method, params }); });

    async function serverRequest(m) {
      const make = DECISION[m.method];
      if (!make) return send({ id: m.id, error: { code: -32601, message: 'Benchook cannot show this request: ' + m.method } });
      const params = m.params || {};
      const question = approvals.describeCodex(m.method, params, files.get(params.itemId));
      open++;
      let decision = 'deny';
      try { decision = await ask(question); } catch { decision = 'deny'; } finally { open--; }
      if (!done) send({ id: m.id, result: make(decision === 'allow', params) });
    }

    function onMessage(m) {
      if (m.id != null && !m.method) {
        const r = replies.get(m.id);
        if (r) { replies.delete(m.id); r(m); }
        return;
      }
      if (m.id != null && m.method) { serverRequest(m); return; }
      const params = m.params || {};
      if (m.method === 'item/started' && params.item && params.item.type === 'fileChange') {
        files.set(params.item.id, (params.item.changes || []).map((c) => c.path).filter(Boolean));
      }
      if (m.method === 'item/completed' && params.item && params.item.type === 'agentMessage' && typeof params.item.text === 'string') {
        text = params.item.text;
      }
      if (m.method === 'thread/tokenUsage/updated') tokens = tokensOf(params.tokenUsage) || tokens;
      if (m.method === 'error' && params.error && params.error.message && !params.willRetry) stderr += '\n' + params.error.message;
      if (m.method === 'turn/completed') {
        const turn = params.turn || {};
        if (turn.status === 'completed') return finish(null);
        finish((turn.error && turn.error.message) || 'Codex could not complete the task (' + (turn.status || 'unknown') + ')');
      }
    }

    /* Decoded as a stream: a character split across two output chunks (most non-ASCII letters are two or more bytes)
       used to turn into U+FFFD inside the agent's text. A line that never ends is capped. */
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      buffer += d; let i;
      if (buffer.length > 32 * 1024 * 1024 && buffer.indexOf('\n') < 0) { buffer = ''; return finish('Codex output exceeded the size limit'); }
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        onMessage(m);
      }
    });
    p.stderr.on('data', (d) => { stderr = (stderr + d).slice(-16000); });
    p.on('error', (e) => finish('Could not start Codex: ' + e.message));
    p.on('close', (code) => { exited = true; finish('Codex exited before the task finished (' + code + ')'); });
    p.stdin.on('error', () => { /* the close event decides */ });
    signal?.addEventListener('abort', cancel, { once: true });
    arm();

    (async () => {
      const init = await call('initialize', { clientInfo: { name: 'benchook', version: require('./product').VERSION } });
      if (init.error) return finish('Codex did not start: ' + init.error.message);
      send({ method: 'initialized' });
      const start = await call('thread/start', model ? { cwd, model } : { cwd });
      if (start.error) return finish('Codex could not open a session: ' + start.error.message);
      threadId = start.result && start.result.thread && start.result.thread.id;
      if (!threadId) return finish('Codex opened no session');
      const turn = await call('turn/start', { threadId, input: [{ type: 'text', text: String(task) }] });
      if (turn.error) finish('Codex did not take the task: ' + turn.error.message);
    })().catch((e) => finish('Codex connection failed: ' + e.message));
  });
}

module.exports = { run, tokensOf };
