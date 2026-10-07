'use strict';
/* A count on screen agrees with its noun: "1 run", "2 runs". The run strip said "1 agent runs", the run
   card "1 runs" and the usage line "1 calls". Two checks: the page's counting helper, and a guard
   that no count is glued to a plural noun by hand. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'panel', 'panel.js'), 'utf8');

test('the counting helper uses the singular for one', () => {
  const start = page.indexOf('function countOf(');
  assert.ok(start >= 0, 'panel.js has no countOf helper');
  const box = vm.createContext({});
  vm.runInContext(page.slice(start, page.indexOf('\n}', start) + 2), box);
  const countOf = vm.runInContext('countOf', box);
  assert.equal(countOf(1, 'run', 'runs'), '1 run');
  assert.equal(countOf(0, 'run', 'runs'), '0 runs');
  assert.equal(countOf(2, 'call', 'calls'), '2 calls');
});

test('no count is joined to a plural noun by hand', () => {
  const lines = page.split('\n').map((l, i) => [i + 1, l])
    .filter(([, l]) => /\+ ["'] ?(agent )?(runs|calls)\b/.test(l));
  assert.deepEqual(lines, []);
});

/* "1 project(s)" and "3 agent(s)": the same count written with "(s)" instead of choosing the noun
   (first real-use trial, 23 September). Every on-screen count goes through countOf. */
test('no on-screen text writes a plural as "(s)"', () => {
  const lines = page.split('\n').map((l, i) => [i + 1, l.trim()])
    .filter(([, l]) => !/^(\/\/|\*|\/\*)/.test(l) && /["'][^"']* [a-z]+\(s\)/.test(l));
  assert.deepEqual(lines, []);
});

/* The two "Delete everywhere" questions, for an agent and for a skill, listed the projects
   differently: the agent's by folder name, the skill's by full path. Both use one list now. */
test('both delete-everywhere questions list the projects the same way', () => {
  const start = page.indexOf('function removalList(');
  assert.ok(start >= 0, 'panel.js has no removalList helper');
  const box = vm.createContext({});
  for (const name of ['function folderName(', 'function countOf(', 'function removalList(']) {
    const at = page.indexOf(name);
    vm.runInContext(page.slice(at, page.indexOf('\n}', at) + 2), box);
  }
  const removalList = vm.runInContext('removalList', box);
  assert.equal(removalList(['C:\\work\\alpha']), 'It will be removed from 1 project:\n  alpha');
  assert.equal(removalList(['C:\\work\\alpha', '/home/me/beta/']), 'It will be removed from 2 projects:\n  alpha\n  beta');
  assert.equal(page.split('removalList(').length - 1, 4, 'the helper and its three callers (skills outside the project too)');
});
