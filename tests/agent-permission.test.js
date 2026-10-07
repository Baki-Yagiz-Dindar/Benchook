'use strict';
/* WHAT AN AGENT MAY DO IS THE USER'S CHOICE, AND IT IS WHAT REALLY HAPPENS .
   Measured before this change, with the files on disk as the result: a panel agent on Claude could only
   read (no permission was passed, and nobody is there to approve in the background); a panel agent on
   Codex could not even read (every command was rejected "blocked by policy", because the account's own
   Codex folder has no Windows sandbox setting). Yet every agent file said `tools: Read, Grep, Glob, Bash`.

   Three levels, each a fixed tool list, so the file line states exactly what is enforced:
     read  - read and search
     edit  - read, create and edit files in the project folder; no commands on Claude
     full  - everything above plus commands
   On Codex the level becomes the sandbox: read-only, or workspace-write (network only with full).
   Legacy default tool lists remain read-only. Missing tools metadata selects the provider's
   default permissions and approval flow. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const resolution = require('../panel/agent-resolution');
const codexWindows = require('../panel/codex-windows');
const worker = require('../panel/worker');
const accounts = require('../panel/accounts');
const cli = require('../panel/cli-path');
const child = require('../panel/subprocess');
const fixture = path.join(__dirname, 'fixtures/worker-process.cjs');

test('each level is a fixed tool list, and a list names its level', () => {
  assert.equal(resolution.toolsForPermission('read'), 'Read, Grep, Glob');
  assert.equal(resolution.toolsForPermission('edit'), 'Read, Grep, Glob, Edit, Write');
  assert.equal(resolution.toolsForPermission('full'), 'Read, Grep, Glob, Edit, Write, Bash');
  for (const level of ['read', 'edit', 'full']) {
    assert.equal(resolution.permissionOf(resolution.toolsForPermission(level)), level);
  }
  assert.equal(resolution.permissionOf('write, edit, glob, grep, read'), 'edit', 'order and case do not matter');
});

/* Missing tools metadata selects the default permission level and provider approval flow. Preserve the effective read-only permissions of legacy tool lists. */
test('an old agent is read-only: the former default line the panel wrote by itself', () => {
  for (const tools of ['Read, Grep, Glob, Bash', 'bash, glob, grep, read']) {
    assert.equal(resolution.permissionOf(tools), 'read', JSON.stringify(tools));
    assert.deepEqual(resolution.toolRestriction(tools), ['Read', 'Grep', 'Glob'], JSON.stringify(tools));
  }
});

test('no tools line is the default level: no restriction, the account\'s own permission settings', () => {
  for (const tools of [null, undefined, '', '  ']) {
    assert.equal(resolution.permissionOf(tools), 'default', JSON.stringify(tools));
    assert.equal(resolution.toolRestriction(tools), null, JSON.stringify(tools));
    assert.equal(resolution.codexSandbox(tools), null, 'Codex keeps its own sandbox and approval settings');
  }
  assert.equal(resolution.toolsForPermission('default'), '', 'the default level writes no tools line');
  assert.deepEqual(resolution.PERMISSION_LEVELS, ['default', 'read', 'edit', 'full'], 'the order the form offers');
});

test('only the former default line counts as a line the panel filled in by itself', () => {
  assert.equal(resolution.formerDefaultTools('Read, Grep, Glob, Bash'), true);
  for (const tools of [null, '', 'Read', 'Read, Grep, Glob']) assert.equal(resolution.formerDefaultTools(tools), false, JSON.stringify(tools));
});

test('a hand-written list is kept as it is and called custom', () => {
  assert.equal(resolution.permissionOf('Read'), 'custom');
  assert.deepEqual(resolution.toolRestriction('Read, WebFetch'), ['Read', 'WebFetch']);
});

test('on Codex the level becomes the sandbox, never wider than the list allows', () => {
  const sandbox = (tools) => resolution.codexSandbox(tools);
  assert.deepEqual(sandbox('Read, Grep, Glob'), { mode: 'read-only', network: false });
  assert.deepEqual(sandbox('Read, Grep, Glob, Edit, Write'), { mode: 'workspace-write', network: false });
  assert.deepEqual(sandbox('Read, Grep, Glob, Edit, Write, Bash'), { mode: 'workspace-write', network: true });
  assert.deepEqual(sandbox('Read, Grep, Glob, Bash'), { mode: 'read-only', network: false }, 'the old line: read-only');
  assert.deepEqual(sandbox('Read, Bash'), { mode: 'read-only', network: false }, 'commands without writing stay read-only');
  assert.deepEqual(sandbox('Read, Write'), { mode: 'workspace-write', network: false });
});

test('the Windows sandbox setting is added only when the account folder has none', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-windows-'));
  assert.deepEqual(codexWindows.sandboxArgs(folder, 'win32'), ['-c', 'windows.sandbox="elevated"'], 'no config file');
  fs.writeFileSync(path.join(folder, 'config.toml'), '[mcp_servers.benchook]\ncommand = "node"\n');
  assert.deepEqual(codexWindows.sandboxArgs(folder, 'win32'), ['-c', 'windows.sandbox="elevated"'], 'config without it');
  fs.writeFileSync(path.join(folder, 'config.toml'), 'model = "x"\n\n[windows]\nsandbox = "unelevated"\n');
  assert.deepEqual(codexWindows.sandboxArgs(folder, 'win32'), [], "the account's own choice is kept");
  assert.deepEqual(codexWindows.sandboxArgs(folder, 'linux'), [], 'only Windows needs it');
});

function fakeAccount(t, root, provider) {
  t.mock.method(accounts, 'find', () => ({ id: 'test', name: 'test account', provider, folder: root }));
  t.mock.method(accounts, 'hasSignIn', () => true);
  t.mock.method(cli, 'cliInvocation', () => ({ command: process.execPath, leadingArgs: [fixture] }));
  const seen = { arg: null };
  t.mock.method(child, 'run', async (request) => {
    seen.arg = request.arg;
    return { code: 0, output: JSON.stringify({ type: 'result', result: 'ok' }), error: null };
  });
  return seen;
}
const after = (arg, flag) => { const i = arg.indexOf(flag); return i >= 0 ? arg[i + 1] : null; };

test('a Claude run gets exactly the tools of its level', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-claude-'));
  const seen = fakeAccount(t, root, 'claude');
  /* Scope edit-level Write and Edit tool patterns to the project directory. */
  for (const [level, list, allowed] of [['read', 'Read,Grep,Glob', 'Read,Grep,Glob'],
    ['edit', 'Read,Grep,Glob,Edit,Write', 'Read,Grep,Glob,Edit(./**),Write(./**)'],
    ['full', 'Read,Grep,Glob,Edit,Write,Bash', 'Read,Grep,Glob,Edit(./**),Write(./**),Bash']]) {
    const r = await worker.run({ accountId: 'test', task: 'work', folder: root, tools: resolution.toolsForPermission(level) });
    assert.ok(!r.error, r.error);
    assert.equal(after(seen.arg, '--tools'), list, level);
    assert.equal(after(seen.arg, '--allowedTools'), allowed, level);
  }
});

test('a Codex run gets the sandbox of its level and the Windows setting; it is never refused for its list', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-codex-'));
  const seen = fakeAccount(t, root, 'codex');
  const cases = [['read', 'read-only', false], ['edit', 'workspace-write', false], ['full', 'workspace-write', true],
    ['custom Read', 'read-only', false]];
  for (const [level, mode, network] of cases) {
    const tools = level.startsWith('custom') ? 'Read' : resolution.toolsForPermission(level);
    const r = await worker.run({ accountId: 'test', task: 'work', folder: root, tools });
    assert.ok(!r.error, level + ': ' + r.error);
    assert.equal(after(seen.arg, '--sandbox'), mode, level);
    const configs = seen.arg.filter((x, i) => seen.arg[i - 1] === '-c');
    assert.equal(configs.includes('sandbox_workspace_write.network_access=true'), network, level + ' network');
    if (process.platform === 'win32') assert.ok(configs.includes('windows.sandbox="elevated"'), level + ': Windows sandbox setting');
    assert.ok(!seen.arg.includes('--dangerously-bypass-approvals-and-sandbox'), 'the sandbox is never turned off');
  }
});

/* THE DEFAULT LEVEL RUNS LIKE NORMAL USE AND ASKS ON THE LIVE RUN CARD . Claude gets no tool
   list; its permission prompts go to Benchook's approval server. Codex runs through `codex app-server` with the
   account's own settings, and its approval requests are asked the same way. */
test('a Claude agent on the default level gets no tool list and asks through the approval server', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-default-claude-'));
  const seen = fakeAccount(t, root, 'claude');
  let hold = null;
  t.mock.method(child, 'run', async (request) => { seen.arg = request.arg; hold = request.hold;
    return { code: 0, output: JSON.stringify({ type: 'result', result: 'ok' }), error: null }; });
  const folder = path.join(root, 'run-1.approvals');
  const r = await worker.run({ accountId: 'test', task: 'work', folder: root, tools: null, approvals: folder });
  assert.ok(!r.error, r.error);
  for (const flag of ['--tools', '--allowedTools', '--disallowedTools']) assert.ok(!seen.arg.includes(flag), flag);
  assert.equal(after(seen.arg, '--permission-prompt-tool'), 'mcp__benchook_approval__ask');
  const config = JSON.parse(after(seen.arg, '--mcp-config'));
  const server = config.mcpServers.benchook_approval;
  assert.equal(path.basename(server.args[server.args.length - 1]), 'approval-server.js');
  assert.equal(server.env.BENCHOOK_APPROVALS, folder);
  assert.equal(typeof hold, 'function', 'the time limit knows when the agent waits for the user');
  assert.equal(hold(), false);
});

test('a Codex agent on the default level runs through the app-server and asks through the run folder', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-default-codex-'));
  fakeAccount(t, root, 'codex');
  const appServer = require('../panel/codex-app-server');
  const approvals = require('../panel/approvals');
  let seen = null;
  t.mock.method(appServer, 'run', async (o) => {
    seen = o;
    const answer = o.ask({ kind: 'command', title: 'Run a command', detail: 'npm test' });
    await new Promise((r) => setTimeout(r, 50));
    approvals.answer(folder, approvals.pending(folder)[0].id, 'allow');
    return { text: 'done after ' + (await answer), tokens: null, threadId: null, error: null, errorOutput: '' };
  });
  const folder = path.join(root, 'run-2.approvals');
  const r = await worker.run({ accountId: 'test', task: 'the task', folder: root, model: 'gpt-x', tools: '', approvals: folder });
  assert.ok(!r.error, r.error);
  assert.equal(r.text, 'done after allow');
  assert.ok(seen.args.includes('app-server') && !seen.args.includes('exec'));
  if (process.platform === 'win32') assert.ok(seen.args.includes('windows.sandbox="elevated"'));
  assert.ok(!seen.args.includes('--sandbox'), 'the account\'s own sandbox');
  assert.equal(seen.model, 'gpt-x');
  assert.equal(seen.task, 'the task');
  assert.equal(seen.cwd, root);
});

/* THE FORM SENDS A LEVEL, THE FILE GETS ITS LIST. A hand-written list ("custom") is kept as it was. */
test('saving a level writes that level\'s tool line; custom keeps the list', () => {
  const writer = require('../panel/agent-writer');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-write-'));
  const field = { name: 'auditor', description: 'd', task: 't', account: 'codex-default', provider: 'codex', model: 'm' };
  for (const level of ['read', 'edit', 'full']) {
    const r = writer.preview(dir, { ...field, permission: level });
    assert.match(r.content, new RegExp('^tools: ' + resolution.toolsForPermission(level) + '$', 'm'), level);
  }
  assert.match(writer.preview(dir, { ...field, permission: 'custom', tools: 'Read, WebFetch' }).content, /^tools: Read, WebFetch$/m);
});

/* THE DEFAULT LEVEL WRITES NO TOOLS LINE, and a file without one keeps having none . */
test('saving the default level writes no tools line', () => {
  const writer = require('../panel/agent-writer');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-default-'));
  const field = { name: 'helper', description: 'd', task: 't', account: 'codex-default', provider: 'codex', model: 'm' };
  const r = writer.preview(dir, { ...field, permission: 'default' });
  assert.ok(!r.error, r.error);
  assert.doesNotMatch(r.content, /^tools:/m);
  assert.match(writer.preview(dir, field).content, /^tools: Read, Grep, Glob, Bash$/m,
    'a caller that states nothing still gets the former line, which the sync never lets loosen a narrow agent');
});

function registryField(t) {
  const registry = require('../panel/agent-registry');
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-registry-'));
  registry.setup(path.join(k, 'agents.json'));
  t.after(() => fs.rmSync(k, { recursive: true, force: true }));
  const project = path.join(k, 'project');
  fs.mkdirSync(path.join(project, '.benchook', 'agents'), { recursive: true });
  return { registry, project };
}

test('a file without a tools line is read, stored and written back without one', (t) => {
  const { registry } = registryField(t);
  const read = registry.fromFile('---\nname: helper\ndescription: d\n---\n\nDo the job.\n');
  assert.equal(read.tools, '', 'nothing is filled in');
  const added = registry.add({ ...read, projects: [] });
  assert.ok(!added.error, added.error);
  assert.equal(registry.find('helper').tools, '');
  assert.doesNotMatch(registry.text(registry.find('helper')), /^tools:/m);
  assert.match(registry.text({ ...registry.find('helper'), tools: 'Read' }), /^tools: Read$/m);
});

/* Definitions created outside the panel retain their declared permission level when imported. */
test('an agent written from a terminal shows the level its file states', (t) => {
  const sync = require('../panel/agent-sync');
  const writer = require('../panel/agent-writer');
  const { registry, project } = registryField(t);
  const folder = path.join(project, '.benchook', 'agents');
  fs.writeFileSync(path.join(folder, 'free.md'), '---\nname: free\ndescription: d\n---\n\nDo the job.\n');
  fs.writeFileSync(path.join(folder, 'reader.md'), '---\nname: reader\ndescription: d\ntools: Read, Grep, Glob\n---\n\nRead.\n');
  fs.writeFileSync(path.join(folder, 'mixed.md'), '---\nname: mixed\ndescription: d\ntools: Read, WebFetch\n---\n\nFetch.\n');
  sync.reconcile(project);
  const level = (name) => resolution.permissionOf(registry.find(name).tools);
  assert.equal(level('free'), 'default');
  assert.equal(level('reader'), 'read');
  assert.equal(level('mixed'), 'custom');
  assert.doesNotMatch(fs.readFileSync(path.join(folder, 'free.md'), 'utf8'), /^tools:/m, 'the file is not given a line it did not have');
  const card = writer.existing(project).find((x) => x.name === 'free');
  assert.equal(resolution.permissionOf(card.tools), 'default', 'the card reads the same level');
});

test('choosing the default level on a narrow agent is applied, the former line is not', (t) => {
  const sync = require('../panel/agent-sync');
  const writer = require('../panel/agent-writer');
  const { registry, project } = registryField(t);
  registry.add({ name: 'auditor', description: 'd', account: 'orchestrator', model: 'orchestrator', tools: 'Read',
    task: 'Read.', projects: [project] });
  sync.publishAgent(registry.find('auditor'));
  const oldPath = path.join(project, '.benchook', 'agents', 'auditor.md');
  const base = { name: 'auditor', description: 'd', account: 'orchestrator', model: 'orchestrator', task: 'Read.', oldPath };
  const unstated = writer.preview(project, base);
  assert.ok(!sync.saveForm({ project, oldName: 'auditor', name: 'auditor', intent: 'edit', content: unstated.content }).error);
  assert.equal(registry.find('auditor').tools, 'Read', 'the former line never loosens a narrow agent');
  const chosen = writer.preview(project, { ...base, permission: 'default' });
  assert.ok(!sync.saveForm({ project, oldName: 'auditor', name: 'auditor', intent: 'edit', content: chosen.content }).error);
  assert.equal(registry.find('auditor').tools, '', 'the default level is a real choice');
  assert.doesNotMatch(fs.readFileSync(oldPath, 'utf8'), /^tools:/m);
});

/* THE PAGE IS TOLD THE LEVEL, not a tool list it would have to interpret itself. */
test('the agent lists sent to the page carry the level', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'panel', 'main.js'), 'utf8');
  assert.equal((main.match(/permission: agentResolution\.permissionOf\(/g) || []).length, 2,
    'both the project list and the registry list carry it');
});

test('an account that names its Windows sandbox in any TOML form keeps its own choice', () => {
  const { namesWindowsSandbox } = require('../panel/codex-windows');
  assert.equal(namesWindowsSandbox('[windows]\nsandbox = "unelevated"\n'), true);
  assert.equal(namesWindowsSandbox('windows.sandbox = "unelevated"\n'), true);
  assert.equal(namesWindowsSandbox('windows = { sandbox = "unelevated" }\n'), true, 'inline table');
  assert.equal(namesWindowsSandbox('[windows]\n"sandbox" = "unelevated"\n'), true, 'quoted key');
  assert.equal(namesWindowsSandbox('model = "x"\n[windows]\nother = 1\n'), false);
  assert.equal(namesWindowsSandbox('[windows\nsandbox = "x"'), false, 'a broken file falls back to the line scan');
});
