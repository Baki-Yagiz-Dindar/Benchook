'use strict';
// PERMISSION PROMPTS OF A BACKGROUND AGENT - asked on the live run card .
// 
// An agent on the default level runs with the account's own permission settings. What normal use would ask in
// the terminal, the agent's process writes here as a question; the panel shows it on the live run card and
// writes the user's answer next to it; the waiting process reads the answer and the agent continues.
// 
// WHY FILES: the question comes from a process the panel did not start (the orchestrator's MCP server starts
// the worker, and Claude starts its own approval server), and the panel already reads the run ledger from the
// user data folder. The questions sit in the run's own folder beside the ledger record.
// 
// Wait for an approval answer or cancellation; do not impose a response deadline.
// A cancelled run counts as denied and leaves no open question behind.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID = /^q-\d+-[0-9a-f]{6}$/;
const DETAIL_MAX = 2000;

const askFile = (folder, id) => path.join(folder, id + '.ask.json');
const answerFile = (folder, id) => path.join(folder, id + '.answer.json');

/** Writes a file whole or not at all, so a reader never sees half of it. The shared writer also
    flushes to disk, falls back on Windows when the target is briefly locked, and removes its
    temporary file when the write fails. */
function writeWhole(file, value) {
  require('./persistent-json').atomicText(file, JSON.stringify(value));
}
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/**
 * Asks and waits for the answer. Resolves `{decision: 'allow'|'deny', answeredAt}`; a cancelled run resolves
 * 'deny' and its question is removed.
 */
function ask(folder, question, { signal, pollMs = 400 } = {}) {
  fs.mkdirSync(folder, { recursive: true });
  const id = 'q-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  writeWhole(askFile(folder, id), { id, kind: question.kind, title: question.title,
    detail: question.detail, askedAt: new Date().toISOString() });
  return new Promise((resolve) => {
    let timer = null;
    const finish = (decision, answeredAt) => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      resolve({ id, decision, answeredAt: answeredAt || new Date().toISOString() });
    };
    const cancel = () => { fs.rmSync(askFile(folder, id), { force: true }); finish('deny'); };
    const look = () => {
      const a = readJson(answerFile(folder, id));
      if (a && (a.decision === 'allow' || a.decision === 'deny')) return finish(a.decision, a.answeredAt);
      timer = setTimeout(look, pollMs);
    };
    if (signal?.aborted) return cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    look();
  });
}

/** The open questions of a run, oldest first. */
function pending(folder) {
  let names;
  try { names = fs.readdirSync(folder); } catch { return []; }
  return names.filter((n) => n.endsWith('.ask.json'))
    .map((n) => n.slice(0, -'.ask.json'.length))
    .filter((id) => ID.test(id) && !fs.existsSync(answerFile(folder, id)))
    .map((id) => readJson(askFile(folder, id)))
    .filter(Boolean)
    .sort((a, b) => String(a.askedAt).localeCompare(String(b.askedAt)));
}

/** Is the run waiting for the user right now? Its time limit does not run out while it is. */
const waiting = (folder) => pending(folder).length > 0;

/** The user's answer. Once per question, only for a question that is really open, only allow or deny. */
function answer(folder, id, decision) {
  if (decision !== 'allow' && decision !== 'deny') return { error: 'The answer must be allow or deny.' };
  if (!ID.test(String(id)) || !fs.existsSync(askFile(folder, id))) return { error: 'That question was not found.' };
  if (fs.existsSync(answerFile(folder, id))) return { error: 'That question was already answered.' };
  try {
    // `wx` fails if an answer appeared in between: a second click cannot overwrite the first.
    fs.writeFileSync(answerFile(folder, id), JSON.stringify({ decision, answeredAt: new Date().toISOString() }), { flag: 'wx' });
  } catch (e) {
    return { error: e.code === 'EEXIST' ? 'That question was already answered.' : 'The answer could not be saved: ' + e.message };
  }
  return { ok: true };
}

const shorten = (s) => { const x = String(s == null ? '' : s); return x.length > DETAIL_MAX ? x.slice(0, DETAIL_MAX - 1) + '…' : x; };

/** A Claude permission prompt (`--permission-prompt-tool` receives the tool name and its input). */
function describeClaude(tool, input) {
  const i = input || {};
  if (/^(Bash|PowerShell)$/.test(tool)) return { kind: 'command', title: 'Run a command', detail: shorten(i.command) };
  if (/^(Edit|MultiEdit|NotebookEdit)$/.test(tool)) return { kind: 'edit', title: 'Edit a file', detail: shorten(i.file_path || i.notebook_path) };
  if (tool === 'Write') return { kind: 'edit', title: 'Write a file', detail: shorten(i.file_path) };
  if (tool === 'WebFetch') return { kind: 'network', title: 'Fetch a web page', detail: shorten(i.url) };
  if (tool === 'WebSearch') return { kind: 'network', title: 'Search the web', detail: shorten(i.query) };
  return { kind: 'tool', title: 'Use the tool ' + tool, detail: shorten(JSON.stringify(i)) };
}

/** A Codex approval request (`codex app-server`); `files` are the paths of the pending file change, if known. */
function describeCodex(method, params, files) {
  const p = params || {};
  if (method === 'item/commandExecution/requestApproval') return { kind: 'command', title: 'Run a command', detail: shorten(p.command) };
  if (method === 'item/fileChange/requestApproval') {
    return { kind: 'edit', title: 'Change files', detail: shorten((files && files.length ? files.join(', ') : '') || p.reason || p.grantRoot) };
  }
  return { kind: 'permissions', title: 'Grant more access', detail: shorten(p.reason || JSON.stringify(p.permissions || {})) };
}

module.exports = { ask, pending, waiting, answer, describeClaude, describeCodex };
