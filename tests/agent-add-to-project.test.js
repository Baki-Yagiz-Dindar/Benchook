'use strict';
// ADDING AN EXISTING AGENT TO A PROJECT.
// 
// THE DEFECT: the panel said to open the agent from another project and save it, and it would be added
// to this project ("Click to open it. Saving adds it to this project."). Because the preview looked only
// at the files of THIS project it showed the agent as a new record. The real save, however, found the
// name in the central registry and REFUSED with "An agent named X already exists". So the action the
// screen promised could never be done, and the error described something the user had not done
// (opening a second agent under the same name).
// 
// THE ROOT CAUSE: the intent was not carried. Creating a new person, editing an existing one and
// adding an existing one to this project are three different intents; all three entered the same call
// with the same flag (`overwrite`). `overwrite` is a FILE question (may I write over it), not an
// identity question.
// 
// THE FIX: the intent is carried explicitly to IPC as a field of the form, and the decision is made in
// one testable place (`agent-sync.saveForm`). Name uniqueness WAS NOT REMOVED: it applies only to a
// claim of a genuinely NEW agent -- the only place it means anything.
// 
// WITH AN UNKNOWN INTENT THE OLD STRICT BEHAVIOUR STAYS: if an older page version sends no intent,
// writing to an existing name is still refused. Treating the unknown as the same person would be the
// way to merge two agents silently.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../panel/agent-registry');
const sync = require('../panel/agent-sync');

function field() {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'toProject-add-'));
  registry.setup(path.join(k, 'agents.json'));
  const project = (name) => {
    const y = path.join(k, name);
    fs.mkdirSync(path.join(y, '.benchook', 'agents'), { recursive: true });
    return y;
  };
  return { k, project, cleanup: () => fs.rmSync(k, { recursive: true, force: true }) };
}
const filePath = (p, name = 'auditor') => path.join(p, '.benchook', 'agents', name + '.md');
const read = (y) => fs.readFileSync(y, 'utf8');

/** The text the page sends: whatever the panel makes the record look like. */
const formText = (extra = {}) => registry.text({
  name: 'auditor', description: 'Code incelenecekse', account: 'personal-account', model: 'opus',
  tools: 'Read, Grep', task: 'Read the sources, report the defects.', ...extra });

/** One agent active in A; B is an empty project. */
function oneInProject(t) {
  const a = field(); t.after(a.cleanup);
  const A = a.project('project-A'), B = a.project('project-B');
  registry.add({ name: 'auditor', description: 'Code incelenecekse', account: 'personal-account',
    model: 'opus', tools: 'Read, Grep', task: 'Read the sources, report the defects.',
    projects: [A] });
  sync.publishAgent(registry.find('auditor'));
  return { a, A, B };
}

/* ---- ADDING ---- */

test("an existing agent is ADDED to a second project; no second person is born", (t) => {
  const { A, B } = oneInProject(t);

  const r = sync.saveForm({ project: B, name: 'auditor', content: formText(),
    intent: 'addToProject' });

  assert.ok(!r.error, 'the action the screen promises must not be refused: ' + r.error);
  assert.equal(registry.list().length, 1, 'the central record must stay SINGLE');
  const record = registry.find('auditor');
  assert.equal(registry.isInProject(record, A), true);
  assert.equal(registry.isInProject(record, B), true, 'both memberships must exist');
  assert.equal(r.membershipAdded, true, 'so the page can say "added"');
  assert.ok(fs.existsSync(filePath(B)), 'its file must be created in this project too');
  assert.deepEqual(r.publishErrors, []);
});

test("the added agent keeps the same task, account and model", (t) => {
  const { A, B } = oneInProject(t);

  sync.saveForm({ project: B, name: 'auditor', content: formText(), intent: 'addToProject' });

  const record = registry.find('auditor');
  assert.equal(record.account, 'personal-account');
  assert.equal(record.model, 'opus');
  assert.equal(record.tools, 'Read, Grep');
  assert.equal(record.task, 'Read the sources, report the defects.');
  assert.equal(read(filePath(A)), read(filePath(B)), 'the file must be byte-identical in both projects');
});

test("an IDLE agent that is in no project can be added as well", (t) => {
  const { A, B } = oneInProject(t);
  sync.removeFromProject('auditor', A);
  assert.deepEqual(registry.find('auditor').projects, [], 'setup: the agent is idle');

  const r = sync.saveForm({ project: B, name: 'auditor', content: formText(),
    intent: 'addToProject' });

  assert.ok(!r.error);
  assert.deepEqual(registry.find('auditor').projects, [B],
    'an unused agent is not dead; it must be addable again');
  assert.ok(fs.existsSync(filePath(B)));
});

test("removing and re-adding brings back the same person", (t) => {
  const { A, B } = oneInProject(t);
  sync.saveForm({ project: B, name: 'auditor', content: formText(), intent: 'addToProject' });

  sync.removeFromProject('auditor', B);
  assert.equal(fs.existsSync(filePath(B)), false, 'removal must delete the file');
  const r = sync.saveForm({ project: B, name: 'auditor', content: formText(),
    intent: 'addToProject' });

  assert.ok(!r.error);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.isInProject(registry.find('auditor'), B), true);
  assert.equal(read(filePath(A)), read(filePath(B)));
});

/* ---- NAME UNIQUENESS WAS NOT REMOVED ---- */

test("creating a NEW person under an existing name is refused", (t) => {
  const { B } = oneInProject(t);

  const r = sync.saveForm({ project: B, name: 'auditor',
    content: formText({ description: 'A different job', task: 'An entirely different instruction.' }), intent: 'new' });

  assert.ok(r.error, 'name uniqueness still holds');
  assert.match(r.error, /already exists/);
  assert.equal(registry.find('auditor').task, 'Read the sources, report the defects.',
    'a refused save must NOT modify the existing agent');
  assert.equal(fs.existsSync(filePath(B)), false, 'a refused save must not create a file either');
});

test("with an unknown intent the old strict behaviour stays", (t) => {
  const { B } = oneInProject(t);

  const r = sync.saveForm({ project: B, name: 'auditor', content: formText() });

  assert.ok(r.error, 'a call with unknown intent must not silently merge two identities');
  assert.match(r.error, /already exists/);
});

test("a genuinely new name is created as a NEW person", (t) => {
  const { B } = oneInProject(t);

  const r = sync.saveForm({ project: B, name: 'writer',
    content: formText({ name: 'writer', description: 'For when text has to be written' }), intent: 'new' });

  assert.ok(!r.error);
  assert.equal(registry.list().length, 2);
  assert.deepEqual(registry.find('writer').projects, [B], 'a newly created agent must belong to this project only');
});

/* ---- THE EDIT PATH IS NOT BROKEN ---- */

test("editing the agent here propagates to every project", (t) => {
  const { A, B } = oneInProject(t);
  sync.saveForm({ project: B, name: 'auditor', content: formText(), intent: 'addToProject' });

  const r = sync.saveForm({ project: A, name: 'auditor',
    content: formText({ model: 'sonnet' }), intent: 'edit' });

  assert.ok(!r.error);
  assert.equal(r.membershipAdded, false, 'an already-member agent must not be reported as "added"');
  assert.equal(registry.find('auditor').model, 'sonnet');
  assert.match(read(filePath(B)), /model: sonnet/, 'the change must reach the other project too');
});

test("fields the form does not show are NOT lost on save", (t) => {
  const { A } = oneInProject(t);
  registry.update('auditor', { extraFrontmatter: ['permissionMode: plan'] });
  sync.publishAgent(registry.find('auditor'));

  sync.saveForm({ project: A, name: 'auditor', content: formText({ description: 'A new description' }),
    intent: 'edit' });

  assert.deepEqual(registry.find('auditor').extraFrontmatter, ['permissionMode: plan'],
    'the form cannot delete a field it does not know');
  assert.match(read(filePath(A)), /permissionMode: plan/);
});

/* ---- PARTIAL SUCCESS ---- */

test("with an unwritable target, adding does not look COMPLETED", (t) => {
  const { a, A, B } = oneInProject(t);
  const C = a.project('project-C');
  sync.saveForm({ project: B, name: 'auditor', content: formText(), intent: 'addToProject' });
  fs.rmSync(B, { recursive: true, force: true });   // B no longer exists

  const r = sync.saveForm({ project: C, name: 'auditor', content: formText(),
    intent: 'addToProject' });

  assert.ok(!r.error, 'reachable targets must still be written');
  assert.ok(r.publishErrors.length >= 1, 'an unreachable target must not stay silent');
  assert.ok(r.publishErrors.some((h) => h.project === B));
  assert.ok(fs.existsSync(filePath(C)), 'it must have been written to this project');
  assert.match(read(filePath(A)), /Read the sources/);
});

test("corrupt text never enters the registry", (t) => {
  const { B } = oneInProject(t);

  const r = sync.saveForm({ project: B, name: 'created-agent',
    content: '---\nname: created-agent\ndescription: front matter that never closes\n', intent: 'new' });

  assert.ok(r.error, 'unparseable text must not be accepted');
  assert.equal(registry.find('created-agent'), null);
});

// ---------------------------------------------------------------------------
// THE INTERFACE HALF - only the PAGE knows the intent
//
// The main process cannot see which list a card was opened from, which is where the root of the defect
// lies. `panel.js` is sliced out of its source and run in an isolated context
// (see tests/panel-state.test.js).
// ---------------------------------------------------------------------------

const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../panel/panel.js'), 'utf8');
const slice = source.slice(source.indexOf('function selectIntent('),
  source.indexOf('async function agentForm('));

function page(defined, external) {
  const context = vm.createContext({ definedAgents: defined, externalAgents: external });
  // The page's counting helper, which these sentences now use for their numbers.
  vm.runInContext(source.slice(source.indexOf('function countOf('), source.indexOf('\n}', source.indexOf('function countOf(')) + 2), context);
  vm.runInContext(slice, context);
  return {
    selectIntent: vm.runInContext('selectIntent', context),
    intentWord: vm.runInContext('intentWord', context),
  };
}

test("the card of an agent from another project opens with ADD intent", () => {
  const s = page([{ name: 'writer' }], [{ name: 'auditor' }]);
  assert.equal(s.selectIntent({ name: 'auditor' }), 'addToProject');
});

test("an agent in this project opens with EDIT intent", () => {
  const s = page([{ name: 'auditor' }], [{ name: 'writer' }]);
  assert.equal(s.selectIntent({ name: 'auditor' }), 'edit');
});

test("an empty form and an undefined card mean NEW intent", () => {
  const s = page([{ name: 'auditor', undefinedDef: true }], []);
  assert.equal(s.selectIntent(null), 'new');
  assert.equal(s.selectIntent({ name: 'auditor' }), 'new',
    'a card that was called before but has no definition really is a new agent');
});

test("what the preview promises is what the button does", () => {
  const s = page([], [{ name: 'auditor' }]);
  const add = s.intentWord('addToProject', 'auditor', 2);
  assert.match(add, /added to this project/, 'the promise shown on screen must be written out');
  assert.match(add, /same agent/, 'it must say that no second person is created');
  assert.match(s.intentWord('edit', 'auditor', 2), /updates this agent/);
  assert.match(s.intentWord('new', 'auditor', 0), /creates a new agent/);
  assert.doesNotMatch(s.intentWord('new', 'auditor', 0), /added to this project/);
});
