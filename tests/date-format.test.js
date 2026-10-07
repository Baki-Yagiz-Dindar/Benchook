'use strict';
/* Every date and time on screen is written the same way, whatever the computer's language. The run
   list wrote its start time with `toLocaleString` and no language, so a Turkish Windows showed
   "23.09.2026 18:59:12" beside "09/23, 06:59 PM" elsewhere (first real-use trial, 23 September). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'panel', 'panel.js'), 'utf8');

test('every date and time names its language', () => {
  const lines = page.split('\n').map((l, i) => [i + 1, l])
    .filter(([, l]) => /\.toLocale(Date|Time)?String\((?!["']en-US["'])/.test(l));
  assert.deepEqual(lines, []);
});

test('the usage line and the run list write a moment the same way', () => {
  const start = page.indexOf('function dateAndTime(');
  assert.ok(start >= 0, 'panel.js has no dateAndTime helper');
  const box = vm.createContext({});
  vm.runInContext(page.slice(start, page.indexOf('\n}', start) + 2), box);
  const dateAndTime = vm.runInContext('dateAndTime', box);
  const moment = new Date(2026, 8, 23, 18, 59, 12);
  assert.equal(dateAndTime(moment), moment.toLocaleString('en-US',
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
  assert.equal(page.split('dateAndTime(').length - 1, 3, 'the helper and its two callers');
});
