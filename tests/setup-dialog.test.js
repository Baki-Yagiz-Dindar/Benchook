'use strict';
/* The project setup confirmation must say what happens to each file. The plan marks every step with
   `kind` (create / update / repair); the page read a field that does not exist, so every line of the
   dialog ended in "(undefined)". The dialog text is built here from the page's own source and a real
   plan for a temporary project. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const setup = require('../panel/project-setup');

const page = fs.readFileSync(path.join(__dirname, '..', 'panel', 'panel.js'), 'utf8');
const start = page.indexOf('  const describe = {');
const end = page.indexOf("].join('\\n');", start) + "].join('\\n');".length;

test('the setup confirmation names the action for every file', (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-dialog-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const p = setup.plan(project);
  assert.ok(p.steps.length > 0, 'a fresh project needs setup steps');
  const box = vm.createContext({ p });
  vm.runInContext(page.slice(start, end) + '\nthis.question = question;', box);
  assert.doesNotMatch(box.question, /undefined/);
  for (const step of p.steps) assert.ok(box.question.includes(step.file + '  (Create)'), 'no action shown for ' + step.file);
});
