'use strict';
/* Model inheritance reads the environment established when the terminal starts. These tests do not cover later in-session model changes. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const resolution = require('../panel/agent-resolution');
const worker = require('../panel/worker');
const accounts = require('../panel/accounts');
const cli = require('../panel/cli-path');
const child = require('../panel/subprocess');

function field(t) {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'model-inherited-'));
  t.after(() => fs.rmSync(k, { recursive: true, force: true }));
  return k;
}

/* ---- THE TWO ENDS OF THE INHERITANCE ---- */

test("the panel writes the model into the environment when it opens a terminal", () => {
  assert.deepEqual(resolution.orchestratorEnv('opus'), { BENCHOOK_ORCHESTRATOR_MODEL: 'opus' });
  assert.deepEqual(resolution.orchestratorEnv('default'), { BENCHOOK_ORCHESTRATOR_MODEL: 'default' });
  assert.deepEqual(resolution.orchestratorEnv(null), { BENCHOOK_ORCHESTRATOR_MODEL: 'default' },
    'even with no model selected this is a KNOWN state: the CLI default');
});

test("the worker reads what it inherits from the environment", () => {
  assert.deepEqual(resolution.inheritedModel({ BENCHOOK_ORCHESTRATOR_MODEL: 'opus' }),
    { model: 'opus', unknown: false });
  assert.deepEqual(resolution.inheritedModel({ BENCHOOK_ORCHESTRATOR_MODEL: 'default' }),
    { model: null, unknown: false },
    'if the orchestrator itself runs on the default, a worker running with no model is the SAME model');
});

test("with no env it says UNKNOWN; it does not sell the default as \"the same model\"", () => {
  assert.deepEqual(resolution.inheritedModel({}), { model: null, unknown: true });
  assert.deepEqual(resolution.inheritedModel(null), { model: null, unknown: true });
  assert.deepEqual(resolution.inheritedModel({ BENCHOOK_ORCHESTRATOR_MODEL: '   ' }),
    { model: null, unknown: true }, 'an empty value is not information');
});

/* ---- THE INTERNAL MARKER DOES NOT GO TO THE CLI ---- */

function fakeAccount(t, root, provider) {
  t.mock.method(accounts, 'find', () => ({ id: 'test', name: 'test account', provider, folder: root }));
  t.mock.method(accounts, 'hasSignIn', () => true);
  t.mock.method(cli, 'cliInvocation', () => ({ command: process.execPath, leadingArgs: [] }));
  const elapsed = { arg: null };
  t.mock.method(child, 'run', async (request) => {
    elapsed.arg = request.arg;
    return { code: 0, output: JSON.stringify({ type: 'result', result: 'ok' }), error: null };
  });
  return elapsed;
}

test("the internal marker is NEVER sent to the CLI as a model name", async (t) => {
  const k = field(t);
  const elapsed = fakeAccount(t, k, 'codex');

  const r = await worker.run({ accountId: 'test', task: 'work', folder: k,
    model: resolution.ORCHESTRATOR });

  assert.ok(r.error, 'an unresolved marker must not slip silently to the CLI');
  assert.match(r.error, /orchestrator|orchestrator/i, 'the reason must be stated plainly');
  assert.equal(elapsed.arg, null, 'the process must never be started');
});

test("a resolved real model passes through normally", async (t) => {
  const k = field(t);
  const elapsed = fakeAccount(t, k, 'codex');

  // `codex exec` is the path of a LOCKED Codex agent; with no tools line it runs through the app-server
  // (25 September 2026, `codex-app-server.test.js`), so this exec test names the read-only lock.
  const r = await worker.run({ accountId: 'test', task: 'work', folder: k, model: 'gpt-5', tools: 'Read, Grep, Glob' });

  assert.ok(!r.error, r.error);
  assert.equal(elapsed.arg[elapsed.arg.indexOf('-m') + 1], 'gpt-5');
});

test("with no model there is no model flag in the command either", async (t) => {
  const k = field(t);
  const elapsed = fakeAccount(t, k, 'codex');

  // `codex exec` is the path of a LOCKED Codex agent; with no tools line it runs through the app-server
  // (25 September 2026, `codex-app-server.test.js`), so this exec test names the read-only lock.
  const r = await worker.run({ accountId: 'test', task: 'work', folder: k, model: null, tools: 'Read, Grep, Glob' });

  assert.ok(!r.error, r.error);
  assert.ok(!elapsed.arg.includes('-m'), 'a run with no model means the CLI default');
});

/* ---- THE REAL MCP PATH ---- */

function loadMcp(project, data, env, catchWorker) {
  const file = path.join(__dirname, '..', 'tools', 'mcp-server.js');
  const localRequire = createRequire(file);
  let handle;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    __dirname: path.dirname(file),
    process: { env: { BENCHOOK_PROJECT: project, ...env }, cwd: () => project },
    console,
    require(request) {
      const resolved = localRequire.resolve(request);
      if (resolved === path.join(__dirname, '..', 'panel', 'worker.js')) return { run: catchWorker };
      if (resolved === path.join(__dirname, '..', 'panel', 'data-path.js')) return { resolve: () => data };
      if (resolved === path.join(__dirname, '..', 'panel', 'mcp-transport.js')) {
        return { serve: (s) => { handle = s.handle; } };
      }
      return localRequire(request);
    },
  });
  return (request) => handle(request);
}

/** An agent bound to the orchestrator, and a session opened with the profile of a registered account. */
function mcpField(t) {
  const k = field(t);
  const project = path.join(k, 'project');
  const profile = path.join(k, 'profile');
  fs.mkdirSync(path.join(project, '.benchook', 'agents'), { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  const data = path.join(k, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'accounts.json'), JSON.stringify({
    accounts: [{ id: 'personal', name: 'Codex account', provider: 'codex', folder: profile }] }));
  fs.writeFileSync(path.join(project, '.benchook', 'agents', 'auditor.md'),
    ['---', 'name: auditor', 'description: Code incelenecekse', 'account: orchestrator',
      'model: orchestrator', '---', '', 'Read and report.', ''].join('\n'));
  return { project, data, profile };
}

test("the model of the orchestrator REACHES the worker; the marker does not", async (t) => {
  const { project, data, profile } = mcpField(t);
  let imported = null;
  const call = loadMcp(project, data,
    { CODEX_HOME: profile, BENCHOOK_ORCHESTRATOR_MODEL: 'gpt-5-codex' },
    async (request) => { imported = request; return { text: 'done', seconds: 0 }; });

  await call({ method: 'tools/call',
    params: { name: 'run_agent', arguments: { agent: 'auditor', task: 'Review this.' } } });

  assert.ok(imported, 'the worker was never called');
  assert.equal(imported.model, 'gpt-5-codex', 'the model of the parent terminal must be inherited');
  assert.notEqual(imported.model, resolution.ORCHESTRATOR);
});

test("when the model is unknown the result says so PLAINLY", async (t) => {
  const { project, data, profile } = mcpField(t);
  let imported = null;
  const call = loadMcp(project, data, { CODEX_HOME: profile },   // NO model information
    async (request) => { imported = request; return { text: 'done', seconds: 0 }; });

  const response = await call({ method: 'tools/call',
    params: { name: 'run_agent', arguments: { agent: 'auditor', task: 'Review this.' } } });

  assert.ok(imported, 'the work must still run: the account is known, the spending decision is not uncertain');
  assert.equal(imported.model, null, 'no invented model name may be sent');
  const text = JSON.stringify(response);
  assert.match(text, /model/i);
  assert.match(text, /could not|default/i,
    'if the same-model promise cannot be made, the screen must say so');
});

test("a relative working folder is resolved against the project; a missing one is refused by name", async (t) => {
  /* Seen 7 October 2026: an orchestrator passed `cwd: "src/"`. The worker started in src/ and Codex was then
     given the same relative path again (-C src/), so it looked for src/src and failed with "file not found". */
  const { project, data, profile } = mcpField(t);
  fs.mkdirSync(path.join(project, 'src'));
  let imported = null;
  const call = loadMcp(project, data, { CODEX_HOME: profile },
    async (request) => { imported = request; return { text: 'done', seconds: 0 }; });
  await call({ method: 'tools/call',
    params: { name: 'run_agent', arguments: { agent: 'auditor', task: 'Review this.', cwd: 'src/' } } });
  assert.ok(imported, 'the worker was never called');
  assert.equal(imported.folder, path.join(project, 'src'), 'the worker gets the full path, not the relative one');
  imported = null;
  const missing = await call({ method: 'tools/call',
    params: { name: 'run_agent', arguments: { agent: 'auditor', task: 'Review this.', cwd: 'nope' } } });
  assert.equal(imported, null, 'nothing runs in a folder that does not exist');
  assert.match(JSON.stringify(missing), /working folder does not exist/);
});
