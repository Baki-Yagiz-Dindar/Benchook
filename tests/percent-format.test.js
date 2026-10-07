'use strict';
/* Percentages are written in English order, number first ("47%"). The account row showed the quota
   as "%47" (the Turkish order) while every other percentage on the same screen read "19%". This
   guards the whole page source against building a percentage with the sign in front. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('no percentage is built with the sign before the number', () => {
  for (const file of ['panel.js', 'index.html']) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'panel', file), 'utf8');
    const lines = text.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /['"`]%['"`]\s*\+/.test(l));
    assert.deepEqual(lines, [], file + ' builds "%" + number');
  }
});
