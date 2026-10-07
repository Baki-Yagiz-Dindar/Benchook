'use strict';
// PROJECT MEMBERSHIP WHEN AN OUTSIDE DEFINITION IS TAKEN IN.
// 
// THE DEFECT: when the definition file of an agent was copied into a second project from outside, the
// panel saw it and applied the definition to the registry -- but did not add that project to the
// MEMBERSHIP of the agent. The cause: `update` always carried the `projects` field over from the old record.
// 
// THE CONSEQUENCE: the file sits in the second project and appears in the panel, but because the agent
// does not count as active there, later central changes DO NOT SPREAD to it. The user believes they see
// the same person in two projects while one of them quietly goes stale - a direct breach of the
// promise that changing it in one place changes it everywhere.
// 
// THE DISTINCTION IS KEPT: taking a new agent in and linking an existing agent to a new project are
// different intents; they need not give the same result, but both must establish membership.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../panel/agent-registry');
const sync = require('../panel/agent-sync');

function field() {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-membership-'));
  registry.setup(path.join(k, 'agents.json'));
  const project = (name) => {
    const y = path.join(k, name);
    fs.mkdirSync(path.join(y, '.benchook', 'agents'), { recursive: true });
    return y;
  };
  return { k, project, cleanup: () => fs.rmSync(k, { recursive: true, force: true }) };
}
const sample = (extra = {}) => ({ name: 'auditor', description: 'Code incelenecekse', account: 'orchestrator',
  model: 'orchestrator', task: 'First instruction.', ...extra });
const read = (y) => fs.readFileSync(y, 'utf8');
const filePath = (p, name) => path.join(p, '.benchook', 'agents', name + '.md');

/** An agent published in A, and its file copied into B by hand. */
function copy(t, change) {
  const a = field(); t.after(a.cleanup);
  const p1 = a.project('one'), p2 = a.project('two');
  registry.add(sample({ projects: [p1] }));
  sync.publishAgent(registry.find('auditor'));
  let content = read(filePath(p1, 'auditor'));
  if (change) content = change(content);
  fs.writeFileSync(filePath(p2, 'auditor'), content);
  return { a, p1, p2 };
}

test("a definition copied in from outside makes the agent a MEMBER of that project", (t) => {
  const { p1, p2 } = copy(t);

  const r = sync.reconcile(p2);

  assert.deepEqual(r.errors, []);
  assert.equal(registry.isInProject(registry.find('auditor'), p2), true,
    'seeing the file must establish membership, otherwise later changes never reach it');
  assert.equal(registry.find('auditor').projects.length, 2);
});

test("after membership a central change reaches the second project TOO", (t) => {
  const { p1, p2 } = copy(t);
  sync.reconcile(p2);

  const g = registry.update('auditor', { task: 'The next instruction.' });
  const y = sync.publishAgent(g.agent);

  assert.deepEqual(y.errors, []);
  assert.match(read(filePath(p1, 'auditor')), /The next instruction\./);
  assert.match(read(filePath(p2, 'auditor')), /The next instruction\./,
    'changing it in one place changes it everywhere');
});

test("a repeated scan does not DUPLICATE membership and does not write needlessly", (t) => {
  const { p2 } = copy(t);
  sync.reconcile(p2);

  const second = sync.reconcile(p2);
  const third = sync.reconcile(p2);

  assert.equal(registry.find('auditor').projects.length, 2, 'the same project must not be added twice');
  assert.deepEqual(second.changed, [], 'a settled file must not count as changed');
  assert.deepEqual(third.changed, []);
});

/* SEEING A PROJECT IS NOT EDITING IT. A same-named agent with
   different content in a newly seen project joins that project, and neither project's file is
   rewritten. Replaces the earlier expectation that the newly seen copy was pushed into the first
   project. A later edit to a file the panel has already seen is still carried everywhere. */
test('a same-named agent with different content in a newly seen project is locked, and no file changes', (t) => {
  const { p1, p2 } = copy(t, (s) => s.replace('First instruction.', 'An instruction changed by hand.'));
  const before1 = read(filePath(p1, 'auditor')), before2 = read(filePath(p2, 'auditor'));

  sync.reconcile(p2);

  const a = registry.find('auditor');
  assert.equal(registry.isInProject(a, p2), false, 'a different agent is not joined to this one');
  assert.equal(registry.hasConflict(a), true, 'the name is locked');
  assert.equal(read(filePath(p1, 'auditor')), before1, 'the first project is not rewritten');
  assert.equal(read(filePath(p2, 'auditor')), before2, 'the newly seen project is not rewritten');
  assert.equal(a.task, 'First instruction.', 'the agent keeps the definition it already had');
  assert.deepEqual(sync.reconcile(p2).changed, [], 'seeing it again is not a change');
});

test('an edit made after the panel has seen the file is carried to the other project', (t) => {
  const { p1, p2 } = copy(t);   // an identical copy: the same agent
  sync.reconcile(p2);   // first sight: joined, nothing written

  fs.writeFileSync(filePath(p2, 'auditor'),
    read(filePath(p2, 'auditor')).replace('First instruction.', 'Later edit.'));
  sync.reconcile(p2);

  assert.equal(registry.find('auditor').task, 'Later edit.');
  assert.match(read(filePath(p1, 'auditor')), /Later edit\./, 'a real edit still reaches every project');
});

test("a NEW name taken in becomes a member of that project only", (t) => {
  const a = field(); t.after(a.cleanup);
  const p1 = a.project('one'), p2 = a.project('two');
  registry.add(sample({ projects: [p1] }));
  sync.publishAgent(registry.find('auditor'));
  fs.writeFileSync(filePath(p2, 'created-agent'),
    ['---', 'name: created-agent', 'description: created outside', '---', '', 'Task.', ''].join('\n'));

  sync.reconcile(p2);

  const created = registry.find('created-agent');
  assert.ok(created, 'an agent created outside must enter the registry');
  assert.deepEqual(created.projects.map((x) => path.basename(x)), ['two'],
    'a new agent must belong only to the project it was found in');
  assert.equal(registry.find('auditor').projects.length, 1, 'the other agent membership must not change');
});

/* THE TWO FORMS OF A MISSING TARGET BEHAVE DIFFERENTLY - the expected behaviour of the missing-target
   scenario has to be on record. The decision is made and tested here. */

test("if only the agent folder was deleted the panel rebuilds it and writes", (t) => {
  const { p1, p2 } = copy(t);
  sync.reconcile(p2);
  // The agent folder is gone but the PROJECT stands. That folder is the own area of the panel; recreating it is normal.
  fs.rmSync(path.join(p2, '.benchook'), { recursive: true, force: true });

  const g = registry.update('auditor', { task: 'The next instruction.' });
  const y = sync.publishAgent(g.agent);

  assert.deepEqual(y.errors, []);
  assert.match(read(filePath(p1, 'auditor')), /The next instruction\./);
  assert.match(read(filePath(p2, 'auditor')), /The next instruction\./);
});

test("if the WHOLE PROJECT was deleted the panel does NOT recreate it; it says so", (t) => {
  const { p1, p2 } = copy(t);
  sync.reconcile(p2);
  fs.rmSync(p2, { recursive: true, force: true });

  const g = registry.update('auditor', { task: 'The next instruction.' });
  const y = sync.publishAgent(g.agent);

  assert.equal(fs.existsSync(p2), false, 'a project folder the user deleted must not come back');
  assert.match(read(filePath(p1, 'auditor')), /The next instruction\./, 'a reachable project must be written');
  assert.equal(y.written.length, 1);
  assert.equal(y.errors.length, 1, 'an unreachable target must not stay silent');
  assert.match(y.errors[0].error, /no longer exists/);
  assert.equal(registry.isInProject(registry.find('auditor'), p2), true,
    'membership is not dropped: if the project returns, publishing completes on its own');
});

test("once the project returns the missing publish completes", (t) => {
  const { p2 } = copy(t);
  sync.reconcile(p2);
  fs.rmSync(p2, { recursive: true, force: true });
  const g = registry.update('auditor', { task: 'The next instruction.' });
  sync.publishAgent(g.agent);

  fs.mkdirSync(path.join(p2, '.benchook', 'agents'), { recursive: true });
  const y = sync.publishAgent(registry.find('auditor'));

  assert.deepEqual(y.errors, []);
  assert.match(read(filePath(p2, 'auditor')), /The next instruction\./);
});
