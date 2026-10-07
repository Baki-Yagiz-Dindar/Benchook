'use strict';
/* ASKING AGAIN AFTER A DECLINED CONNECTION . Claude records "continue without" for a
   project server in `<project>/.claude/settings.local.json` (`disabledMcpjsonServers`) and does not ask
   again; its /mcp list does not show the declined server (measured on 2.1.280). Removing that one
   entry puts the server back to "Pending approval" (measured with `claude mcp get`). Only Benchook's own
   entry is removed, only from the personal settings file; the shared settings file is not Benchook's to
   change. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mcpStatus = require('../panel/mcp-status.js');

function project(serverKey, local, shared) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'benchook-ask-again-'));
  fs.writeFileSync(path.join(folder, '.mcp.json'), JSON.stringify({ mcpServers: {
    [serverKey]: { command: 'node', args: [mcpStatus.TOOL] }, unrelated: { command: 'other', args: [] } } }));
  fs.mkdirSync(path.join(folder, '.claude'));
  if (local) fs.writeFileSync(path.join(folder, '.claude', 'settings.local.json'), JSON.stringify(local, null, 2));
  if (shared) fs.writeFileSync(path.join(folder, '.claude', 'settings.json'), JSON.stringify(shared, null, 2));
  return folder;
}
const readLocal = (folder) => JSON.parse(fs.readFileSync(path.join(folder, '.claude', 'settings.local.json'), 'utf8'));

test("only Benchook's declined entry is removed; the rest of the file stays", () => {
  const folder = project('benchook', { disabledMcpjsonServers: ['benchook', 'unrelated'], permissions: { allow: ['Read'] } });
  assert.equal(mcpStatus.claudeEnablement(null, folder, 'benchook'), 'closed');
  const r = mcpStatus.askAgainClaude(folder);
  assert.equal(r.done, true, JSON.stringify(r));
  assert.deepEqual(readLocal(folder), { disabledMcpjsonServers: ['unrelated'], permissions: { allow: ['Read'] } });
  assert.notEqual(mcpStatus.claudeEnablement(null, folder, 'benchook'), 'closed');
});

test('an emptied list is removed rather than left empty', () => {
  const folder = project('benchook', { disabledMcpjsonServers: ['benchook'] });
  assert.equal(mcpStatus.askAgainClaude(folder).done, true);
  assert.deepEqual(readLocal(folder), {});
});

test('the entry is found under the name the server actually has', () => {
  const folder = project('benchook-old', { disabledMcpjsonServers: ['benchook-old'] });
  assert.equal(mcpStatus.askAgainClaude(folder).done, true);
  assert.deepEqual(readLocal(folder), {});
});

test('a decline in the shared settings file is reported, not changed', () => {
  const shared = { disabledMcpjsonServers: ['benchook'] };
  const folder = project('benchook', null, shared);
  const r = mcpStatus.askAgainClaude(folder);
  assert.ok(r.error && /settings\.json/.test(r.error), JSON.stringify(r));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, '.claude', 'settings.json'), 'utf8')), shared);
});

test('nothing declined or no connection: nothing is written and the reason is given', () => {
  const clean = project('benchook', { other: 1 });
  const r = mcpStatus.askAgainClaude(clean);
  assert.ok(r.error, JSON.stringify(r));
  assert.deepEqual(readLocal(clean), { other: 1 });
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'benchook-ask-again-'));
  assert.ok(mcpStatus.askAgainClaude(bare).error);
});
