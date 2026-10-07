'use strict';
/* SEEING A PROJECT IS NOT EDITING IT.
 * The program must integrate into any project at once: it must detect the existing agents and present
 * them in the panel directly.
 * Adding a project finds the agents and skills already in it and changes none of its files --
 * not even when another project holds a same-named definition with different content, and not
 * when a project's own Claude and Codex copies of a skill differ. An edit made after the panel
 * has seen a file is still carried to the other projects. Expected contents are written out here. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const skills = require('../panel/skills');
const skillRegistry = require('../panel/skill-registry');
const skillSync = require('../panel/skill-sync');
const agentRegistry = require('../panel/agent-registry');
const agentSync = require('../panel/agent-sync');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'untouched-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const A = path.join(root, 'A'), B = path.join(root, 'B');
  for (const p of [A, B]) fs.mkdirSync(p);
  skillRegistry.setup(path.join(root, 'skills.json'), path.join(root, 'copies'));
  agentRegistry.setup(path.join(root, 'agents.json'));
  return { A, B };
}
const skill = (name, description, body) => '---\nname: ' + name + '\ndescription: ' + description + '\n---\n\n' + body + '\n';
function putSkill(project, side, name, content) {
  const d = skills.skillPath(project, side, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), content);
}
const readSkill = (project, side, name) => fs.readFileSync(path.join(skills.skillPath(project, side, name), 'SKILL.md'), 'utf8');
const agentFile = (project, name) => path.join(project, '.claude', 'agents', name + '.md');
function putAgent(project, name, body) {
  fs.mkdirSync(path.dirname(agentFile(project, name)), { recursive: true });
  fs.writeFileSync(agentFile(project, name), '---\nname: ' + name + '\ndescription: reviews\n---\n\n' + body + '\n');
}
/** Every file under a project, with its content: a project is untouched when this is unchanged. */
function tree(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
  } };
  walk(dir);
  return out;
}

test('adding two projects with same-named skills and agents of different content changes no file', (t) => {
  const { A, B } = setup(t);
  for (const side of ['claude', 'codex']) putSkill(A, side, 'writer', skill('writer', 'from A', 'A body.'));
  for (const side of ['claude', 'codex']) putSkill(B, side, 'writer', skill('writer', 'from B', 'B body.'));
  putAgent(A, 'reviewer', 'A task.');
  putAgent(B, 'reviewer', 'B task.');
  const beforeA = tree(A), beforeB = tree(B);

  for (const p of [A, B, A, B]) { skillSync.reconcile(p); agentSync.reconcile(p); }

  assert.deepEqual(tree(A), beforeA, 'project A is unchanged');
  assert.deepEqual(tree(B), beforeB, 'project B is unchanged');
  assert.deepEqual(skillRegistry.find('writer').projects.map((p) => path.basename(p)).sort(), ['A', 'B'],
    'the skill is found in both projects');
  const reviewer = agentRegistry.find('reviewer');
  assert.deepEqual(reviewer.projects.map((p) => path.basename(p)), ['A'], 'the first definition keeps the name');
  assert.equal(agentRegistry.hasConflict(reviewer), true, 'the other definition locks the name instead of joining it');
});

test("a project whose Claude and Codex copies of a skill differ is left as it is", (t) => {
  const { A } = setup(t);
  putSkill(A, 'claude', 'notes', skill('notes', 'claude side', 'Claude body.'));
  putSkill(A, 'codex', 'notes', skill('notes', 'codex side', 'Codex body.'));
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(skills.skillPath(A, 'codex', 'notes'), 'SKILL.md'), past, past);
  const before = tree(A);

  skillSync.reconcile(A); skillSync.reconcile(A);

  assert.deepEqual(tree(A), before);
});

test('an edit to a skill the panel has already seen is still carried to its other projects', (t) => {
  const { A, B } = setup(t);
  for (const side of ['claude', 'codex']) putSkill(A, side, 'writer', skill('writer', 'shared', 'Same body.'));
  for (const side of ['claude', 'codex']) putSkill(B, side, 'writer', skill('writer', 'shared', 'Same body.'));
  skillSync.reconcile(A); skillSync.reconcile(B);   // first sight: nothing written

  const later = new Date(Date.now() + 5000);
  putSkill(B, 'claude', 'writer', skill('writer', 'shared', 'Edited in B.'));
  fs.utimesSync(path.join(skills.skillPath(B, 'claude', 'writer'), 'SKILL.md'), later, later);
  skillSync.reconcile(B);

  assert.match(readSkill(A, 'claude', 'writer'), /Edited in B\./, 'the edit reaches project A');
  assert.match(readSkill(B, 'codex', 'writer'), /Edited in B\./, "and B's other side");
});
