'use strict';
// BINDING A WORKER RUN TO THE RIGHT TERMINAL.
// 
// THE SUSPICION, from a review: project-wide MCP records could be offered to every terminal, and
// separating them by parent session identity was limited.
// 
// THE SUSPICION WAS CONFIRMED by reading the code, in two places:
// 1. The record `tools/mcp-server.js` wrote had NO PARENT FIELD at all: id, name, job, account,
// definition, model, state, times and result were there, but which terminal started the run was
// written nowhere.
// 2. `panel.js refreshAgent` added EVERY worker record in the project to the agent list of EVERY
// pane. A worker started from terminal A also showed live on the card of B, and the running count
// went up in every pane.
// 
// THE FIX: the parent identity is carried from the call into the record. Its source is the
// `BENCHOOK_SESSION` the panel writes per pane (added in -- the only identity the panel CAN match.
// 
// AN OLD RECORD WITH NO PARENT IS NOT GUESSED AT. Binding it to a pane by name or time proximity is the
// thing the card forbids. Such records do not appear on a live card; they stay in the project history.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const workerRecords = require('../panel/worker-records');

function field(t) {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-parent-'));
  t.after(() => fs.rmSync(k, { recursive: true, force: true }));
  return k;
}

/* ---- RECORD SIDE: IS THE PARENT WRITTEN? ---- */

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

function setup(t, env) {
  const root = field(t);
  const project = path.join(root, 'project');
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(project, '.benchook', 'agents'), { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  /* The agent is assigned to ANOTHER account and that account is signed in: the server refuses an agent
     bound to the orchestrator because it cannot read the account of the session ; the record path
     opens only in a real run. */
  const profile = path.join(root, 'codex-profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'auth.json'), '{}');
  fs.writeFileSync(path.join(data, 'accounts.json'), JSON.stringify({
    accounts: [{ id: 'codex-second', name: 'Second', provider: 'codex', folder: profile }],
  }));
  fs.writeFileSync(path.join(project, '.benchook', 'agents', 'auditor.md'),
    ['---', 'name: auditor', 'description: Review', 'account: codex-second', 'provider: codex',
      'model: gpt-5-codex', '---', '', 'Read.', ''].join('\n'));
  const call = loadMcp(project, data, env,
    async () => ({ text: 'done', model: 'haiku', account: 'Claude', seconds: 1 }));
  return { project, data, call };
}

const run = (call) => call({ method: 'tools/call',
  params: { name: 'run_agent', arguments: { agent: 'auditor', task: 'Review this.' } } });

test("the identity of the terminal that started the run is written into the record", async (t) => {
  const { project, data, call } = setup(t, { BENCHOOK_SESSION: 'pane-1' });

  await run(call);

  const records = workerRecords.list(data, project);
  assert.equal(records.length, 1);
  assert.equal(records[0].parent, 'pane-1', 'which terminal started the run must be written down');
});

test("for a terminal not opened by the panel no parent is INVENTED", async (t) => {
  const { project, data, call } = setup(t, {});

  await run(call);

  const records = workerRecords.list(data, project);
  assert.equal(records[0].parent, null, 'no value is invented for an unknown parent');
});

test("runs from two terminals are recorded under separate parents", async (t) => {
  const one = setup(t, { BENCHOOK_SESSION: 'pane-1' });
  await run(one.call);
  // The same project and the same data root, a different pane.
  const callTwice = loadMcp(one.project, one.data, { BENCHOOK_SESSION: 'pane-2' },
    async () => ({ text: 'done', model: 'haiku', account: 'Claude', seconds: 1 }));
  await run(callTwice);

  const parents = workerRecords.list(one.data, one.project).map((x) => x.parent).sort();
  assert.deepEqual(parents, ['pane-1', 'pane-2']);
});

/* ---- THE SCREEN END: WHICH CARD BELONGS TO WHOM ---- */

const page = fs.readFileSync(path.join(__dirname, '..', 'panel', 'panel.js'), 'utf8');
const slice = page.slice(page.indexOf('function paneWorkers('),
  page.indexOf('async function refreshAgent('));
const box = vm.createContext({});
vm.runInContext(slice, box);
const paneWorkers = vm.runInContext('paneWorkers', box);

const worker = (id, parent) => ({ id, parent, status: 'running' });

test("a pane shows live only the worker it started ITSELF", () => {
  const all = [worker('a', 'pane-1'), worker('b', 'pane-2')];

  assert.deepEqual(paneWorkers(all, 'pane-1').map((x) => x.id), ['a']);
  assert.deepEqual(paneWorkers(all, 'pane-2').map((x) => x.id), ['b']);
});

test("a run with an unknown parent is assigned to no pane", () => {
  const all = [worker('a', null), worker('b', 'pane-1')];

  assert.deepEqual(paneWorkers(all, 'pane-1').map((x) => x.id), ['b'],
    'a run of unknown origin is not attached to a terminal by guesswork');
  assert.equal(paneWorkers(all, 'pane-2').length, 0);
});

test("no run is assigned to a pane with no identity", () => {
  const all = [worker('a', 'pane-1'), worker('b', null)];

  // The lengths are compared: an empty array from the vm context carries a separate Array prototype, and
  // a strict deepEqual tells them apart -- a property of the measuring instrument, not of the product.
  assert.equal(paneWorkers(all, null).length, 0, 'an empty id must not match an empty parent');
  assert.equal(paneWorkers(all, '').length, 0);
});

test("the project history stays WHOLE", () => {
  /* The point of the card: a live card belongs to a pane, the project history is whole. The filter is only
     on the live-card path; the history window keeps reading the same list as it is. */
  const all = [worker('a', 'pane-1'), worker('b', null), worker('c', 'pane-2')];
  assert.equal(all.length, 3, 'the filter does not consume its source');
  assert.equal(paneWorkers(all, 'pane-1').length, 1);
});
