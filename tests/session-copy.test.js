'use strict';

// Moving the session record to the target profile when switching accounts -
// the MECHANISM beneath answer-key item 3. Whether the terminal really waited in the panel is
// measured by eye; what is measured here is the copy itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const context = require('../panel/sessions');

function temp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const PROJECT = 'C:\\Projects\\example';
const ID = 'cd51ee99-0108-4e0e-8eea-00a8ea634901';

/** Like a real Claude profile: <root>/projects/<project-name>/<id>.jsonl and subagents. */
function setupClaudeProfile(root, id, content) {
  const k = context.claudeFolder(PROJECT, root);
  fs.mkdirSync(path.join(k, id, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(k, id + '.jsonl'), content, 'utf8');
  fs.writeFileSync(path.join(k, id, 'subagents', 'agent-1.meta.json'),
    '{"agentType":"researcher"}', 'utf8');
  return k;
}

test('Claude: the session record and the sub-agent folder are copied to the target profile', (t) => {
  const source = temp(t, 'copy-source-'), target = temp(t, 'copy-target-');
  setupClaudeProfile(source, ID, '{"benzersiz":"kirmizi-kelebek-41"}\n');

  const written = context.copySession('claude', PROJECT, ID, source, target);

  assert.ok(written.startsWith(target), 'the copy was not written to the target profile: ' + written);
  assert.match(fs.readFileSync(written, 'utf8'), /kirmizi-kelebek-41/);
  const targetFolder = context.claudeFolder(PROJECT, target);
  assert.ok(fs.existsSync(path.join(targetFolder, ID, 'subagents', 'agent-1.meta.json')),
    'the sub-agent folder was not carried over');
});

test('Claude: a copied session is found again by its identity in the target profile', (t) => {
  const source = temp(t, 'copy-source-'), target = temp(t, 'copy-target-');
  setupClaudeProfile(source, ID, '{"a":1}\n');
  context.copySession('claude', PROJECT, ID, source, target);

  // The panel looks for this for --resume after the switch. If it is missing, continuing where it left off does not work.
  assert.ok(context.findSessionFile('claude', PROJECT, ID, target));
});

test('source hesapta session yoksa copy YAPILMAZ, error atar', (t) => {
  const source = temp(t, 'copy-source-'), target = temp(t, 'copy-target-');
  assert.throws(() => context.copySession('claude', PROJECT, ID, source, target),
    /source account/);
  assert.equal(fs.existsSync(context.claudeFolder(PROJECT, target)), false,
    'a failed copy left a half-written folder on the target');
});

test('Codex: the record is copied keeping its date folder structure', (t) => {
  const source = temp(t, 'copy-source-'), target = temp(t, 'copy-target-');
  const relative = path.join('2026', '09', '05', 'rollout-2026-09-05T10-00-00-' + ID + '.jsonl');
  fs.mkdirSync(path.dirname(path.join(source, 'sessions', relative)), { recursive: true });
  fs.writeFileSync(path.join(source, 'sessions', relative), '{"b":2}\n', 'utf8');

  context.copySession('codex', PROJECT, ID, source, target);

  assert.ok(fs.existsSync(path.join(target, 'sessions', relative)),
    'the Codex record is not on the same date path on the target');
});

test('a copy does not delete the source - the way back stays open', (t) => {
  const source = temp(t, 'copy-source-'), target = temp(t, 'copy-target-');
  setupClaudeProfile(source, ID, '{"a":1}\n');
  context.copySession('claude', PROJECT, ID, source, target);

  assert.ok(context.findSessionFile('claude', PROJECT, ID, source),
    'no record was left on the source account; if the copy failed the old session could not be opened');
});

test('a NEWER record on the target is NOT overwritten', (t) => {
  const source = temp(t, 'copy-source-'), target = temp(t, 'copy-target-');
  setupClaudeProfile(source, ID, '{"old":"the old record of account A"}\n');

  // A NEWER record with the same identity in the target: the user has worked there.
  const targetFolder = context.claudeFolder(PROJECT, target);
  fs.mkdirSync(targetFolder, { recursive: true });
  const targetFile = path.join(targetFolder, ID + '.jsonl');
  fs.writeFileSync(targetFile, '{"created":"B hesabinda yapilan is"}\n', 'utf8');
  const after = Date.now() + 5000;
  fs.utimesSync(targetFile, after / 1000, after / 1000);

  assert.throws(() => context.copySession('claude', PROJECT, ID, source, target),
    /newer or divergent/);
  assert.match(fs.readFileSync(targetFile, 'utf8'), /B hesabinda yapilan is/,
    'the newer record on the target was overwritten');
});

test('a source that extends the destination session can be copied', (t) => {
  const source = temp(t, 'copy-source-'), target = temp(t, 'copy-target-');
  setupClaudeProfile(source, ID, '{"old":"stale"}\n{"created":"current record"}\n');

  const targetFolder = context.claudeFolder(PROJECT, target);
  fs.mkdirSync(targetFolder, { recursive: true });
  const targetFile = path.join(targetFolder, ID + '.jsonl');
  fs.writeFileSync(targetFile, '{"old":"stale"}\n', 'utf8');
  const once = Date.now() - 60000;
  fs.utimesSync(targetFile, once / 1000, once / 1000);

  context.copySession('claude', PROJECT, ID, source, target);
  assert.match(fs.readFileSync(targetFile, 'utf8'), /current record/);
});
