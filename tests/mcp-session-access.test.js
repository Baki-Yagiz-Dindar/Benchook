'use strict';
// CONFIGURATION - ENABLEMENT - REAL SESSION ACCESS.
// 
// THE MEASURED DEFECT: on the Claude side the panel looked only at the `.mcp.json` of the project and
// called it installed. It never looked at whether that account had accepted the server, and said
// installed without knowing whether the tool was really present in that session.
// 
// TWO FACTS MEASURED against real profiles (read, their content not copied):
// 1. The own record file of the provider keys projects by the RAW PATH string, and the same project
// can be recorded twice under two spellings (`C:/...` and `C:\...` were seen side by side). The
// reading side has to apply the normalisation rule from.
// 2. The profiles of both accounts had EMPTY `enabledMcpjsonServers`/`disabledMcpjsonServers`, yet
// checking with `/mcp` showed the connection CONNECTED. So the ABSENCE of a record does NOT mean
// not approved. Turning that absence into not installed would be a false warning pushing the user
// into breaking a working setup.
// 
// THE THREE LEVELS RETURN AS SEPARATE FIELDS; none stands in for another:
// configuration  is our server defined in the file              (measurable)
// enablement     did the user explicitly enable or disable it   (measurable when a record exists)
// sessionAccess  is the tool loaded in that session              (NOT MEASURABLE from disk)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mcpStatus = require('../panel/mcp-status');

const TOOL = mcpStatus.TOOL;

function field(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-access-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const project = path.join(d, 'project');
  const profile = path.join(d, 'profile');
  fs.mkdirSync(project); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(project, '.mcp.json'),
    JSON.stringify({ mcpServers: { benchook: { command: 'node', args: [TOOL] } } }));
  return { d, project, profile };
}
const writeProfile = (profile, projects) =>
  fs.writeFileSync(path.join(profile, '.claude.json'), JSON.stringify({ projects: projects }));

/* ---- THE THREE LEVELS RETURN SEPARATELY ---- */

test("the response carries the three levels in separate fields", (t) => {
  const { project, profile } = field(t);
  const r = mcpStatus.claudeStatus(project, profile);

  assert.equal(r.configuration, true, 'being defined in the file is measurable');
  assert.equal(r.enablement, 'unknown', 'with no record the approval state is unknown');
  assert.equal(r.sessionAccess, 'unknown', 'whether the tool is loaded cannot be measured from disk');
});

test("the Codex answer carries the same three fields", (t) => {
  const { d } = field(t);
  fs.writeFileSync(path.join(d, 'config.toml'),
    "[mcp_servers.benchook]\ncommand = 'node'\nargs = ['" + TOOL + "']\n");
  const r = mcpStatus.codexStatus(d);

  assert.equal(r.configuration, true);
  assert.equal(r.enablement, 'opened', 'an unwritten enabled means on; the setup that was measured behaved this way');
  assert.equal(r.sessionAccess, 'unknown', 'this cannot be known for either provider');
});

test("for a disabled Codex definition the enablement reads CLOSED", (t) => {
  const { d } = field(t);
  fs.writeFileSync(path.join(d, 'config.toml'),
    "[mcp_servers.benchook]\ncommand = 'node'\nargs = ['" + TOOL + "']\nenabled = false\n");
  const r = mcpStatus.codexStatus(d);
  assert.equal(r.configuration, true, 'the definition exists; it is not absent, it is disabled');
  assert.equal(r.enablement, 'closed');
});

/* ---- THE EXPLICIT DECISION OF THE ACCOUNT IS READ ---- */

test("if the account has DISABLED the server the panel says so", (t) => {
  const { project, profile } = field(t);
  writeProfile(profile, { [project]: { disabledMcpjsonServers: ['benchook'] } });

  const r = mcpStatus.claudeStatus(project, profile);
  assert.equal(r.installed, false, 'if the user disabled it there is no tool in that session');
  assert.equal(r.status, 'closed');
  assert.equal(r.enablement, 'closed');
  assert.equal(r.configuration, true, 'the definition in the file still stands');
  assert.match(r.note, /turned .*off|disabled/i);
});

test("if the account has APPROVED the server that is written too", (t) => {
  const { project, profile } = field(t);
  writeProfile(profile, { [project]: { enabledMcpjsonServers: ['benchook'] } });

  const r = mcpStatus.claudeStatus(project, profile);
  assert.equal(r.installed, true);
  assert.equal(r.enablement, 'opened');
  assert.match(r.note, /not proof/i, 'even approval is no proof that the tool is loaded');
});

/* ---- ABSENCE IS NOT A NO ---- */

test("with no record in the profile it STAYS installed and the approval state is called unknown", (t) => {
  const { project, profile } = field(t);
  writeProfile(profile, { 'C:/other/project': { enabledMcpjsonServers: ['other'] } });

  const r = mcpStatus.claudeStatus(project, profile);
  assert.equal(r.installed, true, 'the absence of a record does not mean not approved - this was measured');
  assert.equal(r.enablement, 'unknown');
  assert.match(r.note, /not recorded|may ask/i, 'that it is unknown must be written plainly');
});

test("it stays installed even when the profile cannot be read at all", (t) => {
  const { project, profile } = field(t);
  fs.writeFileSync(path.join(profile, '.claude.json'), '{ corrupt json');

  const r = mcpStatus.claudeStatus(project, profile);
  assert.equal(r.installed, true);
  assert.equal(r.enablement, 'unknown');
});

test("with no profile supplied the old behaviour holds", (t) => {
  const { project } = field(t);
  const r = mcpStatus.claudeStatus(project);
  assert.equal(r.installed, true);
  assert.equal(r.enablement, 'unknown');
});

/* ---- PATH SPELLING ---- */

test("the other path spelling in the profile is found too", (t) => {
  const { project, profile } = field(t);
  /* In the own file of the provider the same project stood side by side under two spellings; without
     the normalisation rule from the reading side cannot see the disable decision of the user. */
  writeProfile(profile, { [project.replace(/\\/g, '/')]: { disabledMcpjsonServers: ['benchook'] } });

  assert.equal(mcpStatus.claudeStatus(project, profile).status, 'closed');
});

/* ---- WITH NO CONFIGURATION, ENABLEMENT IS NOT CONSULTED ---- */

test("with no definition in the file, an approval in the profile does not conjure one", (t) => {
  const { d, profile } = field(t);
  const empty = path.join(d, 'empty-project');
  fs.mkdirSync(empty);
  writeProfile(profile, { [empty]: { enabledMcpjsonServers: ['benchook'] } });

  const r = mcpStatus.claudeStatus(empty, profile);
  assert.equal(r.installed, false);
  assert.equal(r.status, 'none');
  assert.equal(r.configuration, false);
});

/* ---- DO THE CALLERS REALLY PASS THE PROFILE ---- */

test("accountFor reads the OWN profile of that account", (t) => {
  const { project, profile } = field(t);
  writeProfile(profile, { [project]: { disabledMcpjsonServers: ['benchook'] } });
  const account = { id: 'claude-one', provider: 'claude', folder: profile };

  const r = mcpStatus.accountFor(account, project, (h) => h.folder);
  assert.equal(r.status, 'closed', 'the panel card must see the decision of the account');
});

test("sessionFor uses the profile folder of the session", (t) => {
  const { project, profile } = field(t);
  writeProfile(profile, { [project]: { disabledMcpjsonServers: ['benchook'] } });

  assert.equal(mcpStatus.sessionFor({ CLAUDECODE: '1', CLAUDE_CONFIG_DIR: profile }, project).status,
    'closed');
  // A session with no profile given: it looks at the home directory, cannot see the disable decision, and stays installed.
  assert.equal(mcpStatus.sessionFor({ CLAUDECODE: '1' }, project).installed, true);
});

/* ---- THE SENTENCE ON THE AGENT CARD TELLS THE STATES APART TOO ---- */

/* Distinguish disabled, project-pinned, missing, and installed connections in both button state and explanatory text. */

test("the sentence for a disabled connection does not say not installed", () => {
  const closed = mcpStatus.MESSAGE.reachability('closed', 'account-b');
  assert.match(closed, /turned off|enable/i, 'the thing to do is to enable it');
  assert.doesNotMatch(closed, /not set up/i);
  assert.match(closed, /account-b/, 'which account it is must be written');
});

test("every state has its own sentence and the installed one has none", () => {
  assert.equal(mcpStatus.MESSAGE.reachability('installed', 'x'), null, 'an installed connection produces no warning');
  assert.match(mcpStatus.MESSAGE.reachability('none', 'x'), /not set up/i);
  assert.match(mcpStatus.MESSAGE.reachability('otherProject', 'x'), /another project/i);
  const all = ['none', 'closed', 'otherProject'].map((d) => mcpStatus.MESSAGE.reachability(d, 'x'));
  assert.equal(new Set(all).size, 3, 'all three must say something different');
});

test("unknown status sessiz kalmaz ama iddia da etmez", () => {
  const m = mcpStatus.MESSAGE.reachability('unknown', 'x');
  assert.equal(m, null, 'if the provider cannot be determined it stays quiet - the first never of the panel');
});
