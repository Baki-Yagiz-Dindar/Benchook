'use strict';
// PRESERVING THE TOOL RESTRICTION ON EDIT AND ON RUN.
// 
// Legacy default tool lists retain their read-only interpretation; default permission inheritance uses no tools field.
// "no restriction" - it is read-only, which is what such an agent could really do; and a Codex agent with
// a list is no longer refused - the list becomes Codex's sandbox (`agent-permission.test.js`). The
// editing half below is unchanged: an unstated line never loosens a narrow one.
// 
// THE DEFECT, IN TWO HALVES:
// 
// 1. EDITING: the form never sends the tools field, and the write layer puts the default
// `Read, Grep, Glob, Bash` into a missing field. The result: changing ONLY the description of an
// agent given nothing but `Read` and saving WIDENS its tool restriction - taking a security
// decision of the user on their behalf and without telling them.
// 
// 2. RUNNING: the `tools:` line of the definition was never read on the own worker path of the panel.
// `panel/worker.js` built the command as `claude --print --output-format json [--model X]`; the tool
// restriction went nowhere. So the restriction written in the file WAS NOT ENFORCED when the panel
// ran that agent. A restriction that is written but not enforced is worse than none: the user
// believes they are protected.
// 
// THE PROVIDER DIFFERENCE WAS VERIFIED LOCALLY (NO paid call):
// claude --help     -> "--allowedTools, --allowed-tools <tools...>  Comma or space-separated
// list of tool names to allow"
// codex exec --help -> NO tool permission list; only `--sandbox` (a file and network policy).
// So on the Claude side the restriction is enforced, and on the Codex side the run is NOT STARTED, with
// the reason stated. No real provider run was made; that the flag really limits the model WAS NOT
// MEASURED, only that it reaches the command in the right form.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../panel/agent-registry');
const sync = require('../panel/agent-sync');
const writeAgent = require('../panel/agent-writer');
const worker = require('../panel/worker');
const accounts = require('../panel/accounts');
const cli = require('../panel/cli-path');
const child = require('../panel/subprocess');
const fixture = path.join(__dirname, 'fixtures/worker-process.cjs');

function field() {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-restriction-'));
  registry.setup(path.join(k, 'agents.json'));
  const project = (name) => {
    const y = path.join(k, name);
    fs.mkdirSync(path.join(y, '.benchook', 'agents'), { recursive: true });
    return y;
  };
  return { k, project, cleanup: () => fs.rmSync(k, { recursive: true, force: true }) };
}
const filePath = (p, name = 'auditor') => path.join(p, '.benchook', 'agents', name + '.md');
const read = (y) => fs.readFileSync(y, 'utf8');

/** An agent given read access only, in project A. */
function narrowAgent(t) {
  const a = field(); t.after(a.cleanup);
  const A = a.project('project-A');
  registry.add({ name: 'auditor', description: 'Code incelenecekse', account: 'personal', model: 'opus',
    tools: 'Read', task: 'Read and report.', projects: [A] });
  sync.publishAgent(registry.find('auditor'));
  return { a, A };
}

/* ---- EDITING DOES NOT WIDEN THE RESTRICTION ---- */

test("the card carries the stored tool restriction", (t) => {
  const { A } = narrowAgent(t);

  const card = writeAgent.existing(A).find((x) => x.name === 'auditor');

  assert.equal(card.tools, 'Read',
    'if the card does not carry the restriction the form cannot send it and a save widens it');
});

test("the preview carries the restriction and writes the default for a new agent that has none", (t) => {
  const { A } = narrowAgent(t);

  const restricted = writeAgent.preview(A, { name: 'auditor', description: 'Code incelenecekse',
    account: 'orchestrator', model: 'orchestrator', task: 'Read and report.', tools: 'Read',
    oldPath: filePath(A) });
  const created = writeAgent.preview(A, { name: 'created-agent', description: 'A new job', account: 'orchestrator',
    model: 'orchestrator', task: 'Task.' });

  assert.match(restricted.content, /^tools: Read$/m);
  assert.match(created.content, /^tools: Read, Grep, Glob, Bash$/m,
    'the default list is right for a new agent with no restriction chosen');
});

test("changing only the description does NOT widen the tool restriction", (t) => {
  const { A } = narrowAgent(t);
  const card = writeAgent.existing(A).find((x) => x.name === 'auditor');
  const on = writeAgent.preview(A, { name: 'auditor', description: 'A new description', account: 'orchestrator',
    model: 'orchestrator', task: 'Read and report.', tools: card.tools, oldPath: filePath(A) });

  const r = sync.saveForm({ project: A, oldName: 'auditor', name: 'auditor',
    intent: 'edit', content: on.content });

  assert.ok(!r.error, r.error);
  assert.equal(registry.find('auditor').tools, 'Read', 'the restriction must stand in the central record');
  assert.match(read(filePath(A)), /^tools: Read$/m, 'it must stand in the file too');
});

/* ---- WHAT A RESTRICTION IS, AND WHAT IT IS NOT ---- */

/* Default permissions inherit account settings and use the approval flow. The legacy fixed tool list remains read-only. */
test("the former default list is read-only; no line is the default level, never silently unrestricted", () => {
  for (const tools of ['Read, Grep, Glob, Bash', 'bash, glob, grep, read']) {
    assert.deepEqual(worker.toolRestriction(tools), ['Read', 'Grep', 'Glob'], JSON.stringify(tools));
  }
  for (const tools of [null, '', '   ']) assert.equal(worker.toolRestriction(tools), null, JSON.stringify(tools));
});

test("any different list is an explicit choice", () => {
  assert.deepEqual(worker.toolRestriction('Read'), ['Read']);
  assert.deepEqual(worker.toolRestriction('Read, Grep'), ['Read', 'Grep']);
  assert.deepEqual(worker.toolRestriction('Read, Grep, Glob, Bash, WebFetch'),
    ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch'], 'widening is a choice as well');
});

/* ---- ON RUN IT IS ENFORCED OR SAID ---- */

function fakeAccount(t, root, provider) {
  t.mock.method(accounts, 'find', () => ({ id: 'test', name: 'test account', provider, folder: root }));
  t.mock.method(accounts, 'hasSignIn', () => true);
  t.mock.method(cli, 'cliInvocation', () => ({ command: process.execPath, leadingArgs: [fixture] }));
  const env = accounts.env;
  t.mock.method(accounts, 'env', (h) => ({ ...env(h), BENCHOOK_TEST_MODE: 'success' }));
  /* THE COMMAND LINE IS CAPTURED HERE: no real provider call is MADE. What is measured is whether the
     restriction reaches the command in the right form -- not that the model is really limited. */
  const elapsed = { arg: null };
  t.mock.method(child, 'run', async (request) => {
    elapsed.arg = request.arg;
    return { code: 0, output: JSON.stringify({ type: 'result', result: 'ok' }), error: null };
  });
  return elapsed;
}

test("on a Claude run the restriction really reaches the command", async (t) => {
  const a = field(); t.after(a.cleanup);
  const elapsed = fakeAccount(t, a.k, 'claude');

  const r = await worker.run({ accountId: 'test', task: 'work', folder: a.k,
    tools: 'Read, Grep' });

  assert.ok(!r.error, r.error);
  const arg = elapsed.arg;
  const i = arg.indexOf('--allowedTools');
  assert.ok(i >= 0, 'the restriction is absent from the command: ' + arg.join(' '));
  assert.equal(arg[i + 1], 'Read,Grep', 'the list must be passed in the form the CLI expects');
  assert.equal(arg[arg.indexOf('--tools') + 1], 'Read,Grep', 'the set of available tools must be limited too');
  assert.equal(arg[arg.indexOf('--disallowedTools') + 1], 'mcp__*', 'MCP tools from the profile must not bypass the restriction');
});

test("an unsupported tool pattern starts neither an unrestricted nor a widened run", async (t) => {
  const a = field(); t.after(a.cleanup);
  const elapsed = fakeAccount(t, a.k, 'claude');
  for (const tools of ['Bash(git log *)', 'Read(path)', 'mcp__server__tool', 'default', '*']) {
    const r = await worker.run({ accountId: 'test', task: 'work', folder: a.k, tools });
    assert.match(r.error, /Nothing was started/, tools);
    assert.equal(elapsed.arg, null, 'the provider must never be started');
  }
});

test("the former default line runs read-only on Claude", async (t) => {
  const a = field(); t.after(a.cleanup);
  const elapsed = fakeAccount(t, a.k, 'claude');

  const r = await worker.run({ accountId: 'test', task: 'work', folder: a.k,
    tools: 'Read, Grep, Glob, Bash' });

  assert.ok(!r.error, r.error);
  assert.equal(elapsed.arg[elapsed.arg.indexOf('--allowedTools') + 1], 'Read,Grep,Glob',
    'an old agent gets exactly the read-only tools, not Bash');
});

test("a narrow Codex agent runs inside a read-only sandbox, never unrestricted", async (t) => {
  const a = field(); t.after(a.cleanup);
  const elapsed = fakeAccount(t, a.k, 'codex');

  const r = await worker.run({ accountId: 'test', task: 'work', folder: a.k,
    tools: 'Read' });

  assert.ok(!r.error, r.error);
  assert.equal(elapsed.arg[elapsed.arg.indexOf('--sandbox') + 1], 'read-only',
    'a list without editing must not let Codex write');
  assert.ok(!elapsed.arg.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test("a Codex agent with the former default line runs (read-only)", async (t) => {
  const a = field(); t.after(a.cleanup);
  fakeAccount(t, a.k, 'codex');

  const r = await worker.run({ accountId: 'test', task: 'work', folder: a.k,
    tools: 'Read, Grep, Glob, Bash' });

  assert.ok(!r.error, r.error);
});

test("a save that does NOT send the tools field does not loosen the restriction either", (t) => {
  const { A } = narrowAgent(t);

  /* The old contract of the page: the tools field is never sent and the write layer puts in the default
     list. The default list sitting in the incoming text is NOT a decision to remove the restriction; the
     panel writes that line itself when the field is not supplied. */
  const on = writeAgent.preview(A, { name: 'auditor', description: 'A new description', account: 'orchestrator',
    model: 'orchestrator', task: 'Read and report.', oldPath: filePath(A) });
  /* Since 6 October 2026 the preview shows the text the save writes (`agent-sync.formFields`): the kept
     restriction is visible before approval instead of the default line the save would replace. */
  assert.match(on.content, /^tools: Read$/m, 'the preview shows the restriction that will be kept');

  const r = sync.saveForm({ project: A, oldName: 'auditor', name: 'auditor',
    intent: 'edit', content: on.content });

  assert.ok(!r.error, r.error);
  assert.equal(registry.find('auditor').tools, 'Read', 'the restriction must not loosen by itself');
  assert.match(read(filePath(A)), /^tools: Read$/m);
  assert.equal(read(filePath(A)), on.content, 'the approved preview is exactly the file written');
});

test("genuinely CHANGING the restriction stays possible", (t) => {
  const { A } = narrowAgent(t);
  const on = writeAgent.preview(A, { name: 'auditor', description: 'Code incelenecekse', account: 'orchestrator',
    model: 'orchestrator', task: 'Read and report.', tools: 'Read, Grep', oldPath: filePath(A) });

  const r = sync.saveForm({ project: A, oldName: 'auditor', name: 'auditor',
    intent: 'edit', content: on.content });

  assert.ok(!r.error, r.error);
  assert.equal(registry.find('auditor').tools, 'Read, Grep',
    'a different list given explicitly must be applied; the protection is not a lock');
});

/* ---- THE MCP BOUNDARY: the restriction travels all the way to the worker ----
   The real `tools/mcp-server.js` is loaded; only the worker call is captured. No provider is reached,
   no paid call. What is measured: whether the restriction in the definition reaches the run request. */

const vm = require('node:vm');
const { createRequire } = require('node:module');

function loadMcp(t, project, data, catchWorker) {
  const file = path.join(__dirname, '..', 'tools', 'mcp-server.js');
  const localRequire = createRequire(file);
  let handle;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    __dirname: path.dirname(file),
    process: { env: { BENCHOOK_DATA_DIR: data, BENCHOOK_PROJECT: project }, cwd: () => project },
    console,
    require(request) {
      const resolved = localRequire.resolve(request);
      if (resolved === path.join(__dirname, '..', 'panel', 'worker.js')) {
        return { run: catchWorker };
      }
      if (resolved === path.join(__dirname, '..', 'panel', 'data-path.js')) {
        return { resolve: () => data };   // the real user folder is never used
      }
      if (resolved === path.join(__dirname, '..', 'panel', 'mcp-transport.js')) {
        return { serve: (s) => { handle = s.handle; } };
      }
      return localRequire(request);
    },
  });
  return (request) => handle(request);
}

test("the restriction of an agent run through MCP REACHES the worker", async (t) => {
  const a = field(); t.after(a.cleanup);
  const A = a.project('project-A');
  const data = path.join(a.k, 'data');
  fs.mkdirSync(path.join(data, 'Benchook'), { recursive: true });
  const accountFile = JSON.stringify({
    accounts: [{ id: 'personal', name: 'Claude', provider: 'claude', folder: null }] });
  fs.writeFileSync(path.join(data, 'Benchook', 'accounts.json'), accountFile);
  fs.writeFileSync(path.join(data, 'accounts.json'), accountFile);
  fs.writeFileSync(filePath(A), ['---', 'name: auditor', 'description: Code incelenecekse',
    'account: personal', 'model: opus', 'tools: Read', '---', '', 'Read and report.', ''].join('\n'));

  let imported = null;
  const call = loadMcp(t, A, data, async (request) => {
    imported = request;
    return { text: 'done', account: 'Claude', model: 'opus', seconds: 0 };
  });
  await call({ method: 'tools/call',
    params: { name: 'run_agent', arguments: { agent: 'auditor', task: 'Review this file.' } } });

  assert.ok(imported, 'the worker was never called');
  assert.equal(imported.tools, 'Read',
    'if the restriction in the definition does not reach the run request, the stored restriction is never enforced on this path');
  /* THE RUN'S QUESTIONS SIT BESIDE ITS LEDGER RECORD : the panel finds them through the record. */
  const workerRecords = require('../panel/worker-records');
  const record = workerRecords.list(data, A)[0];
  assert.equal(imported.approvals, workerRecords.approvalsFolder(data, A, record.id));
});
