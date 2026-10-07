'use strict';
/* The warning before saving must describe the REAL operation.
 *
 * What it protects against: while the already managed `reviewer` agent was being renamed to
 * `renamed-reviewer`, it said "Saving moves this agent to the managed folder". The operation was a rename
 * in two projects, not a move. The same `oldPath !== path` condition is true for two different
 * operations; the sentence now tells them apart. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'panel', 'panel.js'), 'utf8');
const box = vm.createContext({});
// The page's counting helper, which these sentences now use for their numbers.
vm.runInContext(page.slice(page.indexOf('function countOf('), page.indexOf('\n}', page.indexOf('function countOf(')) + 2), box);
vm.runInContext(page.slice(page.indexOf('function noticeSentence('), page.indexOf('function intentWord(')), box);
const noticeSentence = vm.runInContext('noticeSentence', box);

const A = 'C:\\run\\Project A', B = 'C:\\run\\Project B';
const managed = (project, name) => project + '\\.benchook\\agents\\' + name + '.md';

test("renaming a managed agent is not described as a move", () => {
  const s = noticeSentence({ oldPath: managed(B, 'reviewer'), filePath: managed(B, 'renamed-reviewer'),
    oldName: 'reviewer', newName: 'renamed-reviewer', projects: [A, B] });
  assert.doesNotMatch(s, /moves this agent/i, 'the wrong sentence from that morning');
  assert.match(s, /renames "reviewer" to "renamed-reviewer" in 2 projects:/);
  assert.match(s, /Project A/); assert.match(s, /Project B/);
  assert.match(s, /reviewer\.md are deleted after the new ones are written/);
  assert.match(s, /same agent/i, 'it states that the identity is preserved');
});

test("a move from the old folder to the managed folder is still described as a move", () => {
  const s = noticeSentence({ oldPath: A + '\\.claude\\agents\\writer.md', filePath: managed(A, 'writer'),
    oldName: 'writer', newName: 'writer', projects: [A] });
  assert.match(s, /moves this agent to the managed folder/);
  assert.doesNotMatch(s, /renames/);
  assert.match(s, /writer\.md$/m, 'the old path to be deleted is written out');
});

test("if both the name and the folder change both are stated; if neither changes there is no warning", () => {
  const s = noticeSentence({ oldPath: A + '\\.claude\\agents\\writer.md', filePath: managed(A, 'author'),
    oldName: 'writer', newName: 'author', projects: [A] });
  assert.match(s, /renames "writer" to "author"/); assert.match(s, /moves this agent/);
  assert.equal(noticeSentence({ oldPath: managed(A, 'x'), filePath: managed(A, 'x').replace(/\\/g, '/'),
    oldName: 'x', newName: 'x', projects: [A] }), null, 'a difference in separator direction is not a change');
  assert.equal(noticeSentence({ oldPath: null, filePath: managed(A, 'x'), oldName: null, newName: 'x' }), null, 'created agent');
});

test("the warning line calls the pure function; the old hard-coded sentence is gone", () => {
  assert.match(page, /const notice = noticeSentence\(\{ oldPath: r\.oldPath, filePath: r\.filePath, oldName: formOldName, newName: r\.name/);
  assert.equal((page.match(/Saving moves this agent to the managed folder/g) || []).length, 1, 'only inside the pure function');
});
