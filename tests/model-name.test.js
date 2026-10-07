'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const writeAgent = require('../panel/agent-writer.js');

/* `modelName` lives on the page side (no Electron, no DOM), so it is extracted from the source and run
   here. The alternative was a screen test; this distinction is pure text work, and a pure text test is
   both fast and exact. */
function loadModelName() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'panel', 'panel.js'), 'utf8');
  const press = source.indexOf('function modelName(raw)');
  assert.ok(press > 0, 'modelName was not found - if it was renamed this test must be updated too');
  const body = source.slice(press);
  // eslint-disable-next-line no-eval
  return eval('(' + body.slice(0, body.indexOf('\n}') + 2) + ')');
}

const modelName = loadModelName();

/* NO PROVIDER NAME ON SCREEN: only the model reads there. The provider is already in the pane icon, the
   account row and the terminal title. */
test('the provider prefix drops off the screen and the model name stays', () => {
  assert.equal(modelName('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(modelName('claude-opus-5'), 'Opus 5');
});

/* Format Codex model labels without a redundant GPT prefix while preserving the model identifier. */
test('a GPT model is written without GPT', () => {
  assert.equal(modelName('gpt-5.6-luna'), '5.6 Luna');
  assert.equal(modelName('GPT-5.6-Luna'), '5.6 Luna');
  assert.equal(modelName('gpt-6-astra'), '6 Astra');
  assert.equal(modelName('gpt-5.5'), '5.5');
  assert.equal(modelName('gpt-5.4-codex'), '5.4 Codex');
});

test('version numbers join with a dot and the date stamp drops off', () => {
  // `claude-haiku-4-5-20251001` and `claude-haiku-4-5` are THE SAME model; both show as "Haiku 4.5" on
  // screen, otherwise the same model would be listed under two different names.
  assert.equal(modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(modelName('claude-haiku-4-5'), 'Haiku 4.5');
  assert.equal(modelName('claude-fable-5-1'), 'Fable 5.1');
});

test('a family name an older agent was saved with stays readable and "default" is never touched', () => {
  assert.equal(modelName('sonnet'), 'Sonnet');
  assert.equal(modelName('opus'), 'Opus');
  // `default` is not a model name, it means send no model; capitalised it would look like a model on screen.
  assert.equal(modelName('default'), 'default');
  assert.equal(modelName(''), '');
  assert.equal(modelName(null), '');
});

/* THE MODEL LIST: specific versions such as Sonnet 5 or 4 were missing, so people could not use a
   particular model. The list held only aliases. */
test('the model list offers named versions only, never a bare family name', () => {
  const l = writeAgent.CLAUDE_MODELS;
  // User decision, 6 October 2026: "only model names and their versions".
  for (const x of ['sonnet', 'opus', 'haiku', 'fable']) assert.ok(!l.includes(x), x + ' is offered');
  // A full name: exactly that version, fixed.
  const fullName = l.filter((x) => x.startsWith('claude-'));
  assert.ok(fullName.length >= 4, 'no specific version can be chosen: ' + l.join(', '));
  assert.ok(l.includes('default'), 'the option of sending no model is gone');
});

test('every id in the list turns into a readable name on screen', () => {
  for (const x of writeAgent.CLAUDE_MODELS) {
    const name = modelName(x);
    assert.ok(name && name.trim(), x + ' has an empty name');
    if (x !== 'default') {
      assert.doesNotMatch(name, /claude/i, x + ' still carries the provider name on screen');
    }
  }
});

test('no two ids in the list collapse to the same display name', () => {
  // With both `haiku` and `claude-haiku-4-5` in the list at once, both would read "Haiku"/"Haiku 4.5"
  // and the user could not tell which one they chose.
  const names = writeAgent.CLAUDE_MODELS.map(modelName);
  assert.equal(new Set(names).size, names.length, 'clashing name: ' + names.join(', '));
});

test('a family name saved in an older agent is shown as the version it stands for now, from the account catalog', (t) => {
  const os = require('node:os');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const folder = path.join(profile, 'cache', 'model-catalog');
  fs.mkdirSync(folder, { recursive: true });
  const catalog = (at, sonnet) => JSON.stringify({ fetchedAt: at, catalog: { config: { models: [
    { id: 'claude-opus-5-5', name: 'Opus 5.5', short_name: 'Opus', section: 'main' },
    { id: sonnet[0], name: sonnet[1], short_name: 'Sonnet', section: 'main' },
    { id: 'claude-opus-5', name: 'Opus 5', short_name: 'Opus', section: 'overflow' },
  ] } } });
  fs.writeFileSync(path.join(folder, 'old-cc.json'), catalog(1000, ['claude-sonnet-5', 'Sonnet 5']));
  fs.writeFileSync(path.join(folder, 'new-cc.json'), catalog(2000, ['claude-sonnet-5-5', 'Sonnet 5.5']));
  const latest = writeAgent.claudeLatest(profile);
  assert.deepEqual(latest, { opus: 'Opus 5.5', sonnet: 'Sonnet 5.5' }, 'the newest catalog, main entries only; no invented haiku/fable');
  assert.deepEqual(writeAgent.claudeLatest(null), {}, 'no catalog, no version');
  // A newer catalog written by the desktop app (`-ccd`) wins over an older command-line one.
  fs.writeFileSync(path.join(folder, 'desk-ccd.json'), catalog(3000, ['claude-sonnet-6', 'Sonnet 6']));
  assert.equal(writeAgent.claudeLatest(profile).sonnet, 'Sonnet 6');
  fs.rmSync(path.join(folder, 'desk-ccd.json'));
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '..', 'panel', 'panel.js'), 'utf8');
  const box = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function modelName(raw)'), source.indexOf('function accountRecord(')), box);
  const opt = source.indexOf('function modelOptionText(');
  vm.runInContext(source.slice(opt, source.indexOf('\n}', opt) + 2), box);
  assert.equal(box.modelOptionText('opus', latest), 'Opus 5.5');
  assert.equal(box.modelOptionText('haiku', latest), 'Haiku', 'an unknown version is not invented');
  assert.equal(box.modelOptionText('claude-opus-5-5', latest), 'Opus 5.5');
  assert.equal(box.modelOptionText('default', latest), 'Default');
});
