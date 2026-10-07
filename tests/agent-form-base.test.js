'use strict';
/* The form's OWN successful save must not count as an "external change".
 *
 * What it protects against: saving with no external writer opened the conflict strip; a second save was
 * rejected with "Not saved: the file changed outside Benchook". The base (`formStartupContent`) was
 * taken only when the form opened and was not advanced after a save.
 *
 * This file tests two things: (1) the real comparison through the file fingerprint -- with the old base
 * our own save looks "changed" (the defect itself), with the advanced base it does not, and a real
 * external write still does; (2) the three states of the pure helper `recordAfterBase` (read / deleted /
 * unreadable) and the path advancing on rename. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const watcher = require('../panel/watcher');

const page = fs.readFileSync(path.join(__dirname, '..', 'panel', 'panel.js'), 'utf8');
const slice = page.slice(page.indexOf('function recordAfterBase('),
  page.indexOf('async function refreshFormBase('));
const box = vm.createContext({});
vm.runInContext(slice, box);
const recordAfterBase = vm.runInContext('recordAfterBase', box);

test('rename advances the retained form object and next save identity', async () => {
  const agent = { name:'before', filePath:'/before.md' };
  const context = vm.createContext({editingAgent:agent,formOldName:'before',
    g:()=>null,window:{panel:{agentFileState:async()=>({content:'saved'})}}});
  vm.runInContext(page.slice(page.indexOf('function recordAfterBase('),
    page.indexOf('async function checkFormConflict(')),context);
  await vm.runInContext("refreshFormBase('/after.md','after')",context);
  assert.equal(agent.name,'after');
  assert.equal(agent.filePath,'/after.md');
  assert.equal(context.formOldName,'after');
});

/* The same decision as main.js `agent:fileState`: changed if there is a base and the fingerprint differs from it. */
const isChanged = (filePath, base) => {
  const now = watcher.fingerTrace(filePath);
  if (now === null) return { none: true, changed: base != null };
  return { none: false, changed: base != null && now !== base, content: now };
};

function temp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wf062-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test("the baseline advances after our own save; a real external change is still caught", (t) => {
  const filePath = path.join(temp(t), 'a.md');
  fs.writeFileSync(filePath, '---\nname: a\ndescription: FIRST\n---\n');
  const startup = watcher.fingerTrace(filePath);                       // the form was opened

  fs.writeFileSync(filePath, '---\nname: a\ndescription: SECOND\n---\n'); // panel kaydetti
  assert.equal(isChanged(filePath, startup).changed, true,
    'with the old baseline our own save looks like an external change - the defect itself');

  const t1 = recordAfterBase(filePath, isChanged(filePath, null));      // taban ilerletildi
  assert.equal(t1.filePath, filePath);
  assert.equal(isChanged(filePath, t1.base).changed, false, 'with the advanced baseline a second save is not blocked');

  fs.writeFileSync(filePath, '---\nname: a\ndescription: OUTSIDE\n---\n'); // someone wrote from outside
  assert.equal(isChanged(filePath, t1.base).changed, true, 'a real external change is still caught');
});

test("on a rename the baseline moves to the new path", (t) => {
  const d = temp(t), old = path.join(d, 'a.md'), created = path.join(d, 'b.md');
  fs.writeFileSync(old, 'x');
  const startup = watcher.fingerTrace(old);
  fs.renameSync(old, created); fs.writeFileSync(created, 'y');
  assert.equal(isChanged(old, startup).none, true, 'old yola bakan taban "file silindi" derdi');
  const t1 = recordAfterBase(created, isChanged(created, null));
  assert.equal(t1.filePath, created);
  assert.equal(isChanged(t1.filePath, t1.base).changed, false);
});

test("if the file cannot be read or was deleted the baseline stays empty, never invented", () => {
  assert.equal(recordAfterBase('/x/a.md', { none: true, changed: false }).base, null);
  assert.equal(recordAfterBase('/x/a.md', null).base, null);
  assert.equal(recordAfterBase('/x/a.md', { none: false, content: 'i' }).base, 'i');
});
