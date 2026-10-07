'use strict';

// History merging and agent origin - the MECHANISM beneath answer-key items 6 and 7.
// How it looks in the window is measured by eye.

const test = require('node:test');
const assert = require('node:assert/strict');
const digest = require('../panel/run-summary');

const run = (top) => ({
  session: 'session-a', file: 'agent-1', name: 'researcher', createdAt: 1000,
  updatedAt: '2026-09-05T10:00:00.000Z', enabled: false, ...top,
});

test('a run copied during an account switch does not appear twice', () => {
  const two = [run(), run()];       // found in both profiles
  assert.equal(digest.merge(two).length, 1);
});

test('the more recent record of the same run wins', () => {
  const old = run({ updatedAt: '2026-09-05T10:00:00.000Z', status: 'running' });
  const created = run({ updatedAt: '2026-09-05T10:05:00.000Z', status: 'done' });

  assert.equal(digest.merge([old, created])[0].status, 'done');
  assert.equal(digest.merge([created, old])[0].status, 'done', 'the order is changing the result');
});

test('on equal timestamps the record of the active pane wins - only it carries the end marker', () => {
  const result = digest.merge([run({ status: 'unknown' }), run({ enabled: true, status: 'done' })]);
  assert.equal(result.length, 1);
  assert.equal(result[0].enabled, true);
  assert.equal(result[0].status, 'done');
});

/* ---- ORDER DOES NOT CHANGE THE RESULT ----
 *
 * Measured defect: the comparer said "newer OR active". An OLDER but active record overrode a NEWER
 * inactive one; and which one won depended on the order of the list. The rule: time first, and ON A TIE
 * the active source.
 *
 * `active` does not mean "running": it says that the record belongs to the active pane. On a tie it is
 * chosen because the end marker can only be read there. */

const twoNext = (a, b) => [digest.merge([a, b])[0], digest.merge([b, a])[0]];

test("a NEWER inactive record beats an OLDER active one", () => {
  const oldEnabled = run({ updatedAt: '2026-09-05T10:00:00.000Z', enabled: true, result: 'old' });
  const newInactive = run({ updatedAt: '2026-09-05T11:00:00.000Z', enabled: false, result: 'new' });

  for (const s of twoNext(oldEnabled, newInactive)) {
    assert.equal(s.result, 'new', 'being active must not override the timestamp');
  }
});

test("on equal timestamps the active record wins, in either order", () => {
  const inactive = run({ enabled: false, result: 'inactive' });
  const enabled = run({ enabled: true, result: 'enabled' });

  for (const s of twoNext(inactive, enabled)) assert.equal(s.result, 'enabled');
});

test("for a record with an unreadable timestamp the birth time is used", () => {
  const a = run({ updatedAt: null, createdAt: 500, result: 'old' });
  const b = run({ updatedAt: 'corrupt-date', createdAt: 900, result: 'created' });

  for (const s of twoNext(a, b)) assert.equal(s.result, 'created');
});

test("when everything else is equal the record carrying MORE information is chosen", () => {
  const few = run({ step: 2, result: 'short' });
  const many = run({ step: 9, result: 'a longer result' });

  for (const s of twoNext(few, many)) {
    assert.equal(s.step, 9, 'the further-along reading of the same run must be chosen');
  }
});

test("all six orderings of three copies choose the same record", () => {
  const records = [
    run({ updatedAt: '2026-09-05T10:00:00.000Z', enabled: true, result: 'a' }),
    run({ updatedAt: '2026-09-05T11:00:00.000Z', enabled: false, result: 'b' }),
    run({ updatedAt: '2026-09-05T09:00:00.000Z', enabled: false, result: 'c' }),
  ];
  const sequences = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const selectedItems = sequences.map((s) => digest.merge(s.map((i) => records[i]))[0].result);

  assert.deepEqual(selectedItems, ['b', 'b', 'b', 'b', 'b', 'b']);
});

test("merging does not collapse genuinely different runs", () => {
  const list = digest.merge([
    run({ file: 'agent-1', enabled: true, updatedAt: '2026-09-05T09:00:00.000Z' }),
    run({ file: 'agent-2', enabled: false, updatedAt: '2026-09-05T11:00:00.000Z' }),
  ]);
  assert.equal(list.length, 2, 'the key is session plus file; the time and activity rules do not change it');
});

test('runs from different sessions stay on separate rows', () => {
  const list = digest.merge([run({ session: 'session-a' }), run({ session: 'session-b' })]);
  assert.equal(list.length, 2);
});

test('two DIFFERENT agent runs in the same session are not merged', () => {
  const list = digest.merge([run({ file: 'agent-1' }), run({ file: 'agent-2' })]);
  assert.equal(list.length, 2);
});

test('the most recent run comes back first', () => {
  const list = digest.merge([
    run({ session: 'old', createdAt: 100 }),
    run({ session: 'created', createdAt: 900 }),
  ]);
  assert.deepEqual(list.map((k) => k.session), ['created', 'old']);
});

// --- origin ---

const defined = [{ name: 'researcher', model: 'gpt-5.6-luna' }, { name: 'never-idle', model: 'haiku' }];

test('the run count of a defined agent comes through; one that never ran stays at zero with no date', () => {
  const c = digest.separateOrigin(defined, new Map([['researcher', { times: 3, last: 1757066400000 }]]));
  const a = c.find((x) => x.name === 'researcher');
  const h = c.find((x) => x.name === 'never-idle');

  assert.equal(a.times, 3);
  assert.equal(h.times, 0);
  assert.equal(h.last, null, 'it invented a date for an agent that never ran');
});

test('a built-in role of the provider goes under the built-in heading', () => {
  const c = digest.separateOrigin(defined, new Map([['general-purpose', { times: 2, last: 1757066400000 }]]));
  const g = c.find((x) => x.name === 'general-purpose');

  assert.equal(g.builtin, true);
  assert.equal(g.originAmbiguous, false);
});

test('a name with no definition is NOT called deleted - its origin stays uncertain', () => {
  const c = digest.separateOrigin(defined, new Map([['old-role', { times: 1, last: 1757066400000 }]]));
  const e = c.find((x) => x.name === 'old-role');

  assert.equal(e.builtin, false);
  assert.equal(e.originAmbiguous, true);
  assert.match(e.description, /may have been/, 'it states an origin it does not know with a definite sentence');
});

test('telling origins apart does not corrupt the usage map it was given', () => {
  const usage = new Map([['researcher', { times: 1, last: 1 }], ['old-role', { times: 1, last: 1 }]]);
  digest.separateOrigin(defined, usage);
  assert.equal(usage.size, 2, 'the map of the caller was emptied');
});
