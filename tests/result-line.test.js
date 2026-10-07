'use strict';
// The result sentence is visible regardless of the tab. Measured defect: on the Agents tab the "deleted"
// sentence of a deleted agent was written only to #orchestratorStatus on Overview, and the user did not see it.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../panel/panel.js'), 'utf8');

function fixture() {
  const el = () => ({ textContent: '', title: '', hidden: true, classList: { toggle() {} }, dataset: {} });
  const elements = { orchestratorStatus: el(), sidebarStatus: el() };
  const ctx = vm.createContext({
    g: (id) => elements[id],
    document: { querySelector: () => ({}), querySelectorAll: () => [] },
    refreshSkills: () => {},
  });
  const slice = (press, last) => source.slice(source.indexOf(press), source.indexOf(last, source.indexOf(press)));
  vm.runInContext('let sidebarTab = "status";', ctx);
  vm.runInContext(slice('function selectTab(name)', '\nfunction ', ), ctx);
  vm.runInContext(slice('function writeStatus(short', '\nconst paneLabel ='), ctx);
  return { ctx, elements };
}

test('a result written on the Agents tab appears on a line independent of the tab', () => {
  const { ctx, elements } = fixture();
  vm.runInContext('selectTab("agents"); writeStatus("\\"x\\" deleted from 1 project(s).", "hint")', ctx);
  assert.equal(elements.sidebarStatus.textContent, '"x" deleted from 1 project(s).');
  assert.equal(elements.sidebarStatus.title, 'hint');
  assert.equal(elements.sidebarStatus.hidden, false, 'the line must be visible on the Agents tab');
  assert.equal(elements.orchestratorStatus.textContent, '"x" deleted from 1 project(s).', 'the Overview line keeps being written too');
});

test('on the Overview tab the same sentence does not appear twice; an empty sentence hides the line', () => {
  const { ctx, elements } = fixture();
  vm.runInContext('selectTab("agents"); writeStatus("saved"); selectTab("status")', ctx);
  assert.equal(elements.sidebarStatus.hidden, true, 'Overview: #orchestratorStatus already shows it');
  vm.runInContext('selectTab("skills")', ctx);
  assert.equal(elements.sidebarStatus.hidden, false, 'it becomes visible again on returning to the Skills tab');
  vm.runInContext('writeStatus("", "")', ctx);
  assert.equal(elements.sidebarStatus.hidden, true, 'an empty sentence hides the line');
});
