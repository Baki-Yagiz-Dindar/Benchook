'use strict';
// THE CONTRACT OF PUBLISHING. The proof, against real files, that changing it in one place
// changes it everywhere.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../panel/agent-registry');
const sync = require('../panel/agent-sync');

function field() {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sync-'));
  registry.setup(path.join(k, 'agents.json'));
  const project = (name) => { const y = path.join(k, name); fs.mkdirSync(y, { recursive: true }); return y; };
  return { k, project, cleanup: () => fs.rmSync(k, { recursive: true, force: true }) };
}
const sample = (extra = {}) => ({ name: 'auditor', description: 'Code incelenecekse', account: 'claude-one',
  provider: 'claude', model: 'sonnet', task: 'Kodu incele', ...extra });
const read = (y) => fs.readFileSync(y, 'utf8');

test('one change reaches EVERY project the agent is active in', (t) => {
  const a = field(); t.after(a.cleanup);
  const p1 = a.project('one'), p2 = a.project('two');
  registry.add(sample());
  sync.addToProject('auditor', p1);
  sync.addToProject('auditor', p2);

  const y1 = sync.targetPath(p1, 'auditor'), y2 = sync.targetPath(p2, 'auditor');
  assert.ok(fs.existsSync(y1) && fs.existsSync(y2), 'it must be written to both projects');
  assert.equal(read(y1), read(y2), 'the two files must be byte-identical');

  registry.update('auditor', { account: 'codex-uc', provider: 'codex', model: 'gpt-5.6-terra' });
  const r = sync.publishAgent(registry.find('auditor'));
  assert.deepEqual(r.errors, []);
  assert.equal(r.written.length, 2);
  for (const y of [y1, y2]) {
    assert.match(read(y), /account: codex-uc/, y + ' was not updated');
    assert.match(read(y), /model: gpt-5\.6-terra/);
  }
});

/* REMOVING FROM A PROJECT IS NOT DELETING - the file goes, the agent stays. */
test('removing from a project deletes only that file; the agent and the other project stand', (t) => {
  const a = field(); t.after(a.cleanup);
  const p1 = a.project('one'), p2 = a.project('two');
  registry.add(sample());
  sync.addToProject('auditor', p1);
  sync.addToProject('auditor', p2);

  sync.removeFromProject('auditor', p1);
  assert.equal(fs.existsSync(sync.targetPath(p1, 'auditor')), false, 'the file of that project must be deleted');
  assert.equal(fs.existsSync(sync.targetPath(p2, 'auditor')), true, 'the other project must not be affected');
  const remaining = registry.find('auditor');
  assert.ok(remaining, 'the agent must stay in the registry');
  assert.equal(remaining.account, 'claude-one', 'its settings must be preserved too');
});

test('deleting an agent outright removes it from every project and reports where it was removed from', (t) => {
  const a = field(); t.after(a.cleanup);
  const p1 = a.project('one'), p2 = a.project('two');
  registry.add(sample());
  sync.addToProject('auditor', p1);
  sync.addToProject('auditor', p2);

  const r = sync.deleteFully('auditor');
  assert.equal(r.deleted, 'auditor');
  assert.equal(r.removedPaths.length, 2, 'two file da silinmeli');
  assert.deepEqual(r.errors, []);
  assert.equal(registry.find('auditor'), null);
  for (const p of [p1, p2]) assert.equal(fs.existsSync(sync.targetPath(p, 'auditor')), false);
});

/* AN EDIT MADE FROM OUTSIDE IS APPLIED TO THE AGENT ITSELF. Silently writing back over real work done
   outside is not acceptable. */
test('an edit made from outside is applied to the registry and propagates to the other projects', (t) => {
  const a = field(); t.after(a.cleanup);
  const p1 = a.project('one'), p2 = a.project('two');
  registry.add(sample());
  sync.addToProject('auditor', p1);
  sync.addToProject('auditor', p2);

  // Someone changes the file in p1 by hand.
  const y1 = sync.targetPath(p1, 'auditor');
  fs.writeFileSync(y1, read(y1).replace('model: sonnet', 'model: haiku'), 'utf8');

  const r = sync.externalChanged(p1, y1);
  assert.equal(r.updatedAt, true);
  assert.equal(registry.find('auditor').model, 'haiku', 'the registry must take up the outside change');
  assert.match(read(sync.targetPath(p2, 'auditor')), /model: haiku/, 'it must propagate to the other project');
});

test('a new definition created outside is taken into the registry and becomes active in that project', (t) => {
  const a = field(); t.after(a.cleanup);
  const p1 = a.project('one');
  const y = path.join(p1, '.benchook', 'agents', 'fresh.md');
  fs.mkdirSync(path.dirname(y), { recursive: true });
  fs.writeFileSync(y, ['---', 'name: fresh', 'description: d', 'model: haiku',
    'account: claude-one', '---', '', 'Task', ''].join('\n'), 'utf8');

  const r = sync.externalChanged(p1, y);
  assert.equal(r.isNew, true);
  const record = registry.find('fresh');
  assert.ok(record);
  assert.equal(registry.isInProject(record, p1), true, 'it must count as active in the project it was found in');
});

/* A PROJECT THAT CANNOT BE WRITTEN DOES NOT STAY SILENT - a half-spread agent is exactly the error being
   fixed. */
test('if one project cannot be written the work continues but WHICH project failed is returned', (t) => {
  const a = field(); t.after(a.cleanup);
  const p1 = a.project('one');
  const none = path.join(a.k, 'deleted-project');
  registry.add(sample());
  sync.addToProject('auditor', p1);
  registry.addToProject('auditor', none);
  fs.mkdirSync(path.join(none, '.benchook', 'agents'), { recursive: true });
  // Make writing impossible by turning the folder into a file.
  fs.rmSync(path.join(none, '.benchook', 'agents'), { recursive: true, force: true });
  fs.writeFileSync(path.join(none, '.benchook', 'agents'), 'block', 'utf8');

  const r = sync.publishAgent(registry.find('auditor'));
  assert.equal(r.written.length, 1, 'a project that can be written must be written');
  assert.equal(r.errors.length, 1, 'a project that cannot be written must be reported');
  assert.equal(r.errors[0].project, none);
});

test('a project is never written outside its agent folder', (t) => {
  const a = field(); t.after(a.cleanup);
  const p1 = a.project('one');
  assert.equal(sync.allowed(p1, path.join(p1, 'other', 'place.md')), false);
  assert.equal(sync.allowed(p1, path.join(p1, '.benchook', 'agents', 'x.md')), true);
  assert.equal(sync.allowed(p1, path.join(p1, '.claude', 'agents', 'x.md')), true);
  // A folder the panel never reads is not a place it may write to either.
  assert.equal(sync.allowed(p1, path.join(p1, '.claude', 'workers', 'x.md')), false);
  assert.equal(sync.allowed(p1, path.join(p1, '.benchook', 'agents', 'x.txt')), false);
});

/* A FILE IN THE OLD FOLDER IS UPDATED IN PLACE. Moving a file of the user without telling them falls
   under safety contract. */
test('a definition in the old folder is updated there, not moved', (t) => {
  const a = field(); t.after(a.cleanup);
  const p1 = a.project('one');
  const old = path.join(p1, '.claude', 'agents', 'auditor.md');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, 'place tutucu', 'utf8');

  registry.add(sample());
  registry.addToProject('auditor', p1);
  sync.publishAgent(registry.find('auditor'));

  assert.match(read(old), /name: auditor/, 'the old file must be updated in place');
  assert.equal(fs.existsSync(path.join(p1, '.benchook', 'agents', 'auditor.md')), false,
    'no second copy may be created in the new folder');
});

test('if the content is already identical the file is left untouched', (t) => {
  const a = field(); t.after(a.cleanup);
  const p1 = a.project('one');
  registry.add(sample());
  sync.addToProject('auditor', p1);
  const y = sync.targetPath(p1, 'auditor');
  const once = fs.statSync(y).mtimeMs;
  sync.publishAgent(registry.find('auditor'));
  assert.equal(fs.statSync(y).mtimeMs, once, 'the timestamp of an unchanged file must not change either');
});

/* RECONCILING A PROJECT - the watcher does not say which file changed, so the project is read from
   scratch. Two assertions here are critical: what changed is caught, and what did NOT change is not
   written for nothing (otherwise the own write of the panel would trigger the watcher and form a loop). */
test('reconcile catches the outside change and spreads it to the other project', (t) => {
  const a = field(); t.after(a.cleanup);
  const p1 = a.project('one'), p2 = a.project('two');
  registry.add(sample());
  sync.addToProject('auditor', p1);
  sync.addToProject('auditor', p2);

  const y1 = sync.targetPath(p1, 'auditor');
  fs.writeFileSync(y1, read(y1).replace('account: claude-one', 'account: codex-nine'), 'utf8');

  const r = sync.reconcile(p1);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.changed.map((x) => x.name), ['auditor']);
  assert.equal(registry.find('auditor').account, 'codex-nine');
  assert.match(read(sync.targetPath(p2, 'auditor')), /account: codex-nine/);
});

test('reconcile writes nothing when nothing changed; no loop forms', (t) => {
  const a = field(); t.after(a.cleanup);
  const p1 = a.project('one');
  registry.add(sample());
  sync.addToProject('auditor', p1);
  const y = sync.targetPath(p1, 'auditor');
  const once = fs.statSync(y).mtimeMs;
  const r = sync.reconcile(p1);
  assert.deepEqual(r.changed, [], 'with nothing changed no agent may be reported');
  assert.equal(fs.statSync(y).mtimeMs, once, 'the file must not be touched');
});

test('reconcile also takes up an agent created outside', (t) => {
  const a = field(); t.after(a.cleanup);
  const p1 = a.project('one');
  const y = path.join(p1, '.benchook', 'agents', 'outside.md');
  fs.mkdirSync(path.dirname(y), { recursive: true });
  fs.writeFileSync(y, ['---', 'name: outside', 'description: d', 'model: haiku',
    'account: claude-one', '---', '', 'Task', ''].join('\n'), 'utf8');
  const r = sync.reconcile(p1);
  assert.deepEqual(r.changed, [{ name: 'outside', isNew: true }]);
  assert.ok(registry.find('outside'));
});
