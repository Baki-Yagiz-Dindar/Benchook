'use strict';
// Forgetting a project: if the persistent record fails, terminals are not closed and the area is not removed.
// Confirm/cancel and the last project path are tested here too.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../panel/panel.js'), 'utf8');

function fixture({ confirm = true, forgetResult = { projects: ['B'] } } = {}) {
  const calls = { close: [], forget: 0, status: [], change: [], save: 0 };
  const root = { remove() { calls.rootDeleted = true; } };
  const projectFields = new Map([['A', { root, pages: [{ panes: [{ id: 7 }, { id: 8 }] }] }]]);
  const ctx = vm.createContext({
    project: 'A', projects: ['A', 'B'], projectFields, pages: [], activePage: null,
    allLivePanes: () => [{ id: 7 }, { id: 8 }],
    folderName: (y) => y,
    confirm: async () => confirm,
    window: { panel: { closeTerminal: (id) => calls.close.push(id), forgetProject: async () => { calls.forget++; return forgetResult; } } },
    writeStatus: (k, u) => calls.status.push(k),
    changeWorkspace: action => action(),
    closePane: pane => { pane.closed = true; },
    changeProjectOwned: async (y) => calls.change.push(y),
    setupPages: async () => {}, showProject() {}, renderProjectList() {}, refreshDefinitions() {},
    writeEmptyGive() {}, refreshExternalAgent() {}, saveLayout: () => calls.save++,
  });
  const press = source.indexOf('async function forgetProject(filePath)');
  const last = source.indexOf('\nfunction allLivePanes(', press);
  vm.runInContext(source.slice(press, last), ctx);
  return { ctx, calls, projectFields };
}

test('if the save fails nothing closes: the terminals stay open, the field stays, the project stays in the list', async () => {
  const { ctx, calls, projectFields } = fixture({ forgetResult: { error: 'disk full' } });
  await vm.runInContext('forgetProject("A")', ctx);
  assert.equal(calls.forget, 1);
  assert.deepEqual(calls.close, [], 'no terminal was closed');
  assert.ok(projectFields.has('A'), 'field silinmedi');
  assert.deepEqual(vm.runInContext('projects', ctx), ['A', 'B'], 'the project stayed in the list');
  assert.match(calls.status[0], /Could not remove project/);
});

test('without confirmation the save is not even attempted', async () => {
  const { ctx, calls } = fixture({ confirm: false });
  await vm.runInContext('forgetProject("A")', ctx);
  assert.equal(calls.forget, 0);
  assert.deepEqual(calls.close, []);
});

test('if the save succeeds the terminals close, the field is removed and it switches to the remaining project', async () => {
  const { ctx, calls, projectFields } = fixture();
  await vm.runInContext('forgetProject("A")', ctx);
  assert.deepEqual(calls.close, [7, 8]);
  assert.equal(projectFields.has('A'), false);
  assert.deepEqual(calls.change, ['B'], 'removing the open project switches to the first remaining one');
  assert.equal(calls.save, 1);
});

test('forgetting the open project closes its live tabs even when the project was never left', async () => {
  // A project opened at start and never left keeps its tabs in the global `pages`; its field list is empty.
  const { ctx, calls, projectFields } = fixture();
  projectFields.get('A').pages = [];
  const live = { panes: [{ id: 9 }] };
  vm.runInContext('pages', ctx).push(live);
  await vm.runInContext('forgetProject("A")', ctx);
  assert.deepEqual(calls.close, [9]);
});

test('removing the last project selects no folder on its own', async () => {
  const { ctx, calls } = fixture({ forgetResult: { projects: [] } });
  await vm.runInContext('forgetProject("A")', ctx);
  assert.deepEqual(calls.change, [], 'the panel does not select a project on its own');
  assert.equal(vm.runInContext('project', ctx), null);
});
