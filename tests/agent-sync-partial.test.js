'use strict';
// A PARTIAL PUBLISH AND AN OLD COPY.
// 
// THE DEFECT HAS TWO PARTS:
// 1. An agent is in two projects. One is written and the other cannot be. The save still returns
// success and a green "Saved" appears on screen; the sub-error sits only in the returned object.
// 2. When the project that could not be written is READ later, the UNTOUCHED old file there is taken
// for a new edit made from outside. It is taken into the central record and spread to the other
// projects - so the setting the user saved reverts to its old state by itself.
// 
// THIS IS NOT LAST-WRITER-WINS. Preferring the last writer between two real edits by the user is a
// deliberate decision and is PRESERVED. What happens here is different: a copy left over from a
// failed publish, touched by nobody, is mistaken for an edit.
// 
// THE DISTINGUISHING FACT: the panel knows WHAT it last wrote to that project and that the write
// failed. If the file is still that content, nobody outside has touched it.
// 
// LIMIT: the write error is injected in a controlled way; this is not a measurement of real
// permission or lock behaviour. What is measured is how the panel reacts to a partial success.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../panel/agent-registry');
const sync = require('../panel/agent-sync');

function field() {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-partial-'));
  registry.setup(path.join(k, 'agents.json'));
  const project = (name) => {
    const y = path.join(k, name);
    fs.mkdirSync(path.join(y, '.benchook', 'agents'), { recursive: true });
    return y;
  };
  return { k, project, cleanup: () => fs.rmSync(k, { recursive: true, force: true }) };
}
const sample = (extra = {}) => ({ name: 'auditor', description: 'Code incelenecekse', account: 'orchestrator',
  model: 'orchestrator', task: 'Old instruction.', ...extra });
const read = (y) => fs.readFileSync(y, 'utf8');

/** Blocks WRITING to the agent folder of a project. Because the atomic write opens a temporary file,
  *  the block is set at the `openSync` level; reading stays free. */
function lockProject(t, folderPath) {
  const actual = fs.openSync;
  fs.openSync = function (p, ...remaining) {
    if (String(p).startsWith(folderPath)) {
      throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
    }
    return actual.call(fs, p, ...remaining);
  };
  const resolve = () => { fs.openSync = actual; };
  t.after(resolve);
  return resolve;
}
const agentFolder = (p) => path.join(p, '.benchook', 'agents');

/** The starting point of the acceptance scenario: A and B written, then an update while B is locked. */
function partialPublish(t) {
  const a = field(); t.after(a.cleanup);
  const p1 = a.project('one'), p2 = a.project('two');
  registry.add(sample({ projects: [p1, p2] }));
  sync.publishAgent(registry.find('auditor'));
  const y1 = sync.targetPath(p1, 'auditor'), y2 = sync.targetPath(p2, 'auditor');

  const resolve = lockProject(t, agentFolder(p2));
  registry.update('auditor', { task: 'A new instruction.' });
  const result = sync.publishAgent(registry.find('auditor'));
  return { a, p1, p2, y1, y2, resolve, result };
}

test("a partial publish returns WHICH project could not be written; A keeps the new version", (t) => {
  const { p2, y1, result } = partialPublish(t);

  assert.equal(result.errors.length, 1, 'a failed target must not stay silent');
  assert.equal(result.errors[0].project, p2, 'which project it is must be stated');
  assert.match(read(y1), /A new instruction\./, 'a project that could be written must keep the new version');
});

test("OPENING a project that could not be written does not roll back the central record", (t) => {
  const { p1, p2, y1 } = partialPublish(t);

  const r = sync.reconcile(p2);

  assert.equal(registry.find('auditor').task, 'A new instruction.', 'old copy merkezi ezmemeli');
  assert.match(read(y1), /A new instruction\./, 'it must not propagate to the other project either');
  assert.deepEqual(r.changed, [], 'an old copy must not count as an outside change');
});

test("the result is the same on reopen and on a repeated sync", (t) => {
  const { p2 } = partialPublish(t);

  sync.reconcile(p2);
  sync.reconcile(p2);   // as if the panel closed and reopened: the origin data stays in the registry
  sync.reconcile(p2);

  assert.equal(registry.find('auditor').task, 'A new instruction.');
});

/* LET THE NAME SAY EXACTLY WHAT IS TESTED. What is tested here is that a second reconcile after the
   repair writes nothing -- that the PRECONDITION of the loop is broken. The real watcher callback in
   `panel/main.js` DOES NOT RUN in this test; what happens with overlapping file events was not measured. */
test("once the block is gone B is repaired; a second sync writes nothing", (t) => {
  const { p2, y2, resolve } = partialPublish(t);
  resolve();

  const r = sync.reconcile(p2);

  assert.match(read(y2), /A new instruction\./, 'once the block is gone the missing project must be repaired');
  assert.equal(registry.find('auditor').task, 'A new instruction.');
  const second = sync.reconcile(p2);
  assert.deepEqual(second.changed, [], 'after a repair it must not mistake its own write for a change');
  // NOTE: this is NOT proof that the real watcher event chain is free of loops.
  assert.deepEqual(second.errors, []);
});

test("after the repair, a REAL edit to B updates A", (t) => {
  const { p1, p2, y1, y2, resolve } = partialPublish(t);
  resolve();
  sync.reconcile(p2);

  // A real outside edit: the content of the file differs from what the panel wrote.
  fs.writeFileSync(y2, read(y2).replace('A new instruction.', 'An instruction written from outside.'));
  const r = sync.reconcile(p2);

  assert.equal(registry.find('auditor').task, 'An instruction written from outside.',
    'a real outside edit must NOT be overwritten by stale central data');
  assert.match(read(y1), /An instruction written from outside\./, 'it must propagate to the other project');
  assert.equal(r.changed.length, 1);
});

test("a REAL outside edit made while locked does not count as an old copy either", (t) => {
  const { p1, p2, y1, y2 } = partialPublish(t);
  // B could not be written; but someone really did change the file in B. That is an edit.
  const originalOpen = fs.openSync;
  fs.openSync = originalOpen;                       // make B writable again
  fs.writeFileSync(y2, read(y2).replace('Old instruction.', 'An instruction corrected by hand.'));

  sync.reconcile(p2);

  assert.equal(registry.find('auditor').task, 'An instruction corrected by hand.');
  assert.match(read(y1), /An instruction corrected by hand\./);
});

test("behaviour does not change for an OLD record with no origin data", (t) => {
  const a = field(); t.after(a.cleanup);
  const p1 = a.project('one');
  registry.add(sample({ projects: [p1] }));
  sync.publishAgent(registry.find('auditor'));
  // Like a record from before the migration: delete the origin data by hand.
  const r0 = registry.update('auditor', { syncState: {} });
  assert.equal(r0.error, undefined, r0.error);

  const y1 = sync.targetPath(p1, 'auditor');
  fs.writeFileSync(y1, read(y1).replace('Old instruction.', 'An outside edit.'));
  sync.reconcile(p1);

  assert.equal(registry.find('auditor').task, 'An outside edit.',
    'with no origin data a real outside edit still wins');
});

// ---------------------------------------------------------------------------
// THE INTERFACE HALF - a partial success must not look like success on screen
//
// `panel.js` runs in the page; it is sliced out of its source with the established method of this
// repository and run in an isolated context (see tests/panel-state.test.js).
// ---------------------------------------------------------------------------

const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../panel/panel.js'), 'utf8');
const slice = source.slice(source.indexOf('function writeResult('),
  source.indexOf('async function previewAgent('));
const context = vm.createContext({});
vm.runInContext(slice, context);
const writeResult = vm.runInContext('writeResult', context);

test("if everywhere could be written the result is a success and a single line", () => {
  const s = writeResult({ filePath: 'C:/a/auditor.md', publishErrors: [] }, null);
  assert.equal(s.succeeded, true);
  assert.match(s.text, /^Saved: C:\/a\/auditor\.md$/);
});

test("if one project could not be written the result is NOT counted as success and names the target", () => {
  const s = writeResult({ filePath: 'C:/a/auditor.md',
    publishErrors: [{ project: 'C:/two', error: 'access denied' }] }, null);

  assert.equal(s.succeeded, false, 'a partial success must not look green');
  assert.match(s.text, /1 other project could not be updated:/);
  assert.match(s.text, /C:\/two/, 'which project it is must be written');
  assert.match(s.text, /access denied/, 'the reason must be written');
  assert.match(s.text, /still have their previous version/, 'what was NOT lost must be stated');
  assert.match(s.text, /next time it can write/, 'what will happen must be stated');
});

test("on a write with an unknown outcome the location of the preserved evidence file is given", () => {
  const s = writeResult({ filePath: 'C:/a/auditor.md', publishErrors: [
    { project: 'C:/two', error: 'outcome uncertain', preservedTemp: 'C:/two/auditor.md.9.tmp' }] }, null);
  assert.match(s.text, /A recovery copy was kept: C:\/two\/auditor\.md\.9\.tmp/);
});

test("the error above still comes first", () => {
  const s = writeResult({ error: 'Invalid request' }, null);
  assert.equal(s.succeeded, false);
  assert.equal(s.text, 'Invalid request');
});

// ---------------------------------------------------------------------------
// THE ERROR SENTENCE MUST BE IN THE LANGUAGE OF THE USER
//
// A defect found in a screen review. The mechanism was right, the sentence was not: the screen showed
// a raw Node error and the name of the OWN temporary file of the panel.
// ---------------------------------------------------------------------------

test("a permission error is reported in the language of the user, WITHOUT leaking the temp file name", (t) => {
  const { p2, result } = partialPublish(t);
  const h = result.errors.find((x) => x.project === p2);

  assert.ok(h, 'an error must be returned for project-B');
  assert.equal(h.error, 'Benchook does not have permission to write there.');
  assert.doesNotMatch(h.error, /EACCES|EPERM|ENOENT/, 'a raw error code must not reach the screen');
  assert.doesNotMatch(h.error, /\.tmp/, 'the own temp file of the panel must not be shown to the user');
  // The information IS NOT DROPPED: the raw text stays in the detail.
  assert.match(h.detail, /EACCES|access denied/i, 'the raw reason must stay in the record');
});

test("even for an unrecognised error the temp file name is scrubbed (agents and skills share the rule)", () => {
  const { readableError } = require('../panel/readable-error');
  const product = require('../panel/product');
  const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const fromTemp = readableError(new Error('UNKNOWN: rename C:/p/.benchook/agents/a.md.' + uuid + '.tmp'));
  assert.doesNotMatch(fromTemp, /\.tmp|0f8fad5b/);
  const fromStaging = readableError(new Error('copy failed in C:/p/.claude/skills/' + product.STAGING_PREFIX + uuid));
  assert.doesNotMatch(fromStaging, /0f8fad5b/);
  assert.equal(readableError(Object.assign(new Error('x'), { code: 'EBUSY' })), 'The file is open in another program.');
  const skillSource = fs.readFileSync(path.join(__dirname, '../panel/skill-sync.js'), 'utf8');
  assert.match(skillSource, /require\('\.\/readable-error'\)/, 'skill errors go through the same rule');
});

test("the screen sentence gives the project and the reason plainly, on separate lines", () => {
  const s = writeResult({ filePath: 'C:/a/auditor.md', publishErrors: [
    { project: 'C:/two', error: 'Benchook does not have permission to write there.' }] }, null);

  assert.equal(s.succeeded, false);
  assert.doesNotMatch(s.text, /\.tmp|EPERM|EACCES/, 'no internal detail may appear on screen');
  assert.match(s.text, /1 other project could not be updated:/);
  assert.match(s.text, /C:\/two/);
  assert.match(s.text, /does not have permission/);
  assert.match(s.text, /still have their previous version/, 'what was not lost must be stated');
});
