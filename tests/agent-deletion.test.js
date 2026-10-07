'use strict';
// PARTIAL DELETION AND REMOVAL-FROM-PROJECT CONSISTENCY.
// 
// THE DEFECT (two of them, from the same root):
// 
// 1. Deleting everywhere COLLECTED the delete errors in the project files but deleted the central
// record UNCONDITIONALLY. When a file could not be deleted in one project, the identity of the
// agent left the registry while the file stayed. The next time that project was read the
// leftover file was taken in as a NEW agent: same name, new identity, a single membership. The
// user said delete and the agent came back - even looking like the same account and model.
// 
// 2. Removing from a project removed the membership from the registry FIRST and deleted the file
// AFTERWARDS. When the delete failed, the membership was gone and the file remained; the next
// scan saw the file and restored the membership. The removal by the user silently
// undid itself.
// 
// THE CHOSEN FIX -- A PENDING DELETION, NOT A FULL ROLLBACK. Rolling back (writing back the files
// that could be deleted) was rejected: the user said delete, and the panel putting those files BACK
// would override that decision. Instead the record stays in the registry as a PENDING DELETION, its
// membership consists only of the targets that could not be deleted, it does not publish, it is
// not offered as an addable agent, and it completes by itself once the block is gone. The name is
// RESERVED meanwhile: giving a half-deleted name to someone else would create a second identity mix-up.
// 
// LIMIT: here the delete error is injected in a controlled way (`fs.unlinkSync` EPERM). A real
// Windows file lock or permission denial was NOT measured separately; what is measured is the
// behaviour of the panel at the moment of the error.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../panel/agent-registry');
const sync = require('../panel/agent-sync');

/** A temporary data root and temporary projects - the personal registry and real agent files are never used. */
function field() {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deletion-'));
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
const filePath = (p, name) => path.join(p, '.benchook', 'agents', name + '.md');
const read = (y) => fs.readFileSync(y, 'utf8');

/** One agent published in two projects. */
function twoProject(t) {
  const a = field(); t.after(a.cleanup);
  const p1 = a.project('one'), p2 = a.project('two');
  registry.add(sample({ projects: [p1, p2] }));
  const y = sync.publishAgent(registry.find('auditor'));
  assert.deepEqual(y.errors, [], 'setup: it must have been written to both projects');
  return { a, p1, p2 };
}

/** Blocks the deletion of a given path - the controlled stand-in for a locked or permission-denied file. */
function blockDeletion(t, target) {
  const actual = fs.unlinkSync;
  fs.unlinkSync = function (y, ...remaining) {
    if (path.resolve(String(y)) === path.resolve(target)) {
      throw Object.assign(new Error('fixture unlink blocked'), { code: 'EPERM' });
    }
    return actual.call(fs, y, ...remaining);
  };
  const remove = () => { fs.unlinkSync = actual; };
  t.after(remove);
  return remove;
}

/* ---- DELETING EVERYWHERE ---- */

test("when every file can be deleted the record goes too", (t) => {
  const { p1, p2 } = twoProject(t);

  const r = sync.deleteFully('auditor');

  assert.equal(fs.existsSync(filePath(p1, 'auditor')), false);
  assert.equal(fs.existsSync(filePath(p2, 'auditor')), false);
  assert.equal(registry.find('auditor'), null, 'a completed deletion must empty the registry as well');
  assert.deepEqual(r.errors, []);
  assert.equal(r.deleted, 'auditor');
  assert.deepEqual(r.pending, []);
});

test("if one file cannot be deleted the central id is not left ORPHANED", (t) => {
  const { p1, p2 } = twoProject(t);
  blockDeletion(t, filePath(p2, 'auditor'));

  const r = sync.deleteFully('auditor');

  assert.equal(fs.existsSync(filePath(p1, 'auditor')), false, 'silinebilen file silinmeli');
  assert.equal(fs.existsSync(filePath(p2, 'auditor')), true, 'a file that cannot be deleted stays in place');
  const record = registry.find('auditor');
  assert.ok(record, 'the central record is kept until the work finishes');
  assert.equal(record.deletionPending, true, 'the record must stand as a PENDING DELETION');
  assert.deepEqual(record.projects, [p2], 'membership must remain only on the target that could not be deleted');
  assert.equal(r.deleted, null, 'the work did not finish; it must not be reported as finished');
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].project, p2, 'which target failed must be visible');
  assert.match(r.errors[0].error, /permission/i, 'the reason must be in the language of the user');
  assert.deepEqual(r.pending, [p2], 'the remaining targets must be returned so it can be retried');
});

test("a file left over from a half deletion does NOT re-create the agent", (t) => {
  const { p2 } = twoProject(t);
  blockDeletion(t, filePath(p2, 'auditor'));
  sync.deleteFully('auditor');

  const r = sync.reconcile(p2);

  const record = registry.find('auditor');
  assert.equal(record.deletionPending, true, 'a scan must not turn a pending deletion into an active agent');
  assert.deepEqual(r.changed, [], 'a leftover file must not count as a new agent or as changed');
  assert.equal(registry.list().length, 1, 'no second record may be produced');
});

test("once the block is gone the same button COMPLETES the deletion", (t) => {
  const { p2 } = twoProject(t);
  const remove = blockDeletion(t, filePath(p2, 'auditor'));
  sync.deleteFully('auditor');
  remove();

  const r = sync.deleteFully('auditor');

  assert.equal(fs.existsSync(filePath(p2, 'auditor')), false);
  assert.equal(registry.find('auditor'), null, 'once the block is gone the record must go too');
  assert.deepEqual(r.errors, []);
  assert.equal(r.deleted, 'auditor');
});

test("once the block is gone a project scan completes the deletion too", (t) => {
  const { p2 } = twoProject(t);
  const remove = blockDeletion(t, filePath(p2, 'auditor'));
  sync.deleteFully('auditor');
  remove();

  const r = sync.reconcile(p2);

  assert.equal(fs.existsSync(filePath(p2, 'auditor')), false, 'if the block is gone the file must go');
  assert.equal(registry.find('auditor'), null);
  assert.deepEqual(r.changed, []);
  assert.deepEqual(r.errors, []);
});

test("if the user deleted the file themselves the record does not stay stuck", (t) => {
  const { p2 } = twoProject(t);
  const remove = blockDeletion(t, filePath(p2, 'auditor'));
  sync.deleteFully('auditor');
  remove();
  fs.unlinkSync(filePath(p2, 'auditor'));   // what removed the obstacle may have been the user

  const r = sync.deleteFully('auditor');

  assert.equal(registry.find('auditor'), null, 'if the target is already gone the deletion counts as complete');
  assert.deepEqual(r.errors, []);
});

test("a pending deletion does NOT sync - a deleted file does not come back", (t) => {
  const { p1, p2 } = twoProject(t);
  blockDeletion(t, filePath(p2, 'auditor'));
  sync.deleteFully('auditor');

  const y = sync.publishAgent(registry.find('auditor'));

  assert.equal(fs.existsSync(filePath(p1, 'auditor')), false, 'a removed path must not be restored by publishing');
  assert.deepEqual(y.written, []);
  assert.ok(y.errors.length >= 1, 'silently doing nothing would be a lie as well');
});

test("during a pending deletion the agent CANNOT be added to a project", (t) => {
  const a = field(); t.after(a.cleanup);
  const p1 = a.project('one'), p2 = a.project('two'), p3 = a.project('uc');
  registry.add(sample({ projects: [p1, p2] }));
  sync.publishAgent(registry.find('auditor'));
  blockDeletion(t, filePath(p2, 'auditor'));
  sync.deleteFully('auditor');

  const r = sync.addToProject('auditor', p3);

  assert.ok(r.error, 'a half-deleted agent must not be added to a new project');
  assert.equal(fs.existsSync(filePath(p3, 'auditor')), false);
  assert.equal(registry.isInProject(registry.find('auditor'), p3), false);
});

test("while a deletion is pending the name is RESERVED", (t) => {
  const { p2 } = twoProject(t);
  blockDeletion(t, filePath(p2, 'auditor'));
  sync.deleteFully('auditor');

  const r = registry.add(sample({ name: 'auditor', projects: [] }));

  assert.ok(r.error, 'a half-removed name must not be handed to a second person');
  assert.equal(registry.list().length, 1);
});

test("an explicit save CANCELS the pending deletion", (t) => {
  const { p2 } = twoProject(t);
  blockDeletion(t, filePath(p2, 'auditor'));
  sync.deleteFully('auditor');

  /* Pressing Save in the form (main.js `agent:write` -> `registry.update`) is the user saying this
     agent is to exist; a half-finished deletion ends there. The only place that sets the flag is the
     delete path, so the only place to clear it is an explicit edit. */
  const g = registry.update('auditor', { task: 'Changed my mind, keep it.' });

  assert.equal(g.agent.deletionPending, false, 'an explicit edit must clear the pending deletion');
  const y = sync.publishAgent(registry.find('auditor'));
  assert.deepEqual(y.errors, []);
  assert.match(read(filePath(p2, 'auditor')), /Changed my mind, keep it\./, 'publishing must work after the cancellation');
});

test("a file in a place that is not on the pending-deletion list is left untouched", (t) => {
  const a = field(); t.after(a.cleanup);
  const p1 = a.project('one'), p2 = a.project('two');
  registry.add(sample({ projects: [p1, p2] }));
  sync.publishAgent(registry.find('auditor'));
  const copy = read(filePath(p1, 'auditor'));
  blockDeletion(t, filePath(p2, 'auditor'));
  sync.deleteFully('auditor');
  // While the deletion is half finished, a file reappears in the project where it was deleted (a copy by hand).
  fs.writeFileSync(filePath(p1, 'auditor'), copy);

  const r = sync.reconcile(p1);

  assert.equal(fs.existsSync(filePath(p1, 'auditor')), true,
    'the panel does not delete a file the user did not approve');
  assert.deepEqual(r.changed, [], 'it must not resurrect the agent');
  assert.equal(registry.isInProject(registry.find('auditor'), p1), false, 'the membership must not come back');
  assert.ok(r.errors.some((h) => /delete/i.test(h.error)), 'it must not stay silent; it must give the reason');
});

/* ---- REMOVING FROM A PROJECT ---- */

test("removing from a project affects only that project", (t) => {
  const { p1, p2 } = twoProject(t);

  const r = sync.removeFromProject('auditor', p1);

  assert.equal(fs.existsSync(filePath(p1, 'auditor')), false);
  assert.equal(fs.existsSync(filePath(p2, 'auditor')), true, 'the other project must be preserved');
  const record = registry.find('auditor');
  assert.deepEqual(record.projects, [p2]);
  assert.equal(record.deletionPending, false, 'removing is not deleting');
  assert.equal(r.removedPaths, filePath(p1, 'auditor'));
});

test("if the file cannot be deleted the MEMBERSHIP does not drop either", (t) => {
  const { p1, p2 } = twoProject(t);
  blockDeletion(t, filePath(p1, 'auditor'));

  const r = sync.removeFromProject('auditor', p1);

  assert.ok(r.error, 'a failed removal must not look successful');
  assert.match(r.error, /permission/i);
  const record = registry.find('auditor');
  assert.equal(registry.isInProject(record, p1), true,
    'if the file stays the membership must stay; otherwise the next scan restores the membership and the removal undoes itself');
  assert.deepEqual(record.projects, [p1, p2]);
  assert.equal(fs.existsSync(filePath(p2, 'auditor')), true);
});

test("retrying after a failed removal completes cleanly", (t) => {
  const { p1, p2 } = twoProject(t);
  const remove = blockDeletion(t, filePath(p1, 'auditor'));
  sync.removeFromProject('auditor', p1);
  remove();

  const r = sync.removeFromProject('auditor', p1);

  assert.ok(!r.error);
  assert.equal(fs.existsSync(filePath(p1, 'auditor')), false);
  assert.deepEqual(registry.find('auditor').projects, [p2]);
});

test("after a removal a central change does not reach the OLD project", (t) => {
  const { p1, p2 } = twoProject(t);
  sync.removeFromProject('auditor', p1);

  const g = registry.update('auditor', { task: 'Sonraki talimat.' });
  const y = sync.publishAgent(g.agent);

  assert.deepEqual(y.errors, []);
  assert.equal(fs.existsSync(filePath(p1, 'auditor')), false, 'no file may be recreated in the project it was removed from');
  assert.match(read(filePath(p2, 'auditor')), /Sonraki talimat\./);
});

// ---------------------------------------------------------------------------
// THE INTERFACE HALF - a half-finished deletion must not look deleted on screen
//
// `panel.js` runs in the page; it is sliced out of its source with the established method of this
// repository and run in an isolated context (see tests/panel-state.test.js).
// ---------------------------------------------------------------------------

const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../panel/panel.js'), 'utf8');
const slice = source.slice(source.indexOf('function deletionResult('),
  source.indexOf('async function agentNoneTag('));
const context = vm.createContext({});
// The page's counting helper, which these sentences now use for their numbers.
vm.runInContext(source.slice(source.indexOf('function countOf('), source.indexOf('\n}', source.indexOf('function countOf(')) + 2), context);
vm.runInContext(slice, context);
const deletionResult = vm.runInContext('deletionResult', context);

test("if it could be deleted everywhere the result is one sentence and a success", () => {
  const s = deletionResult({ deleted: 'auditor', removedPaths: ['C:/a/auditor.md', 'C:/b/auditor.md'],
    pending: [], errors: [] }, 'auditor');
  assert.equal(s.succeeded, true);
  assert.match(s.text, /deleted from 2 project/);
});

test("if one target is left the screen does not say DELETED", () => {
  const s = deletionResult({ deleted: null, removedPaths: ['C:/a/auditor.md'], pending: ['C:/b'],
    errors: [{ project: 'C:/b', error: 'Benchook does not have permission to write there.' }] },
  'auditor');
  assert.equal(s.succeeded, false);
  assert.equal(s.partial, true);
  assert.match(s.text, /not fully deleted/);
  assert.doesNotMatch(s.text, /deleted from/, 'a partial result must not use the success sentence');
});

test("the remaining target, its reason and the retry path are WRITTEN", () => {
  const s = deletionResult({ deleted: null, removedPaths: [], pending: ['C:/projects/two'],
    errors: [{ project: 'C:/projects/two', error: 'The file is open in another program.' }] },
  'auditor');
  assert.match(s.bottom, /two/, 'which project it is must be visible');
  assert.match(s.bottom, /open in another program/, 'the reason must be in the language of the user');
  assert.match(s.bottom, /again/, 'the retry path must be written out');
  assert.doesNotMatch(s.bottom, /\.tmp|EPERM|EBUSY/, 'the internal detail of the panel must not leak to the screen');
});

test("if the deletion never started the reason is shown as it is", () => {
  const s = deletionResult({ error: 'No agent named "auditor".' }, 'auditor');
  assert.equal(s.succeeded, false);
  assert.match(s.text, /No agent named/);
});

/* ---- A DELETION COMPLETED IN THE BACKGROUND DOES NOT STAY SILENT ----
   A gap found by a cold review: a deletion can complete without the user clicking anywhere (a watcher
   event, or reselecting the project). The care shown on the button path had not been applied to this
   path; the panel deleted a file from disk and wrote nothing on screen. The reconcile now SAYS the
   result and the page writes it. */

test("the background scan SAYS that it finished the deletion", (t) => {
  const { p2 } = twoProject(t);
  const remove = blockDeletion(t, filePath(p2, 'auditor'));
  sync.deleteFully('auditor');
  remove();

  const r = sync.reconcile(p2);

  assert.deepEqual(r.deletionCompleted, ['auditor'], 'a completed deletion must be reported to the caller');
  assert.deepEqual(r.deletionPending, []);
  assert.deepEqual(r.changed, [], 'completing a deletion is not an agent change');
});

test("while the block lasts the scan says PENDING, not done", (t) => {
  const { p2 } = twoProject(t);
  blockDeletion(t, filePath(p2, 'auditor'));
  sync.deleteFully('auditor');

  const r = sync.reconcile(p2);

  assert.deepEqual(r.deletionPending, ['auditor']);
  assert.deepEqual(r.deletionCompleted, []);
  assert.ok(r.errors.some((h) => /permission/i.test(h.error)), 'reason de gelmeli');
});

test("with no deletion the scan returns these fields empty", (t) => {
  const { p2 } = twoProject(t);

  const r = sync.reconcile(p2);

  assert.deepEqual(r.deletionCompleted, []);
  assert.deepEqual(r.deletionPending, []);
});

const watchDeletionResult = vm.runInContext('watchDeletionResult', context);

test("a deletion completed in the background has a sentence on screen", () => {
  const s = watchDeletionResult({ deletionCompleted: ['auditor'], deletionPending: [], errors: [] });
  assert.ok(s, 'it must not stay silent');
  assert.match(s.text, /auditor/);
  assert.match(s.text, /deleted/i);
});

test("arka planda pending silme \"silindi\" demez", () => {
  const s = watchDeletionResult({ deletionCompleted: [], deletionPending: ['auditor'],
    errors: [{ name: 'auditor', project: 'C:/projects/two',
      error: 'Benchook does not have permission to write there.' }] });
  assert.match(s.text, /still waiting/i);
  assert.doesNotMatch(s.text, /deleted:/i);
  assert.match(s.bottom, /permission/i, 'the reason must be visible too');
});

test("if nothing happened about a deletion nothing is written to the screen", () => {
  assert.equal(watchDeletionResult({ changed: [], errors: [] }), null);
  assert.equal(watchDeletionResult(null), null, 'with no publication it stays silent as well');
});
