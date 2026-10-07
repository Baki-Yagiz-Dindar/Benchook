'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ik = require('../panel/onboarding');

// Literal provider spelling from the incident, independent of the normalizer under test.
const canonical = String.raw`c:\users\example\desktop\dotted İ Ş`;
const legacy = 'c:\\users\\example\\desktop\\dotted i\u0307 ş';
const section = (key, value) => `[projects.'${key}']\ntrust_level = "${value}"\n`;

test('Codex Windows project key lowers ASCII without changing Unicode letters', { skip: process.platform !== 'win32' }, () => {
  assert.equal(ik.codexProjectKey(String.raw`C:\Users\example\Desktop\Dotted İ Ş`), canonical);
  assert.equal(ik.codexProjectKey(String.raw`C:\Work\ÉΣİ`), String.raw`c:\work\ÉΣİ`);
});

test('old Unicode-lowered sibling does not conflict with the provider project key', () => {
  for (const oldValue of ['trusted', 'untrusted']) {
    for (const value of ['trusted', 'untrusted']) {
      const text = section(legacy, oldValue) + section(canonical, value);
      assert.deepEqual(ik.codexTrustStatus(text, canonical), {
        status: value === 'trusted' ? 'safe' : 'other', value: value,
      });
      assert.equal(ik.addCodexTrust(text, canonical), text, 'no existing decision or unrelated bytes changed');
    }
  }
});

test('legacy-only trust is not inherited by a distinct Unicode path', () => {
  const text = section(legacy, 'trusted');
  assert.deepEqual(ik.codexTrustStatus(text, canonical), { status: 'none', value: null });
  const written = ik.addCodexTrust(text, canonical);
  assert.ok(written.startsWith(text));
  assert.ok(written.includes(section(canonical, 'trusted')));
});

test('trust insertion targets the correct Unicode table, preserves legacy and other settings', () => {
  const text = section(legacy, 'untrusted') + `[projects.'${canonical}']\n# keep comment\nother = true\n`;
  const written = ik.addCodexTrust(text, canonical);
  assert.ok(written.startsWith(section(legacy, 'untrusted')));
  assert.ok(written.includes(`[projects.'${canonical}']\ntrust_level = "trusted"\n# keep comment\nother = true`));
});

test('actual ASCII case aliases with conflicting decisions still refuse to guess', () => {
  const text = section(canonical, 'trusted') + section(String.raw`C:\USERS\EXAMPLE\DESKTOP\DOTTED İ Ş`, 'untrusted');
  assert.throws(() => ik.codexTrustStatus(text, canonical), /Conflicting Codex project paths/);
  assert.throws(() => ik.addCodexTrust(text, canonical), /Conflicting Codex project paths/);
});

test('disk plan and consent path preserve existing duplicate-looking Unicode records', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchook-unicode-trust-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'Dotted İ Ş');
  fs.mkdirSync(project);
  // Only the temporary ASCII prefix is derived; the distinguishing suffix is literal.
  const prefix = root.replace(/[A-Z]/g, c => c.toLowerCase());
  const key = path.join(prefix, 'dotted İ Ş');
  const oldKey = path.join(prefix, 'dotted i̇ ş');
  const file = path.join(root, 'config.toml');
  const text = section(oldKey, 'trusted') + section(key, 'untrusted');
  fs.writeFileSync(file, text);
  const result = ik.plan({ provider: 'codex' }, root, project);
  assert.equal(result.trust.otherDecision, 'untrusted');
  assert.deepEqual(result.items, []);
  ik.apply({ provider: 'codex' }, root, project, { trust: true });
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  fs.writeFileSync(file, section(oldKey, 'trusted'));
  assert.equal(ik.plan({ provider: 'codex' }, root, project).trust.required, true);
  ik.apply({ provider: 'codex' }, root, project, {});
  assert.equal(fs.readFileSync(file, 'utf8'), section(oldKey, 'trusted'));
  ik.apply({ provider: 'codex' }, root, project, { trust: true });
  assert.equal(ik.plan({ provider: 'codex' }, root, project).trust.required, false);
  assert.ok(fs.readFileSync(file, 'utf8').includes(section(key, 'trusted')));
});
