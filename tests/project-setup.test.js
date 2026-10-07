'use strict';

/* PROJECT SETUP and THE CATALOGUE HOOK.
 *
 * What it protects against: the panel showed an agent as belonging to this project while the
 * orchestrator said no such agent existed. Both were right; no catalogue hook had been installed.
 *
 * Every test looks in BOTH DIRECTIONS. Whether it installs is not enough on its own: it must also show
 * that it does not accidentally delete the own hooks of the project, does not apply the same plan a
 * second time, and does not GUESS for an account that is not in the registry.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const setup = require('../panel/project-setup');

const catalogScript = path.join(__dirname, '..', 'tools', 'project-catalog.js');

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A test registry instead of the one of the panel: whatever the name, there is matching and no guessing.
const registry = (id) => ({ 'claude-default': 'claude', 'codex-default': 'codex' })[id] || null;

function writeAgent(dir, name, lines) {
  const k = path.join(dir, '.benchook', 'agents');
  fs.mkdirSync(k, { recursive: true });
  fs.writeFileSync(path.join(k, name + '.md'), ['---', 'schema: panel-agent/v1',
    'name: ' + name, ...lines, '---', '', 'work', ''].join('\n'), 'utf8');
  return path.join(k, name + '.md');
}

/** The account the assigned agent names, written into the test's own data folder. */
function registerAccount(appData) {
  const d = path.join(appData, 'Benchook');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'accounts.json'), JSON.stringify({ accounts: [
    { id: 'claude-default', name: 'Claude', provider: 'claude', folder: null }] }));
}

function catalog(dir, flag) {
  const r = spawnSync(process.execPath, [catalogScript, flag], {
    env: { ...process.env, BENCHOOK_PROJECT: dir, APPDATA: path.join(dir, '.test-data') },
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('an empty project gets the hook and the MCP record of both orchestrators', (t) => {
  const dir = project(t);
  const p = setup.plan(dir, registry);
  const files = p.steps.map((a) => path.relative(dir, a.file).replace(/\\/g, '/'));
  assert.deepEqual(files.sort(),
    ['.claude/settings.json', '.codex/hooks.json', '.mcp.json']);

  // plan ALONE must write nothing: touching the disk before approval breaks safety contract.
  assert.equal(fs.existsSync(path.join(dir, '.mcp.json')), false);

  setup.apply(p.steps);
  const claude = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.match(claude.hooks.SessionStart[0].hooks[0].command, /project-catalog.js" --session-start/);
  assert.match(claude.hooks.UserPromptSubmit[0].hooks[0].command, /project-catalog.js" --prompt/);
});

test('running the same setup a second time finds nothing to write', (t) => {
  const dir = project(t);
  setup.apply(setup.plan(dir, registry).steps);
  assert.deepEqual(setup.plan(dir, registry).steps, []);
});

test('the own hooks of the project are preserved and not overwritten', (t) => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
    permissions: { allow: ['Bash(ls*)'] },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'bash my-own-script.sh' }] }] },
  }, null, 2), 'utf8');

  setup.apply(setup.plan(dir, registry).steps);
  const j = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(j.permissions.allow, ['Bash(ls*)']);
  const commands = j.hooks.SessionStart.flatMap((x) => x.hooks).map((x) => x.command);
  assert.ok(commands.some((c) => c.includes('my-own-script.sh')), 'the own hook of the project is gone');
  assert.ok(commands.some((c) => c.includes('project-catalog.js')), 'the hook of the panel was not installed');
});

test('a missing provider line is filled in from the registry; for an account missing from the registry there is NO guess', (t) => {
  const dir = project(t);
  const known = writeAgent(dir, 'known', ['description: X', 'model: haiku', 'account: claude-default']);
  const foreign = writeAgent(dir, 'foreign', ['description: Y', 'model: haiku', 'account: kimbilir']);

  const repairs = setup.plan(dir, registry).steps.filter((a) => a.kind === 'repair');
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].file, known);
  assert.match(repairs[0].note, /claude/);

  setup.apply(repairs);
  assert.match(fs.readFileSync(known, 'utf8'), /^provider: claude$/m);
  assert.doesNotMatch(fs.readFileSync(foreign, 'utf8'), /provider:/);
});

test('catalogue hook: it lists on open, stays QUIET while nothing changes, and speaks when it does', (t) => {
  const dir = project(t);
  writeAgent(dir, 'probe', ['description: What this test is for', 'model: haiku',
    'account: claude-default', 'provider: claude']);

  const startup = JSON.parse(catalog(dir, '--session-start'));
  assert.match(startup.hookSpecificOutput.additionalContext, /probe/);
  assert.match(startup.hookSpecificOutput.additionalContext, /run_agent/);

  // Nothing changed: not a single character may be written, or it burns tokens on every message.
  assert.equal(catalog(dir, '--prompt'), '');

  writeAgent(dir, 'later', ['description: Added mid-job', 'model: haiku',
    'account: codex-default', 'provider: codex']);
  const diff = JSON.parse(catalog(dir, '--prompt'));
  const text = diff.hookSpecificOutput.additionalContext;
  assert.equal(diff.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(text, /Agent added/);
  assert.match(text, /later/);
  assert.doesNotMatch(text, /probe/);   // what is announced is the DIFFERENCE, not the list

  // After the announcement it must go quiet again.
  assert.equal(catalog(dir, '--prompt'), '');

  fs.unlinkSync(path.join(dir, '.benchook', 'agents', 'later.md'));
  assert.match(JSON.parse(catalog(dir, '--prompt')).hookSpecificOutput.additionalContext,
    /Agent removed from this project: later/);
});

/* THE CATALOGUE SAYS IT CANNOT BE REACHED FROM THAT SESSION - measured.
   The catalogue described the agent correctly and said to call it with run_agent, but the profile of
   that Codex account had no `[mcp_servers.worker]`: no such tool was defined in that session at all.
   The orchestrator coped through the shell; nowhere said what the state was. */
test('catalogue hook: it speaks when the connection is not installed and stays quiet when it is installed or unknown', (t) => {
  const dir = project(t);
  const tool = path.join(__dirname, '..', 'tools', 'mcp-server.js');
  const home = path.join(dir, 'codex-ev');
  fs.mkdirSync(home, { recursive: true });
  writeAgent(dir, 'assigned', ['description: What this test is for', 'model: haiku',
    'account: claude-default', 'provider: claude']);
  registerAccount(path.join(dir, '.test-data'));

  const run = (env) => {
    const status = path.join(dir, '.test-data');
    // Every run starts from a clean state: the records are in the catalogue-state folder of the data root.
    for (const root of ['Benchook', 'Benchook'])
      fs.rmSync(path.join(status, root, 'catalog-state'), { recursive: true, force: true });
    const r = spawnSync(process.execPath, [catalogScript, '--session-start'], {
      env: { CLAUDECODE: '', CODEX_HOME: '', ...process.env, BENCHOOK_PROJECT: dir,
        APPDATA: status, ...env },
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim()).hookSpecificOutput.additionalContext;
  };

  // A Codex session with no record: the warning appears.
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "x"\n');
  assert.match(run({ CLAUDECODE: '', CODEX_HOME: home }),
    /MCP connection is not set up for this session/);

  // The same session after the record is installed: not a single word.
  fs.writeFileSync(path.join(home, 'config.toml'),
    '[mcp_servers.worker]\ncommand = "node"\nargs = [\'' + tool + '\']\n');
  assert.doesNotMatch(run({ CLAUDECODE: '', CODEX_HOME: home }), /MCP connection is not set up/);

  // If the provider cannot be determined nothing is claimed.
  assert.doesNotMatch(run({ CLAUDECODE: '', CODEX_HOME: '' }), /MCP connection is not set up/);
});

/* IF THE CONNECTION CHANGES, THE TOOL LIST OF THE ORCHESTRATOR GOES STALE - measured: the user did the
   setup from the panel, the record was written to disk after that session had started, and the session
   never saw the tool. Because the agent list had not changed the hook stayed quiet too. The screen of
   the panel reaches only whoever looks at the panel; this hook is the only place that reaches the orchestrator. */
test('catalogue hook: it announces a change of connection state and stays quiet while it holds', (t) => {
  const dir = project(t);
  const tool = path.join(__dirname, '..', 'tools', 'mcp-server.js');
  const home = path.join(dir, 'codex-ev');
  const status = path.join(dir, '.test-data');
  fs.mkdirSync(home, { recursive: true });
  writeAgent(dir, 'assigned', ['description: What this test is for', 'model: haiku',
    'account: claude-default', 'provider: claude']);
  registerAccount(path.join(dir, '.test-data'));

  const run = (flag) => {
    const r = spawnSync(process.execPath, [catalogScript, flag], {
      env: { ...process.env, CLAUDECODE: '', CODEX_HOME: home, BENCHOOK_PROJECT: dir, APPDATA: status },
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(r.status, 0, r.stderr);
    const raw = r.stdout.trim();
    return raw ? JSON.parse(raw).hookSpecificOutput.additionalContext : '';
  };
  const writeSetup = () => fs.writeFileSync(path.join(home, 'config.toml'),
    '[mcp_servers.worker]\ncommand = "node"\nargs = [\'' + tool + '\']\n');
  const deleteSetup = () => fs.writeFileSync(path.join(home, 'config.toml'), 'model = "x"\n');

  deleteSetup();
  assert.match(run('--session-start'), /MCP connection is not set up for this session/);
  // Nothing changed: not a single character may be written.
  assert.equal(run('--prompt'), '');

  // The user did the setup while the session was open: the agent list is the same, but this MUST BE ANNOUNCED.
  writeSetup();
  const opened = run('--prompt');
  assert.match(opened, /now configured for this session/);
  assert.match(opened, /open a new terminal/i);
  assert.equal(run('--prompt'), '', 'the same state must not be announced a second time');

  // The reverse direction is announced too.
  deleteSetup();
  /* The sentence widened with not only none but also the closed and pinned-to-another-project
     transitions are announced through the same door, with the reason coming from one place. */
  assert.match(run('--prompt'), /no longer usable for this session's account/);
  assert.equal(run('--prompt'), '');
});

/* AN OLD STATE FILE: if on an install that skips versions this file triggered an announcement on every
   message, the silence default would break and burn tokens every round. That is what this test protects.

   THE EXPECTATION WAS DELIBERATELY REVERSED. The record in the old format used to be read and
   the first prompt event stayed SILENT. The old record does not say which SESSION heard what; counting
   it as seen by this session produces a false already-notified and the session never hears about the
   agent the user added. So the old file is no longer read; on the first round the full list is given
   once, the baseline is written, and it goes quiet on the second round. What is protected is the same:
   an announcement is NOT REPEATED. */
test('catalogue hook: a state file in the old format does not force an announcement on every message', (t) => {
  const dir = project(t);
  const status = path.join(dir, '.test-data');
  writeAgent(dir, 'probe2', ['description: A test', 'model: haiku',
    'account: claude-default', 'provider: claude']);

  const run = (flag) => {
    const r = spawnSync(process.execPath, [catalogScript, flag], {
      env: { ...process.env, CLAUDECODE: '', CODEX_HOME: '', BENCHOOK_PROJECT: dir, APPDATA: status },
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };

  // Put the old format on disk by hand: one record per project, a plain signature string.
  const old = path.join(status, 'Benchook', 'catalog-state.json');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, JSON.stringify({ [dir]: 'probe2|claude-default|claude|haiku' }, null, 2));

  assert.match(run('--prompt'), /probe2/, 'this session never saw the list; it must not be met with silence');
  assert.equal(run('--prompt'), '', 'it must repair itself on the second round');
  assert.ok(fs.existsSync(old), 'the old record is not deleted');
});
