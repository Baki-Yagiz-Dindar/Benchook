'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const context = require('../panel/sessions.js');

/* NO --resume FOR A SESSION NOT CONFIRMED TO EXIST. Seen in a real run:
       No conversation found with session ID: <id>
       [process ended, exit code 1]
   The terminal never opened. The panel passed the session identity saved in the layout to the CLI
   as `--resume` without checking it; when that record was missing from the chosen account's profile,
   the CLI died.

   `findSessionFile` could ALREADY make this check; it just was not called on the startup path.
   This test holds that the function answers correctly in both directions; that the startup path calls
   it is measured separately by the screen test. */

function profile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Puts a session record belonging to that project into an account's profile. */
function writeSession(accountRoot, project, id) {
  const k = context.claudeFolder(project, accountRoot);
  fs.mkdirSync(k, { recursive: true });
  const y = path.join(k, id + '.jsonl');
  fs.writeFileSync(y, JSON.stringify({ type: 'user', timestamp: new Date().toISOString() }) + '\n');
  return y;
}

test('when the record EXISTS the session file is found', () => {
  const p = profile();
  try {
    const project = 'C:/project/trial';
    const id = 'fe967830-b5bb-46b1-b96b-e25844cb8ade';
    const written = writeSession(p.root, project, id);
    const found = context.findSessionFile('claude', project, id, p.root);
    assert.equal(path.resolve(found), path.resolve(written));
  } finally { p.cleanup(); }
});

test('when the record is ABSENT null is returned - the panel sees this and opens a clean session', () => {
  const p = profile();
  try {
    const found = context.findSessionFile('claude', 'C:/project/trial',
      'fe967830-b5bb-46b1-b96b-e25844cb8ade', p.root);
    assert.equal(found, null);
  } finally { p.cleanup(); }
});

test('a record in the profile of ANOTHER account is not found under this account', () => {
  // The situation the user hit: the account was removed and added again, or the page had been opened
  // with another account. The identity stays in the layout but has no counterpart in the chosen profile.
  const a = profile(); const b = profile();
  try {
    const project = 'C:/project/trial';
    const id = 'fe967830-b5bb-46b1-b96b-e25844cb8ade';
    writeSession(a.root, project, id);
    assert.ok(context.findSessionFile('claude', project, id, a.root), 'it must be present on the source account');
    assert.equal(context.findSessionFile('claude', project, id, b.root), null);
  } finally { a.cleanup(); b.cleanup(); }
});

test('a record belonging to ANOTHER project is not found in this project', () => {
  const p = profile();
  try {
    const id = 'fe967830-b5bb-46b1-b96b-e25844cb8ade';
    writeSession(p.root, 'C:/project/first', id);
    assert.equal(context.findSessionFile('claude', 'C:/project/second', id, p.root), null);
  } finally { p.cleanup(); }
});
