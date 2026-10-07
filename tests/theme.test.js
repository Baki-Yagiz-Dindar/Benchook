'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const theme = require('../panel/theme');
const { layoutValid } = require('../panel/layout-shape');

function fakeDocument() {
  const links = ['pink', 'purple', 'blue', 'classic'].map((id) => ({
    dataset: { panelTheme: id }, disabled: false,
  }));
  return {
    links,
    documentElement: { dataset: {} },
    querySelectorAll: () => links,
  };
}

test('an unknown theme falls back to a safe default', () => {
  assert.equal(theme.valid('missing'), 'pink');
  assert.equal(theme.valid(null), 'pink');
});

test('only the link of the selected theme stays enabled', () => {
  const document = fakeDocument();
  assert.equal(theme.apply(document, 'blue'), 'blue');
  assert.deepEqual(document.links.map((x) => x.disabled), [true, true, false, true]);
  assert.equal(document.documentElement.dataset.theme, 'blue');
});

test('an unknown theme does not invalidate the project layout', () => {
  assert.equal(layoutValid({ projects: [], theme: 'pink' }), true);
  assert.equal(layoutValid({ projects: [], theme: 'future-version-theme' }), true);
  assert.equal(layoutValid({ projects: [], theme: 42 }), false);
});
