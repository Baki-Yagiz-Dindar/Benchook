'use strict';
/* When the user has their own Claude status line, the panel still gets the percentage and does not overwrite the line.
 *
 * Old behaviour: when the user's `statusLine` setting was seen, the panel did not install its collector at
 * all; the line was kept but the context percentage never arrived. New behaviour: the panel's command is a
 * wrapper -- it writes the same stdin JSON to a file, then runs the user's command with the same stdin and
 * passes its output and exit code through unchanged. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const context = require('../panel/claude-context');

const SCRIPT = path.resolve(__dirname, '../panel/claude-context.js');
function temp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wf001-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
const ENTRY = { session_id: 'wf001', workspace: { project_dir: 'X' }, model: { id: 'm' },
  context_window: { context_window_size: 200000, used_percentage: 41,
    current_usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } } };
const hasBash = !spawnSync('bash', ['-c', 'true'], { windowsHide: true }).error;

test("when the user has a status line the panel wraps it instead of overwriting it", (t) => {
  const root = temp(t), project = temp(t);
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo MINE', padding: 2 } }));
  const a = context.setting(root, project, path.join(root, 'out.json'), 'node');
  assert.ok(a && a.statusLine, 'it used to return null - the defect itself');
  assert.equal(a.statusLine.type, 'command');
  assert.equal(a.statusLine.padding, 2, 'the other fields are carried over verbatim');
  assert.match(a.statusLine.command, /claude-context\.js' '.*out\.json' --after 'echo MINE'$/);
  assert.equal(a.userCommand, 'echo MINE');
});

test("the precedence follows Claude - project settings.local.json, then project settings.json, then the account", (t) => {
  const root = temp(t), project = temp(t);
  fs.mkdirSync(path.join(project, '.claude'));
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ statusLine: { command: 'echo ACCOUNT' } }));
  fs.writeFileSync(path.join(project, '.claude/settings.json'), JSON.stringify({ statusLine: { command: 'echo PROJECT' } }));
  assert.equal(context.setting(root, project, 'o', 'node').userCommand, 'echo PROJECT');
  fs.writeFileSync(path.join(project, '.claude/settings.local.json'), JSON.stringify({ statusLine: { command: 'echo LOCAL' } }));
  assert.equal(context.setting(root, project, 'o', 'node').userCommand, 'echo LOCAL');
});

test("with no user line the old plain command applies; an unknown setting with no command is left alone", (t) => {
  const root = temp(t), project = temp(t);
  const flat = context.setting(root, project, 'o', 'node');
  assert.doesNotMatch(flat.statusLine.command, /--after/);
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ statusLine: { type: 'odd' } }));
  assert.equal(context.setting(root, project, 'o', 'node'), null, 'komutu missing setting: estimate none, panel kurulmaz');
});

test("the wrapper writes the file, runs the user command with the same stdin and prints its output", { skip: !hasBash && 'no bash' }, (t) => {
  const d = temp(t), out = path.join(d, 'out.json'), copy = path.join(d, 'user-stdin.json').replace(/\\/g, '/');
  const r = spawnSync(process.execPath, [SCRIPT, out, '--after', 'cat > "' + copy + '"; echo USER_LINE_OK'],
    { input: JSON.stringify(ENTRY), encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'USER_LINE_OK', 'the screen shows the line of the user, not the one of the panel');
  assert.equal(context.read(out, 'X').percent, 41, 'the panel still got the percentage');
  assert.deepEqual(JSON.parse(fs.readFileSync(copy, 'utf8')), ENTRY, 'the user command received the same JSON');
});

test("the exit code of the user command passes through; the user command runs even when the parsing of the panel fails", { skip: !hasBash && 'no bash' }, (t) => {
  const d = temp(t), out = path.join(d, 'out.json');
  const r1 = spawnSync(process.execPath, [SCRIPT, out, '--after', 'echo FAILING; exit 3'],
    { input: JSON.stringify(ENTRY), encoding: 'utf8', windowsHide: true });
  assert.equal(r1.status, 3); assert.match(r1.stdout, /FAILING/);
  assert.ok(fs.existsSync(out), 'the file was still written');
  const r2 = spawnSync(process.execPath, [SCRIPT, path.join(d, 'out2.json'), '--after', 'echo STILL_MINE'],
    { input: 'not json', encoding: 'utf8', windowsHide: true });
  assert.equal(r2.status, 0); assert.equal(r2.stdout.trim(), 'STILL_MINE');
  assert.ok(!fs.existsSync(path.join(d, 'out2.json')), 'an unreadable entry is not written to the file');
});
