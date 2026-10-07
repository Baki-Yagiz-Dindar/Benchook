'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tool = path.join(__dirname, '..', 'tools', 'mcp-server.js');

/* THE REGISTRY MUST BELONG TO THE TEST. These tests once read the REAL registry of the panel on the
   machine; when the user deleted an account the test turned red although nothing it tested had
   broken. Every test now sets up its own registry. */
function setupRegistry(accounts) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-registry-'));
  fs.mkdirSync(path.join(data, 'Benchook'), { recursive: true });
  fs.writeFileSync(path.join(data, 'Benchook', 'accounts.json'),
    JSON.stringify({ accounts }, null, 2));
  return data;
}

const DEFAULT_REGISTRY = [
  { id: 'claude-default', name: 'Claude', provider: 'claude', folder: null },
  { id: 'codex-default', name: 'Codex', provider: 'codex', folder: null },
];

function call(project, data, request, field, extraEnv={}) {
  return new Promise((resolution, red) => {
    const p = spawn(process.execPath, [tool], {
      env: { ...process.env, BENCHOOK_DATA_DIR:'', BENCHOOK_PROJECT: project, APPDATA: data, ...extraEnv }, windowsHide: true,
    });
    let output = '', error = '';
    p.stdout.on('data', (x) => { output += x; });
    p.stderr.on('data', (x) => { error += x; });
    p.on('error', red);
    p.on('close', (code) => {
      if (code !== 0) return red(new Error(error || 'MCP exited with ' + code));
      const response = output.trim().split(/\r?\n/).map(JSON.parse).find((x) => x.id === 1);
      resolution(field(response.result));
    });
    p.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, ...request }) + '\n');
  });
}

const requestList = (project, data) => call(project, data,
  { method: 'tools/call', params: { name: 'list_agents', arguments: {} } },
  (r) => r.content[0].text);

const requestIntro = (project, data) => call(project, data,
  { method: 'initialize', params: { protocolVersion: '2025-06-18' } },
  (r) => r.instructions);

const writeAgent = (project, name, lines) => {
  const k = path.join(project, '.benchook', 'agents');
  fs.mkdirSync(k, { recursive: true });
  fs.writeFileSync(path.join(k, name + '.md'), ['---', ...lines, '---', '', 'work', ''].join('\n'));
};
test('MCP uses explicit panel data directory instead of stale legacy accounts',async t=>{
  const root=setupRegistry([]),project=path.join(root,'project'),custom=path.join(root,'custom');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(custom);
  fs.writeFileSync(path.join(custom,'accounts.json'),JSON.stringify({accounts:[{id:'current-account',name:'Current',provider:'claude',folder:null}]}));
  writeAgent(project,'current-agent',['name: current-agent','account: current-account','model: haiku']);
  const result=await call(project,root,{method:'tools/call',params:{name:'list_agents',arguments:{}}},r=>r.content[0].text,{BENCHOOK_DATA_DIR:custom});
  assert.match(result,/current-account/);assert.doesNotMatch(result,/not registered/);
});

test('MCP lists the panel definition with its assigned account and does not read the built-in role folder', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-mcp-'));
  const data = setupRegistry(DEFAULT_REGISTRY);
  t.after(() => { fs.rmSync(project, { recursive: true, force: true });
                  fs.rmSync(data, { recursive: true, force: true }); });

  writeAgent(project, 'test', ['schema: panel-agent/v1', 'name: test',
    'description: Tek seferlik test', 'model: haiku', 'account: claude-default',
    'provider: claude']);

  // The built-in review roles live under `.claude/agents/` and are not visible through this door.
  const builtin = path.join(project, '.claude', 'agents');
  fs.mkdirSync(builtin, { recursive: true });
  fs.writeFileSync(path.join(builtin, 'challenger.md'),
    ['---', 'name: challenger', 'description: A built-in role', 'model: sonnet', '---', '', 'role', ''].join('\n'));

  const result = await requestList(project, data);
  assert.match(result, /test/);
  assert.match(result, /Provider: claude/);
  assert.doesNotMatch(result, /challenger/);
});

/* THE BEHAVIOUR THAT REPLACED THE SCHEMA FILTER.
   The measured defect: a definition without the `schema: panel-agent/v1` line was SILENTLY skipped at
   the reading sites; the panel drew its card while the orchestrator said no such agent existed.
   The rule changed: every `.md` in the folder is an agent, and what is missing binds to the
   orchestrator. This test checks both directions - the agent is VISIBLE, and how it will run is written CORRECTLY. */
test('a definition with no schema is an agent too; with no account it binds to the orchestrator', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-schemaless-'));
  const data = setupRegistry(DEFAULT_REGISTRY);
  t.after(() => { fs.rmSync(project, { recursive: true, force: true });
                  fs.rmSync(data, { recursive: true, force: true }); });

  writeAgent(project, 'historian', ['name: historian', 'description: Reads the history', 'model: sonnet']);

  const result = await requestList(project, data);
  assert.match(result, /historian/);
  assert.match(result, /Account: Same as orchestrator/);
  // NO REASON IS WRITTEN: for an agent with no account at all there is no event to describe; if it
  // falls back to the orchestrator anyway there is nothing to explain. A reason appears only when
  // SOMETHING HAPPENED (the account was deleted).
  assert.doesNotMatch(result, /NOT:/);
});

/* ONLY THE IDENTITY IS RECOGNISED NOW: the concept of an account name was removed from the program,
   because a hand-written label both appeared on screen and took part in matching, so changing the
   label could silently break an agent. Before removing it, every definition in the five projects the
   panel knew about was scanned: no agent resolved by name.
   A definition written with a label now binds to the orchestrator and its REASON is written - it does not go silent. */
test('an account label written into the file does not resolve; the agent binds to the orchestrator and the reason is written', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-ad-'));
  const data = setupRegistry([{ id: 'claude-example', name: 'ExampleAccount', provider: 'claude', folder: null }]);
  t.after(() => { fs.rmSync(project, { recursive: true, force: true });
                  fs.rmSync(data, { recursive: true, force: true }); });

  // `provider` is deliberately nonsense too: the real kind of the account is a fact WRITTEN in the
  // registry, and the line in the file is only a hint.
  writeAgent(project, 'dsaf', ['schema: panel-agent/v1', 'name: dsaf', 'description: A test',
    'model: Sonnet', 'account: ExampleAccount', 'provider: ExampleAccount']);

  const result = await requestList(project, data);
  assert.match(result, /Account: Same as orchestrator/);
  assert.match(result, /not registered/, 'the reason must be written; the agent must not drop out silently');
  assert.doesNotMatch(result, /Account: claude-example/, 'a label must not stand in for an id');
});

test('when two accounts share a label no choice is MADE; the agent binds to the orchestrator', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-twin-'));
  const data = setupRegistry([
    { id: 'claude-a', name: 'Twin', provider: 'claude', folder: null },
    { id: 'claude-b', name: 'Twin', provider: 'claude', folder: null },
  ]);
  t.after(() => { fs.rmSync(project, { recursive: true, force: true });
                  fs.rmSync(data, { recursive: true, force: true }); });

  writeAgent(project, 'twinned', ['schema: panel-agent/v1', 'name: twinned', 'description: A test',
    'model: haiku', 'account: Twin']);

  const result = await requestList(project, data);
  assert.match(result, /Account: Same as orchestrator/);
  assert.match(result, /not registered/);
});

/* A DELETED ACCOUNT: if the linked account is deleted the agent falls back to the orchestrator and the
   reason is VISIBLE. The agent does not go silent. */
test('an agent bound to an account missing from the registry falls back to the orchestrator and gives the reason', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-deleted-'));
  const data = setupRegistry([{ id: 'codex-default', name: 'Codex', provider: 'codex', folder: null }]);
  t.after(() => { fs.rmSync(project, { recursive: true, force: true });
                  fs.rmSync(data, { recursive: true, force: true }); });

  writeAgent(project, 'test-2', ['schema: panel-agent/v1', 'name: test-2', 'description: A test',
    'model: haiku', 'account: deleted-account', 'provider: claude']);

  const result = await requestList(project, data);
  assert.match(result, /test-2/);
  assert.match(result, /Account: Same as orchestrator/);
  assert.match(result, /not registered/);
});

/* AN AGENT BOUND TO THE ORCHESTRATOR DOES NOT PASS THIS DOOR. The panel does not know which account the
   calling orchestrator is on; choosing one would mean taking a spending decision for the user. */
test('run_agent does not execute an agent bound to the orchestrator; it explains how to run it', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-red-'));
  const data = setupRegistry(DEFAULT_REGISTRY);
  t.after(() => { fs.rmSync(project, { recursive: true, force: true });
                  fs.rmSync(data, { recursive: true, force: true }); });

  writeAgent(project, 'local', ['schema: panel-agent/v1', 'name: local', 'description: A test',
    'model: orchestrator', 'account: orchestrator', 'provider: orchestrator']);

  const result = await call(project, data,
    { method: 'tools/call', params: { name: 'run_agent', arguments: { agent: 'local', task: 'x' } } },
    (r) => r.content[0].text);
  assert.match(result, /NATIVE SUBAGENT REQUIRED/);
  assert.match(result, /native subagent/);
});

/* THE CONNECTION BLURB. Measured: Codex RECEIVES the `instructions` text of an MCP server - seen in its
   own session record, prepended to the description of every `mcp__worker__*` tool. So the text is now a
   channel, and unguarded it could quietly empty out. It has to carry two things at once: the routing
   rule and the LIVE agent list. The list must say the right thing for an empty project too, or no
   agents and could not read would look the same. */
test('the connection blurb carries the routing rule and the live agent list of that project', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-intro-'));
  const data = setupRegistry(DEFAULT_REGISTRY);
  t.after(() => { fs.rmSync(project, { recursive: true, force: true });
                  fs.rmSync(data, { recursive: true, force: true }); });

  const empty = await requestIntro(project, data);
  assert.match(empty, /run_agent/);
  assert.match(empty, /No agents assigned/);

  writeAgent(project, 'probe', ['schema: panel-agent/v1', 'name: probe', 'description: What this test is for',
    'model: haiku', 'account: claude-default', 'provider: claude']);

  const filled = await requestIntro(project, data);
  assert.match(filled, /probe/);
  assert.match(filled, /What this test is for/);
  assert.match(filled, /claude-default/);
  assert.doesNotMatch(filled, /No agents assigned/);
});

/* MONITORING DOES NOT STAY SILENT: if the panel shows a reachability warning, the indicator itself
   cannot be silent. When the record could not be written the error was swallowed entirely: the job
   ran and the result returned, but the monitoring window of the panel stayed empty and the reason was
   written NOWHERE. An empty window reads as no work having happened; the two are different. */
test('if the record cannot be written the result still returns, with a monitoring warning', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-watch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  const k = path.join(project, '.benchook', 'agents');
  fs.mkdirSync(k, { recursive: true });
  // The account IS in the registry but not signed in: the job never starts and no model is called.
  fs.writeFileSync(path.join(k, 'closed.md'),
    '---\nname: closed\ndescription: d\nmodel: haiku\naccount: claude-closed\n---\n\nis\n');
  const data = setupRegistry([{ id: 'claude-closed', name: 'Closed', provider: 'claude',
    folder: path.join(dir, 'none-ev') }]);

  // A FILE is placed where the record folder would go: `mkdirSync` fails there.
  fs.writeFileSync(path.join(data, 'Benchook', 'worker-runs'), 'block');

  const text = await call(project, data,
    { method: 'tools/call', params: { name: 'run_agent', arguments: { agent: 'closed', task: 'x' } } },
    (r) => r.content[0].text);

  assert.match(text, /WORKER FAILED/, text);
  assert.match(text, /signed out/, text);
  assert.match(text, /MONITORING WARNING/, text);
  assert.match(text, /The work itself ran|will not appear/, text);
});

/* THE DEFINITION IS REREAD AT CALL TIME - a routing safeguard.
   An old catalogue must not authorise a deleted or changed assignment. The record must also say which
   definition ran by FILE and DIGEST, not by NAME: two runs may carry the same name and run different
   definitions. */
test('a run uses the current definition, not the one from listing time; the record names the definition', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-refresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  const k = path.join(project, '.benchook', 'agents');
  fs.mkdirSync(k, { recursive: true });
  const file = path.join(k, 'variable.md');
  const definition = (account) => '---\nname: variable\ndescription: d\nmodel: haiku\naccount: '
    + account + '\n---\n\nis\n';
  // Both accounts ARE in the registry but not signed in: the job never starts and no model is called.
  const data = setupRegistry([
    { id: 'claude-one', name: 'One', provider: 'claude', folder: path.join(dir, 'none-1') },
    { id: 'claude-two', name: 'Two', provider: 'claude', folder: path.join(dir, 'none-2') },
  ]);
  const run = () => call(project, data,
    { method: 'tools/call', params: { name: 'run_agent', arguments: { agent: 'variable', task: 'x' } } },
    (r) => r.content[0].text);

  fs.writeFileSync(file, definition('claude-one'));
  const first = await run();
  assert.match(first, /One is signed out/, first);

  // The definition CHANGED: the new run must use the new account, and the old list must grant nothing.
  fs.writeFileSync(file, definition('claude-two'));
  const second = await run();
  assert.match(second, /Two is signed out/, second);
  assert.doesNotMatch(second, /One is signed out/);

  // The records: the same name, different definition digests.
  const root = fs.existsSync(path.join(data, 'Benchook')) ? path.join(data, 'Benchook')
    : path.join(data, 'Benchook');
  const records = require('../panel/worker-records').list(root, project);
  assert.equal(records.length, 2, JSON.stringify(records));
  for (const record of records) {
    assert.equal(record.name, 'variable');
    assert.equal(String(record.definitionFile).split(String.fromCharCode(92)).join('/'), '.benchook/agents/variable.md');
    assert.match(String(record.definitionDigest), /^[0-9a-f]{16}$/);
  }
  assert.notEqual(records[0].definitionDigest, records[1].definitionDigest,
    'the definition changed yet the two records carry the same digest');
});

/* The agent definition sets the role and scope. Task text supplies the work request without replacing that definition. */
test('the run_agent description does not push the caller into writing a role', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-role-'));
  const data = setupRegistry(DEFAULT_REGISTRY);
  t.after(() => { fs.rmSync(project, { recursive: true, force: true });
                  fs.rmSync(data, { recursive: true, force: true }); });

  const toolNames = await call(project, data, { method: 'tools/list', params: {} },
    (r) => JSON.stringify(r.tools));
  const a = JSON.parse(toolNames).find((x) => x.name === 'run_agent');
  assert.ok(a, 'run_agent aleti none');
  assert.match(a.description, /role comes from its own definition/i);
  assert.match(a.description, /do not restate the role/i);
  assert.match(a.inputSchema.properties.task.description, /NOT a role brief/i);
  assert.match(a.inputSchema.properties.task.description, /introduce itself/i);
});

/* WHEN THE ACCOUNT OF THE SESSION CAN BE READ, AN AGENT BOUND TO THE ORCHESTRATOR RUNS TOO.
   The old behaviour refused in every case, reasoning that the account of the caller was unknown; that
   is no longer true, because the panel gives every terminal the profile folder of its account itself.
   Here the account IS in the registry but not signed in: the routing is seen reaching the right account
   and no model is called. */
test('when the session account can be read, an agent bound to the orchestrator is not refused', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-session-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  const profile = path.join(dir, 'profile-empty');
  const data = setupRegistry([{ id: 'claude-session', name: 'Session', provider: 'claude', folder: profile }]);

  writeAgent(project, 'local', ['schema: panel-agent/v1', 'name: local', 'description: A test',
    'model: orchestrator', 'account: orchestrator', 'provider: orchestrator']);

  const request = { method: 'tools/call',
    params: { name: 'run_agent', arguments: { agent: 'local', task: 'x' } } };

  // The identity CAN BE READ: the job is not refused, it is routed to that account and stops at the login check.
  const readable = await call(project, data, request, (r) => r.content[0].text,
    { CLAUDE_CONFIG_DIR: profile });
  assert.doesNotMatch(readable, /NATIVE SUBAGENT REQUIRED/, readable);
  assert.match(readable, /Session is signed out/, readable);

  // The identity CANNOT BE READ: the old behaviour stays and the reason is written; nothing is spent on an invented account.
  const unreadable = await call(project, data, request, (r) => r.content[0].text,
    { CLAUDE_CONFIG_DIR: path.join(dir, 'inRegistry-missing') });
  assert.match(unreadable, /NATIVE SUBAGENT REQUIRED/, unreadable);
  assert.match(unreadable, /could not read which account/i, unreadable);
});
