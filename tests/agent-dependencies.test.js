// Tests for the scan that finds the FILE DEPENDENCIES in an agent definition.
//
// Why it exists: some agents are not single-file - their bodies say to apply a procedure that lives in
// another file. When the panel copies an agent it carries one file, so such an agent is born quietly
// crippled in the target project. The warning mark makes that visible.
//
// The real job of these tests is also to protect the case where the mark does NOT light: if every card
// carried a mark, the mark would say nothing. So every lights-up test below has a stays-off twin.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { dependency } = require('../panel/agent-writer.js');

function temp(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'link-'));
  for (const [filePath, content] of Object.entries(files)) {
    const full = path.join(root, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return root;
}

test('a file that is executed counts as a STRONG missing dependency', () => {
  const root = temp({ 'empty.txt': 'x' });
  const b = dependency('Execute .claude/skills/sample-start/SKILL.md for the request.', root);
  assert.deepStrictEqual(b.missingStrong, ['.claude/skills/sample-start/SKILL.md']);
});

test('SAME agent, file exists strong missing none', () => {
  const root = temp({ '.claude/skills/sample-start/SKILL.md': '# Procedure' });
  const b = dependency('Execute .claude/skills/sample-start/SKILL.md for the request.', root);
  assert.deepStrictEqual(b.missingStrong, []);
  assert.strictEqual(b.all.length, 1);
  assert.strictEqual(b.all[0].exists, true);
});

test('a read-only document that is missing raises no alarm; it is a soft missing', () => {
  const root = temp({ 'empty.txt': 'x' });
  const b = dependency('Look up the findings in docs/research/INDEX.md.', root);
  assert.deepStrictEqual(b.missingStrong, []);
  assert.deepStrictEqual(b.missingSoft, ['docs/research/INDEX.md']);
});

/* THE EXTENSION ALONE IS NOT ENOUGH. A `.sh` or `.py` extension used to count as STRONG on its own,
   which lit the mark even for a file named in a descriptive sentence. The question now is whether the
   verb governs that path; both directions are tested. */
test('a shell script is strong when it is EXECUTED', () => {
  const root = temp({ 'empty.txt': 'x' });
  const b = dependency('Use `bash .claude/hooks/memory.sh search "topic"` for retrieval.', root);
  assert.deepStrictEqual(b.missingStrong, ['.claude/hooks/memory.sh']);
});

test('a shell script that is only MENTIONED is not strong', () => {
  const root = temp({ 'empty.txt': 'x' });
  const b = dependency('The search helper lives in .claude/hooks/memory.sh these days.', root);
  assert.deepStrictEqual(b.missingStrong, []);
  assert.deepStrictEqual(b.missingSoft, ['.claude/hooks/memory.sh']);
});

/* IN TURKISH THE VERB COMES LAST. An agent written in Turkish would slip through a rule that only
   looks backwards. */
test('it is caught even when the verb follows the path, as Turkish word order puts it', () => {
  const root = temp({ 'empty.txt': 'x' });
  const b = dependency('Apply the file .claude/skills/x/SKILL.md.', root);
  assert.deepStrictEqual(b.missingStrong, ['.claude/skills/x/SKILL.md']);
});

test('a header field is not mistaken for a path', () => {
  const root = temp({ 'empty.txt': 'x' });
  const b = dependency('---\ntools: Read, Grep, Glob, Bash\nmodel: inherit\n---\n', root);
  assert.deepStrictEqual(b.all, []);
});

test('a web address does not count as a path', () => {
  const root = temp({ 'empty.txt': 'x' });
  const b = dependency('Source: https://example.com/one/reference.md', root);
  assert.deepStrictEqual(b.all, []);
});

test('the agent OWN file is not counted as a dependency', () => {
  const root = temp({ '.claude/agents/x.md': 'me' });
  const own = path.join(root, '.claude/agents/x.md');
  const b = dependency('This file lives in .claude/agents/x.md.', root, own);
  assert.deepStrictEqual(b.all, []);
});

test('the same agent is clean in the SOURCE project and missing in the TARGET project', () => {
  const text = 'Execute .claude/skills/sample-end/SKILL.md in advisor mode.';
  const source = temp({ '.claude/skills/sample-end/SKILL.md': '# Procedure' });
  const target = temp({ 'empty.txt': 'x' });
  assert.deepStrictEqual(dependency(text, source).missingStrong, []);
  assert.deepStrictEqual(dependency(text, target).missingStrong, ['.claude/skills/sample-end/SKILL.md']);
});

/* Dependency strength depends on whether the execution verb governs the path. Cover informational mentions, line breaks, and sentence boundaries. */
test('a .py path inside an INFORMATIONAL sentence is not strong', () => {
  const root = temp({ 'empty.txt': 'x' });
  const text = 'Image generation is hosted too — fal.ai FLUX-schnell and DeepInfra '
    + 'FLUX-dev in `src/core/image_gen_api.py` — even though the rung is NAMED gen_image.';
  const b = dependency(text, root);
  assert.deepStrictEqual(b.missingStrong, []);
  assert.deepStrictEqual(b.missingSoft, ['src/core/image_gen_api.py']);
});

test('a verb and a path on SEPARATE LINES still count as strong', () => {
  const root = temp({ 'empty.txt': 'x' });
  const text = 'Follow the procedure written in' + String.fromCharCode(10) + 'docs/procedures/onboarding.md first.';
  const b = dependency(text, root);
  assert.deepStrictEqual(b.missingStrong, ['docs/procedures/onboarding.md']);
});

test('an ordinary English "call" does not produce a strong dependency', () => {
  const root = temp({ 'empty.txt': 'x' });
  const b = dependency('You can call docs/notes/meeting.md a reference, not a procedure.', root);
  assert.deepStrictEqual(b.missingStrong, []);
});

test('once a SENTENCE END intervenes the verb no longer governs that path', () => {
  const root = temp({ 'empty.txt': 'x' });
  const b = dependency('Do not run those tests. See docs/notes/a.md for context.', root);
  assert.deepStrictEqual(b.missingStrong, []);
});

test('a sibling file name with no slash is VISIBLE but is not called missing', () => {
  const root = temp({ 'tools/examples/show_records.py': '#' });
  const text = 'The probes `tools/examples/show_records.py` and '
    + '`map_records.py` dump the real ones verbatim.';
  const b = dependency(text, root);
  assert.deepStrictEqual(b.placeAmbiguous, ['map_records.py']);
  assert.deepStrictEqual(b.missingStrong, []);
  assert.deepStrictEqual(b.missingSoft, []);
});

test('a file written with a path is not repeated as location unknown', () => {
  const root = temp({ 'empty.txt': 'x' });
  const b = dependency('Execute .claude/skills/x/SKILL.md now.', root);
  assert.deepStrictEqual(b.placeAmbiguous, []);
});

/* four tests used to stand under a source-write-door heading (`writeSource`): it writes to a
   known folder, it does not write to an unknown one, it does not create a missing file, it does not
   write empty text. The path was removed; the behaviours it protected now live in:
   - known folder / unknown path / junction -> `agent-sync.js allowed` and the structural target path
     (the junction test in `tests/release-regressions.test.js`, `tests/agent-sync.test.js`);
   - does not create a missing file -> that was an edit-path rule; on the new path creating and editing
     go through the same door and are separated by the INTENT field , `selectIntent`);
   - empty text is not written -> `agent-writer.js preview` "Instructions cannot be empty" (the empty
     task assertion in `tests/agent-writer.test.js`). */
