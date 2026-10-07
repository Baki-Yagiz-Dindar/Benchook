'use strict';
// Additive provider changes must not poison unrelated fields or erase readable records.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const models = require('../panel/agent-writer');
const sessions = require('../panel/sessions');
const identity = require('../panel/account-identity');
const quota = require('../panel/quota-codex');

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchook-provider-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
function event(input = 10, limit = 100) {
  return { type: 'event_msg', payload: { type: 'token_count', info: {
    last_token_usage: { input_tokens: input }, model_context_window: limit,
  }, rate_limits: { primary: { used_percent: 20, window_minutes: 300, resets_at: 2000000000 } } } };
}

test('an empty or changed newest Claude catalog does not discard an older readable catalog', t => {
  const root = temp(t), cache = path.join(root, 'cache/model-catalog');
  write(path.join(cache, 'old-cc.json'), { fetchedAt: 1, catalog: { config: { models: [
    { id: 'claude-test-future', section: 'main', extra: { future: true } },
  ] } } });
  for (const changed of [[], [null, { id: 42 }]]) {
    write(path.join(cache, 'new-cc.json'), { fetchedAt: 2, catalog: { config: { models: changed } } });
    assert.ok(models.claudeModels(root).includes('claude-test-future'));
  }
});

test('an unknown Codex catalog entry does not hide valid models or leak invalid identifiers', t => {
  const root = temp(t);
  write(path.join(root, 'models_cache.json'), { models: [null,
    { visibility: 'list', slug: null },
    { visibility: 'list', slug: 'future-model', display_name: 'Future', extra: true },
    { visibility: 'list', slug: 'future-model' },
  ] });
  assert.deepEqual(models.codexModels(root).seen, [{ name: 'future-model', label: 'Future', record: null }]);
});

test('quota-only Codex events update quota without discarding the last context observation', t => {
  const file = path.join(temp(t), 'session.jsonl');
  const update = event(); update.payload.info = null; update.payload.rate_limits.primary.used_percent = 45;
  fs.writeFileSync(file, [ { type: 'turn_context', payload: { model: 'real-model' } }, event(), update,
    { type: 'future_event', payload: { model: 'not-a-model-selection' } },
  ].map(JSON.stringify).join('\n'));
  const read = sessions.read('codex', file);
  assert.equal(read.model, 'real-model');
  assert.equal(read.used, 10);
  assert.equal(read.quota.short.percent, 45);
});

test('changed numeric types and invalid usage are unavailable rather than a plausible percentage', t => {
  const file = path.join(temp(t), 'session.jsonl');
  for (const [used, limit] of [[10, '100'], [-1, 100], [10, -100]]) {
    fs.writeFileSync(file, JSON.stringify(event(used, limit)));
    assert.equal(sessions.read('codex', file).percent, null);
  }
});

test('invalid quota percentages are rejected while optional changed fields remain unknown', t => {
  const file = path.join(temp(t), 'session.jsonl');
  for (const percent of ['20', -1, 101, null]) {
    assert.throws(() => quota.parse({ rateLimits: { primary: { usedPercent: percent } } }));
    const row = event(); row.payload.rate_limits.primary.used_percent = percent;
    fs.writeFileSync(file, JSON.stringify(row));
    assert.equal(sessions.read('codex', file).quota.short, null);
  }
  const value = quota.parse({ rateLimits: { primary: {
    usedPercent: 20, windowDurationMins: {}, resetsAt: ['changed'], extra: true,
  } } });
  assert.deepEqual(value.short, { percent: 20, minutes: null, resetsAt: null });
});

test('changed identity data never throws or exposes non-string account fields', t => {
  const root = temp(t), file = path.join(root, 'auth.json');
  for (const value of [null, [], { tokens: { id_token: {} } }]) {
    write(file, value);
    assert.ok(identity.codex(root).error);
  }
  const body = Buffer.from(JSON.stringify({ email: { changed: true }, name: ['changed'] })).toString('base64url');
  write(file, { tokens: { id_token: 'header.' + body + '.signature' }, extra: true });
  const result = identity.codex(root);
  assert.equal(result.email, null);
  assert.equal(result.name, null);
});

test('a Codex session with a matching filename but another project is never resumed or copied', t => {
  const root = temp(t), project = path.join(root, 'project');
  write(path.join(root, 'sessions/rollout-session-a.jsonl'), {
    type: 'session_meta', payload: { id: 'session-a', cwd: path.join(root, 'other'), source: 'cli' },
  });
  assert.equal(sessions.findSessionFile('codex', project, 'session-a', root), null);
  assert.throws(() => sessions.copySession('codex', project, 'session-a', root, path.join(root, 'target')));
  assert.equal(fs.existsSync(path.join(root, 'target')), false);
});

test('session metadata survives a filename change; ambiguous copies are not guessed', t => {
  const root = temp(t), project = path.join(root, 'project');
  const meta = { type: 'session_meta', payload: { id: 'session-a', cwd: project, source: 'cli', future: true } };
  const file = path.join(root, 'sessions/new-layout.jsonl');
  write(file, meta);
  assert.equal(sessions.findSessionFile('codex', project, 'session-a', root), file);
  write(path.join(root, 'sessions/duplicate.jsonl'), meta);
  assert.equal(sessions.findSessionFile('codex', project, 'session-a', root), null);
  fs.renameSync(path.join(root, 'sessions/duplicate.jsonl'), path.join(root, 'sessions/rollout-session-a.jsonl'));
  assert.equal(sessions.findSessionFile('codex', project, 'session-a', root), null,
    'an old filename must not hide an ambiguous renamed copy');
});
