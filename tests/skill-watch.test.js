'use strict';
// THE SKILL WATCHER WAS LOOKING AT THE WRONG FOLDER.
//
// Measured defect: the skill module keeps the Codex side under `.agents/skills` (measured, not assumed),
// while the watcher watched `.codex/skills`. A change made from outside to the right folder never reached
// the watcher; the page refreshed only when the tab was clicked again. The two roots were written by hand
// in two places; when one changed the other did not.
//
// Fix: the watcher takes its roots from the skill module's OWN table -- a single source.
// No compatibility support was written for `.codex/skills`: the watcher was the only place reading it and
// storage never used it; so it was not an old path, it was a wrong path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const watcher = require('../panel/watcher');
const skills = require('../panel/skills');

function field(t) {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-watch-'));
  t.after(() => fs.rmSync(k, { recursive: true, force: true }));
  const project = path.join(k, 'project');
  fs.mkdirSync(project);
  return { k, project, registryPath: path.join(k, 'agents.json') };
}

function notifyWait(box, duration = 2500) {
  return new Promise((resolve) => {
    const end = Date.now() + duration;
    const look = () => {
      const h = box.find((x) => x.label === 'skill');
      if (h) return resolve(h);
      if (Date.now() > end) return resolve(null);
      setTimeout(look, 40);
    };
    look();
  });
}

/* ---- ROOTS FROM A SINGLE SOURCE ---- */

test("the watcher watches EVERY root of the skill module", (t) => {
  const { project } = field(t);
  const watched = watcher.projectFolders(project)
    .filter((x) => x.label === 'skill').map((x) => path.resolve(x.filePath));

  for (const side of Object.keys(skills.SIDES)) {
    const root = path.resolve(skills.folder(project, side));
    assert.ok(watched.includes(root), side + ' side root is not being watched: ' + root);
  }
});

test("a folder the storage never uses is not watched", (t) => {
  const { project } = field(t);
  const watched = watcher.projectFolders(project).map((x) => x.filePath.replace(/\\/g, '/'));
  assert.ok(!watched.some((y) => y.endsWith('.codex/skills')),
    'watching a folder the storage never writes to would stand in for the wrong root');
});

/* ---- REAL FILE EVENT ---- */

test("a change in the Codex skill folder produces a notice", async (t) => {
  const { project, registryPath } = field(t);
  const root = skills.folder(project, 'codex');
  fs.mkdirSync(path.join(root, 'sample'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sample', 'SKILL.md'), '# Sample\n');
  const notices = [];
  const w = watcher.setupWatcher((label, p) => notices.push({ label, project: p }));
  t.after(() => w.close());
  w.setup(watcher.targets([project], registryPath));

  fs.writeFileSync(path.join(root, 'sample', 'SKILL.md'), '# Sample\n\nEdited from outside.\n');
  const notify = await notifyWait(notices);

  assert.ok(notify, 'a change in the right folder must reach the watcher');
  assert.equal(notify.project, project);
});

test("the Claude skill folder produces a notice too", async (t) => {
  const { project, registryPath } = field(t);
  const root = skills.folder(project, 'claude');
  fs.mkdirSync(root, { recursive: true });
  const notices = [];
  const w = watcher.setupWatcher((label, p) => notices.push({ label, project: p }));
  t.after(() => w.close());
  w.setup(watcher.targets([project], registryPath));

  fs.mkdirSync(path.join(root, 'created'));
  fs.writeFileSync(path.join(root, 'created', 'SKILL.md'), '# Created\n');

  assert.ok(await notifyWait(notices), 'this side must not break while the other side is being fixed');
});

test("a skill folder absent at the start is watched once it appears later", async (t) => {
  const { project, registryPath } = field(t);        // no skill folder exists
  const notices = [];
  const w = watcher.setupWatcher((label, p) => notices.push({ label, project: p }),
    { reTryMs: 120 });
  t.after(() => w.close());
  w.setup(watcher.targets([project], registryPath));

  const root = skills.folder(project, 'codex');
  fs.mkdirSync(root, { recursive: true });
  await new Promise((c) => setTimeout(c, 400));           // let the retry interval pass
  fs.mkdirSync(path.join(root, 'late'));
  fs.writeFileSync(path.join(root, 'late', 'SKILL.md'), '# Late\n');

  assert.ok(await notifyWait(notices), 'a skill change must be seen even when the folder appeared later');
});

test("a deletion produces a notice too", async (t) => {
  const { project, registryPath } = field(t);
  const root = skills.folder(project, 'codex');
  fs.mkdirSync(path.join(root, 'toDelete'), { recursive: true });
  fs.writeFileSync(path.join(root, 'toDelete', 'SKILL.md'), '# S\n');
  const notices = [];
  const w = watcher.setupWatcher((label, p) => notices.push({ label, project: p }));
  t.after(() => w.close());
  w.setup(watcher.targets([project], registryPath));

  fs.rmSync(path.join(root, 'toDelete'), { recursive: true, force: true });

  assert.ok(await notifyWait(notices), 'a removed skill must drop off the open page');
});
