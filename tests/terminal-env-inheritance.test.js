'use strict';
/* A terminal opened by the panel must not inherit the SESSION IDENTITY of the shell that started the panel.
 *
 * What it protects against: when Electron was started from a Codex shell, both real terminals carried that
 * shell's CODEX_SESSION_ID, the catalog state merged into a single file and the second terminal never
 * received the agent-added announcement. The cause was in one place: the environment builder in
 * accounts.js cleared only CODEX_THREAD_ID, not CODEX_SESSION_ID.
 *
 * Rule: EVERY inherited harness session identity is cleared. The identity the provider creates for its own
 * session is not affected -- that variable is born AFTER the terminal opens, in the CLI's own child
 * processes; only the value coming from above the panel is removed here. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const accounts = require('../panel/accounts');
const status = require('../panel/catalog-state');

const INHERITED = {
  CODEX_SESSION_ID: 'top-codex-session',
  CODEX_THREAD_ID: 'top-codex-subject',
  CLAUDE_CODE_SESSION_ID: 'top-claude-session',
};

function inherit(t) {
  const old = {};
  for (const [name, value] of Object.entries(INHERITED)) { old[name] = process.env[name]; process.env[name] = value; }
  t.after(() => {
    for (const name of Object.keys(INHERITED)) {
      if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name];
    }
  });
}

const accountFolder = (t) => path.join(require('node:os').tmpdir(), 'wf064-' + process.pid + '-' + t.name.length);

test('the environment of a terminal with an account carries no session identity from the parent shell', (t) => {
  inherit(t);
  for (const provider of ['codex', 'claude']) {
    const o = accounts.env({ id: 'x-' + provider, provider, name: 'X', folder: accountFolder(t) });
    for (const name of Object.keys(INHERITED)) assert.equal(o[name], undefined, provider + ' terminal must not carry ' + name);
  }
});

test('the environment of a terminal with no account carries no session identity from the parent shell either', (t) => {
  inherit(t);
  const o = accounts.env(null);
  for (const name of Object.keys(INHERITED)) assert.equal(o[name], undefined, name + ' must not be carried');
  // Windows process.env lookup ignores case; the copied ordinary object does not.
  const pathKey = Object.keys(process.env).find((name) => name.toLowerCase() === 'path');
  assert.ok(pathKey, 'this terminal has an executable search path');
  assert.equal(o[pathKey], process.env[pathKey], 'the search path is preserved under its own key');
  for (const name of ['Path', 'PATH']) {
    const clean = accounts.cleanInherited({ [name]: 'fixture-bin', CODEX_SESSION_ID: 'top' });
    assert.deepEqual(clean, { [name]: 'fixture-bin' }, 'the key spelling and its value are preserved');
  }
});

test('once the inheritance is cleared the catalogue session falls back to the own pane identity of the panel', (t) => {
  inherit(t);
  // main.js writes BENCHOOK_SESSION into every pane; with no harness identity the catalog must use it.
  const o = { ...accounts.env({ id: 'c', provider: 'codex', name: 'C', folder: accountFolder(t) }), BENCHOOK_SESSION: 'pane-1' };
  assert.deepEqual(status.sessionIdFromFile(o), { id: 'pane-1', source: 'BENCHOOK_SESSION' });
  // Counter-evidence: in an uncleaned environment the parent shell's identity would win -- the defect itself.
  assert.notEqual(status.sessionIdFromFile({ ...process.env, BENCHOOK_SESSION: 'pane-1' }).source, 'BENCHOOK_SESSION');
});

test('the OWN session identity of the provider still takes precedence', () => {
  // After the terminal opens the CLI creates its own identity; the hook environment contains that value.
  const o = { ...accounts.env(null), BENCHOOK_SESSION: 'pane-1', CODEX_SESSION_ID: 'cli-own' };
  assert.deepEqual(status.sessionIdFromFile(o), { id: 'cli-own', source: 'CODEX_SESSION_ID' });
});
