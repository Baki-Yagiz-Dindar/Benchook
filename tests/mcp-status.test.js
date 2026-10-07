'use strict';

/* THE WORKER CONNECTION MUST BE VISIBLE - measured. The user opened a Codex orchestrator and triggered an
   agent. The catalogue described it correctly and said to call an agent assigned to another account with
   run_agent, but the Codex profile of that account had no `[mcp_servers.worker]` record: no such tool
   was defined in that session at all. The orchestrator coped through the shell; neither the catalogue
   nor the screen said what the state was. It must say somewhere that the MCP connection is not set up. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mcpStatus = require('../panel/mcp-status');

const TOOL = mcpStatus.TOOL;

function root(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-status-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('Codex: with no record it is not installed and the reason is written', (t) => {
  const d = root(t);
  fs.writeFileSync(path.join(d, 'config.toml'), 'model = "x"\n');
  const r = mcpStatus.codexStatus(d);
  assert.equal(r.installed, false);
  assert.match(r.note, /missing or out of date/);
});

test('Codex: a record pointing at the own server of the panel is installed', (t) => {
  const d = root(t);
  fs.writeFileSync(path.join(d, 'config.toml'),
    '[mcp_servers.benchook]\ncommand = "node"\nargs = [\'' + TOOL + '\']\n');
  assert.equal(mcpStatus.codexStatus(d).installed, true);
});

/* THE SERVER OF ANOTHER INSTALLATION DOES NOT COUNT AS INSTALLED: there is a record, but it is not the tool of this panel. */
test('Codex: a record pointing at a different path does not count as installed', (t) => {
  const d = root(t);
  fs.writeFileSync(path.join(d, 'config.toml'),
    '[mcp_servers.benchook]\ncommand = "node"\nargs = [\'C:\\\\other\\\\worker-mcp.js\']\n');
  assert.equal(mcpStatus.codexStatus(d).installed, false);
});

/* A RECORD PINNED TO A PROJECT IS NOT INSTALLED - the measured behaviour is preserved: it shows the
   agents of the pinned project in every workspace, which is misleading. */
test('Codex: a record pinned to a single project does not count as installed and names that project', (t) => {
  const d = root(t);
  fs.writeFileSync(path.join(d, 'config.toml'),
    '[mcp_servers.benchook]\ncommand = "node"\nargs = [\'' + TOOL + '\']\n'
    + '[mcp_servers.benchook.env]\nBENCHOOK_PROJECT = "C:\\\\fixed\\\\project"\n');
  const r = mcpStatus.codexStatus(d);
  assert.equal(r.installed, false);
  assert.match(r.note, /fixed to one project/);
});

test('Claude: the connection is looked for in the project file', (t) => {
  const d = root(t);
  assert.equal(mcpStatus.claudeStatus(d).installed, false);
  fs.writeFileSync(path.join(d, '.mcp.json'),
    JSON.stringify({ mcpServers: { benchook: { command: 'node', args: [TOOL] } } }));
  assert.equal(mcpStatus.claudeStatus(d).installed, true);
});

/* WHEN THE PROVIDER CANNOT BE DETERMINED IT STAYS QUIET. safety contract of the panel: it does not show
   what it does not know as known. A false not-installed warning would push the user into breaking a
   working setup. */
test('session: with an unknown provider nothing is claimed', (t) => {
  const d = root(t);
  // The `status` field was added in unknown is also a value of the shared vocabulary.
  assert.deepEqual(mcpStatus.sessionFor({}, d), { unknown: true, status: 'unknown' });
});

test('session: a Claude session looks at the project file, a Codex session at the home of the account', (t) => {
  const d = root(t);
  const home = path.join(d, 'home');
  fs.mkdirSync(home);

  assert.equal(mcpStatus.sessionFor({ CLAUDECODE: '1' }, d).installed, false);
  fs.writeFileSync(path.join(d, '.mcp.json'),
    JSON.stringify({ mcpServers: { benchook: { command: 'node', args: [TOOL] } } }));
  assert.equal(mcpStatus.sessionFor({ CLAUDECODE: '1' }, d).installed, true);

  // The same project, a Codex session: the project file means nothing to Codex.
  assert.equal(mcpStatus.sessionFor({ CODEX_HOME: home }, d).installed, false);
  fs.writeFileSync(path.join(home, 'config.toml'),
    '[mcp_servers.benchook]\ncommand = "node"\nargs = [\'' + TOOL + '\']\n');
  assert.equal(mcpStatus.sessionFor({ CODEX_HOME: home }, d).installed, true);
});

/* THE SENTENCES LIVE IN ONE PLACE: the card of the panel and the catalogue the orchestrator reads must
   say the same thing. The defect fixed here had exactly that shape -- two consumers, two answers. */
test('the warning sentences carry the name of the account and are in English', () => {
  assert.match(mcpStatus.MESSAGE.signInNone('account-a'), /^Assigned account \(account-a\) is signed out/);
  assert.match(mcpStatus.MESSAGE.connectionNone('account-b'),
    /^MCP connection is not set up for account-b/);
  assert.match(mcpStatus.MESSAGE.openRe, /Open a new terminal/);
});
