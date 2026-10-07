'use strict';
// From the worker server's pid to the pane: process ancestry.
const test = require('node:test'), assert = require('node:assert/strict');
const { fromAncestryPane, resolveMap } = require('../panel/process-ancestry');

test('ancestry: server to codex to node to pty; if the pty belongs to a pane, that pane', () => {
  const map = new Map([[500, 400], [400, 300], [300, 200], [200, 100], [100, 1]]);
  const panes = new Map([[200, 'pane-A'], [900, 'pane-B']]);
  assert.equal(fromAncestryPane(500, map, panes), 'pane-A');
  assert.equal(fromAncestryPane(300, map, panes), 'pane-A');
  assert.equal(fromAncestryPane(200, map, panes), 'pane-A', 'the pty pid itself matches too');
});

test('ancestry: null when it reaches no pane; a cycle and a missing parent are handled safely', () => {
  const map = new Map([[500, 400], [400, 300], [300, 300]]);
  const panes = new Map([[900, 'pane-B']]);
  assert.equal(fromAncestryPane(500, map, panes), null);
  assert.equal(fromAncestryPane(7777, map, panes), null, 'haritada missing pid');
  assert.equal(fromAncestryPane(NaN, map, panes), null);
  const loop = new Map([[1, 2], [2, 1]]);
  assert.equal(fromAncestryPane(1, loop, panes), null, 'a pid cycle does not run forever');
});

test('resolveMap: PowerShell lines are read and a corrupt line is skipped', () => {
  const h = resolveMap('500 400\r\n400 300\r\ncorrupt line\r\n\r\n 300 200 \r\n');
  assert.deepEqual([...h.entries()], [[500, 400], [400, 300], [300, 200]]);
});
