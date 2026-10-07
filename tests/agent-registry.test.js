'use strict';
// THE CONTRACT OF THE AGENT REGISTRY - an agent is a PERSON.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../panel/agent-registry');

function freshRegistry() {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-registry-'));
  registry.setup(path.join(k, 'agents.json'));
  return k;
}
const sample = (extra = {}) => ({ name: 'auditor', description: 'Code incelenecekse', account: 'claude-one',
  provider: 'claude', model: 'sonnet', task: 'Kodu incele', ...extra });

test('an empty registry can be read and an agent added', (t) => {
  const k = freshRegistry(); t.after(() => fs.rmSync(k, { recursive: true, force: true }));
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.add(sample()).error, undefined);
  const a = registry.find('auditor');
  assert.equal(a.account, 'claude-one');
  assert.deepEqual(a.projects, [], 'a new agent is active in no project');
});

/* A NAME IS UNIQUE. Agents carrying the same name are not allowed, and the system warns that an agent
   with this name exists and a different name must be used. NO merging; the clash is blocked. */
test('an existing name cannot be used a second time and the reason is written', (t) => {
  const k = freshRegistry(); t.after(() => fs.rmSync(k, { recursive: true, force: true }));
  registry.add(sample());
  const r = registry.add(sample({ account: 'claude-two' }));
  assert.match(r.error, /already exists/i);
  assert.match(r.error, /every project/i, 'it must give the reason too: the name is shared across projects');
  assert.equal(registry.list().length, 1, 'no second record may be written');
});

test('name comparison does not fall into the Turkish dotless-I trap', (t) => {
  const k = freshRegistry(); t.after(() => fs.rmSync(k, { recursive: true, force: true }));
  registry.add(sample({ name: 'TEST' }));
  assert.match(registry.add(sample({ name: 'test' })).error, /already exists/i);
  assert.ok(registry.find('TesT'), 'it must be found regardless of case');
});

/* CHANGING IT IN ONE PLACE CHANGES IT EVERYWHERE. Because the registry keeps one record this holds by
   construction; the test pins that the record really is SINGLE and that the projects derive from it. */
test('an agent is a single record: an update gives every project the same content', (t) => {
  const k = freshRegistry(); t.after(() => fs.rmSync(k, { recursive: true, force: true }));
  registry.add(sample());
  registry.addToProject('auditor', 'C:/p/one');
  registry.addToProject('auditor', 'C:/p/two');
  registry.update('auditor', { account: 'codex-uc', provider: 'codex', model: 'gpt-5.6-terra' });
  const a = registry.find('auditor');
  assert.equal(a.projects.length, 2, 'an update must not drop the project list');
  const text = registry.text(a);
  assert.match(text, /account: codex-uc/);
  assert.match(text, /model: gpt-5\.6-terra/);
  // The text written for both projects is the same: there is no per-project field.
  assert.equal(registry.text(a), text);
});

/* REMOVING FROM A PROJECT IS NOT DELETING: an agent not being used does not mean it is dead. */
test('removing from a project does not kill the agent; an agent in no project stays in the registry', (t) => {
  const k = freshRegistry(); t.after(() => fs.rmSync(k, { recursive: true, force: true }));
  registry.add(sample());
  registry.addToProject('auditor', 'C:/p/one');
  registry.addToProject('auditor', 'C:/p/two');
  registry.removeFromProject('auditor', 'C:/p/one');
  assert.equal(registry.isInProject(registry.find('auditor'), 'C:/p/one'), false);
  assert.equal(registry.isInProject(registry.find('auditor'), 'C:/p/two'), true);
  registry.removeFromProject('auditor', 'C:/p/two');
  const a = registry.find('auditor');
  assert.ok(a, 'the agent must stay in the registry even when it is in no project');
  assert.deepEqual(a.projects, []);
  assert.equal(a.account, 'claude-one', 'its settings must be preserved too: a worker waiting idle');
});

test('deleting an agent REPORTS which projects it affected', (t) => {
  const k = freshRegistry(); t.after(() => fs.rmSync(k, { recursive: true, force: true }));
  registry.add(sample());
  registry.addToProject('auditor', 'C:/p/one');
  registry.addToProject('auditor', 'C:/p/two');
  const r = registry.remove('auditor');
  assert.deepEqual(r.projects, ['C:/p/one', 'C:/p/two']);
  assert.equal(registry.find('auditor'), null);
});

test('a project path spelled differently still counts as the same project', (t) => {
  const k = freshRegistry(); t.after(() => fs.rmSync(k, { recursive: true, force: true }));
  registry.add(sample());
  registry.addToProject('auditor', 'C:\\p\\one');
  assert.equal(registry.isInProject(registry.find('auditor'), 'C:/p/one'), true);
  registry.addToProject('auditor', 'C:/P/ONE');
  assert.equal(registry.find('auditor').projects.length, 1, 'the same project must not be added twice');
});

/* THE PROJECT-SPECIFIC SECTION IS GONE. It sits in older files; it is dropped on read and never written back. */
test('a project-specific section in an old file is dropped on read and never written back', (t) => {
  const k = freshRegistry(); t.after(() => fs.rmSync(k, { recursive: true, force: true }));
  const old = ['---', 'schema: panel-agent/v1', 'name: old', 'description: d',
    'model: haiku', 'account: claude-one', '---', '', 'The actual task', '',
    '## Bu projede neye dikkat edeceksin', '', 'nothing at all', ''].join('\n');
  const a = registry.fromFile(old);
  assert.equal(a.task, 'The actual task', 'only the task must remain');
  assert.doesNotMatch(registry.text(a), /dikkat edeceksin/);
  assert.doesNotMatch(registry.text(a), /nothing at all/);
});

test('the written file format preserves the front matter the catalogue expects', (t) => {
  const k = freshRegistry(); t.after(() => fs.rmSync(k, { recursive: true, force: true }));
  const m = registry.text(registry.fromFile(registry.text(sample())));
  for (const field of ['schema: panel-agent/v1', 'name: auditor', 'description: Code incelenecekse',
    'model: sonnet', 'account: claude-one', 'provider: claude', 'tools: ']) {
    assert.match(m, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), field + ' kayboldu');
  }
});

test('an invalid name is refused and what to do is explained', (t) => {
  const k = freshRegistry(); t.after(() => fs.rmSync(k, { recursive: true, force: true }));
  assert.match(registry.nameSuitable(''), /Enter a name/i);
  assert.match(registry.nameSuitable('name with spaces'), /letters, digits/i);
  assert.equal(registry.nameSuitable('valid-ad_1.2'), null);
});

/* ONLY THE PROJECT-SPECIFIC SECTION IS DROPPED. The first version of the rule cut at the first `##`
   heading, and the migration PREVIEW showed that it deleted real content: one agent had four legitimate
   sections in its body and the file fell from 73 lines to 12. This test keeps that rule from coming back. */
test('other headings in the body are preserved; only the project-specific section is removed', (t) => {
  const k = freshRegistry(); t.after(() => fs.rmSync(k, { recursive: true, force: true }));
  const raw = ['---', 'name: many-bolumlu', 'description: d', 'model: haiku', 'account: claude-one',
    '---', '', 'Opening sentence', '', '## Why you exist', '', 'reason', '',
    '## Bu projede neye dikkat edeceksin', '', 'nothing at all', '',
    '## Rules', '', 'kural one', ''].join('\n');
  const a = registry.fromFile(raw);
  assert.match(a.task, /Opening sentence/);
  assert.match(a.task, /## Why you exist/, 'a legitimate section is kept');
  assert.match(a.task, /kural one/, 'the section AFTER the project-specific one must stay too');
  assert.doesNotMatch(a.task, /dikkat edeceksin/);
  assert.doesNotMatch(a.task, /nothing at all/);
});

test('a project-specific section written in English is recognised too', (t) => {
  const k = freshRegistry(); t.after(() => fs.rmSync(k, { recursive: true, force: true }));
  const raw = ['---', 'name: x', 'description: d', 'model: haiku', 'account: claude-one', '---',
    '', 'Task', '', '## Project-specific guidance', '', 'something', ''].join('\n');
  const a = registry.fromFile(raw);
  assert.equal(a.task, 'Task');
});

test('a body with no project-specific section is left completely unchanged', (t) => {
  const k = freshRegistry(); t.after(() => fs.rmSync(k, { recursive: true, force: true }));
  const body = 'One-line task\n\n## Your limits\n\nread only';
  const raw = ['---', 'name: y', 'description: d', 'model: haiku', 'account: claude-one', '---',
    '', body, ''].join('\n');
  assert.equal(registry.fromFile(raw).task, body);
});

/* THE FORM ITSELF MUST NOT ASK FOR A PROJECT-SPECIFIC FIELD - the test for a defect caught by the record
   check. The storage layer had started dropping the section while the FORM still asked for it: anything
   the user typed would have been lost silently and the panel would have said nothing.

   This is a source check, because the form code cannot run without a browser; intent is not enough,
   the field being ABSENT from the file is what is pinned. */
test('the agent form does not ask for a project-specific field and the writer produces no such section', () => {
  const root = path.join(__dirname, '..');
  const page = fs.readFileSync(path.join(root, 'panel', 'panel.js'), 'utf8');
  assert.doesNotMatch(page, /fDikkat/, 'the form field has come back');
  const writer = fs.readFileSync(path.join(root, 'panel', 'agent-writer.js'), 'utf8');
  assert.doesNotMatch(writer, /field\.notice/, 'the writer still reads that field');
  assert.doesNotMatch(writer, /## Project-specific guidance/,
    'the writer still produces a project-specific section');
});
