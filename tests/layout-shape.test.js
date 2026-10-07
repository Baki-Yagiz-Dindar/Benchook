'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLayout, layoutValid } = require('../panel/layout-shape');

test('the per-project table is created when missing', () => {
  assert.deepEqual(normalizeLayout({ window: {} }).projectState, {});
});

test('the open project joins the known-projects list', () => {
  assert.deepEqual(normalizeLayout({ project: 'C:/a' }).projects, ['C:/a']);
  assert.deepEqual(normalizeLayout({ project: 'C:/b', projects: ['C:/a'] }).projects, ['C:/a', 'C:/b']);
});

test('state already stored for other projects is kept', () => {
  const d = normalizeLayout({ project: 'C:/a', projects: ['C:/a', 'C:/b'],
    projectState: { 'C:/b': { sidebarTab: 'status' } } });
  assert.deepEqual(d.projectState['C:/b'], { sidebarTab: 'status' });
});

test('running it twice changes nothing more', () => {
  const once = normalizeLayout({ project: 'C:/a' });
  const twice = normalizeLayout(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
});

test('a value that is not an object is returned unchanged', () => {
  assert.equal(normalizeLayout(null), null);
  assert.equal(normalizeLayout(undefined), undefined);
  assert.equal(normalizeLayout('text'), 'text');
});

test('the validator accepts the current shape and rejects wrong field types', () => {
  assert.equal(layoutValid({ project: 'C:/a', projects: ['C:/a'], projectState: { 'C:/a': { pages: [] } } }), true);
  assert.equal(layoutValid({ projects: 'C:/a' }), false);
  assert.equal(layoutValid({ projectState: { 'C:/a': { pages: 'x' } } }), false);
  assert.equal(layoutValid([]), false);
});
