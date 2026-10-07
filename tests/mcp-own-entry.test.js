'use strict';

/* THE PANEL'S OWN MCP ENTRY IS RECOGNISED BY THE SCRIPT IT RUNS, NOT BY ITS KEY.
   An entry can sit under a key from an older version or one renamed by hand. Setup must replace
   every such entry with one under the current key -- never add a second server beside it --
   and must keep the project's own servers. Status must still find the entry, and must say when
   a Codex registration's name is out of date, because Codex records calls under that name.
   Expected keys are written out by hand here, not read from the module under test. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const setup = require('../panel/project-setup');
const mcpStatus = require('../panel/mcp-status');

const TOOL = mcpStatus.TOOL;

function dir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-own-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const registry = (id) => ({ 'claude-default': 'claude', 'codex-default': 'codex' })[id] || null;
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('setup replaces an entry that runs the worker under another key, and keeps the project servers', (t) => {
  const project = dir(t);
  const own = { command: 'python', args: ['tool.py'] };
  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: {
    'old-name': { command: 'node', args: [setup.WORKER] },
    'own-tool': own,
  } }));

  setup.apply(setup.plan(project, registry).steps);

  const servers = readJson(path.join(project, '.mcp.json')).mcpServers;
  assert.deepEqual(Object.keys(servers).sort(), ['benchook', 'own-tool'],
    'one worker entry under the current key; the old one is gone, not doubled');
  assert.deepEqual(servers.benchook, { command: 'node', args: [setup.WORKER] });
  assert.deepEqual(servers['own-tool'], own, "the project's own server is untouched");
  assert.deepEqual(setup.plan(project, registry).steps, [], 'a second run finds nothing to change');
});

test('Claude: an entry under another key is still installed, and its approval is read under that key', (t) => {
  const project = dir(t);
  fs.writeFileSync(path.join(project, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'old-name': { command: 'node', args: [TOOL] } } }));
  assert.equal(mcpStatus.claudeStatus(project).status, 'installed');

  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'),
    JSON.stringify({ disabledMcpjsonServers: ['old-name'] }));
  assert.equal(mcpStatus.claudeStatus(project).status, 'closed');
});

test('Codex: a registration under another name is installed but reported as out of date', (t) => {
  const home = dir(t);
  fs.writeFileSync(path.join(home, 'config.toml'),
    "[mcp_servers.old-name]\ncommand = 'node'\nargs = ['" + TOOL + "']\n");
  const r = mcpStatus.codexStatus(home);
  assert.equal(r.status, 'installed');
  assert.match(r.note, /older name \(old-name\)/);
  assert.match(r.note, /Run setup again/);
});

test('Codex: the current name with inherited variables is installed with no out-of-date note', (t) => {
  const home = dir(t);
  fs.writeFileSync(path.join(home, 'config.toml'),
    "[mcp_servers.benchook]\ncommand = 'node'\nargs = ['" + TOOL + "']\n"
    + 'env_vars = ["BENCHOOK_ORCHESTRATOR_MODEL", "BENCHOOK_SESSION"]\n');
  const r = mcpStatus.codexStatus(home);
  assert.equal(r.status, 'installed');
  assert.doesNotMatch(r.note, /older name/);
});

test('Codex: a path that only appears in a comment, or in an env table, is not a registration', (t) => {
  const text = "[mcp_servers.other]\n# args = ['" + TOOL + "']\ncommand = 'node'\nargs = ['C:/x.js']\n"
    + "[mcp_servers.benchook]\ncommand = 'node'\nargs = ['" + TOOL + "']\n"
    + "[mcp_servers.benchook.env]\nCODEX_HOME = 'C:/home'\n";
  assert.deepEqual(mcpStatus.ownCodexSections(text), ['benchook']);
});

test('the current key is listed first when both an old and the current entry exist', () => {
  const json = { mcpServers: {
    'old-name': { command: 'node', args: [TOOL] },
    benchook: { command: 'node', args: [TOOL] },
  } };
  assert.deepEqual(mcpStatus.ownClaudeKeys(json, '.'), ['benchook', 'old-name']);
});
