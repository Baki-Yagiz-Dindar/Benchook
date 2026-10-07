'use strict';
// LIVE SYNC SCOPE ACROSS BACKGROUND PROJECTS.
// 
// THE SUSPICION, from a review: the watcher was tied to the selected project, and there was no
// continuous sync for every project in the background. It was a suspicion to be measured, not a proven
// defect. MEASURED (real modules plus a real `fs.watch`) and confirmed -- and it turned out worse than a
// delay:
// 
// paths watched while A is selected: 6 | is the folder of B watched: false
// notices received after B was edited: 0
// save from the A screen -> is the edit the orchestrator made in B still in the file of B: FALSE
// (had B been selected: changed = [auditor], central task = the text the orchestrator wrote)
// 
// So the problem was not that it shows up a little late: the panel overwrote a real edit SITTING in a
// background project without ever seeing it - the silently inverted form of the promise that
// changing it in one place changes it everywhere.
// 
// THE SCOPE DECISION (a written limit, not a silent narrowing): OPEN projects are watched -- projects
// opened in this session whose field and terminals are alive. A project registered with the panel but
// never opened is not watched; the live promise is about open projects. The number of watchers is
// capped (`MAX_PROJECTS`), because each project means five folders and an operating-system watcher is
// not free.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../panel/agent-registry');
const sync = require('../panel/agent-sync');
const watcher = require('../panel/watcher');

function field() {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'live-scope-'));
  registry.setup(path.join(k, 'agents.json'));
  const project = (name, openFolder = true) => {
    const y = path.join(k, name);
    if (openFolder) fs.mkdirSync(path.join(y, '.benchook', 'agents'), { recursive: true });
    else fs.mkdirSync(y, { recursive: true });
    return y;
  };
  return { k, project, registryPath: path.join(k, 'agents.json'),
    cleanup: () => fs.rmSync(k, { recursive: true, force: true }) };
}
const filePath = (p, name = 'auditor') => path.join(p, '.benchook', 'agents', name + '.md');
const read = (y) => fs.readFileSync(y, 'utf8');

/** One agent active in two projects, published to both. */
function twoProject(t) {
  const a = field(); t.after(a.cleanup);
  const A = a.project('project-A'), B = a.project('project-B');
  registry.add({ name: 'auditor', description: 'Code incelenecekse', account: 'orchestrator',
    model: 'orchestrator', task: 'First instruction.', projects: [A, B] });
  const y = sync.publishAgent(registry.find('auditor'));
  assert.deepEqual(y.errors, [], 'setup: it must be written to both projects');
  return { a, A, B };
}

/** Waits until a notice arrives; returns null if none does. A real `fs.watch` is used. */
function notifyWait(box, duration = 2500) {
  return new Promise((resolve) => {
    const end = Date.now() + duration;
    const look = () => {
      if (box.length) return resolve(box[0]);
      if (Date.now() > end) return resolve(null);
      setTimeout(look, 40);
    };
    look();
  });
}

/* ---- SCOPE ---- */

test("the targets cover every OPEN project and are tagged with their project", (t) => {
  const { a, A, B } = twoProject(t);

  const h = watcher.targets([A, B], a.registryPath);

  assert.ok(h.some((x) => x.filePath.includes('project-A') && x.label === 'agent'));
  assert.ok(h.some((x) => x.filePath.includes('project-B') && x.label === 'agent'),
    'a background project must be watched too; V02 was precisely the absence of this');
  const bTarget = h.find((x) => x.filePath.includes('project-B'));
  assert.equal(bTarget.project, B, 'the notice must say which project the event belongs to');
  assert.ok(h.some((x) => x.filePath === a.registryPath && !x.project), 'registry de izlenmeye devam');
});

test("the number of watchers is capped; the selected project is always in scope", (t) => {
  const a = field(); t.after(a.cleanup);
  const projects = [];
  for (let i = 0; i < watcher.MAX_PROJECTS + 5; i++) projects.push(a.project('p' + i));

  const h = watcher.targets(projects, a.registryPath);
  const covered = new Set(h.filter((x) => x.project).map((x) => x.project));

  assert.equal(covered.size, watcher.MAX_PROJECTS, 'the cap must be enforced');
  assert.ok(covered.has(projects[0]), 'the first (selected) project must not be dropped');
});

test("a change in a project that is NOT selected still produces a notice", async (t) => {
  const { a, A, B } = twoProject(t);
  const notices = [];
  const w = watcher.setupWatcher((label, project) => notices.push({ label, project }));
  t.after(() => w.close());
  w.setup(watcher.targets([A, B], a.registryPath));

  fs.writeFileSync(filePath(B), read(filePath(B)).replace('First instruction.', 'Edited from outside.'));
  const notify = await notifyWait(notices);

  assert.ok(notify, 'a change in a background project must produce a notice');
  assert.equal(notify.label, 'agent');
  assert.equal(notify.project, B, 'the notice must carry which project it happened in');
});

test("when a project is forgotten its watcher is released too", async (t) => {
  const { a, A, B } = twoProject(t);
  const notices = [];
  const w = watcher.setupWatcher((label, project) => notices.push({ label, project }));
  t.after(() => w.close());
  w.setup(watcher.targets([A, B], a.registryPath));
  w.setup(watcher.targets([A], a.registryPath));   // B was closed or forgotten

  fs.writeFileSync(filePath(B), read(filePath(B)).replace('First instruction.', 'No longer watched.'));
  const notify = await notifyWait(notices, 900);

  assert.equal(notify, null, 'if a released project still emits events the watcher is leaking');
});

test("a folder created LATER is caught as well", async (t) => {
  const a = field(); t.after(a.cleanup);
  const C = a.project('project-C', false);   // the agent folder does not exist yet
  const notices = [];
  const w = watcher.setupWatcher((label, project) => notices.push({ label, project }),
    { reTryMs: 120 });
  t.after(() => w.close());
  w.setup(watcher.targets([C], a.registryPath));

  fs.mkdirSync(path.join(C, '.benchook', 'agents'), { recursive: true });
  await new Promise((c) => setTimeout(c, 400));            // let the retry interval pass
  fs.writeFileSync(filePath(C), '---\nname: auditor\n---\n\nTask.\n');
  const notify = await notifyWait(notices);

  assert.ok(notify, 'a folder born later must be watched too, otherwise a new project stays silent');
  assert.equal(notify.project, C);
});

/* ---- SYNC ---- */

test("a background edit reaches the centre and the OTHER project", (t) => {
  const { A, B } = twoProject(t);
  fs.writeFileSync(filePath(B), read(filePath(B))
    .replace('First instruction.', 'The edit the orchestrator made inside B.'));

  const r = sync.reconcileAll([A, B]);

  assert.equal(registry.find('auditor').task, 'The edit the orchestrator made inside B.',
    'a real edit in a project that is not selected must be applied to the centre');
  assert.match(read(filePath(A)), /The edit the orchestrator made inside B/, 'and it must propagate to the other project');
  assert.deepEqual(r.errors, []);
  assert.ok(r.changed.some((x) => x.name === 'auditor'));
});

test("after a sync, saving from the A screen does NOT erase the edit made in B", (t) => {
  const { A, B } = twoProject(t);
  fs.writeFileSync(filePath(B), read(filePath(B))
    .replace('First instruction.', 'The edit the orchestrator made inside B.'));

  /* The real order: the panel syncs the open projects, then the user changes a field on the A screen
     and saves (the form path: update plus publish). THE OLD BEHAVIOUR THAT WAS MEASURED: with no sync at
     all, the edit in B was silently overwritten. */
  sync.reconcileAll([A, B]);
  const g = registry.update('auditor', { description: 'Changed from the A screen' });
  sync.publishAgent(g.agent);

  assert.match(read(filePath(B)), /The edit the orchestrator made inside B/,
    'real work done outside must not be lost');
  assert.match(read(filePath(A)), /The edit the orchestrator made inside B/);
  assert.match(read(filePath(A)), /Changed from the A screen/, 'the edit the user made must stay as well');
});

test("a second sync writes nothing - our own write does not create a loop", (t) => {
  const { A, B } = twoProject(t);
  fs.writeFileSync(filePath(B), read(filePath(B)).replace('First instruction.', 'Edited from outside.'));
  sync.reconcileAll([A, B]);

  const second = sync.reconcileAll([A, B]);
  const third = sync.reconcileAll([A, B]);

  assert.deepEqual(second.changed, [], 'a settled file must not count as changed');
  assert.deepEqual(third.changed, []);
  assert.deepEqual(second.errors, []);
});

test("an unreadable project does not stop the others", (t) => {
  const { a, A, B } = twoProject(t);
  fs.writeFileSync(filePath(B), read(filePath(B)).replace('First instruction.', 'Edited from outside.'));
  const noneProject = path.join(a.k, 'deleted-project');

  const r = sync.reconcileAll([noneProject, A, B]);

  assert.equal(registry.find('auditor').task, 'Edited from outside.',
    'one unreadable project must not block the others from syncing');
  assert.deepEqual(r.errors, []);
});

test("a storm of events collapses into a single notice", async (t) => {
  const { a, A, B } = twoProject(t);
  const notices = [];
  const w = watcher.setupWatcher((label, project) => notices.push({ label, project }));
  t.after(() => w.close());
  w.setup(watcher.targets([A, B], a.registryPath));

  // An orchestrator can write many files in a row; running a sync for each write would keep the panel
  // busy. Debouncing (WAITING_MS) collapses them into one notice.
  for (let i = 0; i < 25; i++) {
    fs.writeFileSync(filePath(B, 'temp' + i), '---\nname: temp' + i + '\n---\n\nTask.\n');
  }
  await notifyWait(notices);
  await new Promise((c) => setTimeout(c, 700));

  assert.ok(notices.length <= 4,
    'notices received for 25 writes: ' + notices.length + ' - debouncing is not working');
  assert.ok(notices.every((h) => h.project === B));
});

// ---------------------------------------------------------------------------
// THE INTERFACE HALF - the open-projects list of the page
//
// `panel.js` runs in the page; it is sliced out of its source and run in an isolated context (see
// tests/panel-state.test.js). The main process receives only this list, so the correctness of the
// scope starts here.
// ---------------------------------------------------------------------------

const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../panel/panel.js'), 'utf8');
const slice = source.slice(source.indexOf('function openProjects('),
  source.indexOf('async function setupWatching('));

function page(selected, fields) {
  const context = vm.createContext({
    project: selected,
    FIELDLESS: "(No project)",
    projectFields: new Map(fields.map((x) => [x, {}])),
  });
  vm.runInContext(slice, context);
  return vm.runInContext('openProjects()', context);
}

test("the open project list STARTS with the selected one and contains them all", () => {
  const list = page('C:/p/b', ['C:/p/a', 'C:/p/b', 'C:/p/c']);
  assert.equal(list[0], 'C:/p/b', 'the selected project must come first; the cap must not catch it');
  assert.deepEqual([...list].sort(), ['C:/p/a', 'C:/p/b', 'C:/p/c']);
});

test("with no project selected the list is empty; no fake project is invented", () => {
  assert.deepEqual(page(null, ["(No project)"]), []);
});

test("once a closed project loses its field it drops off the list too", () => {
  const once = page('C:/p/a', ['C:/p/a', 'C:/p/b']);
  const after = page('C:/p/a', ['C:/p/a']);   // B was forgotten: its field was removed
  assert.equal(once.length, 2);
  assert.deepEqual(after, ['C:/p/a']);
});
