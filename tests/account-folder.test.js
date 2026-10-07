// IS THE IDENTITY FOLDER CREATED WHEN AN ACCOUNT IS ADDED?
//
// What it protects against: a second Codex account could not be added. The cause was that the panel never
// created the folder; it did not show on the Claude side because the two programs behave differently:
//
//   claude, with a missing CLAUDE_CONFIG_DIR -> creates the folder itself, login opens
// codex,  with a missing CODEX_HOME        -> "CODEX_HOME points to... does not exist", does not open
//
// So the test measures that THE FOLDER IS CREATED, not that the command is written correctly.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const accounts = require('../panel/accounts.js');

function freshRegistry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'));
  accounts.setup(path.join(root, 'accounts.json'));
  return root;
}

test('adding a Codex account REALLY creates the id folder', () => {
  const root = freshRegistry();
  const folder = path.join(root, 'codex-second');
  assert.strictEqual(fs.existsSync(folder), false);
  accounts.add({ name: 'second codex', provider: 'codex', folder });
  assert.strictEqual(fs.existsSync(folder), true, 'folder was not created - Codex cannot start under this account');
});

test('a Claude account creates it too', () => {
  const root = freshRegistry();
  const folder = path.join(root, 'claude-second');
  accounts.add({ name: 'second claude', provider: 'claude', folder });
  assert.strictEqual(fs.existsSync(folder), true);
});

test('prepareFolder leaves an existing folder intact', () => {
  const root = freshRegistry();
  const folder = path.join(root, 'filled');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'auth.json'), '{"x":1}');
  const r = accounts.prepareFolder({ provider: 'codex', folder });
  assert.ok(!r.error, r.error);
  assert.strictEqual(fs.readFileSync(path.join(folder, 'auth.json'), 'utf8'), '{"x":1}');
});

test('an added account is in the registry and its folder path is correct', () => {
  const root = freshRegistry();
  const folder = path.join(root, 'codex-uc');
  const once = new Set(accounts.list().map((h) => h.id));
  const list = accounts.add({ provider: 'codex', folder });
  // A name can no longer be given; a new account is told apart by its IDENTITY.
  const created = list.find((h) => !once.has(h.id));
  assert.ok(created, 'account defterde none');
  assert.strictEqual(path.resolve(created.folderPath), path.resolve(folder));
  assert.strictEqual(created.signedIn, false, 'an account with no login must not look signed in');
});

test('a second account cannot be added to the same folder', () => {
  const root = freshRegistry();
  const folder = path.join(root, 'shared');
  accounts.add({ name: 'one', provider: 'codex', folder });
  assert.throws(() => accounts.add({ name: 'two', provider: 'codex', folder }), /already used/i);
});
