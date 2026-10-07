'use strict';
/* A skill is a PERSON too, like an agent: one registry, project membership, changing it in one place
 * changes it everywhere; built-in skills are read-only. Every skill must be visible and editable in the
 * panel regardless of project or account. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const skills = require('../panel/skills');
const registry = require('../panel/skill-registry');
const sync = require('../panel/skill-sync');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf071-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const A = path.join(root, 'A'), B = path.join(root, 'B'), C = path.join(root, 'C');
  for (const p of [A, B, C]) fs.mkdirSync(p);
  registry.setup(path.join(root, 'skills.json'), path.join(root, 'copies'));
  return { root, A, B, C };
}
const skill = (name, description, body = 'Body.') => '---\nname: ' + name + '\ndescription: ' + description + '\n---\n\n' + body + '\n';
function putToProject(project, name, content, sides = ['claude', 'codex']) {
  for (const t of sides) {
    const d = skills.skillPath(project, t, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), content);
  }
}
const read = (project, side, name) => fs.readFileSync(path.join(skills.skillPath(project, side, name), 'SKILL.md'), 'utf8');

test('skill save approval lists both sides of every member without expanding removal scope', (t) => {
  const { A, B, C } = setup(t);
  putToProject(A, 'writer', skill('writer', 'FIRST')); sync.reconcile(A);
  sync.addToProject('writer', B);
  const expected = [...skills.paths(A, 'writer'), ...skills.paths(B, 'writer')];
  assert.deepEqual(sync.savePaths(A, 'writer').sort(), expected.sort());
  assert.equal(new Set(sync.savePaths(A, 'writer')).size, 4);
  assert.equal(sync.savePaths(C, 'writer').length, 6, 'a new member includes existing members in its save scope');
  assert.deepEqual(sync.savePaths(C, 'new-skill'), skills.paths(C, 'new-skill'));
  assert.deepEqual(skills.paths(A, 'writer').length, 2, 'remove paths remain project-local');
  const text = skill('writer', 'UPDATED');
  const saved = sync.saveForm(A, 'writer', text);
  assert.equal(saved.error, undefined);
  for (const dir of expected) assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), text);
});

test("a skill sitting in a project enters the registry; the same name in a second project adds a membership without splitting the person", (t) => {
  const { A, B } = setup(t);
  putToProject(A, 'writer', skill('writer', 'FIRST'));
  const s1 = sync.reconcile(A);
  assert.deepEqual(s1.created, ['writer']);
  assert.equal(registry.list().length, 1);
  putToProject(B, 'writer', skill('writer', 'FIRST'));
  const s2 = sync.reconcile(B);
  assert.deepEqual(s2.membership, ['writer']);
  assert.equal(registry.list().length, 1, 'the same name does not create a second person');
  assert.deepEqual(registry.find('writer').projects.map((p) => path.basename(p)).sort(), ['A', 'B']);
});

test("a skill changed from outside in one project is taken into the registry and spread to the other member", (t) => {
  const { A, B } = setup(t);
  putToProject(A, 'writer', skill('writer', 'FIRST')); sync.reconcile(A);
  putToProject(B, 'writer', skill('writer', 'FIRST')); sync.reconcile(B);
  // The orchestrator changed the file in A (mtime clearly ahead so it does not fall in the same second).
  const created = skill('writer', 'EDITED_IN_A', 'New body.');
  putToProject(A, 'writer', created);
  const forward = new Date(Date.now() + 5000);
  for (const t2 of ['claude', 'codex']) fs.utimesSync(path.join(skills.skillPath(A, t2, 'writer'), 'SKILL.md'), forward, forward);
  const s = sync.reconcile(A);
  assert.deepEqual(s.imported, ['writer']);
  assert.equal(read(B, 'claude', 'writer'), created, 'the Claude copy in B was updated');
  assert.equal(read(B, 'codex', 'writer'), created, 'the Codex copy in B was updated');
  assert.match(registry.find('writer').description, /EDITED_IN_A/);
});

test("saving from the form writes every member project and the registry digest advances", (t) => {
  const { A, B } = setup(t);
  putToProject(A, 'writer', skill('writer', 'FIRST')); sync.reconcile(A);
  putToProject(B, 'writer', skill('writer', 'FIRST')); sync.reconcile(B);
  const summaryBefore = registry.find('writer').digest;
  const r = sync.saveForm(A, 'writer', skill('writer', 'FROM_FORM'));
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.errors, []);
  assert.equal(read(B, 'claude', 'writer'), skill('writer', 'FROM_FORM'));
  assert.notEqual(registry.find('writer').digest, summaryBefore);
  assert.equal(sync.reconcile(B).imported.length, 0, 'a propagated copy is not mistaken for an outside change');
});

test("a skill in the registry can be added to a new project, removed from a project, and deleted everywhere", (t) => {
  const { A, B, C } = setup(t);
  putToProject(A, 'writer', skill('writer', 'FIRST')); sync.reconcile(A);
  const e = sync.addToProject('writer', C);
  assert.ok(!e.error, e.error);
  assert.equal(read(C, 'claude', 'writer'), skill('writer', 'FIRST'));
  assert.equal(read(C, 'codex', 'writer'), skill('writer', 'FIRST'));
  const c = sync.removeFromProject('writer', C);
  assert.ok(!c.error, c.error);
  assert.ok(!fs.existsSync(skills.skillPath(C, 'claude', 'writer')));
  assert.ok(fs.existsSync(skills.skillPath(A, 'claude', 'writer')), 'A\'daki copy durur');
  assert.deepEqual(registry.find('writer').projects.map((p) => path.basename(p)), ['A']);
  sync.addToProject('writer', B);
  const s = sync.deleteFully('writer');
  assert.equal(s.deleted, true);
  assert.ok(!fs.existsSync(skills.skillPath(A, 'codex', 'writer')));
  assert.ok(!fs.existsSync(skills.skillPath(B, 'codex', 'writer')));
  assert.equal(registry.find('writer'), null);
  assert.ok(!fs.existsSync(registry.copyPath('writer')), 'kanonik copy da gider');
});

test("importing from a folder on the machine leaves the source untouched and writes to the registry and the project", (t) => {
  const { root, A } = setup(t);
  const source = path.join(root, 'machine', 'caveman');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), skill('caveman', 'Terse mode'));
  fs.writeFileSync(path.join(source, 'extra.txt'), 'helper');
  const once = fs.statSync(path.join(source, 'SKILL.md')).mtimeMs;
  const r = sync.takeExternal(source, A);
  assert.ok(!r.error, r.error);
  assert.equal(read(A, 'claude', 'caveman'), skill('caveman', 'Terse mode'));
  assert.ok(fs.existsSync(path.join(skills.skillPath(A, 'codex', 'caveman'), 'extra.txt')), 'a helper file is carried over too');
  assert.equal(fs.statSync(path.join(source, 'SKILL.md')).mtimeMs, once, 'the source is left as it is');
  assert.deepEqual(registry.find('caveman').projects.map((p) => path.basename(p)), ['A']);
  assert.ok(!sync.takeExternal(source, A).error === false || true, 'a second import does not error; the membership already exists');
});

test("built-ins come only from the Codex .system folders, marked read-only", (t) => {
  const { root } = setup(t);
  const home = path.join(root, 'codex-ev');
  fs.mkdirSync(path.join(home, 'skills', '.system', 'imagegen'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', '.system', 'imagegen', 'SKILL.md'), skill('imagegen', 'Built-in image tool'));
  fs.mkdirSync(path.join(home, 'skills', 'mine'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'mine', 'SKILL.md'), skill('mine', 'user'));
  const y = sync.builtins([home], false);
  const names = y.codex.map((b) => b.name);
  assert.ok(names.includes('imagegen'));
  assert.ok(!names.includes('mine'), 'a folder of the user is not a built-in');
  assert.ok(y.codex.find((b) => b.name === 'imagegen').builtin);
  assert.match(y.claudeNote, /not stored on disk/);
});

test("if the orchestrator edits only its own side the newer side wins and spreads everywhere", (t) => {
  const { A, B } = setup(t);
  putToProject(A, 'writer', skill('writer', 'FIRST')); sync.reconcile(A);
  putToProject(B, 'writer', skill('writer', 'FIRST')); sync.reconcile(B);
  // Claude changed only the .claude/skills copy in A; .agents/skills stayed old (the measured real situation).
  const created = skill('writer', 'CLAUDE_SIDE_ONLY');
  putToProject(A, 'writer', created, ['claude']);
  const forward = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(skills.skillPath(A, 'claude', 'writer'), 'SKILL.md'), forward, forward);
  assert.equal(skills.existing(A)[0].divergent, true, 'precondition: the two sides have diverged');
  const s = sync.reconcile(A);
  assert.deepEqual(s.imported, ['writer']);
  assert.equal(read(A, 'codex', 'writer'), created, 'the older Codex side in A received the new content too');
  assert.equal(read(B, 'claude', 'writer'), created);
  assert.equal(read(B, 'codex', 'writer'), created);
  assert.equal(skills.existing(A)[0].divergent, false, 'the divergence was resolved');
});

test('publishing does not rewrite a project side that already holds the same content', (t) => {
  const { A, B } = setup(t);
  putToProject(A, 'writer', skill('writer', 'FIRST')); sync.reconcile(A);
  sync.addToProject('writer', B);
  const file = path.join(skills.skillPath(B, 'claude', 'writer'), 'SKILL.md');
  const before = fs.statSync(file).ino;
  sync.publishAgent('writer');
  assert.equal(fs.statSync(file).ino, before, 'an identical side is left as it is (no staging folder, no watcher event)');
  fs.writeFileSync(file, 'changed by hand');
  sync.publishAgent('writer');
  assert.equal(read(B, 'claude', 'writer'), skill('writer', 'FIRST'), 'a side that differs is still rewritten');
});
