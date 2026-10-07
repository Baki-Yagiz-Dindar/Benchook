'use strict';
// `panel/onboarding.js` - why does the terminal of an account logged in from the panel show a setup
// wizard, and what does the panel do to the customer's settings while fixing that?
//
// The expected values were NOT invented: they come from a real `claude` run and from the `config.toml`
// format of a real Codex installation.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const firstSetup = require('../panel/onboarding.js');

function temp() {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'first-setup-test-'));
  test.after(() => { try { fs.rmSync(k, { recursive: true, force: true }); } catch { /* olsun */ } });
  return k;
}

const claudeAccount = { provider: 'claude' };
const codexAccount = { provider: 'codex' };

test('in a fresh Claude identity folder both the cosmetic mark and the trust entry show as missing', () => {
  const k = temp();
  const folder = path.join(k, '.claude-created'); fs.mkdirSync(folder);
  const project = path.join(k, 'project'); fs.mkdirSync(project);

  const d = firstSetup.status(claudeAccount, folder, project);
  assert.equal(d.cosmetic.required, true);
  assert.equal(d.trust.required, true);
  assert.equal(d.cosmetic.file, path.join(folder, '.claude.json'));
});

test('writing the cosmetic mark writes ONE key and does not touch trust', () => {
  const k = temp();
  const folder = path.join(k, '.claude-created'); fs.mkdirSync(folder);
  const project = path.join(k, 'project'); fs.mkdirSync(project);

  firstSetup.apply(claudeAccount, folder, project, { cosmetic: true });
  const v = JSON.parse(fs.readFileSync(path.join(folder, '.claude.json'), 'utf8'));
  assert.deepEqual(Object.keys(v), ['hasCompletedOnboarding']);
  assert.equal(v.hasCompletedOnboarding, true);

  // Trust is a separate decision: it is never written without asking.
  const d = firstSetup.status(claudeAccount, folder, project);
  assert.equal(d.cosmetic.required, false);
  assert.equal(d.trust.required, true);
});

test('writing trust uses the key the real CLI uses and preserves existing settings', () => {
  const k = temp();
  const folder = path.join(k, '.claude-created'); fs.mkdirSync(folder);
  const project = path.join(k, 'project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(folder, '.claude.json'), JSON.stringify({
    userID: 'abc', projects: { 'C:/other/project': { hasTrustDialogAccepted: true } },
  }));

  firstSetup.apply(claudeAccount, folder, project, { trust: true });
  const v = JSON.parse(fs.readFileSync(path.join(folder, '.claude.json'), 'utf8'));
  assert.equal(v.userID, 'abc', 'existing fields must be preserved');
  assert.equal(v.projects['C:/other/project'].hasTrustDialogAccepted, true, 'another project must be preserved');
  // Measured form: full path with forward slashes.
  const key = path.resolve(project).replace(/\\/g, '/');
  assert.equal(v.projects[key].hasTrustDialogAccepted, true);
  assert.equal(firstSetup.status(claudeAccount, folder, project).trust.required, false);
});

test('for the default Claude folder the configuration lives in the home directory', () => {
  const defaults = path.join(os.homedir(), '.claude');
  assert.equal(firstSetup.claudeConfiguration(defaults), path.join(os.homedir(), '.claude.json'));
  assert.equal(firstSetup.claudeConfiguration(null), path.join(os.homedir(), '.claude.json'));
  assert.equal(firstSetup.claudeConfiguration('C:\\x\\.claude-h2'), path.join('C:\\x\\.claude-h2', '.claude.json'));
});

test('Codex trust is added to config.toml without breaking existing sections', () => {
  const k = temp();
  const home = path.join(k, '.codex-created'); fs.mkdirSync(home);
  const project = path.join(k, 'project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(home, 'config.toml'),
    "[mcp_servers.worker]\ncommand = \"node\"\n\n[projects.'c:\\other']\ntrust_level = \"trusted\"\n");

  const d = firstSetup.status(codexAccount, home, project);
  assert.equal(d.trust.required, true);
  assert.equal(d.cosmetic.required, false, 'on the Codex side there is no cosmetic mark for the panel to write');

  firstSetup.apply(codexAccount, home, project, { trust: true });
  const text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  assert.match(text, /\[mcp_servers\.worker\]/, 'an existing section must be preserved');
  assert.match(text, /\[projects\.'c:\\other'\]/, 'the trust entry of another project must be preserved');
  assert.equal(firstSetup.status(codexAccount, home, project).trust.required, false);
  // Measured form: lower-case path with backslashes.
  assert.ok(text.includes("[projects.'" + path.resolve(project).toLowerCase() + "']"));
});

test('if the user said they do not trust it the panel does NOT change that decision', () => {
  const k = temp();
  const home = path.join(k, '.codex-created'); fs.mkdirSync(home);
  const project = path.join(k, 'project'); fs.mkdirSync(project);
  const key = path.resolve(project).toLowerCase();
  fs.writeFileSync(path.join(home, 'config.toml'),
    "[projects.'" + key + "']\ntrust_level = \"untrusted\"\n");

  const d = firstSetup.status(codexAccount, home, project);
  assert.equal(d.trust.required, false, 'the decision is made; the panel does not ask again');
  assert.equal(d.trust.otherDecision, 'untrusted', 'it must be possible to say on screen what happened');

  firstSetup.apply(codexAccount, home, project, { trust: true });
  assert.match(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), /trust_level = "untrusted"/);
});

test('malformed Claude settings are preserved and onboarding refuses to overwrite them', () => {
  const k = temp();
  const folder = path.join(k, '.claude-created'); fs.mkdirSync(folder);
  const project = path.join(k, 'project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(folder, '.claude.json'), '{ not json');
  const backupRoot = path.join(k, 'backup');
  firstSetup.setup(backupRoot);
  test.after(() => firstSetup.setup(null));

  assert.throws(() => firstSetup.apply(claudeAccount, folder, project, { cosmetic: true, trust: true }));
  assert.equal(fs.readFileSync(path.join(folder, '.claude.json'), 'utf8'), '{ not json');
  // The broken version is copied into the panel's OWN folder; it is no longer left in the customer's folder.
  assert.equal(fs.existsSync(backupRoot), false);
  assert.equal(fs.readdirSync(folder).filter((a) => a.endsWith('.backup')).length, 0);
});

test('if nothing is selected nothing is written', () => {
  const k = temp();
  const folder = path.join(k, '.claude-created'); fs.mkdirSync(folder);
  const project = path.join(k, 'project'); fs.mkdirSync(project);
  firstSetup.apply(claudeAccount, folder, project, {});
  assert.equal(fs.existsSync(path.join(folder, '.claude.json')), false);
});

test('the TOML reader tells quote styles and section boundaries apart', () => {
  const key = 'c:\\users\\example\\project';
  assert.equal(firstSetup.codexTrustStatus(
    "[projects.\"c:\\\\users\\\\example\\\\project\"]\ntrust_level = \"trusted\"\n", key).status, 'safe');
  // trust_level in ANOTHER section: it does not count as belonging to this project.
  assert.equal(firstSetup.codexTrustStatus(
    "[projects.'" + key + "']\n\n[other]\ntrust_level = \"trusted\"\n", key).status, 'none');
  // If the section is missing it is added; nothing breaks even without a trailing newline.
  const created = firstSetup.addCodexTrust("[a]\nb = 1", key);
  assert.match(created, /\[a\]\nb = 1\n\n\[projects\./);
});
