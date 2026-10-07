// PROJECT SKILLS - tests for the layer that writes the skills of a project to both sides at once.
//
// Why two sides: measured with marker skills. There is NO shared folder at project level:
//   <project>/.claude/skills -> Claude only,  <project>/.agents/skills -> Codex only.
//
// The rule: whenever a skill enters the system from anywhere, it must be created identically for both
// Claude and Codex. Most of the tests below protect exactly that: a skill written to one side only is a DEFECT.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const b = require('../panel/skills.js');

function project(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-'));
  for (const [filePath, content] of Object.entries(files)) {
    const full = path.join(root, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return root;
}

const SKILL = (name, description) =>
  '---\nname: ' + name + '\ndescription: ' + (description || 'when it is used') + '\n---\n\n# '
  + name + '\n\nbody\n';

function sourceSkill(name, extraFile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-'));
  const folder = path.join(root, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'SKILL.md'), SKILL(name), 'utf8');
  if (extraFile) {
    fs.mkdirSync(path.join(folder, path.dirname(extraFile)), { recursive: true });
    fs.writeFileSync(path.join(folder, extraFile), 'extra content', 'utf8');
  }
  return folder;
}

test('a skill present on both sides shows as a SINGLE row', () => {
  const p = project({
    '.claude/skills/team-loop/SKILL.md': SKILL('team-loop'),
    '.agents/skills/team-loop/SKILL.md': SKILL('team-loop'),
  });
  const list = b.existing(p);
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual(list[0].sides.sort(), ['claude', 'codex']);
  assert.deepStrictEqual(list[0].missingSide, []);
  assert.strictEqual(list[0].divergent, false);
});

test('a skill present on one side only is flagged as MISSING', () => {
  const p = project({ '.claude/skills/only/SKILL.md': SKILL('only') });
  const [x] = b.existing(p);
  assert.deepStrictEqual(x.sides, ['claude']);
  assert.deepStrictEqual(x.missingSide, ['codex'], 'the Codex side is missing but nothing says so');
});

/* DIVERGENCE IS NOT HIDDEN. If the two copies differ, the skill of the same name behaves differently
   under the two orchestrators; if that stayed silent the user would never find the reason. */
test('when the two copies differ it is called DIVERGENT', () => {
  const p = project({
    '.claude/skills/x/SKILL.md': SKILL('x', 'an older description'),
    '.agents/skills/x/SKILL.md': SKILL('x', 'a newer description'),
  });
  assert.strictEqual(b.existing(p)[0].divergent, true);
});

test('identical copies are NOT called divergent', () => {
  const p = project({
    '.claude/skills/x/SKILL.md': SKILL('x'),
    '.agents/skills/x/SKILL.md': SKILL('x'),
  });
  assert.strictEqual(b.existing(p)[0].divergent, false);
});

test('a folder with no SKILL.md does not count as a skill', () => {
  const p = project({ '.claude/skills/empty/NOTES.md': 'not a skill' });
  assert.deepStrictEqual(b.existing(p), []);
});

test('adding writes to BOTH SIDES at once', () => {
  const p = project({});
  const r = b.add(p, sourceSkill('trial'));
  assert.ok(!r.error, r.error);
  for (const side of ['.claude', '.agents']) {
    const filePath = path.join(p, side, 'skills', 'trial', 'SKILL.md');
    assert.ok(fs.existsSync(filePath), side + ' side was not written: ' + filePath);
  }
});

/* A skill does not have to be a SINGLE FILE; unlike agents, the whole folder is carried. That is why
   the missing-file warning agents need is not needed for skills. */
test('adding carries the side files too', () => {
  const p = project({});
  b.add(p, sourceSkill('many-files', 'references/ek.md'));
  assert.ok(fs.existsSync(path.join(p, '.agents/skills/many-files/references/ek.md')));
  assert.ok(fs.existsSync(path.join(p, '.claude/skills/many-files/references/ek.md')));
});

test('it does not overwrite when the name already exists', () => {
  const p = project({ '.claude/skills/trial/SKILL.md': SKILL('trial') });
  assert.match(b.add(p, sourceSkill('trial')).error || '', /already exists/);
});

test('kaynakta SKILL.md yoksa eklemez', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));
  assert.match(b.add(project({}), empty).error || '', /does not contain SKILL\.md/);
});

test('editing updates BOTH SIDES at once', () => {
  const p = project({
    '.claude/skills/x/SKILL.md': SKILL('x', 'old'),
    '.agents/skills/x/SKILL.md': SKILL('x', 'old'),
  });
  const created = SKILL('x', 'created');
  assert.ok(!b.write(p, 'x', created).error);
  assert.strictEqual(fs.readFileSync(path.join(p, '.claude/skills/x/SKILL.md'), 'utf8'), created);
  assert.strictEqual(fs.readFileSync(path.join(p, '.agents/skills/x/SKILL.md'), 'utf8'), created);
  assert.strictEqual(b.existing(p)[0].divergent, false, 'an edit must leave no divergence');
});

test('empty content is not written', () => {
  const p = project({ '.claude/skills/x/SKILL.md': SKILL('x') });
  assert.match(b.write(p, 'x', '   ').error || '', /empty/i);
});

test('removing deletes from BOTH SIDES at once', () => {
  const p = project({
    '.claude/skills/x/SKILL.md': SKILL('x'),
    '.agents/skills/x/SKILL.md': SKILL('x'),
  });
  const r = b.remove(p, 'x');
  assert.ok(!r.error, r.error);
  assert.strictEqual(fs.existsSync(path.join(p, '.claude/skills/x')), false);
  assert.strictEqual(fs.existsSync(path.join(p, '.agents/skills/x')), false);
});

/* The path is protected by a RULE, not by care: `remove` can delete only INSIDE the skill folders of
   the project. Otherwise a mistake in a name could delete somewhere else in the project. */
test('a name that escapes OUTSIDE the skill folder is not deleted', () => {
  const p = project({ 'important/file.txt': 'keep', '.claude/skills/x/SKILL.md': SKILL('x') });
  const r = b.remove(p, path.join('..', '..', '..', 'important'));
  assert.ok(r.error, 'the panel agreed to delete outside the project');
  assert.strictEqual(fs.existsSync(path.join(p, 'important/file.txt')), true);
});

test('trying to delete a missing skill gives the reason', () => {
  assert.match(b.remove(project({}), 'none').error || '', /not in this project/);
  assert.equal(b.remove(project({}), 'none').absent, true, 'callers tell absence apart without reading the sentence');
});

test('the sync fills the missing side from the source', () => {
  const p = project({ '.claude/skills/x/SKILL.md': SKILL('x', 'the right one') });
  assert.ok(!b.syncSkill(p, 'x', 'claude').error);
  const [list] = b.existing(p);
  assert.deepStrictEqual(list.missingSide, []);
  assert.strictEqual(list.divergent, false);
});

test('opening the panel completes one-sided skills onto the other side automatically', () => {
  const p = project({
    '.claude/skills/x/SKILL.md': SKILL('x', 'must stay the same'),
    '.claude/skills/x/references/extra.md': 'helper file',
  });
  const r = b.completeMissing(p);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.synced.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(p, '.agents/skills/x/SKILL.md'), 'utf8'),
    SKILL('x', 'must stay the same'));
  assert.strictEqual(fs.readFileSync(path.join(p, '.agents/skills/x/references/extra.md'), 'utf8'),
    'helper file');
  assert.deepStrictEqual(b.existing(p)[0].missingSide, []);
});

test('the automatic completion does not pick between two different existing copies on its own', () => {
  const p = project({
    '.claude/skills/x/SKILL.md': SKILL('x', 'claude'),
    '.agents/skills/x/SKILL.md': SKILL('x', 'codex'),
  });
  const r = b.completeMissing(p);
  assert.deepStrictEqual(r.synced, []);
  assert.strictEqual(b.existing(p)[0].divergent, true);
});

test('the automatic completion does not overwrite an existing target folder with no SKILL.md', () => {
  const p = project({
    '.claude/skills/x/SKILL.md': SKILL('x', 'source'),
    '.agents/skills/x/README.md': 'korunacak file',
  });
  const r = b.completeMissing(p);
  assert.strictEqual(r.synced.length, 0);
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0].error, /destination folder already exists/);
  assert.strictEqual(fs.readFileSync(path.join(p, '.agents/skills/x/README.md'), 'utf8'),
    'korunacak file');
  assert.strictEqual(fs.existsSync(path.join(p, '.agents/skills/x/SKILL.md')), false);
});

test('the sync corrects a DIVERGED side against the source', () => {
  const p = project({
    '.claude/skills/x/SKILL.md': SKILL('x', 'correct'),
    '.agents/skills/x/SKILL.md': SKILL('x', 'corrupt'),
  });
  b.syncSkill(p, 'x', 'claude');
  assert.strictEqual(
    fs.readFileSync(path.join(p, '.agents/skills/x/SKILL.md'), 'utf8'), SKILL('x', 'correct'));
});

test('with no skill on the source side it does not sync', () => {
  const p = project({ '.agents/skills/x/SKILL.md': SKILL('x') });
  assert.match(b.syncSkill(p, 'x', 'claude').error || '', /source provider does not contain/);
});

test('a SKILL.md with no heading falls back to the folder name and does not crash', () => {
  const p = project({ '.claude/skills/unnamed/SKILL.md': 'no heading, plain text\n' });
  const [x] = b.existing(p);
  assert.strictEqual(x.name, 'unnamed');
  assert.strictEqual(x.description, '');
});

test('with no project supplied it returns an empty list and throws no error', () => {
  assert.deepStrictEqual(b.existing(null), []);
});
