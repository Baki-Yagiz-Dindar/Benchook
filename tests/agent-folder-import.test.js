'use strict';
// IMPORTING AGENTS FROM A FOLDER.
// 
// THE SUSPICION WAS CONFIRMED by reading the code: the "Import agents from a folder" button did NOT
// import the folder; it only added it to the project list of the panel, and because the outside agent
// list is read from the registry nothing changed. The button was also never drawn when the list was
// completely empty -- the early return sat above it, so it was missing exactly when it was needed most.
// 
// SHOW FIRST, THEN ASK. The panel ONLY READS the folder and lists what it finds; whichever ones the user
// wants are imported. In a folder chosen just for browsing, no file changes without approval -- the
// safety contract.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../panel/agent-registry');
const sync = require('../panel/agent-sync');

function field(t) {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'fromFolder-'));
  t.after(() => fs.rmSync(k, { recursive: true, force: true }));
  registry.setup(path.join(k, 'agents.json'));
  return k;
}
const folder = (p) => path.join(p, '.benchook', 'agents');
const read = (y) => fs.readFileSync(y, 'utf8');

/** A folder sitting outside that the panel has never seen. */
function externalFolder(t, definitions) {
  const k = field(t);
  const d = path.join(k, 'old-project');
  fs.mkdirSync(folder(d), { recursive: true });
  for (const [name, lines] of Object.entries(definitions)) {
    fs.writeFileSync(path.join(folder(d), name + '.md'), lines);
  }
  return { k, d };
}
const definition = (name, task = 'Read and report.') => ['---', 'name: ' + name,
  'description: what ' + name + ' is for', 'account: orchestrator', 'model: orchestrator',
  'tools: Read', '---', '', task, ''].join('\n');

/* ---- THE SCAN WRITES NOTHING ---- */

test("the scan REPORTS whatever is in the folder", (t) => {
  const { d } = externalFolder(t, { auditor: definition('auditor'), writer: definition('writer') });

  const r = sync.scanFolder(d);

  assert.deepEqual(r.found.map((x) => x.name).sort(), ['auditor', 'writer']);
  const auditor = r.found.find((x) => x.name === 'auditor');
  assert.equal(auditor.description, 'what auditor is for', 'the user must be able to see what they are importing');
  assert.equal(auditor.alreadyExists, false);
});

test("tarama DOSYAYA DA DEFTERE DE dokunmaz", (t) => {
  const { d } = externalFolder(t, { auditor: definition('auditor') });
  const filePath = path.join(folder(d), 'auditor.md');
  const before = read(filePath);

  sync.scanFolder(d);

  assert.equal(read(filePath), before, 'looking must not modify the file');
  assert.deepEqual(registry.list(), [], 'nothing may enter the registry before confirmation');
});

test("an unparseable file is listed WITH ITS REASON, not skipped", (t) => {
  const { d } = externalFolder(t, { auditor: definition('auditor'),
    corrupt: '---\nname: corrupt\ndescription: front matter that never closes\n' });

  const r = sync.scanFolder(d);

  const corrupt = r.found.find((x) => x.name === 'corrupt');
  assert.ok(corrupt, 'an unreadable file must not be silently treated as absent');
  assert.ok(corrupt.corrupt, 'the reason must be visible');
  assert.equal(corrupt.importable, false, 'it must be clear that it cannot be imported');
});

test("an already known agent is FLAGGED", (t) => {
  const { d } = externalFolder(t, { auditor: definition('auditor') });
  registry.add({ name: 'auditor', description: 'Already exists', account: 'personal', model: 'opus',
    task: 'Old task.', projects: [] });

  const r = sync.scanFolder(d);

  const x = r.found.find((y) => y.name === 'auditor');
  assert.equal(x.alreadyExists, true, 'the same name is the same person; the user must see this');
  assert.equal(x.alreadyHere, false, 'but it is not active in this folder');
});

test("an empty or unreadable folder is not an error; it yields an empty result", (t) => {
  const k = field(t);
  assert.deepEqual(sync.scanFolder(path.join(k, 'none-such-one-place')).found, []);
  assert.deepEqual(sync.scanFolder(null).found, []);
});

/* ---- ONLY THE SELECTED ONES ARE IMPORTED ---- */

test("only the selected agent is imported; the other is left untouched", (t) => {
  const { d } = externalFolder(t, { auditor: definition('auditor'), writer: definition('writer') });

  const r = sync.takeFromFolder(d, ['auditor']);

  assert.deepEqual(r.imported.map((x) => x.name), ['auditor']);
  assert.ok(registry.find('auditor'), 'the selected one must be imported');
  assert.equal(registry.find('writer'), null, 'the unselected one must not be imported');
});

test("an imported agent becomes active in the folder it was FOUND in and keeps its fields", (t) => {
  const { d } = externalFolder(t, { auditor: definition('auditor') });

  sync.takeFromFolder(d, ['auditor']);

  const record = registry.find('auditor');
  assert.deepEqual(record.projects, [d], 'the agent stays where it was found');
  assert.equal(record.task, 'Read and report.');
  assert.equal(record.tools, 'Read', 'the tool restriction is not widened on import');
});

test("if the name already exists no SECOND person is born", (t) => {
  const { d } = externalFolder(t, { auditor: definition('auditor', 'The task in the folder.') });
  registry.add({ name: 'auditor', description: 'Already exists', account: 'personal', model: 'opus',
    task: 'Old task.', projects: [] });

  sync.takeFromFolder(d, ['auditor']);

  assert.equal(registry.list().length, 1, 'the name is the identity; no second record may be created');
  // A different definition under a taken name is another agent: locked, not joined.
  assert.equal(registry.isInProject(registry.find('auditor'), d), false, 'a different agent is not joined');
  assert.equal(registry.hasConflict(registry.find('auditor')), true, 'the name is locked');
});

test("a corrupt file does not enter the registry even when selected; its reason is returned", (t) => {
  const { d } = externalFolder(t, { corrupt: '---\nname: corrupt\nfront matter left open\n' });

  const r = sync.takeFromFolder(d, ['corrupt']);

  assert.deepEqual(r.imported, []);
  assert.equal(r.errors.length, 1);
  assert.equal(registry.find('corrupt'), null);
});

test("if nothing is selected nothing happens", (t) => {
  const { d } = externalFolder(t, { auditor: definition('auditor') });
  const filePath = path.join(folder(d), 'auditor.md');
  const before = read(filePath);

  const r = sync.takeFromFolder(d, []);

  assert.deepEqual(r.imported, []);
  assert.deepEqual(registry.list(), []);
  assert.equal(read(filePath), before, 'a cancel changes neither the file nor the registry');
});

/* ---- THE INTERFACE HALF ---- */

const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../panel/panel.js'), 'utf8');
const slice = source.slice(source.indexOf('function scanSummary('),
  source.indexOf('async function takeFromFolderAgent('));
const context = vm.createContext({});
// The page's counting helper, which these sentences now use for their numbers.
vm.runInContext(source.slice(source.indexOf('function countOf('), source.indexOf('\n}', source.indexOf('function countOf(')) + 2), context);
vm.runInContext(slice, context);
const scanSummary = vm.runInContext('scanSummary', context);

test("for an empty folder it states plainly what was found", () => {
  const s = scanSummary({ found: [] }, 'C:/old/project');
  assert.match(s, /No agent/i);
  assert.match(s, /project/, 'which folder was inspected must be visible');
});

test("what was found and what is already known are reported separately", () => {
  const s = scanSummary({ found: [
    { name: 'auditor', importable: true, alreadyExists: false },
    { name: 'writer', importable: true, alreadyExists: true },
    { name: 'corrupt', importable: false, corrupt: 'front matter that never closes' },
  ] }, 'C:/old/project');
  /* THE NAMES ARE NOT IN THE SUMMARY BUT IN THE TICK LIST: the summary is a heading, and the selection list
     shows the agents one by one. The first expectation written mixed the two up; the expectation was
     corrected, not the product. */
  assert.match(s, /Found 2 agent/, 'the number that can be imported must be written');
  assert.match(s, /1 file could not be read/, 'the number that could not be read must be written too');
  assert.match(s, /corrupt — front matter that never closes/, 'the reason it could not be read must be visible');
  assert.match(s, /already knows 1 of them \(writer\)/, 'the already known one must be reported separately');
  assert.match(s, /Nothing has been changed yet/, 'it must say that nothing has changed before confirmation');
});

test("the preview says the folder will be added and the files rewritten", () => {
  const s = scanSummary({ found: [{ name: 'auditor', importable: true, alreadyExists: false }] }, 'C:/dis/project');
  assert.match(s, /adds this folder to Benchook's project list/, 'it must say the folder will be added');
  assert.match(s, /rewritten in Benchook's format/, 'it must say the source files will be rewritten');
  assert.match(s, /left untouched/, 'it must say the unselected ones are left untouched');
});
