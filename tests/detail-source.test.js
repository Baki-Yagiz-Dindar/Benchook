'use strict';
/* The detail window must show the record of the row that was clicked.
 *
 * What it protects against: the history list chose the newest record (`HISTORY_NEWER_PASSIVE`), but
 * clicking the row showed the old record from the pane's live list (`LOCAL_NATIVE_FINAL`). The detail
 * renderer looked up the same file key in the live list first. The first test here rebuilds that moment
 * exactly. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'panel', 'panel.js'), 'utf8');
const slice = page.slice(page.indexOf('function selectDetailRecord('),
  page.indexOf('function renderDetail('));
const box = vm.createContext({});
vm.runInContext(slice, box);
const select = vm.runInContext('selectDetailRecord', box);

const live = { file: 'agent-local', result: 'LOCAL_NATIVE_FINAL' };
const project = { file: 'agent-local', result: 'HISTORY_NEWER_PASSIVE' };

test("a row opened from the history shows the record in the project list (merged, most recent)", () => {
  assert.equal(select('agent-local', 'project', [live], [project]).result, 'HISTORY_NEWER_PASSIVE');
});

test("a row opened from a live card shows the own record of that pane", () => {
  assert.equal(select('agent-local', 'pane', [live], [project]).result, 'LOCAL_NATIVE_FINAL');
});

test("if the record is not in its own list the other list is the fallback; if it is in neither, null", () => {
  assert.equal(select('agent-local', 'project', [live], []).result, 'LOCAL_NATIVE_FINAL');
  assert.equal(select('agent-local', 'pane', null, [project]).result, 'HISTORY_NEWER_PASSIVE');
  assert.equal(select('other', 'project', [live], [project]), null);
});

test("a history row and earlier runs open with source \"project\"; a live card with \"pane\"", () => {
  // The callers are tested too: a correct pure function with a caller left on the old behaviour
  // would reproduce the same defect.
  assert.match(page, /openAgent = a\.file; renderDetail\(a\.file, 'project'\)/, 'history row');
  assert.match(page, /openAgent = x\.file; detailInstalled = null; renderDetail\(x\.file, 'project'\)/, 'earlier runs');
  assert.match(page, /openAgent = d\.shown; renderDetail\(d\.shown, 'pane'\)/, 'live card');
});
