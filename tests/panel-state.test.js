'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../panel/panel.js'), 'utf8');
const serializer = source.slice(source.indexOf('function layoutData()'), source.indexOf('function saveLayout()'));
const poller = source.slice(source.indexOf('let contextRefreshing = false'), source.indexOf('function hourShort'));
const pane = id => ({ id, provider: 'codex', sessionId: null, bottomLeft: {}, bottomRight: {} });

test('a background identity is learned and written to the record of the right project', async () => {
  const a = pane(1), b = pane(2);
  const pageA = { id: 'a', panes: [a] }, pageB = { id: 'b', panes: [b] };
  const saves = [];
  const sandbox = {
    project: 'B', projects: ['A', 'B'], theme: 'pink', handoverFile: 'notes/handoff.md', textSize: 15, FIELDLESS: '(project none)',
    activePage: pageB, pages: [pageB], sidebarTab: 'status',
    projectFields: new Map([['A', { pages: [pageA], activePage: pageA, sidebarTab: 'skills' }]]),
    idMap: new Map([[1, a], [2, b]]),
    sumPageStatus() {}, refreshLeft() {},
    window: { panel: { readContext: async id => ({ sessionId: 'session-' + id, error: 'no usage yet' }) } },
    saveLayout: () => saves.push(JSON.parse(vm.runInContext('JSON.stringify(layoutData())', context))),
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(serializer + poller, context);
  await vm.runInContext('refreshContext()', context);
  assert.equal(a.sessionId, 'session-1');
  assert.equal(b.sessionId, 'session-2');
  const result = saves.at(-1);
  assert.equal(result.projectState.pages[0].orchestrator.sessionId, 'session-2');
  assert.equal(result.allProjectStatus.A.pages[0].orchestrator.sessionId, 'session-1');
  assert.equal(result.allProjectStatus.A.sidebarTab, 'skills');
  assert.equal(result.handoverFile, 'notes/handoff.md', 'the handoff-notes setting is saved with the layout');
  assert.equal(result.textSize, 15, 'the terminal text size is saved with the layout');
});

test('a late answer is not written to a terminal that was closed and reopened', async () => {
  const a = pane(1); let answer;
  const context = vm.createContext({ idMap: new Map([[1, a]]), refreshLeft() {}, saveLayout() { throw new Error('stale save'); },
    window: { panel: { readContext: () => new Promise(r => answer = r) } } });
  vm.runInContext(poller, context);
  const pending = vm.runInContext('refreshContext()', context);
  a.id = 3;
  answer({ sessionId: 'old-session' }); await pending;
  assert.equal(a.sessionId, null);
});
