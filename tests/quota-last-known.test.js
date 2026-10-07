'use strict';
/* AN OBSERVATION WITHOUT USAGE NUMBERS DOES NOT REPLACE THE LAST KNOWN ONES (Codex trial, 24 September).
   On reopening, the panel resumes the Claude terminal; Claude's first status line of a resumed session
   carries no `rate_limits`. That observation was taken as the newest: the account row said "Usage limits
   unavailable" and the saved last-known numbers on disk were overwritten with nulls (measured: the
   saved file went from 26% / 30% to null / null within a minute of opening). */
const test = require('node:test');
const assert = require('node:assert/strict');
const quotaClaude = require('../panel/quota-claude.js');

const numbers = (time) => ({ time, quota: { short: { percent: 26, resetsAt: '2099-01-01T00:00:00.000Z' },
  long: { percent: 30, resetsAt: '2099-01-02T00:00:00.000Z' } } });
const empty = (time) => ({ time, quota: { short: null, long: null } });

test('a live observation without numbers falls back to the saved numbers of the same sign-in', () => {
  const saved = { authId: 'me', observation: numbers('2026-09-23T21:18:41Z') };
  const r = quotaClaude.choose([empty('2026-09-23T21:48:16Z')], saved, 'me');
  assert.equal(r.observation, saved.observation);
  assert.equal(r.save, false, 'the empty observation is not written over the saved numbers');
});

test('a live observation with numbers is used and saved, even when a newer one has none', () => {
  const withNumbers = numbers('2026-09-23T21:40:00Z');
  const r = quotaClaude.choose([empty('2026-09-23T21:48:16Z'), withNumbers], null, 'me');
  assert.equal(r.observation, withNumbers);
  assert.equal(r.save, true);
});

test('saved numbers of another sign-in are never used', () => {
  const r = quotaClaude.choose([], { authId: 'someone-else', observation: numbers('t') }, 'me');
  assert.equal(r.observation, null);
  assert.equal(r.save, false);
});

test('with nothing to show the reason stays on screen', () => {
  const r = quotaClaude.choose([empty('t')], null, 'me');
  assert.match(quotaClaude.read(r.observation).error, /Usage limits unavailable/);
});
