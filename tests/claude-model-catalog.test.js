'use strict';
/* THE CLAUDE MODEL LIST COMES FROM CLAUDE CODE ITSELF . The list was written by hand
   in `agent-writer.js`; when Opus 5.5 came out the panel still offered "Opus 5" and nothing newer. Claude
   Code keeps the catalog it fetched from its server in `<profile>/cache/model-catalog/*-cc.json`
   (measured on Claude Code 2.1.280: `catalog.config.models`, each with `id`, `name` and `section`
   "main" or "overflow"). Reading it costs no request and no token. The hand-written list stays only as
   the answer for a profile that has never run Claude Code. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const writeAgent = require('../panel/agent-writer.js');

function profile(files) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'benchook-catalog-'));
  const cache = path.join(folder, 'cache', 'model-catalog');
  fs.mkdirSync(cache, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(cache, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return folder;
}

const catalog = (fetchedAt, models) => ({ version: 2, fetchedAt, staleAt: fetchedAt + 1,
  catalog: { surface: 'cc', config: { id: 'cc', models } } });

test('the list is read from the catalog Claude Code saved: current models first, older ones after', () => {
  const folder = profile({ 'a-cc.json': catalog(100, [
    { id: 'claude-opus-9', name: 'Opus 9', section: 'main' },
    { id: 'claude-opus-8', name: 'Opus 8', section: 'overflow' },
    { id: 'claude-haiku-9-1-20300101', name: 'Haiku 9.1', section: 'main' },
  ]) });
  const list = writeAgent.claudeModels(folder);
  assert.equal(list[0], 'default');
  // User decision, 6 October 2026: only named versions are offered, never a bare family name.
  for (const alias of ['opus', 'sonnet', 'haiku', 'fable']) assert.ok(!list.includes(alias), alias + ' is not offered');
  const full = list.filter((x) => x.startsWith('claude-'));
  assert.deepEqual(full, ['claude-opus-9', 'claude-haiku-9-1-20300101', 'claude-opus-8']);
});

test('with several saved catalogs the newest one is used', () => {
  const folder = profile({
    'old-cc.json': catalog(100, [{ id: 'claude-old-1', name: 'Old 1', section: 'main' }]),
    'new-cc.json': catalog(200, [{ id: 'claude-new-2', name: 'New 2', section: 'main' }]),
  });
  const full = writeAgent.claudeModels(folder).filter((x) => x.startsWith('claude-'));
  assert.deepEqual(full, ['claude-new-2']);
});

test('no catalog, an unreadable one or no profile: the built-in list, never an empty box', () => {
  for (const folder of [profile({}), profile({ 'x-cc.json': '{not json' }), profile({ 'y-cc.json': { version: 9 } }), null]) {
    assert.deepEqual(writeAgent.claudeModels(folder), writeAgent.CLAUDE_MODELS);
  }
});

test('the built-in list knows the current models', () => {
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-4-5']) {
    assert.ok(writeAgent.CLAUDE_MODELS.includes(id), id);
  }
});
