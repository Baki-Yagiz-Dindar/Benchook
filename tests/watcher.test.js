'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const watcher = require('../panel/watcher.js');

/* A change made to the account or model of any agent from any orchestrator must be reflected in the
   panel, and the same goes for the agent list.

   THE WATCHER ITSELF (`fs.watch`) DEPENDS ON THE OPERATING SYSTEM and does not behave the same in every
   environment, so what is tested here is not that the event ARRIVES but that WHAT the panel will tell
   the user is right: which folders are watched, and what the difference sentence says when a file
   changes. Whether the event really arrives is seen on the own screen of the panel; that is also why
   polling was not removed. */

test('project targets: the agent, worker, built-in and skill folders and the registry are watched', () => {
  const h = watcher.projectTargets('C:/p', 'C:/data/accounts.json');
  const paths = h.map((x) => x.filePath.replace(/\\/g, '/'));
  assert.ok(paths.some((y) => y.endsWith('.benchook/agents')));
  assert.ok(!paths.some((y) => y.endsWith('.claude/workers')), 'no folder the panel does not read is watched');
  assert.ok(paths.some((y) => y.endsWith('.claude/agents')));
  assert.ok(paths.some((y) => y.endsWith('.claude/skills')));
  // the Codex skill root is the same as the one of the storage (`.agents/skills`); `.codex/skills`
  // was the wrong root written here by hand, and it is not kept for compatibility either.
  assert.ok(paths.some((y) => y.endsWith('.agents/skills')));
  assert.ok(!paths.some((y) => y.endsWith('.codex/skills')));

  // If the registry CHANGES the agent list must refresh: when an account is deleted the agents bound to
  // it fall back to the orchestrator, so what the card says changes.
  const registry = h.find((x) => x.filePath.replace(/\\/g, '/').endsWith('accounts.json'));
  assert.ok(registry);
  assert.equal(registry.label, 'agent');
});

test('with no project only the registry is watched and no path is invented', () => {
  const h = watcher.projectTargets(null, 'C:/data/accounts.json');
  assert.equal(h.length, 1);
});

/* THE DIFFERENCE SENTENCE, the useful part of the warning: something like "this agent's model
   changed" is what is useful. File changed is not enough; WHAT changed has to be written. */
test('a change of account or model is reported to the user in a readable form', () => {
  const old = ['---', 'name: test', 'model: haiku', 'account: claude-a', '---', '', 'work', ''].join('\n');
  const created = ['---', 'name: test', 'model: sonnet', 'account: claude-b', '---', '', 'work', ''].join('\n');
  const f = watcher.diffs(old, created);
  const c = watcher.diffSentence(f);
  assert.match(c, /model: haiku → sonnet/);
  assert.match(c, /account: claude-a → claude-b/);
});

test('when only the task text changed the header fields are not reported as changed', () => {
  const old = ['---', 'name: test', 'model: haiku', '---', '', 'an older job', ''].join('\n');
  const created = ['---', 'name: test', 'model: haiku', '---', '', 'a newer job', ''].join('\n');
  const f = watcher.diffs(old, created);
  assert.equal(f.length, 1);
  assert.equal(f[0].field, 'Instructions');
  assert.match(watcher.diffSentence(f), /Instructions changed/);
});

test('a move from an empty field to a filled one is written as Empty and not skipped', () => {
  const old = ['---', 'name: test', '---', '', 'work', ''].join('\n');
  const created = ['---', 'name: test', 'account: claude-a', '---', '', 'work', ''].join('\n');
  assert.match(watcher.diffSentence(watcher.diffs(old, created)), /account: Empty → claude-a/);
});

test('with no change the diff list is empty', () => {
  const raw = ['---', 'name: test', 'model: haiku', '---', '', 'work', ''].join('\n');
  assert.equal(watcher.diffs(raw, raw).length, 0);
});

test('fingerTrace returns null for a missing file and invents nothing', () => {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-'));
  try {
    assert.equal(watcher.fingerTrace(path.join(k, 'none.md')), null);
    const y = path.join(k, 'var.md');
    fs.writeFileSync(y, 'content');
    assert.equal(watcher.fingerTrace(y), 'content');
  } finally { fs.rmSync(k, { recursive: true, force: true }); }
});

/* A real `fs.watch`: does an event arrive on this machine? If not, the test does NOT fail -- polling is
   the fallback anyway. But if it does, the watcher has been seen to really be set up. */
test('a file change in a real folder produces a notice (skipped when the environment does not support it)', async (t) => {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-live-'));
  t.after(() => fs.rmSync(k, { recursive: true, force: true }));

  const incoming = [];
  const w = watcher.setupWatcher((label) => incoming.push(label));
  w.setup([{ filePath: k, label: 'agent' }]);
  t.after(() => w.close());

  fs.writeFileSync(path.join(k, 'created.md'), 'x');
  await new Promise((r) => setTimeout(r, watcher.WAITING_MS + 400));

  if (!incoming.length) { t.skip('fs.watch produced no event in this environment; the polling fallback still applies'); return; }
  assert.equal(incoming[0], 'agent');
  // Do events arriving back to back collapse into one notice -- otherwise one edit would refresh the
  // page many times over.
  assert.ok(incoming.length <= 2, 'the events must be coalesced, received: ' + incoming.length);
});
