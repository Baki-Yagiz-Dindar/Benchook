'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const accounts = require('../panel/accounts.js');

/* Read the provider identity after login: the browser may authorize an existing session instead of the expected account. Detect duplicate identities so separate rows cannot silently represent the same quota. */

function registry() {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'account-id-'));
  accounts.setup(path.join(k, 'accounts.json'));
  fs.writeFileSync(path.join(k, 'accounts.json'), JSON.stringify({ accounts: [] }));
  return { k, cleanup: () => fs.rmSync(k, { recursive: true, force: true }) };
}

test('an account can be added without a name; the panel sets a temporary label and marks it', () => {
  const d = registry();
  try {
    const l = accounts.add({ provider: 'claude', folder: path.join(d.k, 'p1') });
    assert.equal(l.length, 1);
    assert.ok(l[0].name, 'the label was left empty');
    assert.equal(l[0].temp, true, 'the temporary flag is missing - a real name could be overwritten');
  } finally { d.cleanup(); }
});

/* AN ACCOUNT CANNOT BE NAMED. A name supplied from outside is now IGNORED; the label always comes from
   the e-mail read at login. The old test pinned the opposite. */
test('a name supplied from outside is ignored; the label stays temporary', () => {
  const d = registry();
  try {
    const l = accounts.add({ name: 'my work account', provider: 'claude', folder: path.join(d.k, 'p1') });
    assert.notEqual(l[0].name, 'my work account', 'a hand-typed name must not reach the registry');
    assert.equal(l[0].temp, true, 'the label stays temporary until a login happens');
  } finally { d.cleanup(); }
});

test('name matching is gone: a definition finds its account only by ID', () => {
  const d = registry();
  try {
    const l = accounts.add({ provider: 'claude', folder: path.join(d.k, 'p1') });
    const id = l[0].id;
    accounts.updateName(id, 'ExampleAccount');
    assert.equal(accounts.findLoose(id).id, id, 'the id must be found');
    assert.equal(accounts.findLoose('ExampleAccount'), null, 'the label must not find it');
    assert.equal(accounts.findLoose('exampleaccount'), null);
  } finally { d.cleanup(); }
});

test('updateName writes the name and clears the temporary flag', () => {
  const d = registry();
  try {
    const l = accounts.add({ provider: 'claude', folder: path.join(d.k, 'p1') });
    const after = accounts.updateName(l[0].id, 'ExampleAccount');
    assert.equal(after[0].name, 'ExampleAccount');
    assert.equal(after[0].temp, undefined, 'the name is real now; it must not be overwritten again');
  } finally { d.cleanup(); }
});

test('the same e-mail on a second account is reported as a twin', () => {
  const d = registry();
  try {
    const a = accounts.add({ provider: 'claude', folder: path.join(d.k, 'p1') })[0];
    accounts.writeEmail(a.id, 'first@example.test');
    accounts.updateName(a.id, 'first');
    const all = accounts.add({ provider: 'claude', folder: path.join(d.k, 'p2') });
    const b = all.find((x) => x.id !== a.id);

    const twin = accounts.emailTwin(b.id, 'first@example.test');
    assert.ok(twin, 'the same account is on two rows and the panel does not see it');
    assert.equal(twin.id, a.id, 'a twin is recognised by ID, not by label');
    // Letter case does not turn one account into two.
    assert.ok(accounts.emailTwin(b.id, 'FIRST@Example.test'));
  } finally { d.cleanup(); }
});

test('a different e-mail is no twin; an account is not its own twin', () => {
  const d = registry();
  try {
    const a = accounts.add({ provider: 'claude', folder: path.join(d.k, 'p1') })[0];
    accounts.writeEmail(a.id, 'first@example.test');
    assert.equal(accounts.emailTwin(a.id, 'first@example.test'), null);
    assert.equal(accounts.emailTwin('other', 'second@example.test'), null);
    assert.equal(accounts.emailTwin('other', ''), null);
  } finally { d.cleanup(); }
});

test('two unnamed accounts are not offered the same folder', () => {
  // An empty name used to always give 'account2': the second unnamed account suggested the folder of the
  // first and was refused with a folder-already-used message.
  const a = accounts.suggestedFolder('claude', '');
  const b = accounts.suggestedFolder('claude', '');
  assert.notEqual(a, b);
  assert.match(a, /\.claude-/);
});
