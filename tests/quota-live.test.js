'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const quota = require('../panel/quota-codex');
const cli = require('../panel/cli-path');
test('the live quota protocol starts a real process and only reads', async t => {
  t.mock.method(cli, 'cliInvocation', () => ({ command: process.execPath, leadingArgs: [path.join(__dirname, 'fixtures/quota-server.cjs')] }));
  const r = await quota.query({ provider: 'codex', folder: __dirname });
  assert.ok(!r.error, r.error); assert.equal(r.quota.short.percent, 37); assert.equal(r.quota.long, null);
});
test('the limit of another product is not shown as the Codex quota', () => {
  assert.throws(() => quota.parse({ rateLimitsByLimitId: { other: { primary: { usedPercent: 0 } } } }), /Codex/);
  assert.throws(() => quota.parse({ rateLimits: { primary: { usedPercent: null } } }), /unavailable/i);
});
