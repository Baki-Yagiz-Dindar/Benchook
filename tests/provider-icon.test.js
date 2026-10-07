'use strict';
/* The provider icon must carry the class the stylesheet sizes and colours. A bulk rename had turned
   the class into `agentIcon` while every rule in index.html still targets `.agent-icon`, so the icons
   on agent cards and account rows were drawn with no size and no provider colour. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'panel', 'panel.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'panel', 'index.html'), 'utf8');
const start = page.indexOf('function providerIcon(');
const box = vm.createContext({
  document: { createElementNS: () => ({ attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, appendChild() {} }) },
});
vm.runInContext(page.slice(start, page.indexOf('\nfunction ', start + 1)), box);
const providerIcon = vm.runInContext('providerIcon', box);

test('the provider icon uses the class the stylesheet sizes and colours', () => {
  for (const provider of ['claude', 'codex']) {
    const [base, kind] = providerIcon(provider).attributes.class.split(' ');
    assert.equal(kind, provider);
    assert.ok(html.includes('.agent-card .' + base + '{'), 'no card rule sizes .' + base);
    assert.ok(html.includes('.account-row .avatar .' + base + '{'), 'no account-row rule sizes .' + base);
    assert.ok(html.includes('.agent-card .' + base + '.' + provider + '{'), 'no colour rule for .' + base + '.' + provider);
  }
});
