'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agent = require('../panel/agent-writer');

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const field = { name: 'auditor', description: 'Call when the code changes', task: 'Audit the code',
  account: 'codex-default', provider: 'codex', model: 'gpt-test' };

test('account and model are required', (t) => {
  const dir = project(t);
  assert.match(agent.preview(dir, { ...field, account: '' }).error, /account/);
  assert.match(agent.preview(dir, { ...field, model: '' }).error, /model/);
  // the empty-text-is-not-written protection of the removed source-write path now lives here.
  assert.match(agent.preview(dir, { ...field, task: '   ' }).error, /empty/i);
});

test('every agent is produced in the neutral project store with one panel schema', (t) => {
  const dir = project(t), r = agent.preview(dir, field);
  assert.equal(r.filePath, path.join(dir, '.benchook', 'agents', 'auditor.md'));
  assert.match(r.content, /schema: panel-agent\/v1/);
  assert.match(r.content, /account: codex-default/);
  assert.match(r.content, /provider: codex/);
  assert.match(r.content, /tools: Read, Grep, Glob, Bash/);
  assert.equal(r.worker, 'panel');
});

test('the same name cannot be used silently in two definitions', (t) => {
  const dir = project(t), old = path.join(dir, '.claude', 'agents');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'auditor.md'), '---\nname: auditor\n---\n');
  assert.match(agent.preview(dir, field).error, /already in use/);
});

/* Deletion target protection is covered by agent-deletion and release-regressions tests. Shared editing is covered by agent-sync and agent-add-to-project tests; account/model identity is covered by agent-membership tests. */

/* IF THE ASSIGNED ACCOUNT IS SIGNED OUT THE CARD SAYS SO. `worker.js` already refuses at call time;
   seeing it before running saves a run. No warning is WRITTEN for an agent bound to the orchestrator:
   the panel does not know that account. */
test('an agent assigned to a signed-out account carries a warning; a signed-in account and the orchestrator do not', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-signedIn-'));
  const accounts = require('../panel/accounts.js');
  try {
    const openHome = path.join(root, 'opened-ev'), closedHome = path.join(root, 'closed-ev');
    fs.mkdirSync(openHome, { recursive: true });
    fs.mkdirSync(closedHome, { recursive: true });
    // The proof of a login is the identity file; the folder of a signed-out account has no such file.
    fs.writeFileSync(path.join(openHome, '.credentials.json'), '{}');
    fs.writeFileSync(path.join(root, 'accounts.json'), JSON.stringify({ accounts: [
      { id: 'claude-opened', name: 'Opened', provider: 'claude', folder: openHome },
      { id: 'claude-closed', name: 'Closed', provider: 'claude', folder: closedHome },
    ] }));
    accounts.setup(path.join(root, 'accounts.json'));

    const k = path.join(root, 'project', '.benchook', 'agents');
    fs.mkdirSync(k, { recursive: true });
    const definition = (name, account) => '---\nname: ' + name + '\ndescription: d\nmodel: haiku\n'
      + 'account: ' + account + '\n---\n\nis\n';
    fs.writeFileSync(path.join(k, 'opened.md'), definition('opened', 'claude-opened'));
    fs.writeFileSync(path.join(k, 'closed.md'), definition('closed', 'claude-closed'));
    fs.writeFileSync(path.join(k, 'orch.md'), definition('orch', 'orchestrator'));

    const list = agent.existing(path.join(root, 'project'));
    const find = (name) => list.find((a) => a.name === name);
    assert.equal(find('opened').signInWarning, null, 'no warning may be written for a signed-in account');
    assert.equal(find('orch').signInWarning, null, 'no warning may be written for an agent bound to the orchestrator');
    assert.match(find('closed').signInWarning, /^Assigned account \(Closed\) is signed out/);
  } finally {
    accounts.setup(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
