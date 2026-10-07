'use strict';

/* THE ORCHESTRATOR ACCOUNT MENU WHILE A SESSION IS OPEN.
 *
 * What it protects against: an account added while an orchestrator was running showed up in the
 * account cards but not in "Switch account or model". The menu was rebuilt only while the page had
 * no terminal, so it caught up only when an empty panel happened to trigger a refresh.
 *
 * The other direction is checked as well: rebuilding must not move the selection. The running
 * account stays selected outside switch mode, and the user's pick survives inside it. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../panel/panel.js'), 'utf8');
const piece = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const code = piece('function accountSignIn(h)', 'async function refreshRegistry')
  + piece('function renderAccountMenu()', '/* ---------------- OUR OWN DROPDOWN');

function fakeSelect() {
  const s = {
    options: [], selected: '',
    set textContent(_) { this.options = []; this.selected = ''; },
    appendChild(o) { this.options.push(o); if (this.options.length === 1) this.selected = o.value; },
    get value() { return this.selected; },
    set value(v) { this.selected = this.options.some((o) => o.value === v) ? v : ''; },
    dispatchEvent() { this.changed = (this.changed || 0) + 1; },
  };
  return s;
}

function setup({ registry, panes = [], change = false, value = '' }) {
  const select = fakeSelect();
  const context = vm.createContext({
    registry, panes, orchChangeMode: change, registryStatus: new Map(),
    g: (id) => (id === 'orchestratorAccount' ? select : null), Event: class {},
    document: { createElement: () => ({ value: '', textContent: '' }) },
  });
  vm.runInContext(code, context);
  vm.runInContext('renderAccountMenu()', context);
  if (value) select.value = value;
  return { select, context, run: () => vm.runInContext('renderAccountMenu()', context) };
}

const A = { id: 'a', name: 'work', provider: 'claude', signedIn: true };
const B = { id: 'b', name: 'home', provider: 'codex', signedIn: true };

test('an account added while an orchestrator runs reaches the menu, and the running account stays selected', () => {
  const t = setup({ registry: [A], panes: [{ accountId: 'a', label: 'Claude · work' }] });
  assert.equal(t.select.value, 'a');
  t.context.registry.push(B);
  t.run();
  assert.deepEqual(t.select.options.map((o) => o.value), ['', 'a', 'b']);
  assert.equal(t.select.value, 'a', 'the running account must not slide');
  const before = t.select.changed || 0;
  t.run();
  assert.equal(t.select.changed || 0, before, 'a refresh that changes nothing raises no change event');
});

test('in switch mode a refresh keeps the account the user picked', () => {
  const t = setup({ registry: [A, B], panes: [{ accountId: 'a' }], change: true });
  t.select.value = 'b';
  t.context.registry.push({ id: 'c', name: 'new', provider: 'claude', signedIn: false });
  t.run();
  assert.equal(t.select.value, 'b');
  assert.match(t.select.options.at(-1).textContent, /Signed out/);
});

test('a running orchestrator whose account was removed keeps a visible row', () => {
  const t = setup({ registry: [A, B], panes: [{ accountId: 'b', label: 'Codex · home' }] });
  t.context.registry.splice(1, 1);
  t.run();
  assert.equal(t.select.value, 'b');
  assert.match(t.select.options.at(-1).textContent, /removed from Benchook/);
});

test('with no orchestrator the previous choice is kept, and a removed choice falls back to empty', () => {
  const t = setup({ registry: [A, B], value: 'b' });
  t.run();
  assert.equal(t.select.value, 'b');
  t.context.registry.splice(1, 1);
  const before = t.select.changed || 0;
  t.run();
  assert.equal(t.select.value, '');
  assert.equal(t.select.changed, before + 1, 'a selection changed by code is announced, so the model list follows');
});

test('the menu is rebuilt on every registry render, not only on an empty page', () => {
  const render = piece('function renderRegistry()', 'function renderAccountMenu()');
  assert.match(render, /renderAccountMenu\(\)/);
  assert.doesNotMatch(render, /!panes\.length/);
});

/* THE OTHER SCREENS THAT NAME AN ACCOUNT follow the same refresh: the agent form's account box and
   the pane titles. Found in the same sweep: both kept the list or the name from when they were drawn. */
const others = piece('function fillFormAccounts(select)', 'function renderAccountMenu()');

function formSetup(registry, current) {
  const select = fakeSelect();
  select.dataset = { current: current || '' };
  select.dispatchEvent = () => { select.changed = (select.changed || 0) + 1; };
  select.changed = undefined;
  const context = vm.createContext({ registry, registryStatus: new Map(), panes: [], pages: [], activePage: null,
    paneLabel: (l) => l, document: { createElement: () => ({ value: '', textContent: '', disabled: false }) }, Event: class {} });
  vm.runInContext(code + others, context);
  return { select, context };
}

test('an account signed in while the agent form is open appears in its account box, the choice stays', () => {
  const t = formSetup([A], null);
  vm.runInContext('fillFormAccounts', t.context)(t.select);
  t.select.value = 'a';
  t.context.registry.push({ id: 'n', name: 'new', provider: 'claude', signedIn: true });
  vm.runInContext('fillFormAccounts', t.context)(t.select);
  assert.ok(t.select.options.some((o) => o.value === 'n'));
  assert.equal(t.select.value, 'a');
  assert.equal(t.select.changed, undefined, 'an unchanged choice raises no change event');
});

test('the agent form keeps its own signed-out account, and a removed choice is reported once', () => {
  const t = formSetup([A, { id: 's', name: 'old', provider: 'codex', signedIn: false }], 's');
  vm.runInContext('fillFormAccounts', t.context)(t.select);
  t.select.value = 's';
  assert.equal(t.select.value, 's');
  t.context.registry.splice(1, 1);
  vm.runInContext('fillFormAccounts', t.context)(t.select);
  assert.equal(t.select.value, '');
  assert.equal(t.select.changed, 1);
});

test('a pane title follows an account renamed at sign-in and keeps its model part', () => {
  const pane = { accountId: 'a', label: 'Claude account · default', name: { textContent: '' } };
  const t = formSetup([{ ...A, name: 'renamed.user' }], null);
  t.context.pages.push({ id: 'p' }); t.context.activePage = t.context.pages[0];
  t.context.panes.push(pane);
  vm.runInContext('syncAccountNames()', t.context);
  assert.equal(pane.label, 'renamed.user · default');
  assert.equal(pane.name.textContent, 'renamed.user · default');
});
