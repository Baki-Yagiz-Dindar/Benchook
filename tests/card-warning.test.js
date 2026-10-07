'use strict';
// Card warning and the link to an unregistered account.
// Measured defects: (1) the card warning sentence was clipped entirely inside the bottom line;
// (2) an agent with an unregistered account, saved without being touched, fell back to "orchestrator".
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../panel/panel.js'), 'utf8');

function fixture(registry, mcpWarning = null) {
  const el = () => ({ textContent: '', title: '', className: '' });
  const ctx = vm.createContext({ registry, mcpWarning, document: { createElement: el } });
  const slice = (press, last) => source.slice(source.indexOf(press), source.indexOf(last, source.indexOf(press)));
  vm.runInContext(slice('function unregisteredFileAccount(a)', '\nfunction setupBottomLine'), ctx);
  vm.runInContext(slice('function setupWarningLine(a)', '\nlet mcpWarning = null;'), ctx);
  return ctx;
}

test('card warning: a short label is visible and the full sentence is in the tooltip', () => {
  const ctx = fixture([], "MCP connection is not set up for X; this agent cannot be called from there.");
  const u = vm.runInContext(`setupWarningLine({ resolution: { asOrchestrator: false, account: 'b', reason: null },
    signInWarning: "Assigned account (b) is signed out; sign in from the panel before running this agent." })`, ctx);
  assert.equal(u.className, 'agent-warning');
  assert.equal(u.textContent, 'Signed out · Unreachable', 'the labels are short and fit on the card');
  assert.match(u.title, /signed out; sign in/);
  assert.match(u.title, /MCP connection is not set up/);
});

test('card warning: an unregistered account reads "No account"; with no warning there is no line', () => {
  const ctx = fixture([]);
  const u = vm.runInContext(`setupWarningLine({ resolution: { asOrchestrator: true, reason: "Linked account (none) is not registered.", fileAccount: 'none' } })`, ctx);
  assert.equal(u.textContent, 'No account');
  assert.equal(u.title, 'Linked account (none) is not registered.');
  assert.equal(vm.runInContext(`setupWarningLine({ resolution: { asOrchestrator: false, account: 'a', reason: null } })`, ctx), null);
});

test('an unregistered file account: the id is returned when it is not in the registry, null when it is or when it is the orchestrator', () => {
  const ctx = fixture([{ id: 'a', name: 'Account A' }]);
  const unregistered = (resolution) => vm.runInContext('unregisteredFileAccount(' + JSON.stringify({ resolution }) + ')', ctx);
  assert.equal(unregistered({ asOrchestrator: true, fileAccount: 'none-account' }), 'none-account');
  assert.equal(unregistered({ asOrchestrator: true, fileAccount: 'a' }), null, 'it is in the registry: the box already shows it');
  assert.equal(unregistered({ asOrchestrator: true, fileAccount: 'Account A' }), null, 'it matches by name too');
  assert.equal(unregistered({ asOrchestrator: true, fileAccount: 'orchestrator' }), null);
  assert.equal(unregistered({ asOrchestrator: true, fileAccount: null }), null, 'no account in the file: the real setting is the orchestrator');
  assert.equal(unregistered({ asOrchestrator: false, account: 'a', fileAccount: 'a' }), null);
});
