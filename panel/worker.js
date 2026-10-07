// WORKER - runs a job with the token of ANOTHER ACCOUNT, on ANOTHER MODEL.
//
// Why it exists: one of the reasons this program was built is to spend fewer tokens by handing
// different jobs to different agents on different accounts.
//
// HOW: `claude --print` on the Claude side and `codex exec` on the Codex side - both one-shot, with
// no conversation. The only thing that separates the accounts is an environment variable
// (`accounts.js` `env`); no token is read, copied, or even placed into the environment of the
// process - the child program reads its own identity file from its own folder.
//
// MEASUREMENT: `--output-format json` (Claude) and `--json` (Codex) also give the token count of
// the run. That is why the panel can say what a worker spent - without inventing it.
//
// IN TERMS OF THE safety constraints: this is the ONLY place in the panel that spends tokens. It never
// runs by itself; it runs only when a job is explicitly given, and which account paid is written down.

const fs = require('node:fs');
const child = require('./subprocess');
const cliPath = require('./cli-path');
const resolution = require('./agent-resolution');   // the tool-restriction rule is shared
const accounts = require('./accounts');
const codexWindows = require('./codex-windows');
const codexAppServer = require('./codex-app-server');
const approvals = require('./approvals');
const path = require('node:path');

/* Send task text through stdin, avoiding shell interpretation and command-line length limits. Start provider CLIs directly without a shell. */

/* Default-level Claude agents use account permission settings and route approval prompts through the approval server. Requests remain in the run folder until answered or cancelled. */
const APPROVAL_TOOL = 'mcp__benchook_approval__ask';
function approvalConfig(folder) {
  const server = path.join(__dirname, '..', 'tools', 'approval-server.js');
  return JSON.stringify({ mcpServers: { benchook_approval: { command: process.execPath, args: [server],
    env: { BENCHOOK_APPROVALS: folder, ELECTRON_RUN_AS_NODE: '1' } } } });
}

/** The Claude side: a one-shot run with no conversation. The task comes from stdin. */
function claudeCommand(model, restriction, approvalsFolder) {
  const arg = ['--print', '--output-format', 'json'];
  if (model) arg.push('--model', model);
  /* Restrict built-in tools with --tools and MCP tools with --disallowedTools. Scope Write/Edit permissions to the project using relative patterns. */
  const allowed = (restriction || []).map((x) => /^(edit|write)$/i.test(x) ? x + '(./**)' : x);
  if (restriction && restriction.length) arg.push('--tools', restriction.join(','),
    '--allowedTools', allowed.join(','), '--disallowedTools', 'mcp__*');
  else if (approvalsFolder) arg.push('--mcp-config', approvalConfig(approvalsFolder), '--permission-prompt-tool', APPROVAL_TOOL);
  return { command: 'claude', arg };
}

/* * The Codex side: the `exec` subcommand; the identity is read from CODEX_HOME. The task comes from stdin.
 *  THE AGENT'S LEVEL BECOMES THE SANDBOX : read-only, or workspace-write, with the network
 *  only for the full level. The Windows sandbox is named too when the account folder does not name one;
 *  without it Codex rejected every command, reading included (`codex-windows.js`). */
function codexCommand(model, folder, tools, codexHome) {
  const arg = ['exec', '--json', '--skip-git-repo-check'];
  if (model) arg.push('-m', model);
  if (folder) arg.push('-C', folder);
  const sandbox = resolution.codexSandbox(tools);
  arg.push('--sandbox', sandbox.mode);
  if (sandbox.network) arg.push('-c', 'sandbox_workspace_write.network_access=true');
  arg.push(...codexWindows.sandboxArgs(codexHome));
  return { command: 'codex', arg };
}

/** Text and token counts from the JSON answer of Claude. A missing field is NOT INVENTED; it stays null. */
function parseClaude(raw) {
  let c;
  try { c = JSON.parse(raw); } catch { return { text: raw.trim(), tokens: null }; }
  /* Keep fresh input, cached input, cache writes, and output separate because they represent distinct usage categories. */
  const k = c.usage || {};
  const tokens = (k.input_tokens != null || k.output_tokens != null) ? {
    fresh: k.input_tokens || 0,
    cacheRead: k.cache_read_input_tokens || 0,
    cacheWritten: k.cache_creation_input_tokens || 0,
    output: k.output_tokens || 0,
    input: (k.input_tokens || 0) + (k.cache_read_input_tokens || 0)
         + (k.cache_creation_input_tokens || 0),
  } : null;
  // THE MODEL THAT REALLY RAN - measured: the output of `claude --print --output-format json` has a
  // `modelUsage` field whose KEYS are the full identities of the models that ran. Asking for `haiku`
  // returned `{"claude-haiku-4-5-20251001": {..., "canonicalModel": "claude-haiku-4-5",...}}`.
  // Until then the panel recorded the REQUESTED model as the real model; that field was not a
  // verification, it was a copy of the request.
  // There can be several keys (a sub-agent, or the provider falling back to another model); all of
  // them are kept and none is picked.
  const activeRuns = (c.modelUsage && typeof c.modelUsage === 'object')
    ? Object.keys(c.modelUsage).map((k) => (c.modelUsage[k] && c.modelUsage[k].canonicalModel) || k)
    : [];

  return {
    text: typeof c.result === 'string' ? c.result : raw.trim(),
    observedModels: activeRuns,
    error: c.is_error || (c.type === 'result' && String(c.subtype || '').startsWith('error'))
      ? (typeof c.result === 'string' ? c.result : (c.errors || []).join('; ') || "Claude could not complete the task") : null,
    tokens,
    duration: c.duration_ms || null,
    cost: typeof c.total_cost_usd === 'number' ? c.total_cost_usd : null,
    session: c.session_id || null,
  };
}

/** Codex `--json` writes events line by line; the last message and any token counts are collected. */
function parseCodex(raw) {
  let text = '';
  let tokens = null;
  let error = null;
  let sessionIdFromFile = null;   // `thread.started.thread_id` - the key to the record of the model that ran
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    const i = o.msg || o;
    if (i.type === 'thread.started' && typeof i.thread_id === 'string') sessionIdFromFile = i.thread_id;
    if (i.type === 'agent_message' && typeof i.message === 'string') text = i.message;
    if (i.type === 'item.completed' && i.item?.type === 'agent_message' && i.item.text) text = i.item.text;
    if (i.type === 'turn.failed' || i.type === 'error') error = i.error?.message || i.message || "Codex could not complete the task";
    // The breakdown carries THE SAME fields as the Claude side. It once did not: this side returned
    // {read, written} while the display expected {fresh, cacheRead,...} and "undefined" appeared on
    // screen. Using one shape makes that class of error impossible.
    const k = i.info || i.usage || (i.token_usage && i.token_usage.total)
            || (i.info && i.info.last_token_usage) || null;
    const last = (k && k.last_token_usage) ? k.last_token_usage : k;
    if (last && (last.input_tokens != null || last.output_tokens != null)) {
      const cache = last.cached_input_tokens || last.cache_read_input_tokens || 0;
      tokens = {
        fresh: Math.max(0, (last.input_tokens || 0) - cache),
        cacheRead: cache,
        cacheWritten: 0,          // Codex does not give this split: it is not invented, zero is written
        output: last.output_tokens || 0,
        input: last.input_tokens || 0,
      };
    }
  }
  return { text: text.trim() || raw.trim(), tokens, error, sessionIdFromFile };
}

/* Read Codex model identities from turn_context records in the rollout file matched to thread.started.thread_id. Return unknown when the matching record cannot be found. */
function codexRunningModels(accountFolder, sessionIdFromFile) {
  if (!sessionIdFromFile) return [];
  let file;
  try { file = require('./sessions').findSessionFile('codex', null, sessionIdFromFile, accountFolder); } catch { return []; }
  if (!file) return [];
  const models = new Set();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('turn_context')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'turn_context' && o.payload && typeof o.payload.model === 'string') models.add(o.payload.model);
    }
  } catch { return []; }
  return [...models];
}

/**
 * DID THE REQUESTED MODEL REALLY RUN - the panel has to be sure a job ran on the account and the
 * model entered for that agent.
 *
 * The comparison is NOT that the names are equal, because they are not: the request is an alias such
 * as `haiku`, while what ran is a full identity such as `claude-haiku-4-5`. The criterion is that the
 * alias occurs inside the identity that ran. That catches asking for `opus` and getting `sonnet`,
 * without raising a pointless warning when a version number changes.
 *
 * THE THREE STATES ARE KEPT APART, and two of them do NOT mean all is well:
 *   verified: true   -> the requested model ran, and the evidence was read from the output
 *   verified: false  -> ANOTHER model ran; `modelWarning` says which
 *   verified: null   -> it could not be verified (the provider does not report the model that ran,
 *                       or no model was chosen). That does not mean it ran; it means unknown.
 *
 * THE CODEX SIDE WAS MEASURED: the `codex exec --json` output does not report the model, but the
 * rollout file of the run does (`turn_context.payload.model`) - see `codexRunningModels`.
 * If the file is not found it is `null` again: what is unknown is never called verified.
 */
function modelCheck(requested, activeRuns, provider) {
  const list = Array.isArray(activeRuns) ? activeRuns.filter(Boolean) : [];
  if (!list.length) {
    return { observedModels: [], verified: null, modelWarning: null,
      /* Missing model evidence leaves this run unverified; it does not establish that the provider never reports model identity. */
      unverifiedReason: provider === 'codex'
        ? "The running model was not found in the Codex output. "
          + "Model identity remains unverified for this run."
        : "The running model was not found in the output" };
  }
  if (!requested) {
    return { observedModels: list, verified: null, modelWarning: null,
      unverifiedReason: "No model was explicitly selected" };
  }

  /* Compare requested and reported model identifiers symmetrically so a versioned alias can match a shorter canonical identifier. */
  const normalize = value => String(value).toLowerCase().replace(/-\d{8}$/, '');
  const name = normalize(requested);
  const alias = /^(?:opus|sonnet|haiku|fable)$/.test(name);
  const fitting = list.filter((m) => {
    const k = normalize(m);
    return k === name || (alias && k.startsWith('claude-' + name + '-'));
  });

  if (!fitting.length) {
    return { observedModels: list, verified: false,
      modelWarning: "MODEL MISMATCH: requested \"" + requested + "\"; observed: " + list.join(', '),
      unverifiedReason: null };
  }

  /* IF SEVERAL MODELS RAN IT IS NOT CALLED VERIFIED. The old form used `some`, an OR: even when the
     real call ran on opus and only a sub-agent in the list was haiku, it still said verified - an
     invisible copy of the very defect being fixed, showing a verification that never happened. The
     output does not say which key was the REAL call; and because it does not say, the result is
     called unknown. */
  if (list.length > 1) {
    return { observedModels: list, verified: null, modelWarning: null,
      unverifiedReason: "Multiple models were reported (" + list.join(', ') + "); the output does not identify which "
        + "model handled the primary task" };
  }

  return { observedModels: list, verified: true, modelWarning: null, unverifiedReason: null };
}

/* *
 * Runs a job on an account.
 * @param {object} request { accountId, model, task, folder (the directory the worker runs in), timeout }
 * @returns {Promise<object>} { text, tokens, account, model, seconds,... } or { error } */
async function run({ accountId, model, task, folder, tools, duration = 600, signal, approvals: approvalsFolder }) {
  if (!task || !String(task).trim()) return { error: "Task instructions are empty" };
  if (!Number.isFinite(duration) || duration <= 0) return { error: "Invalid timeout" };
  const account = accounts.find(accountId);
  if (!account) return { error: "Account not found: " + accountId };
  if (!accounts.hasSignIn(account)) return { error: account.name + " is signed out; sign in before running this agent" };
  /* AN INTERNAL MARKER IS NOT A MODEL NAME. `orchestrator` and `default` are markers of the
     panel itself; if they reach this point unresolved, a model name that does not exist would be sent
     to the CLI. Reaching here at all is a defect and is not silently corrected: the caller must learn about it. */
  const marker = String(model || '').trim();
  if (marker === resolution.ORCHESTRATOR || marker === 'default') {
    return { error: 'Benchook could not resolve which model "' + marker + '" means for this run, '
      + 'so nothing was started. This is a Benchook bug, not a problem with your setup.' };
  }
  const restriction = resolution.toolRestriction(tools);
  if (restriction && restriction.some((name) => !/^[A-Za-z][A-Za-z0-9]*$/.test(name)
    || name.toLowerCase() === 'default')) {
    return { error: 'This tool limit contains a pattern or external tool that Benchook cannot '
      + 'enforce safely: ' + restriction.join(', ') + '. Use plain built-in tool names such as Read or Grep. '
      + 'Nothing was started; the saved definition was not changed.' };
  }
  /* CODEX IS NOT REFUSED FOR ITS LIST ANY MORE . Codex cannot limit single tools, so a
     list used to stop the run; now the list becomes Codex's sandbox (`resolution.codexSandbox`), which is
     never wider than the list allows: without editing, commands stay read-only. */
  /* A CODEX AGENT ON THE DEFAULT LEVEL RUNS THROUGH `codex app-server`: `codex exec` cannot ask anyone. */
  const asking = account.provider === 'codex' && !restriction;
  const { command, arg } = asking
    ? { command: 'codex', arg: ['app-server', ...codexWindows.sandboxArgs(accounts.folderPath(account))] }
    : account.provider === 'codex'
      ? codexCommand(model, folder, tools, accounts.folderPath(account))
      : claudeCommand(model, restriction, approvalsFolder);
  const invocation = cliPath.cliInvocation(command);
  if (!invocation) return { error: cliPath.cliMissing(command) };
  const startedAt = Date.now();
  const env = cliPath.invocationEnv(invocation, accounts.env(account));
  let r, c;
  if (asking) {
    // No run folder, nobody to ask: the request is denied, as a background run without Benchook would be.
    const ask = async (question) => approvalsFolder
      ? (await approvals.ask(approvalsFolder, question, { signal })).decision : 'deny';
    const a = await codexAppServer.run({ command: invocation.command, args: [...invocation.leadingArgs, ...arg],
      cwd: folder || undefined, env, model, task, ask, durationMs: duration * 1000, signal });
    // The provider's own words are the error; the server's log lines are not shown (they are its tracing).
    r = { code: 0, output: a.text, errorOutput: '' };
    c = { text: a.text, tokens: a.tokens, error: a.error, sessionIdFromFile: a.threadId };
  } else {
    r = await child.run({
      command: invocation.command, arg: [...invocation.leadingArgs, ...arg], cwd: folder || undefined,
      env, entry: task, durationMs: duration * 1000, signal,
      hold: approvalsFolder ? () => approvals.waiting(approvalsFolder) : undefined,
    });
    c = account.provider === 'codex' ? parseCodex(r.output || '') : parseClaude(r.output || '');
  }
  if (account.provider === 'codex' && !c.observedModels) c.observedModels = codexRunningModels(accounts.folderPath(account), c.sessionIdFromFile);
  const info = { account: account.name, accountId: account.id, provider: account.provider,
    model: model || null, seconds: Math.round((Date.now() - startedAt) / 1000), tokens: c.tokens,
    cost: c.cost ?? null,
    ...modelCheck(model, c.observedModels, account.provider) };
  /* Prefer provider error details, including retry information, and append the process exit code. A generic process failure must not hide the actionable provider message. */
  const error = r.error
    || (c.error ? c.error + (r.code !== 0 ? " (worker exit " + (r.signal || r.code) + ')' : '') : null)
    || (r.code !== 0 ? "Worker exited unsuccessfully (" + (r.signal || r.code) + ')' : null)
    || (!(r.output || '').trim() ? "Worker returned no result" : null);
  try { require('./quota-warning').save(process.env.BENCHOOK_DATA_DIR, account, c.error); }
  catch (e) { info.quotaRecordWarning = 'Usage warning could not be saved: ' + e.message; }
  if (error) return { ...info, error: error + (r.errorOutput?.trim() ? ': ' + r.errorOutput.trim().slice(0, 400) : ''),
    text: c.text, couldNotStop: r.couldNotStop || false };
  return { ...info, text: c.text, warning: r.errorOutput?.trim().slice(0, 200) || null };
}

// The restriction definition is SHARED (`agent-resolution`): the write path and the run path must use the same rule.
module.exports = { toolRestriction: resolution.toolRestriction, run, parseClaude, parseCodex, codexRunningModels, modelCheck };
