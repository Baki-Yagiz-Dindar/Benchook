'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../panel/panel.js'), 'utf8');
const functions = source.slice(source.indexOf('function hourShort('), source.indexOf('function setupRing('));
const context = vm.createContext({});
vm.runInContext(functions, context);
test('Codex Unix seconds and Claude ISO reset times display the same future time', () => {
  const seconds = Math.floor(Date.now() / 1000) + 7200;
  const numeric = context.writeReset(seconds);
  assert.match(numeric, /remaining/);
  assert.equal(numeric, context.writeReset(new Date(seconds * 1000).toISOString()));
});
test('past reset remains elapsed; missing and malformed reset remain unavailable', () => {
  assert.match(context.writeReset(Math.floor(Date.now() / 1000) - 3600), /elapsed/);
  assert.equal(context.writeReset(null), null);
  assert.equal(context.writeReset('invalid'), null);
});
