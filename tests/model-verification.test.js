'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const worker = require('../panel/worker.js');

/* THE REQUIREMENT: the panel has to be sure a job ran on the account and model entered for that agent.
   The measured defect: the record had a real-model field whose value was the REQUESTED model. So the panel
   recorded a verification it had never done.
   The measured fix (a real run): the output of `claude --print --output-format json` has a `modelUsage`
   field whose keys are the full identities of the models that ran. `haiku` was requested, and
   `claude-haiku-4-5-20251001` / canonical `claude-haiku-4-5` came back.

   KEEPING THE THREE STATES APART IS THE REAL SUBJECT OF THIS TEST: if verified, another model ran and
   could not verify are confused, the panel again shows as known what it does not know. */

test('if the requested alias appears inside the full identity that ran, it counts as verified', () => {
  const r = worker.modelCheck('haiku', ['claude-haiku-4-5'], 'claude');
  assert.equal(r.verified, true);
  assert.equal(r.modelWarning, null);
});

test('if a different model ran a warning is produced and what ran is written down', () => {
  const r = worker.modelCheck('opus', ['claude-sonnet-4-5'], 'claude');
  assert.equal(r.verified, false);
  assert.match(r.modelWarning, /MODEL MISMATCH/);
  assert.match(r.modelWarning, /claude-sonnet-4-5/);
});

test('if the model that ran cannot be read it is NOT called verified and the reason is written', () => {
  const r = worker.modelCheck('haiku', [], 'claude');
  assert.equal(r.verified, null);
  assert.equal(r.modelWarning, null);
  assert.ok(r.unverifiedReason);
});

/* An absent reported model must remain unknown rather than being treated as a successful model match. */
/* What was OBSERVED on the Codex side was a quota error; what would have been INFERRED is that Codex
   does not give this information, and that inference was not made (the fourth rule of CLAUDE.md). The
   reason text has to carry the distinction: it says unknown, not that it refuses. */
test('a Codex run could not be measured today; the reason says unknown, not that it refuses', () => {
  const r = worker.modelCheck('gpt-5.6-luna', [], 'codex');
  assert.equal(r.verified, null);
  assert.match(r.unverifiedReason, /unverified/);
  assert.match(r.unverifiedReason, /Codex/);
});

/* Cover alias matching and ambiguous model evidence without reporting false verification. */

test('asking for a full id and getting the canonical name back raises NO false warning', () => {
  // The `model:` field is free text; a user can type the dated full identity. A one-way comparison
  // counted that as not having run.
  const r = worker.modelCheck('claude-haiku-4-5-20251001', ['claude-haiku-4-5'], 'claude');
  assert.equal(r.verified, true);
  assert.equal(r.modelWarning, null);
});

test('if several models ran it is NOT called verified; which one was the real call is unknown', () => {
  const r = worker.modelCheck('haiku', ['claude-opus-4-1', 'claude-haiku-4-5'], 'claude');
  assert.equal(r.verified, null);
  assert.match(r.unverifiedReason, /does not identify/);
  assert.deepEqual(r.observedModels, ['claude-opus-4-1', 'claude-haiku-4-5']);
});

test('if several ran and none matches the request the warning is still raised', () => {
  const r = worker.modelCheck('opus', ['claude-sonnet-4-5', 'claude-haiku-4-5'], 'claude');
  assert.equal(r.verified, false);
  assert.match(r.modelWarning, /MODEL MISMATCH/);
});

test('with no model chosen there is nothing to compare against; what ran is recorded anyway', () => {
  const r = worker.modelCheck(null, ['claude-sonnet-4-5'], 'claude');
  assert.equal(r.verified, null);
  assert.deepEqual(r.observedModels, ['claude-sonnet-4-5']);
});

/* The parser itself: are the `modelUsage` keys really read.
   The body was taken from the output of a real run. */
test('parseClaude reads the modelUsage keys from a real output', () => {
  const raw = JSON.stringify({
    type: 'result', subtype: 'success', result: 'DONE',
    usage: { input_tokens: 10, output_tokens: 63 },
    modelUsage: {
      'claude-haiku-4-5-20251001': { inputTokens: 10, canonicalModel: 'claude-haiku-4-5' },
    },
  });
  const c = worker.parseClaude(raw);
  assert.deepEqual(c.observedModels, ['claude-haiku-4-5']);
});
