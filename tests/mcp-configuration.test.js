'use strict';
// DISABLED, INCOMPLETE AND FAKE MCP DEFINITIONS.
// 
// THE MEASURED DEFECT: the Codex check stopped at finding the `[mcp_servers.worker]` section and
// looking for the PATH of the worker file inside it. So a disabled definition with `enabled = false`
// also came back as installed, and the path appearing in a COMMENT line was enough as well.
// 
// That `enabled` really is an MCP server setting was verified inside the installed `codex.exe`: the
// fields of the server configuration structure include `command, args, env, env_vars, cwd,... ,
// startup_timeout_sec, tool_timeout_sec, enabled, disabled_reason, omit_tools_from,...`.
// 
// THE DISTINCTION: CONFIGURED, DISABLED and ABSENT must not be confused. A fourth state -- the tool
// really being loaded in that session -- CANNOT BE KNOWN by reading configuration, so every answer
// says it is evidence of configuration only. Measuring that is.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mcpStatus = require('../panel/mcp-status');

const TOOL = mcpStatus.TOOL;

test('quoted server names and commented headers preserve connection state', t => {
  const d = root(t);
  write(d, '[mcp_servers."benchook"] # connection\ncommand = "node"\nargs = [' + JSON.stringify(TOOL.replace(/\\/g, '/')) + ']\nenabled = false\n');
  assert.equal(mcpStatus.codexStatus(d).status, 'closed');
});

test('multiline environment lists are merged without corrupting other settings', () => {
  const toml = require('../panel/node_modules/@iarna/toml');
  const input = '[mcp_servers."benchook"] # connection\nenv_vars = [\n "KEEP", # value\n]\ncommand = "node"\n[mcp_servers.other] # unrelated\nenv_vars = ["OTHER"]\n';
  const result = mcpStatus.addEnvVars(input);
  const parsed = toml.parse(result.text);
  assert.deepEqual(parsed.mcp_servers.benchook.env_vars, ['KEEP', ...mcpStatus.INHERITED_ENV]);
  assert.deepEqual(parsed.mcp_servers.other.env_vars, ['OTHER']);
  assert.equal(mcpStatus.addEnvVars(result.text).changed, false);
  assert.equal(toml.parse(mcpStatus.addToolTimeout(result.text).text).mcp_servers.benchook.tool_timeout_sec, mcpStatus.TOOL_TIMEOUT_SEC);
});

test('invalid or unsupported settings are rejected before generating a replacement', () => {
  assert.throws(() => mcpStatus.addEnvVars('[mcp_servers.benchook]\nenv_vars = "invalid"\n'));
  assert.throws(() => mcpStatus.addEnvVars('mcp_servers = { benchook = { command = "node" } }'));
  assert.throws(() => mcpStatus.addToolTimeout('[mcp_servers.benchook]\nbroken = [\n'));
});

function root(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-configuration-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const write = (d, text) => fs.writeFileSync(path.join(d, 'config.toml'), text);
const installed = (tool = TOOL) =>
  "[mcp_servers.benchook]\ncommand = 'node'\nargs = ['" + tool + "']\n";

/* ---- DISABLED DEFINITION ---- */

test("a definition with enabled = false does not count as installed and reads CLOSED", (t) => {
  const d = root(t);
  write(d, installed() + 'enabled = false\n');

  const r = mcpStatus.codexStatus(d);
  assert.equal(r.installed, false, 'a disabled server supplies no tools in that session');
  assert.equal(r.status, 'closed', 'absent and disabled are not the same thing');
  assert.match(r.note, /disabled/i, 'the user must know what to enable');
});

test("enabled = true written explicitly means installed", (t) => {
  const d = root(t);
  write(d, installed() + 'enabled = true\n');
  const r = mcpStatus.codexStatus(d);
  assert.equal(r.installed, true);
  assert.equal(r.status, 'installed');
});

test("when enabled is never written it is taken as on", (t) => {
  const d = root(t);
  write(d, installed());
  assert.equal(mcpStatus.codexStatus(d).status, 'installed');
});

test("another server being disabled does not affect ours", (t) => {
  const d = root(t);
  write(d, "[mcp_servers.other]\ncommand = 'node'\nenabled = false\n\n" + installed());
  assert.equal(mcpStatus.codexStatus(d).status, 'installed', 'the section boundary must hold');
});

/* ---- A COMMENT LINE IS NOT EVIDENCE ---- */

test("a path that appears only in a comment line does not count as installed", (t) => {
  const d = root(t);
  write(d, "[mcp_servers.benchook]\n# args = ['" + TOOL + "']\ncommand = 'node'\nargs = ['C:/other/x.js']\n");

  const r = mcpStatus.codexStatus(d);
  assert.equal(r.installed, false, 'a name appearing in a file is no proof of a connection');
  assert.equal(r.status, 'none');
});

test("an enabled = false inside a comment does not disable the definition", (t) => {
  const d = root(t);
  write(d, installed() + '# enabled = false\n');
  assert.equal(mcpStatus.codexStatus(d).status, 'installed');
});

/* ---- INCOMPLETE AND CORRUPT ---- */

test("a definition with no command does not count as installed", (t) => {
  const d = root(t);
  write(d, "[mcp_servers.benchook]\nargs = ['" + TOOL + "']\n");
  assert.equal(mcpStatus.codexStatus(d).installed, false, 'with no command to run the server never starts');
});

test("a remote server definition does not count as the local tool of the panel", (t) => {
  const d = root(t);
  write(d, '[mcp_servers.benchook]\nurl = "https://sample.gecersiz/worker"\n');
  const r = mcpStatus.codexStatus(d);
  assert.equal(r.installed, false);
  assert.equal(r.status, 'none');
});

test("an unreadable configuration becomes \"none\" and does not crash", (t) => {
  const d = root(t);
  const r = mcpStatus.codexStatus(path.join(d, 'missing-home'));
  assert.equal(r.installed, false);
  assert.equal(r.status, 'none');
});

/* ---- A SHARED CONTRACT: THE PANEL AND THE CATALOGUE SAY THE SAME THING ---- */

test("both providers use the same state words", (t) => {
  const d = root(t);
  const project = path.join(d, 'project');
  fs.mkdirSync(project);

  assert.equal(mcpStatus.claudeStatus(project).status, 'none');
  fs.writeFileSync(path.join(project, '.mcp.json'),
    JSON.stringify({ mcpServers: { benchook: { command: 'node', args: [TOOL] } } }));
  assert.equal(mcpStatus.claudeStatus(project).status, 'installed');

  write(d, installed() + 'enabled = false\n');
  assert.equal(mcpStatus.codexStatus(d).status, 'closed');
  assert.ok(mcpStatus.STATES.includes('closed'), 'the vocabulary must be written in one place');
});

/* ON THE CLAUDE SIDE "CLOSED" IS NOT INVENTED. That the provider reads an `enabled` field inside
   `.mcp.json` COULD NOT BE VERIFIED; under Claude, disabling a server is kept in a separate setting.
   If the panel interpreted that field its own way it would call a working setup closed and push the
   user into breaking it -- the own warning of the module. The answer must not change after an unknown
   field is supplied either. */
test("on the Claude side an unknown field does not change the answer", (t) => {
  const d = root(t);
  fs.writeFileSync(path.join(d, '.mcp.json'), JSON.stringify({
    mcpServers: { benchook: { command: 'node', args: [TOOL], enabled: false } },
  }));
  const r = mcpStatus.claudeStatus(d);
  assert.equal(r.installed, true, 'a working setup is not called disabled because of an unverified field');
  assert.equal(r.status, 'installed');
});

test("an \"installed\" answer states that it is evidence of CONFIGURATION only", (t) => {
  const d = root(t);
  const project = path.join(d, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, '.mcp.json'),
    JSON.stringify({ mcpServers: { benchook: { command: 'node', args: [TOOL] } } }));
  write(d, installed());

  /* Whether the session really loaded the tool CANNOT BE KNOWN from here; both answers must say so,
     or the panel shows something it did not measure as if it had. */
  for (const r of [mcpStatus.claudeStatus(project), mcpStatus.codexStatus(d)]) {
    assert.equal(r.installed, true);
    assert.match(r.note, /not proof|new session|approval/i,
      'configuration and reachability in a session must stay separate: ' + r.note);
  }
});

/* ---- THE OLD BEHAVIOUR IS PRESERVED ---- */

test("a record pinned to a project is still told apart", (t) => {
  const d = root(t);
  write(d, installed() + '[mcp_servers.benchook.env]\nBENCHOOK_PROJECT = "C:\\\\fixed\\\\project"\n');
  const r = mcpStatus.codexStatus(d);
  assert.equal(r.installed, false);
  assert.equal(r.status, 'otherProject');
  assert.match(r.note, /fixed to one project/);
});

/* ---- THE CATALOGUE END: WHAT THE ORCHESTRATOR HEARS ---- */

const { spawnSync } = require('node:child_process');
const script = path.join(__dirname, '..', 'tools', 'project-catalog.js');

function catalogField(t) {
  const d = root(t);
  const data = path.join(d, 'data');
  const project = path.join(d, 'project');
  const home = path.join(d, 'codex-ev');
  fs.mkdirSync(path.join(project, '.benchook', 'agents'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'accounts.json'), JSON.stringify({
    accounts: [{ id: 'codex-second', name: 'Second', provider: 'codex', folder: home }],
  }));
  // An agent ASSIGNED to another account: only then does a connection warning have a subject.
  fs.writeFileSync(path.join(project, '.benchook', 'agents', 'auditor.md'),
    ['---', 'name: auditor', 'description: Review code', 'account: codex-second',
      'provider: codex', 'model: gpt-5-codex', '---', '', 'Read.', ''].join('\n'));
  return { data, project, home };
}

function catalogRun({ data, project, home, session, event }) {
  const o = { ...process.env };
  for (const k of Object.keys(o)) if (/^CLAUDE|^CODEX_|^BENCHOOK_|^WORKER_/i.test(k)) delete o[k];
  Object.assign(o, { BENCHOOK_DATA_DIR: data, BENCHOOK_PROJECT: project, CODEX_HOME: home,
    BENCHOOK_SESSION: session });
  const r = spawnSync(process.execPath, [script, event], { encoding: 'utf8', cwd: project, env: o });
  assert.equal(r.status, 0, r.stderr);
  const raw = r.stdout.trim();
  return raw ? JSON.parse(raw).hookSpecificOutput.additionalContext : '';
}

test("the catalogue does not pass a disabled connection off as \"installed\"", (t) => {
  const a = catalogField(t);
  write(a.home, installed() + 'enabled = false\n');

  const c = catalogRun({ ...a, session: 'A', event: '--session-start' });
  assert.match(c, /MCP connection is not set up for this session/);
  assert.match(c, /disabled/i, 'it must say that it is disabled and what to do');
});

test("disabling an installed connection is announced to an open session, with no empty announcement", (t) => {
  const a = catalogField(t);
  write(a.home, installed());
  catalogRun({ ...a, session: 'A', event: '--session-start' });

  write(a.home, installed() + 'enabled = false\n');
  const c = catalogRun({ ...a, session: 'A', event: '--prompt' });

  assert.match(c, /no longer usable/i, 'the transition must be announced');
  assert.match(c, /disabled/i, 'sebebi tek yerden gelmeli');
  assert.notEqual(c.trim(), '', 'no empty context may be sent');
  assert.equal(catalogRun({ ...a, session: 'A', event: '--prompt' }), '',
    'it must go quiet on the second round');
});

/* ---- THE PANEL END: THE COLOUR AND WORD OF THE BUTTON ---- */

/* Connection colors depend on structured state, not translated labels. */
const vm = require('node:vm');
const page = fs.readFileSync(path.join(__dirname, '..', 'panel', 'panel.js'), 'utf8');
const slice = page.slice(page.indexOf('function mcpStatusLabel('),
  page.indexOf('function writeMcp('));
const box = vm.createContext({});
vm.runInContext(slice, box);
const mcpStatusLabel = vm.runInContext('mcpStatusLabel', box);
const mcpStatusColor = vm.runInContext('mcpStatusColor', box);

test("an installed connection is GREEN and the others are not", () => {
  assert.equal(mcpStatusColor('installed'), 'ready');
  assert.equal(mcpStatusColor('closed'), 'missing');
  assert.equal(mcpStatusColor('otherProject'), 'missing');
  assert.equal(mcpStatusColor('none'), 'missing');
});

test("with no selection and an unknown state the button is DIMMED", () => {
  assert.equal(mcpStatusColor('inactive'), 'inactive');
  assert.equal(mcpStatusColor('unknown'), 'inactive',
    'showing an unknown as amber would claim it can be installed');
});

test("all four states are separate words on screen", () => {
  const words = mcpStatus.STATES.map(mcpStatusLabel);
  assert.equal(new Set(words).size, words.length, 'no two may use the same word');
  assert.match(mcpStatusLabel('closed'), /Disabled/);
  assert.match(mcpStatusLabel('installed'), /Ready/);
});

test("an unrecognised state is not shown as \"installed\"", () => {
  assert.equal(mcpStatusLabel('unknown-one-thing'), "Not configured");
  assert.equal(mcpStatusColor('unknown-one-thing'), 'missing');
});

/* ---- THE MODEL AND PANE OF THE TERMINAL REACH THE SERVER - /060 ----
   Measured: Codex does not pass the parent environment to an MCP server; if `env_vars = [...]` is
   written it copies those names from the calling process. The panel adds this line at setup; the
   state check says so when it is missing. */

test("addEnvVars puts the env_vars line at the head of the section and leaves the rest untouched", () => {
  const text = "# yorum\n[mcp_servers.benchook]\ncommand = 'node'\nargs = ['" + TOOL + "']\n\n"
    + "[mcp_servers.benchook.env]\nCODEX_HOME = 'C:\\ev'\n\n[projects.'c:\\p']\ntrust_level = \"trusted\"\n";
  const r = mcpStatus.addEnvVars(text);
  assert.equal(r.changed, true);
  assert.match(r.text, /\[mcp_servers\.benchook\]\nenv_vars = \["BENCHOOK_ORCHESTRATOR_MODEL", "BENCHOOK_SESSION"\]\ncommand/);
  assert.ok(r.text.startsWith('# yorum\n'));
  assert.ok(r.text.includes("[projects.'c:\\p']\ntrust_level = \"trusted\""));
  assert.ok(r.text.includes("CODEX_HOME = 'C:\\ev'"));
});

test("if env_vars is already complete the text does not change; if it is short they are merged", () => {
  const full = "[mcp_servers.benchook]\nenv_vars = [\"BENCHOOK_ORCHESTRATOR_MODEL\", \"BENCHOOK_SESSION\"]\ncommand = 'node'\n";
  assert.equal(mcpStatus.addEnvVars(full).changed, false);
  const partial = "[mcp_servers.benchook]\nenv_vars = [\"OTHER\"]\ncommand = 'node'\n";
  const r = mcpStatus.addEnvVars(partial);
  assert.equal(r.changed, true);
  assert.match(r.text, /env_vars = \["OTHER", "BENCHOOK_ORCHESTRATOR_MODEL", "BENCHOOK_SESSION"\]/);
  assert.equal((r.text.match(/env_vars/g) || []).length, 1);
});

test("with no section addEnvVars invents nothing", () => {
  const r = mcpStatus.addEnvVars("[projects.'c:\\p']\ntrust_level = \"trusted\"\n");
  assert.equal(r.changed, false);
});

test("an older setup with no env_vars is still INSTALLED but reports the missing inheritance", (t) => {
  const d = root(t);
  write(d, installed());
  const r = mcpStatus.codexStatus(d);
  assert.equal(r.status, 'installed');
  assert.match(r.note, /Run setup again/);
  const d2 = root(t);
  // Complete = both lines the panel writes at setup (the wait limit, below).
  write(d2, mcpStatus.addToolTimeout(mcpStatus.addEnvVars(installed()).text).text);
  const r2 = mcpStatus.codexStatus(d2);
  assert.equal(r2.status, 'installed');
  assert.doesNotMatch(r2.note, /Run setup again/);
});

/* ---- THE CLAUDE APPROVAL LIVES IN THE PROJECT SETTINGS - ----
   Measured against a real Claude Code 2.1.272: the approval is in `<project>/.claude/settings.local.json`;
   the CLI deletes the fields in the profile. */
test("the approval in the project settings.local.json is read as on, off or all", (t) => {
  const d = root(t);
  const project = path.join(d, 'project'); fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  const profile = path.join(d, 'profile'); fs.mkdirSync(profile);
  const local = path.join(project, '.claude', 'settings.local.json');
  fs.writeFileSync(local, JSON.stringify({ enabledMcpjsonServers: ['benchook'] }));
  assert.equal(mcpStatus.claudeEnablement(profile, project), 'opened');
  fs.writeFileSync(local, JSON.stringify({ disabledMcpjsonServers: ['benchook'] }));
  assert.equal(mcpStatus.claudeEnablement(profile, project), 'closed');
  fs.writeFileSync(local, JSON.stringify({ enableAllProjectMcpServers: true }));
  assert.equal(mcpStatus.claudeEnablement(profile, project), 'opened');
  fs.writeFileSync(local, JSON.stringify({}));
  assert.equal(mcpStatus.claudeEnablement(profile, project), 'unknown', 'the absence of a record is not a no');
  // The shared settings.json comes second; the profile (older versions) is still read last
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ disabledMcpjsonServers: ['benchook'] }));
  assert.equal(mcpStatus.claudeEnablement(profile, project), 'closed');
  fs.rmSync(path.join(project, '.claude', 'settings.json'));
  fs.writeFileSync(path.join(profile, '.claude.json'), JSON.stringify({ projects: { [project.split(path.sep).join('/')]: { enabledMcpjsonServers: ['benchook'] } } }));
  assert.equal(mcpStatus.claudeEnablement(profile, project), 'opened');
});

/* Configure a long MCP transport timeout so waiting for an approval does not expire the agent call. Setup writes tool_timeout_sec and status checks identify a missing setting. */
test('the wait limit line is added to the Benchook section only, once', () => {
  const text = "[mcp_servers.benchook]\ncommand = 'node'\n\n[mcp_servers.other]\ncommand = 'x'\n";
  const r = mcpStatus.addToolTimeout(text);
  assert.equal(r.changed, true);
  assert.match(r.text, /\[mcp_servers\.benchook\]\ntool_timeout_sec = 31536000\ncommand = 'node'/);
  assert.doesNotMatch(r.text.split('[mcp_servers.other]')[1], /tool_timeout_sec/);
  assert.equal(mcpStatus.addToolTimeout(r.text).changed, false);
  assert.equal(mcpStatus.addToolTimeout("[projects.'c:\\p']\n").changed, false, 'no section, nothing invented');
});

test('a wait limit the user set is kept', () => {
  const text = "[mcp_servers.benchook]\ntool_timeout_sec = 900\ncommand = 'node'\n";
  assert.equal(mcpStatus.addToolTimeout(text).changed, false);
});

test('a setup without the wait limit is installed but says the agent result can be lost after 5 minutes', (t) => {
  const d = root(t);
  write(d, mcpStatus.addEnvVars(installed()).text);
  const r = mcpStatus.codexStatus(d);
  assert.equal(r.status, 'installed');
  assert.match(r.note, /5 minutes/);
  assert.match(r.note, /Run setup again/);
});

test('setup writes the wait limit line', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'panel', 'main.js'), 'utf8');
  assert.match(main, /mcpStatus\.addToolTimeout\(mcpStatus\.addEnvVars\(written\)\.text\)/);
});

test('the default Claude account reads its project decision from the home folder file, not from inside .claude', (t) => {
  const os = require('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-home-'));
  const project = path.join(home, 'project');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => { Object.assign(process.env, saved); fs.rmSync(home, { recursive: true, force: true }); });
  const key = project.replace(/\\/g, '/');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [key]: { disabledMcpjsonServers: ['benchook'] } } }));
  const onboarding = require('../panel/onboarding');
  assert.equal(onboarding.claudeConfiguration(path.join(home, '.claude')), path.join(home, '.claude.json'));
  assert.equal(onboarding.claudeConfiguration(path.join(home, 'other')), path.join(home, 'other', '.claude.json'));
  // The card's reading for the default profile finds the decision in ~/.claude.json (it used to read
  // ~/.claude/.claude.json, found nothing and said "unknown").
  const mcpStatus = require('../panel/mcp-status');
  assert.notEqual(mcpStatus.claudeEnablement(path.join(home, '.claude'), project), 'unknown');
});
