'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const folders = require('../panel/agent-folders');

// Expectations written out by hand, not derived from the module under test.
test('the panel folder is .benchook/agents and Claude Code folder is .claude/agents', () => {
  assert.deepEqual(folders.PANEL, ['.benchook', 'agents']);
  assert.deepEqual(folders.CLAUDE, ['.claude', 'agents']);
});

test('the listed folders are the panel folder first, then Claude Code folder, and nothing else', () => {
  assert.deepEqual(folders.LISTED, [['.benchook', 'agents'], ['.claude', 'agents']]);
});

test('inProject joins each folder onto the project path', () => {
  const project = path.join('C:', 'work', 'demo');
  assert.deepEqual(folders.inProject(project, folders.LISTED), [
    path.join('C:', 'work', 'demo', '.benchook', 'agents'),
    path.join('C:', 'work', 'demo', '.claude', 'agents'),
  ]);
});
