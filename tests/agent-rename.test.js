'use strict';
// RENAMING WHILE PRESERVING THE IDENTITY.
// 
// THE DEFECT, MEASURED (real modules): changing the name in an open form in A and saving did not rename
// the agent, it created A SECOND AGENT.
// 
// agents in the registry: ["auditor","supervisor"]
// folder A: ["auditor.md","supervisor.md"]   <- the old definition was left orphaned
// folder B: ["auditor.md"]                    <- the other project never heard about it
// 
// So one person split into two identities, the old files were left lying around, and the other
// projects the agent was active in went on living under the old name.
// 
// THE ROOT CAUSE: the identity is the name at the moment the form OPENED, while the save looked only at
// the NAME in the form. When the new name was not found in the registry it counted as a new agent.
// 
// THE ORDER MATTERS: the old file is deleted only after the new name was written SUCCESSFULLY to that
// project. The reverse would mean deleting the agent from that project altogether when the write failed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../panel/agent-registry');
const sync = require('../panel/agent-sync');
const writeAgent = require('../panel/agent-writer');

function field() {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 're-name-'));
  registry.setup(path.join(k, 'agents.json'));
  const project = (name) => {
    const y = path.join(k, name);
    fs.mkdirSync(path.join(y, '.benchook', 'agents'), { recursive: true });
    return y;
  };
  return { k, project, cleanup: () => fs.rmSync(k, { recursive: true, force: true }) };
}
const folder = (p) => path.join(p, '.benchook', 'agents');
const files = (p) => fs.readdirSync(folder(p)).sort();
const read = (y) => fs.readFileSync(y, 'utf8');

/** One agent active in two projects. */
function twoProject(t) {
  const a = field(); t.after(a.cleanup);
  const A = a.project('project-A'), B = a.project('project-B');
  registry.add({ name: 'auditor', description: 'Code incelenecekse', account: 'personal', model: 'opus',
    task: 'Read and report.', projects: [A, B] });
  const y = sync.publishAgent(registry.find('auditor'));
  assert.deepEqual(y.errors, []);
  return { a, A, B };
}

/** The save call of the page: the identity is the name at the moment the form OPENED. */
const save = (project, oldName, newName, extra = {}) => sync.saveForm({
  project, oldName, name: newName, intent: 'edit',
  content: registry.text({ ...(registry.find(oldName) || {}), name: newName, ...extra }),
});

/* ---- RENAMING ---- */

test("a name change renames the SAME agent; no second person is born", (t) => {
  const { A, B } = twoProject(t);

  const r = save(A, 'auditor', 'supervisor');

  assert.ok(!r.error, r.error);
  assert.equal(registry.list().length, 1, 'only one person may remain');
  assert.ok(registry.find('supervisor'), 'the new name must be in the registry');
  assert.equal(registry.find('auditor'), null, 'the old id must be gone');
  assert.equal(r.nameChanged, true);
});

test("in EVERY PROJECT it is active in the file moves to the new name, leaving no orphan", (t) => {
  const { A, B } = twoProject(t);

  save(A, 'auditor', 'supervisor');

  assert.deepEqual(files(A), ['supervisor.md'], 'the old definition must not be orphaned');
  assert.deepEqual(files(B), ['supervisor.md'], 'the other project must be renamed too');
  assert.match(read(path.join(folder(B), 'supervisor.md')), /name: supervisor/);
});

test("memberships and fields are preserved", (t) => {
  const { A, B } = twoProject(t);

  save(A, 'auditor', 'supervisor');

  const record = registry.find('supervisor');
  assert.equal(record.projects.length, 2);
  assert.equal(registry.isInProject(record, A), true);
  assert.equal(registry.isInProject(record, B), true);
  assert.equal(record.account, 'personal');
  assert.equal(record.model, 'opus');
  assert.equal(record.task, 'Read and report.');
});

test("fields the form does not show are not lost on a rename either", (t) => {
  const { A } = twoProject(t);
  registry.update('auditor', { extraFrontmatter: ['permissionMode: plan'] });
  sync.publishAgent(registry.find('auditor'));

  save(A, 'auditor', 'supervisor');

  assert.deepEqual(registry.find('supervisor').extraFrontmatter, ['permissionMode: plan']);
  assert.match(read(path.join(folder(A), 'supervisor.md')), /permissionMode: plan/);
});

/* ---- CLASHES AND LETTER CASE ---- */

test("taking over another name is REFUSED and nothing changes", (t) => {
  const { A } = twoProject(t);
  registry.add({ name: 'writer', description: 'For when text has to be written', account: 'personal', model: 'opus',
    task: 'Write.', projects: [A] });
  sync.publishAgent(registry.find('writer'));

  const r = save(A, 'auditor', 'writer');

  assert.ok(r.error, 'a move to a clashing name must be refused');
  assert.match(r.error, /already exists/);
  assert.ok(registry.find('auditor'), 'the old id must stand');
  assert.equal(registry.find('writer').task, 'Write.', 'the other agent must NOT change');
  assert.deepEqual(files(A), ['auditor.md', 'writer.md']);
});

test("a change of letter case alone does not delete the file", (t) => {
  const { A, B } = twoProject(t);

  const r = save(A, 'auditor', 'Auditor');

  assert.ok(!r.error, r.error);
  assert.equal(registry.list().length, 1, 'the same person; no second record may be created');
  assert.equal(registry.find('auditor').name, 'Auditor', 'the spelling must be updated');
  for (const p of [A, B]) {
    assert.equal(files(p).length, 1, 'only one file may remain: ' + files(p).join(','));
    assert.match(read(path.join(folder(p), files(p)[0])), /name: Auditor/,
      'the file must be neither deleted nor left with the old content');
  }
});

/* ---- HALF-FINISHED RENAME ---- */

test("in a project where the new name cannot be written the OLD file is not deleted", (t) => {
  const { A, B } = twoProject(t);
  fs.rmSync(B, { recursive: true, force: true });   // B is unreachable

  const r = save(A, 'auditor', 'supervisor');

  assert.deepEqual(files(A), ['supervisor.md'], 'a reachable project must be renamed');
  assert.ok(r.publishErrors.length >= 1, 'an unreachable target must not stay silent');
  assert.equal(registry.isInProject(registry.find('supervisor'), B), true,
    'membership is not dropped: if the project returns the rename completes');
});

test("if the old file cannot be deleted it is REPORTED and can be retried", (t) => {
  const { A, B } = twoProject(t);
  const old = path.join(folder(B), 'auditor.md');
  const actual = fs.unlinkSync;
  fs.unlinkSync = function (y, ...remaining) {
    if (path.resolve(String(y)) === path.resolve(old)) {
      throw Object.assign(new Error('fixture unlink blocked'), { code: 'EPERM' });
    }
    return actual.call(fs, y, ...remaining);
  };
  let r;
  try { r = save(A, 'auditor', 'supervisor'); } finally { fs.unlinkSync = actual; }

  assert.ok(!r.error, 'the rename itself succeeded');
  assert.deepEqual(files(B).sort(), ['auditor.md', 'supervisor.md'],
    'the new name was written, the old one could not be deleted');
  assert.equal(r.oldNameRemaining.length, 1, 'a leftover old definition must not stay silent');
  assert.equal(r.oldNameRemaining[0].project, B);
  assert.match(r.oldNameRemaining[0].error, /permission/i);

  // Once the block is gone the same path cleans up: the save can be run again.
  const second = sync.saveForm({ project: A, oldName: 'supervisor', name: 'supervisor',
    intent: 'edit', content: registry.text(registry.find('supervisor')) });
  assert.ok(!second.error);
  fs.unlinkSync(path.join(folder(B), 'auditor.md'));
  assert.deepEqual(files(B), ['supervisor.md']);
});

test("a rename touches no file OUTSIDE the agent folder", (t) => {
  const { A, B } = twoProject(t);
  const history = path.join(A, '.benchook', 'runs.json');
  fs.writeFileSync(history, JSON.stringify({ runs: [{ agent: 'auditor', code: 0 }] }));
  const before = read(history);

  save(A, 'auditor', 'supervisor');

  assert.equal(read(history), before,
    'the origin of a past run is not rewritten: that run really did use "auditor"');
});

/* ---- THE PREVIEW AND THE WRITE PROMISE THE SAME THING ---- */

test("for a definition in the old folder the preview says what the write really does", (t) => {
  const a = field(); t.after(a.cleanup);
  const C = path.join(a.k, 'project-C');
  fs.mkdirSync(path.join(C, '.claude', 'agents'), { recursive: true });
  const oldFile = path.join(C, '.claude', 'agents', 'native.md');
  fs.writeFileSync(oldFile, '---\nname: native\ndescription: In the old folder\n---\n\nTask.\n');
  sync.reconcile(C);

  const on = writeAgent.preview(C, { name: 'native', description: 'In the old folder', account: 'orchestrator',
    model: 'orchestrator', task: 'Task.', oldPath: oldFile });

  /* MEASURED: the preview said the agent would move to the managed folder and the old definition WOULD BE
     DELETED, while the real write updated the file in place and deleted nothing. So the panel announced
     a deletion it would not perform. */
  assert.equal(path.resolve(on.filePath), path.resolve(sync.targetPath(C, 'native')),
    'the target of the preview must match the target of the write');
  assert.ok(!on.oldPath || path.resolve(on.oldPath) === path.resolve(on.filePath),
    'a move or delete that will not happen must not be announced');

  const y = sync.saveForm({ project: C, name: 'native', intent: 'edit',
    content: registry.text({ ...registry.find('native'), task: 'A new task.' }) });
  assert.equal(path.resolve(y.filePath), path.resolve(oldFile), 'the file is updated in place');
  assert.match(read(oldFile), /A new task\./);
});

test("renaming a definition in the old folder REPORTS that it moved", (t) => {
  const a = field(); t.after(a.cleanup);
  const C = path.join(a.k, 'project-C');
  fs.mkdirSync(path.join(C, '.claude', 'agents'), { recursive: true });
  const oldFile = path.join(C, '.claude', 'agents', 'native.md');
  fs.writeFileSync(oldFile, '---\nname: native\ndescription: In the old folder\n---\n\nTask.\n');
  sync.reconcile(C);

  const r = sync.saveForm({ project: C, oldName: 'native', name: 'nativeCopy', intent: 'edit',
    content: registry.text({ ...registry.find('native'), name: 'nativeCopy' }) });

  assert.ok(!r.error, r.error);
  assert.equal(fs.existsSync(oldFile), false, 'the old name must be gone');
  assert.ok(fs.existsSync(path.join(C, '.benchook', 'agents', 'nativeCopy.md')));
  assert.equal(r.moved.length, 1, 'if the folder changed the user must be told');
  assert.match(r.moved[0].from, /agents/);
  assert.match(r.moved[0].to, /[.]benchook/);
});

// ---------------------------------------------------------------------------
// THE INTERFACE HALF - the two side effects of a rename are written on screen
//
// `panel.js` runs in the page; it is sliced out of its source and run in an isolated context
// (see tests/panel-state.test.js).
// ---------------------------------------------------------------------------

const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../panel/panel.js'), 'utf8');
const slice = source.slice(source.indexOf('function nameChangeNotes('),
  source.indexOf('async function previewAgent('));
const context = vm.createContext({});
// The page's counting helper, which these sentences now use for their numbers.
vm.runInContext(source.slice(source.indexOf('function countOf('), source.indexOf('\n}', source.indexOf('function countOf(')) + 2), context);
vm.runInContext(slice, context);
const nameChangeNotes = vm.runInContext('nameChangeNotes', context);

test("a clean rename writes nothing extra to the screen", () => {
  assert.deepEqual(nameChangeNotes({ oldNameRemaining: [], moved: [] }), []);
  assert.deepEqual(nameChangeNotes(null), []);
});

test("an old definition that cannot be deleted is shown on screen with what to do", () => {
  const lines = nameChangeNotes({ moved: [], oldNameRemaining: [
    { project: 'C:/projects/two', filePath: 'C:/projects/two/auditor.md',
      error: 'Benchook does not have permission to write there.' }] });
  const text = lines.join('\n');
  assert.match(text, /old name is still there/i);
  assert.match(text, /two/, 'which project it is must be visible');
  assert.match(text, /permission/i, 'the reason must be in the language of the user');
  assert.match(text, /again/, 'the retry path must be written out');
});

test("if the folder changed the move is visible on screen", () => {
  const text = nameChangeNotes({ oldNameRemaining: [], moved: [
    { project: 'C:/p', from: 'C:/p/.claude/agents/native.md',
      to: 'C:/p/.benchook/agents/nativeCopy.md' }] }).join('\n');
  assert.match(text, /Moved:/);
  assert.match(text, /agents/);
  assert.match(text, /[.]benchook/);
});

test("an EDIT with no identity does not silently create a second agent", (t) => {
  const { A } = twoProject(t);

  /* The old page contract: only the NAME in the form is sent. That was the defect itself -- when the new
     name was not found in the registry a second person was created. An explicit error is returned now. */
  const r = sync.saveForm({ project: A, name: 'supervisor', intent: 'edit',
    content: registry.text({ ...registry.find('auditor'), name: 'supervisor' }) });

  assert.ok(r.error, 'an edit with no identity must not be accepted');
  assert.equal(registry.find('supervisor'), null, 'no second person may be born');
  assert.ok(registry.find('auditor'), 'the existing agent must stand');
  assert.deepEqual(files(A), ['auditor.md']);
});

test("even with no explicit id the FILE BEING EDITED gives the identity", (t) => {
  const { A, B } = twoProject(t);

  /* Even when the page does not send the old name it sends which file it opened. The name of that file is
     not a guess but the identity itself; a rename is recognised from there too. */
  const r = sync.saveForm({ project: A, name: 'supervisor', intent: 'edit',
    oldPath: path.join(folder(A), 'auditor.md'),
    content: registry.text({ ...registry.find('auditor'), name: 'supervisor' }) });

  assert.ok(!r.error, r.error);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.find('auditor'), null);
  assert.deepEqual(files(A), ['supervisor.md']);
  assert.deepEqual(files(B), ['supervisor.md']);
});
