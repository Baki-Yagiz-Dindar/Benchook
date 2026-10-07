'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const accounts = require('../panel/accounts.js');

test('email twins are limited to the same provider and retain case-insensitive matching', () => {
  const d = registry(JSON.stringify({ accounts: [
    { id: 'claude-a', name: 'A', provider: 'claude', folder: null, email: 'user@example.test' },
    { id: 'codex-a', name: 'B', provider: 'codex', folder: null, email: 'USER@example.test' },
  ] }));
  try {
    assert.equal(accounts.emailTwin('claude-a', 'USER@example.test'), null);
    assert.equal(accounts.emailTwin('codex-a', 'user@example.test'), null);
    assert.equal(accounts.emailTwin('missing', 'user@example.test'), null);
    const data = JSON.parse(fs.readFileSync(d.y, 'utf8'));
    data.accounts.push({ id: 'claude-b', name: 'C', provider: 'claude', folder: null, email: 'user@example.test' });
    fs.writeFileSync(d.y, JSON.stringify(data));
    assert.equal(accounts.emailTwin('claude-a', ' USER@example.test ').id, 'claude-b');
    assert.equal(accounts.emailTwin('codex-a', 'user@example.test'), null);
    assert.equal(accounts.emailTwin('claude-a', ''), null);
  } finally { fs.rmSync(d.k, { recursive: true, force: true }); }
});

/* AN EMPTY STORE IS NOT THE SAME AS NO STORE - measured in real use.
   The user removed the accounts from the panel and the file became an empty account list (so removal
   WORKED), but the reader treated the empty list as "no store" and brought the two default accounts
   back. On screen this looks like "the Remove button does not work".

   The test holds both directions: an empty store must stay empty, a missing store must fall back to the
   default. Either is meaningless without the other -- testing only the first could break first launch. */

function registry(content) {
  const k = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'));
  const y = path.join(k, 'accounts.json');
  if (content !== null) fs.writeFileSync(y, content);
  accounts.setup(y);
  return { k, y };
}

test('when the user removes the last account the registry stays EMPTY; defaults do not come back', () => {
  const d = registry('{"accounts": []}');
  try {
    assert.deepEqual(accounts.list(), []);
  } finally { fs.rmSync(d.k, { recursive: true, force: true }); }
});

test('the removal survives once it has been written to disk', () => {
  const d = registry(JSON.stringify({ accounts: [
    { id: 'claude-a', name: 'A', provider: 'claude', folder: null },
  ] }));
  try {
    accounts.remove('claude-a');
    assert.deepEqual(accounts.list(), []);
    // Also empty when read again from the file: no cache, the source is the file itself.
    accounts.setup(d.y);
    assert.deepEqual(accounts.list(), []);
  } finally { fs.rmSync(d.k, { recursive: true, force: true }); }
});

// First launch: no registry file yet, so no accounts. Only accounts the user adds appear.
test('with no registry file (first launch) the account list is empty', () => {
  const d = registry(null);
  try {
    assert.deepEqual(accounts.list(), []);
  } finally { fs.rmSync(d.k, { recursive: true, force: true }); }
});

test('a corrupt account store stays intact and reports a recovery error', () => {
  const d = registry('{not json');
  try {
    assert.throws(() => accounts.list(), /preserved/);
    assert.equal(fs.readFileSync(d.y, 'utf8'), '{not json');
  } finally { fs.rmSync(d.k, { recursive: true, force: true }); }
});

test('an empty registry finds no account; agents fall back to the orchestrator', () => {
  const d = registry('{"accounts": []}');
  try {
    assert.equal(accounts.find('claude-default'), null);
    assert.equal(accounts.findLoose('Claude'), null);
  } finally { fs.rmSync(d.k, { recursive: true, force: true }); }
});
