'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const acorn = require('../panel/node_modules/acorn');
const source = fs.readFileSync(path.join(__dirname, '../panel/panel.js'), 'utf8');
const tree = acorn.parse(source, { ecmaVersion: 'latest' });
function code(...names) {
  return names.map(name => {
    const node = tree.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
    assert.ok(node, name); return source.slice(node.start, node.end);
  }).join('\n');
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('MCP setup does not report success for disabled settings or overwrite a changed project', async () => {
  const writes = [], elements = {}, pending = deferred();
  let result = Promise.resolve({ installed: false, status: 'closed', note: 'Disabled' });
  const context = vm.createContext({ mcpRefreshRequest: 0, mcpSetupRequest: 0, project: 'A', activePage: {},
    orchChangeMode: false, panes: [{ accountId: 'account' }],
    g: id => elements[id] ||= { dataset: {}, value: '' },
    window: { panel: { setupMcp: () => result } },
    writeMcp: (...args) => writes.push(args), mcpStatusLabel: x => x,
    writeStatus() {}, refreshMcpStatus() {} });
  const first = source.indexOf("g('mcpSetup').onclick = async () => {");
  const last = source.indexOf('\n};', first) + 3;
  vm.runInContext(source.slice(first, last), context);
  await elements.mcpSetup.onclick();
  assert.equal(writes.at(-1)[2], 'closed'); assert.equal(elements.mcpSetup.disabled, false);
  result = pending.promise;
  const request = elements.mcpSetup.onclick(); context.project = 'B';
  pending.resolve({ installed: true, status: 'installed' }); await request;
  assert.equal(writes.length, 1);
});

test('a status poll during MCP setup does not swallow the setup result', async () => {
  const writes = [], elements = {}, pending = deferred();
  const context = vm.createContext({ mcpRefreshRequest: 0, mcpSetupRequest: 0, project: 'A', activePage: {},
    orchChangeMode: false, panes: [{ accountId: 'account' }],
    g: id => elements[id] ||= { dataset: {}, value: '' },
    window: { panel: { setupMcp: () => pending.promise } },
    writeMcp: (...args) => writes.push(args), mcpStatusLabel: x => x,
    writeStatus() {}, refreshMcpStatus() {} });
  const first = source.indexOf("g('mcpSetup').onclick = async () => {");
  vm.runInContext(source.slice(first, source.indexOf('\n};', first) + 3), context);
  const click = elements.mcpSetup.onclick();
  context.mcpRefreshRequest++;   // the account poll refreshed the status meanwhile
  pending.resolve({ installed: true, status: 'installed' }); await click;
  assert.equal(writes.at(-1)[2], 'installed');
});

test('MCP responses cannot overwrite a newer request or a cleared selection', async () => {
  const requests = [], writes = [], elements = {};
  const context = vm.createContext({ mcpRefreshRequest: 0, project: 'A', activePage: {},
    orchChangeMode: false, panes: [{ accountId: 'account' }],
    g: id => elements[id] ||= { dataset: {}, value: '' },
    window: { panel: { mcpStatus: () => { const d = deferred(); requests.push(d); return d.promise; } } },
    writeMcp: (...args) => writes.push(args), mcpStatusLabel: x => x,
    setupReachabilityWarning() {}, writeDeclinedBar() {} });
  vm.runInContext(code('refreshMcpStatus'), context);
  const first = context.refreshMcpStatus();
  context.project = 'B'; const second = context.refreshMcpStatus();
  requests[1].resolve({ status: 'installed', installed: true }); await second;
  requests[0].resolve({ status: 'none' }); await first;
  assert.equal(writes.at(-1)[2], 'installed');
  const third = context.refreshMcpStatus();
  context.project = null; await context.refreshMcpStatus();
  requests[2].resolve({ status: 'installed' }); await third;
  assert.equal(writes.at(-1)[2], 'inactive');
});

test('workspace ownership rejects overlapping mutations and releases after failure', async () => {
  const context = vm.createContext({ workspaceBusy: false, writeStatus() {}, showError() {} });
  vm.runInContext(code('workspaceBlocked', 'changeWorkspace'), context);
  const waiting = deferred(); let calls = 0;
  const first = context.changeWorkspace(() => waiting.promise);
  await context.changeWorkspace(() => { calls++; });
  assert.equal(calls, 0);
  waiting.resolve(); await first;
  await context.changeWorkspace(() => { throw Error('failed'); });
  await context.changeWorkspace(() => { calls++; });
  assert.equal(calls, 1); assert.equal(context.workspaceBusy, false);
});

test('tab navigation does not change active state during a workspace mutation', async () => {
  const page = { id: 'A' };
  const context = vm.createContext({ workspaceBusy: true, activePage: page,
    pages: [page, { id: 'B' }], writeStatus() {} });
  vm.runInContext(code('workspaceBlocked', 'goToPage'), context);
  await context.goToPage('B'); assert.equal(context.activePage, page);
});

test('a pending terminal uses its captured project and closes a late result after disposal', async () => {
  const onboarding = deferred(), opened = deferred(), calls = [];
  const context = vm.createContext({ project: 'wrong-project',
    prepareFirstSetup: () => onboarding.promise, setupCommand: () => 'fixture',
    window: { panel: { openTerminal: options => { calls.push(options); return opened.promise; },
      closeTerminal: id => calls.push(id) } } });
  vm.runInContext(code('launch'), context);
  const pane = { project: 'original-project', terminal: { cols: 80, rows: 24 } };
  const result = context.launch(pane);
  onboarding.resolve(); await new Promise(setImmediate);
  assert.equal(calls[0].workingDirectory, 'original-project');
  pane.closed = true; opened.resolve({ id: 42 }); await result;
  assert.equal(calls[1], 42);
});

test('closing a background pane marks pending launches cancelled and preserves active panes', () => {
  const pane = { owner: { panes: [] }, terminal: { dispose() {} }, container: { remove() {} } };
  pane.owner.panes.push(pane);
  const context = vm.createContext({ activePage: {}, idMap: new Map(), saveLayout() {}, rememberSession() {} });
  vm.runInContext(code('closePane'), context);
  context.closePane(pane, true);
  assert.equal(pane.closed, true); assert.equal(pane.owner.panes.length, 0);
});
