'use strict';
// DEFINITION PROTECTION - (fields) + (the body of Markdown with no front matter).
//
// WHY A SEPARATE FILE: the two jobs are two faces of one parser contract, but their acceptances differ.
// The contract binds three modules at once (`agent-resolution` reads, `agent-registry` converts,
// `agent-sync` writes), so the evidence is grouped by the job, not by module.
//
// THE REAL CALL PATH IS TESTED, not a helper. The trigger of the finding was selecting a project:
// `main.js` calls `agentSync.reconcile(project)` inside `watcher:setup`. Opening the form or pressing
// Save is not needed. The tests therefore go through `reconcile`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../panel/agent-registry');
const sync = require('../panel/agent-sync');

/** A temporary data root and a temporary project - the personal registry and real agent files are never used. */
function field() {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'definition-guard-'));
  registry.setup(path.join(k, 'agents.json'));
  const project = (name) => {
    const y = path.join(k, name);
    fs.mkdirSync(path.join(y, '.benchook', 'agents'), { recursive: true });
    return y;
  };
  const write = (p, name, content) => {
    const y = path.join(p, '.benchook', 'agents', name + '.md');
    fs.writeFileSync(y, content);
    return y;
  };
  return { k, project, write, cleanup: () => fs.rmSync(k, { recursive: true, force: true }) };
}
const read = (y) => fs.readFileSync(y, 'utf8');

// ---------------------------------------------------------------------------
// - a Markdown task with no front matter
// ---------------------------------------------------------------------------

test("the body of a plain .md file with no front matter stays the task", (t) => {
  const a = field(); t.after(a.cleanup);
  const p = a.project('one');
  // The real text that was emptied in the review.
  const body = 'Read all source files. Report defects only; do not change files.';
  const y = a.write(p, 'auditor', body);

  sync.reconcile(p);

  assert.match(read(y), /Report defects only/, 'selecting a project must not erase the task text');
  assert.equal(registry.find('auditor').task, body, 'the task in the registry must not be emptied either');
});

test("a --- rule inside the body is not mistaken for the front matter close", (t) => {
  const a = field(); t.after(a.cleanup);
  const p = a.project('one');
  const body = ['# Task', '', 'First section.', '', '---', '', '## Your limits', '',
    'Second section.'].join('\n');
  const y = a.write(p, 'auditor', body);

  sync.reconcile(p);

  const after = read(y);
  assert.match(after, /First section\./, 'what comes before --- must not be lost');
  assert.match(after, /## Your limits/, 'what comes after --- must not be lost');
  assert.match(after, /Second section\./);
});

test("a plain task written with CRLF line endings is preserved", (t) => {
  const a = field(); t.after(a.cleanup);
  const p = a.project('one');
  const y = a.write(p, 'auditor', 'First line.\r\nSecond line.\r\n');

  sync.reconcile(p);

  const record = registry.find('auditor');
  assert.match(record.task, /First line\./);
  assert.match(record.task, /Second line\./);
});

test("front matter that opens but never closes leaves the file UNTOUCHED and is diagnosed", (t) => {
  const a = field(); t.after(a.cleanup);
  const p = a.project('one');
  const raw = '---\nname: auditor\ndescription: left half-written\n\nTask text here.';
  const y = a.write(p, 'auditor', raw);

  const r = sync.reconcile(p);

  assert.equal(read(y), raw, 'an unparseable file must not be rewritten');
  assert.equal(registry.find('auditor'), null, "no 'empty but valid' record may be produced");
  assert.equal(r.errors.length, 1, 'it must not stay silent');
  assert.match(r.errors[0].error, /front matter/i);
});

test("an empty file is not a loss; it becomes an agent with an empty task and no diagnosis", (t) => {
  const a = field(); t.after(a.cleanup);
  const p = a.project('one');
  a.write(p, 'empty-agent', '');

  const r = sync.reconcile(p);

  assert.equal(r.errors.length, 0);
  assert.equal(registry.find('empty-agent').task, '', 'there was nothing to lose');
});

// ---------------------------------------------------------------------------
// - preserving definition fields without loss
// ---------------------------------------------------------------------------

const NATIVE = [
  '---',
  'name: auditor',
  'description: Code incelenecekse',
  'tools: Read, Grep',
  '# a comment the panel did not write',
  'permissionMode: plan',
  'maxTurns: 12',
  'disallowedTools:',
  '  - Bash',
  '  - Write',
  'unknownField: some value',
  '---',
  '',
  'Review the code and report the findings.',
  '',
].join('\n');

test("opening a project does not delete fields the panel does not know", (t) => {
  const a = field(); t.after(a.cleanup);
  const p = a.project('one');
  const y = a.write(p, 'auditor', NATIVE);

  sync.reconcile(p);

  const after = read(y);
  for (const expected of ['permissionMode: plan', 'maxTurns: 12', 'disallowedTools:',
    '  - Bash', '  - Write', 'unknownField: some value', '# a comment the panel did not write']) {
    assert.ok(after.includes(expected), 'kaybolan field: ' + expected);
  }
  assert.match(after, /Review the code and report the findings\./, 'the task must be preserved too');
  assert.match(after, /tools: Read, Grep/, 'the tool restriction must not be widened');
});

test("changing the description still preserves unrelated fields", (t) => {
  const a = field(); t.after(a.cleanup);
  const p = a.project('one');
  const y = a.write(p, 'auditor', NATIVE);
  sync.reconcile(p);

  const r = registry.update('auditor', { description: 'A new description' });
  assert.equal(r.error, undefined, r.error);
  sync.publishAgent(r.agent);

  const after = read(y);
  assert.match(after, /description: A new description/);
  assert.ok(after.includes('permissionMode: plan'), 'an edit must not delete an unrelated field');
  assert.ok(after.includes('  - Write'));
  assert.match(after, /Review the code and report the findings\./);
});

test("a second sync does not touch the file - it does not rewrite what it wrote", (t) => {
  const a = field(); t.after(a.cleanup);
  const p = a.project('one');
  const y = a.write(p, 'auditor', NATIVE);
  sync.reconcile(p);
  const first = read(y);

  const r = sync.reconcile(p);

  assert.equal(read(y), first, 'publishing must be stable; the content must not shift on every open');
  assert.deepEqual(r.changed, [], 'an unchanged file must not be counted as changed');
});

test("preserved fields also reach the OTHER project the agent belongs to", (t) => {
  const a = field(); t.after(a.cleanup);
  const p1 = a.project('one'), p2 = a.project('two');
  a.write(p1, 'auditor', NATIVE);
  sync.reconcile(p1);

  const r = sync.addToProject('auditor', p2);
  assert.deepEqual(r.errors, []);

  const second = read(path.join(p2, '.benchook', 'agents', 'auditor.md'));
  assert.ok(second.includes('permissionMode: plan'), 'an agent is the same person in every project');
  assert.match(second, /Review the code and report the findings\./);
});

test("a multi-line value of a known field cannot be converted safely; it is reported, not written", (t) => {
  const a = field(); t.after(a.cleanup);
  const p = a.project('one');
  const raw = ['---', 'name: auditor', 'description: |', '  First line', '  Second line',
    '---', '', 'Task text.', ''].join('\n');
  const y = a.write(p, 'auditor', raw);

  const r = sync.reconcile(p);

  assert.equal(read(y), raw, 'a file that cannot be converted safely must not be rewritten');
  assert.equal(r.errors.length, 1, 'it must not be skipped silently');
});

// ---------------------------------------------------------------------------
// THE OTHER READING SITES OF THE SAME CONTRACT
//
// Fixing the parser was not enough: the writer, the watcher and project setup carried THEIR OWN COPIES
// of the old parser. Had a copy stayed, the task would be preserved in the file but would still look
// empty in the list of the panel. These three tests keep the copies from coming back.
// ---------------------------------------------------------------------------

const writeAgent = require('../panel/agent-writer');
const watcher = require('../panel/watcher');
const projectSetup = require('../panel/project-setup');

test('the card and list path shows the plain Markdown body too', (t) => {
  const a = field(); t.after(a.cleanup);
  const p = a.project('one');
  a.write(p, 'flat', 'Read all source files. Report defects only.');

  const card = writeAgent.existing(p).find((x) => x.name === 'flat');

  assert.ok(card, 'a plain .md file is an agent as well');
  assert.match(card.body, /Report defects only/, 'the panel list must not show the task as empty');
});

test('the external-change warning reports the instruction diff for a plain Markdown file too', () => {
  const f = watcher.diffs('First instruction.', 'Changed instruction.');
  assert.deepEqual(f, [{ field: 'Instructions', from: null, to: null }]);
  // A `name:` line in the body is NOT a front matter field; no field change may be invented.
  assert.deepEqual(watcher.diffs('name: one\nbody', 'name: two\nbody'),
    [{ field: 'Instructions', from: null, to: null }]);
});

test('provider migration does not touch a task text that has no front matter', (t) => {
  const a = field(); t.after(a.cleanup);
  const p = a.project('one');
  // A plain task text with `account:` in its body: the migration must not take it for front matter.
  const filePath = a.write(p, 'flat', 'Task:\n\nUse the account: claude-one line in the report.');

  const plan = projectSetup.plan(p, () => 'claude');

  assert.equal(plan.error, undefined, plan.error);
  assert.ok(!(plan.steps || []).some((x) => x.file === filePath),
    'a file without front matter is not a migration subject');
});
