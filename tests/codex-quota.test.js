'use strict';

// The quota of EVERY account that is added must be read.
//
// Codex quota does not come from the network: `used_percent` is written on every turn into that account's
// OWN session record. So which account root is searched is decisive; the default folder used to be
// searched every time and the quota of a second Codex account never appeared.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const context = require('../panel/sessions');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-quota-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Like a real Codex record: sessions/<year>/<month>/<day>/rollout-….jsonl */
function setupCodexRecord(root, percentShort, percentLong) {
  const k = path.join(root, 'sessions', '2026', '09', '05');
  fs.mkdirSync(k, { recursive: true });
  const line = JSON.stringify({
    payload: {
      info: {
        last_token_usage: { input_tokens: 48145 },
        total_token_usage: { total_tokens: 508444 },
        model_context_window: 258400,
      },
      rate_limits: {
        primary: { used_percent: percentShort, window_minutes: 300, resets_at: '2026-09-05T18:00:00Z' },
        secondary: { used_percent: percentLong, window_minutes: 10080, resets_at: '2026-09-07T17:00:00Z' },
        plan_type: 'pro',
      },
      type: 'token_count',
    },
  });
  const file = path.join(k, 'rollout-2026-09-05T10-00-00-01a06cf1-0000-0000-0000-000000000001.jsonl');
  fs.writeFileSync(file, '{"model":"gpt-5.6-luna"}\n' + line + '\n', 'utf8');
  return file;
}

test('the quota is read from the root of the account that was ASKED about', (t) => {
  const a = temp(t), b = temp(t);
  setupCodexRecord(a, 11, 22);
  setupCodexRecord(b, 77, 88);

  const readRoot = (root) => context.read('codex', context.lastCodexSession(root).file).quota;
  assert.equal(readRoot(a).short.percent, 11);
  assert.equal(readRoot(b).short.percent, 77, 'the quota of the second account got mixed up with the first');
});

test('the record of one account is not looked for in the root of another', (t) => {
  const filled = temp(t), empty = temp(t);
  setupCodexRecord(filled, 11, 22);
  fs.mkdirSync(path.join(empty, 'sessions'), { recursive: true });

  assert.ok(context.lastCodexSession(filled));
  assert.equal(context.lastCodexSession(empty), null, 'a record that does not exist was found on an empty account');
});

test('both quota windows come from the right field', (t) => {
  const root = temp(t);
  setupCodexRecord(root, 34, 56);
  const k = context.read('codex', context.lastCodexSession(root).file).quota;

  assert.equal(k.short.percent, 34);
  assert.equal(k.short.minutes, 300, 'the five-hour window got mixed up with the weekly one');
  assert.equal(k.long.percent, 56);
  assert.equal(k.long.minutes, 10080);
  assert.equal(k.plan, 'pro');
});

test('the time it was read is returned with it, so a stale number is never shown undated', (t) => {
  const root = temp(t);
  setupCodexRecord(root, 5, 6);
  const last = context.lastCodexSession(root);

  assert.ok(last.writing, 'okunma saati none');
  assert.ok(!Number.isNaN(Date.parse(last.writing)));
});

test('the context percentage is computed from the LAST request, NOT from a cumulative total', (t) => {
  const root = temp(t);
  setupCodexRecord(root, 5, 6);
  const s = context.read('codex', context.lastCodexSession(root).file);

  // 48,145 / 258,400 = 18.6%.  Using the cumulative 508,444 would have given 197%.
  assert.ok(s.percent > 18 && s.percent < 19, 'percent ' + s.percent);
});
