'use strict';
/* RENDERER ROBUSTNESS (code review, 6 October 2026). Each case was found by reading the page code and is
 * checked here by running that code, cut out of panel.js, against stubs. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'panel', 'panel.js'), 'utf8').replace(/\r\n/g, '\n');
const cut = (from, to) => {
  const a = page.indexOf(from);
  const b = page.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, 'marker not found: ' + from);
  return page.slice(a, b);
};

test('the per-second counter of a running card moves (cards are kept per agent name)', () => {
  const box = vm.createContext({});
  vm.runInContext(cut('function refreshDuration()', '\n}\n') + '\n}', box);
  const written = [];
  Object.assign(box, {
    lastList: [{ name: 'scout', file: 'run-2', status: 'running' }, { name: 'scout', file: 'run-1', status: 'running' }],
    cards: new Map([['scout', { shown: 'run-2', duration: 'node' }]]),
    setupText: (node, text) => written.push([node, text]),
    writeDuration: (s) => s + 's',
    elapsedSeconds: () => 7,
  });
  vm.runInContext('refreshDuration()', box);
  assert.deepEqual(written, [['node', '7s']], 'only the run the card shows is counted, once');
});

function roundBox(over = {}) {
  const box = vm.createContext({});
  vm.runInContext(cut('function paneWorkers(', '\n/* WHICH AGENTS AND ACCOUNTS ARE RUNNING'), box);
  vm.runInContext(cut('function countOf(', '\n}\n') + '\n}', box);
  vm.runInContext(cut('async function refreshAgentRound()', '\n}\n') + '\n}', box);
  const drawn = [];
  Object.assign(box, {
    project: 'C:/p',
    panes: [],
    enabled: null,
    historyOpen: false,
    openAgent: null,
    lastList: [],
    setRunning: () => {},
    markWaitingQuestions: async () => {},
    writeSummary: () => {},
    renderGrid: () => drawn.push('grid'),
    refreshProjectRuns: async () => {},
    ...over,
  });
  return { box, drawn };
}
const pane = (id) => ({ id, connection: id, provider: 'claude', agentBadge: { innerHTML: '', style: {} } });

test('one pane whose agent read fails does not stop the round for the others', async () => {
  const a = pane('a'), b = pane('b');
  const { box, drawn } = roundBox({
    panes: [a, b],
    window: { panel: {
      projectWorkers: async () => ({ list: [] }),
      readAgents: async (id) => { if (id === 'a') throw new Error('unreadable'); return { list: [{ name: 'x', status: 'running' }] }; },
    } },
  });
  await vm.runInContext('refreshAgentRound()', box);
  assert.equal(a.agents.none, 'error');
  assert.equal(b.agents.list.length, 1, 'the second pane is still read');
  assert.match(b.agentBadge.innerHTML, /1 agent/);
  assert.deepEqual(drawn, ['grid'], 'the cards are still drawn');
});

test('a round whose project changed while it waited is dropped', async () => {
  const a = pane('a');
  let release;
  const { box, drawn } = roundBox({
    panes: [a],
    window: { panel: {
      projectWorkers: () => new Promise((r) => { release = r; }),
      readAgents: async () => ({ list: [] }),
    } },
  });
  const round = vm.runInContext('refreshAgentRound()', box);
  box.project = 'C:/other';
  release({ list: [{ id: 'w1', status: 'running', parent: 'a' }] });
  await round;
  assert.equal(a.agents, undefined, 'nothing from the old project is written');
  assert.deepEqual(drawn, []);
});

test('an agent list that arrives after a project switch is not drawn into the new project', async () => {
  const box = vm.createContext({});
  vm.runInContext(cut('async function refreshDefinitions()', '\n}\n') + '\n}', box);
  const pending = [];
  Object.assign(box, {
    project: 'C:/old', definedAgents: [],
    setupWatching: () => {}, setupText: () => {}, g: () => ({}), renderAgentList: () => {},
    refreshExternalAgent: () => {}, agentSummary: () => '', errorText: (e) => String(e),
    window: { panel: { listAgents: (p) => new Promise((r) => pending.push([p, r])) } },
  });
  const oldCall = vm.runInContext('refreshDefinitions()', box);
  box.project = 'C:/new';
  const newCall = vm.runInContext('refreshDefinitions()', box);
  pending[1][1]([{ name: 'new-agent' }]);
  await newCall;
  pending[0][1]([{ name: 'old-agent' }]);
  await oldCall;
  assert.deepEqual(box.definedAgents.map((a) => a.name), ['new-agent']);
});

test('of two overlapping agent-list reads for the same project, the older reply never overwrites the newer', async () => {
  const box = vm.createContext({});
  vm.runInContext(cut('async function refreshDefinitions()', '\n}\n') + '\n}', box);
  const pending = [];
  Object.assign(box, {
    project: 'C:/same', definedAgents: [],
    setupWatching: () => {}, setupText: () => {}, g: () => ({}), renderAgentList: () => {},
    refreshExternalAgent: () => {}, agentSummary: () => '', errorText: (e) => String(e),
    window: { panel: { listAgents: (p) => new Promise((r) => pending.push(r)) } },
  });
  const older = vm.runInContext('refreshDefinitions()', box);
  const newer = vm.runInContext('refreshDefinitions()', box);
  pending[1]([{ name: 'after-save' }]);
  await newer;
  pending[0]([{ name: 'before-save' }]);
  await older;
  assert.deepEqual(box.definedAgents.map((a) => a.name), ['after-save']);
});
