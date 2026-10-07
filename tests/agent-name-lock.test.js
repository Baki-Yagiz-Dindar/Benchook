'use strict';
/* SAME NAME, DIFFERENT AGENTS: LOCKED.
 * If two agents with the same name enter the panel in any way, they must be blocked so nobody changes them
 * by mistake; only renaming stays active.
 * While two different definitions share a name, every change is refused except renaming one copy,
 * and that rename touches only the renamed file. Expected values are written out by hand here. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../panel/agent-registry');
const sync = require('../panel/agent-sync');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'name-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  registry.setup(path.join(root, 'agents.json'));
  const A = path.join(root, 'A'), B = path.join(root, 'B');
  for (const p of [A, B]) fs.mkdirSync(p);
  return { A, B };
}
const file = (p, name, folder = ['.claude', 'agents']) => path.join(p, ...folder, name + '.md');
function put(p, name, task, folder) {
  const f = file(p, name, folder);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '---\nname: ' + name + '\ndescription: reviews code\nmodel: sonnet\n---\n\n' + task + '\n');
  return f;
}
const read = (f) => fs.readFileSync(f, 'utf8');
function twoDifferent(t) {
  const { A, B } = setup(t);
  const fa = put(A, 'reviewer', 'Task in A.'), fb = put(B, 'reviewer', 'Task in B.');
  sync.reconcile(A); sync.reconcile(B);
  return { A, B, fa, fb };
}

test('two different agents with one name are locked, and every change but a rename is refused', (t) => {
  const { A, B, fa, fb } = twoDifferent(t);
  const before = [read(fa), read(fb)];
  assert.equal(registry.hasConflict(registry.find('reviewer')), true);

  const edited = read(fa).replace('Task in A.', 'Changed.');
  assert.equal(sync.saveForm({ project: A, name: 'reviewer', content: edited, intent: 'edit', oldName: 'reviewer' }).locked, true);
  assert.equal(sync.deleteFully('reviewer').locked, true);
  assert.equal(sync.removeFromProject('reviewer', A).locked, true);
  assert.equal(sync.addToProject('reviewer', B).locked, true);
  assert.deepEqual([read(fa), read(fb)], before, 'no file changed');
});

test('renaming the copy in the project that holds the other definition changes only its name line', (t) => {
  const { A, B, fa, fb } = twoDifferent(t);
  const beforeA = read(fa), beforeB = read(fb);

  const r = sync.renameCopy(B, 'reviewer', 'reviewer-b', fb);

  assert.equal(r.renamed, true, r.error);
  const nb = file(B, 'reviewer-b');
  assert.equal(fs.existsSync(fb), false);
  assert.equal(read(nb), beforeB.replace('name: reviewer\n', 'name: reviewer-b\n'), 'only the name line differs');
  assert.equal(read(fa), beforeA, 'the other project is untouched');
  assert.equal(registry.hasConflict(registry.find('reviewer')), false, 'the lock is gone');
  assert.deepEqual(registry.find('reviewer-b').projects.map((p) => path.basename(p)), ['B']);
});

test("renaming the locked agent's own copy frees the name for the other project's definition", (t) => {
  const { A, B, fa, fb } = twoDifferent(t);
  const beforeB = read(fb);

  assert.equal(sync.renameCopy(A, 'reviewer', 'reviewer-a', fa).renamed, true);
  sync.reconcile(B);

  assert.equal(read(fb), beforeB, 'the other project is untouched');
  const rest = registry.find('reviewer');
  assert.deepEqual(rest.projects.map((p) => path.basename(p)), ['B'], "B's definition now holds the name");
  assert.equal(registry.hasConflict(rest), false);
  assert.equal(rest.task, 'Task in B.');
});

test('a rename to the same, an invalid or a taken name is refused and nothing moves', (t) => {
  const { A, B, fb } = twoDifferent(t);
  put(A, 'taken', 'Another agent.'); sync.reconcile(A);
  const before = read(fb);
  for (const name of ['reviewer', 'Bad Name', 'taken']) {
    assert.ok(sync.renameCopy(B, 'reviewer', name, fb).error, name);
  }
  assert.equal(read(fb), before);
});

test('identical copies are the same agent and are not locked', (t) => {
  const { A, B } = setup(t);
  put(A, 'reviewer', 'Same task.'); put(B, 'reviewer', 'Same task.');
  sync.reconcile(A); sync.reconcile(B);
  const a = registry.find('reviewer');
  assert.equal(registry.hasConflict(a), false);
  assert.deepEqual(a.projects.map((p) => path.basename(p)).sort(), ['A', 'B']);
});

test('two different definitions of one name inside a single project are locked too', (t) => {
  const { A } = setup(t);
  put(A, 'reviewer', 'In the panel folder.', ['.benchook', 'agents']);
  put(A, 'reviewer', 'In the Claude folder.');
  sync.reconcile(A);
  assert.equal(registry.hasConflict(registry.find('reviewer')), true);
});

test('the lock lifts when the other definition leaves its project', (t) => {
  const { B, fb } = twoDifferent(t);
  fs.unlinkSync(fb);
  sync.reconcile(B);
  assert.equal(registry.hasConflict(registry.find('reviewer')), false);
});
