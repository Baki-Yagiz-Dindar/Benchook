'use strict';
// DEFINITION PUBLISHING THAT SURVIVES AN INTERRUPTION.
// 
// THE DEFECT: `agent-sync.js` applied `writeFileSync` DIRECTLY to the target `.md` file. If an error
// happened mid-write (a full disk, a lock) the old sound definition was gone and a half file was left in
// its place. In the review only the header was written to the file before ENOSPC was returned, and the
// old content was lost.
// 
// WHAT IS ODD: the old path (`agent-writer.js` `writeSource`) already used
// `persistent-json.atomicText`. When the central person model came in the new publish path
// LOST that guarantee. So this is not a gap but a regression.
// 
// LIMIT: a controlled error is injected here. This is NOT a measurement of a real full disk or a power
// cut; the durability behaviour of the operating system and the disk is not guaranteed without being
// measured separately. What is measured: whether the panel preserves the old file at the moment of error.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../panel/agent-registry');
const sync = require('../panel/agent-sync');
const writeAgent = require('../panel/agent-writer');

function field() {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-resilient-'));
  registry.setup(path.join(k, 'agents.json'));
  const project = (name) => {
    const y = path.join(k, name);
    fs.mkdirSync(path.join(y, '.benchook', 'agents'), { recursive: true });
    return y;
  };
  return { k, project, cleanup: () => fs.rmSync(k, { recursive: true, force: true }) };
}
const sample = (extra = {}) => ({ name: 'auditor', description: 'Code incelenecekse', account: 'orchestrator',
  model: 'orchestrator', task: 'An older sound instruction.', ...extra });
const read = (y) => fs.readFileSync(y, 'utf8');
const folder = (p) => path.join(p, '.benchook', 'agents');
const temps = (p) => fs.readdirSync(folder(p)).filter((x) => !x.endsWith('.md'));

/** A controlled error while writing the temporary file: the call writing to the fd writes half and throws. */
function crashWriteMidway(t) {
  const actual = fs.writeFileSync;
  fs.writeFileSync = function (target, ...remaining) {
    if (typeof target === 'number') {
      actual.call(fs, target, '---\nname: auditor\n');
      throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
    }
    return actual.call(fs, target, ...remaining);
  };
  t.after(() => { fs.writeFileSync = actual; });
}

test("an error mid-write leaves the old file preserved BYTE FOR BYTE", (t) => {
  const a = field(); t.after(a.cleanup);
  const p = a.project('one');
  registry.add(sample({ projects: [p] }));
  sync.publishAgent(registry.find('auditor'));
  const target = sync.targetPath(p, 'auditor');
  const previous = read(target);

  registry.update('auditor', { task: 'Created talimat.' });
  crashWriteMidway(t);
  const r = sync.publishAgent(registry.find('auditor'));

  assert.equal(read(target), previous, 'the older sound definition must be preserved');
  /* A REAL FULL DISK HITS BOTH WRITES: the definition file and the registry note. Both are reported and
     neither topples the work by throwing -- the partial result reaches the caller. */
  assert.ok(r.errors.length >= 1, 'the error must not stay silent');
  /* THE REASON IN THE LANGUAGE OF THE USER, THE RAW TEXT IN THE RECORD. ENOSPC is shown as "There is not
     enough disk space."; the injected raw sentence stays in the `detail` field. */
  assert.ok(r.errors.some((h) => /not enough disk space/.test(h.error)),
    'a write error must be reported in the language of the user');
  assert.ok(r.errors.some((h) => /disk full/.test(h.detail || '')),
    'the raw reason must stay in the record');
  assert.deepEqual(r.written, [], 'a file that could not be written must not count as written');
});

test("an error at the moment of replacing the target still preserves the old file", (t) => {
  const a = field(); t.after(a.cleanup);
  const p = a.project('one');
  registry.add(sample({ projects: [p] }));
  sync.publishAgent(registry.find('auditor'));
  const target = sync.targetPath(p, 'auditor');
  const previous = read(target);

  registry.update('auditor', { task: 'Created talimat.' });
  const actual = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('fixture io error'), { code: 'EIO' }); };
  t.after(() => { fs.renameSync = actual; });
  const r = sync.publishAgent(registry.find('auditor'));

  assert.equal(read(target), previous, 'if the replace fails the target must be left untouched');
  // The own write of the registry uses a replace too; it fails as well and is reported separately.
  assert.ok(r.errors.length >= 1);
  assert.ok(r.errors.some((h) => /io error/.test(h.error)), 'the replace error must be reported');
});

test("an error on a new file leaves NO half-written .md behind", (t) => {
  const a = field(); t.after(a.cleanup);
  const p = a.project('one');
  registry.add(sample({ projects: [p] }));
  const target = sync.targetPath(p, 'auditor');
  crashWriteMidway(t);

  const r = sync.publishAgent(registry.find('auditor'));

  assert.equal(fs.existsSync(target), false, 'no half-written definition file may be left');
  assert.ok(r.errors.length >= 1);
});

test("after a failed write its own temp file is cleaned up", (t) => {
  const a = field(); t.after(a.cleanup);
  const p = a.project('one');
  registry.add(sample({ projects: [p] }));
  crashWriteMidway(t);

  sync.publishAgent(registry.find('auditor'));

  assert.deepEqual(temps(p), [], 'it must not leave its own temp file behind');
});

test("a retry completes cleanly", (t) => {
  const a = field(); t.after(a.cleanup);
  const p = a.project('one');
  registry.add(sample({ projects: [p] }));
  sync.publishAgent(registry.find('auditor'));
  const target = sync.targetPath(p, 'auditor');

  registry.update('auditor', { task: 'Created talimat.' });
  const actual = fs.writeFileSync;
  fs.writeFileSync = function (h, ...remaining) {
    if (typeof h === 'number') { throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' }); }
    return actual.call(fs, h, ...remaining);
  };
  let first;
  try { first = sync.publishAgent(registry.find('auditor')); }
  finally { fs.writeFileSync = actual; }   // the block is lifted in every case; it does not leak
  assert.ok(first.errors.length >= 1);

  const second = sync.publishAgent(registry.find('auditor'));

  assert.deepEqual(second.errors, [], 'once the block is gone the write must complete');
  assert.match(read(target), /Created talimat\./);
  assert.deepEqual(temps(p), [], 'no temp file may remain');
});

test("after a failed write no EMPTY task is carried into the central record", (t) => {
  const a = field(); t.after(a.cleanup);
  const p = a.project('one');
  registry.add(sample({ projects: [p] }));
  sync.publishAgent(registry.find('auditor'));

  registry.update('auditor', { task: 'Created talimat.' });
  const actual = fs.writeFileSync;
  fs.writeFileSync = function (h, ...remaining) {
    if (typeof h === 'number') {
      actual.call(fs, h, '---\nname: auditor\n');
      throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
    }
    return actual.call(fs, h, ...remaining);
  };
  sync.publishAgent(registry.find('auditor'));
  fs.writeFileSync = actual;   // the block is gone; the sync now runs under normal conditions

  sync.reconcile(p);

  assert.notEqual(registry.find('auditor').task, '', 'a half-written or old file must not empty the record');
});

test("a temp file does not enter agent discovery", (t) => {
  const a = field(); t.after(a.cleanup);
  const p = a.project('one');
  registry.add(sample({ projects: [p] }));
  sync.publishAgent(registry.find('auditor'));
  // Leave a temporary file behind as if left over from an interrupted run.
  fs.writeFileSync(path.join(folder(p), 'auditor.md.0000.tmp'), '---\nname: auditor\n');

  const r = sync.reconcile(p);
  const cards = writeAgent.existing(p);

  assert.deepEqual(r.errors, [], 'a temp file must not produce a diagnosis');
  assert.equal(cards.filter((x) => x.name === 'auditor').length, 1, 'agent ikilenmemeli');
  assert.equal(cards.length, 1, 'a temp file must not count as an agent');
});
