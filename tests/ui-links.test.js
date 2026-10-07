'use strict';
/* Check that referenced DOM IDs, data roles, and highlight classes match the actual HTML, renderer, and CSS. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = path.join(__dirname, '..', 'panel');
const html = fs.readFileSync(path.join(P, 'index.html'), 'utf8');
const page = fs.readFileSync(path.join(P, 'panel.js'), 'utf8');
const css = html + ['theme-base.css', 'theme-blue.css', 'theme-pink.css', 'theme-purple.css', 'theme-raycast.css']
  .map((f) => fs.readFileSync(path.join(P, f), 'utf8')).join('\n');

test('every element another element names by id exists', () => {
  const ids = new Set([...(html + page).matchAll(/id=\\?["']([A-Za-z][\w-]*)/g), ...page.matchAll(/setupField\('([^']+)'/g)].map((m) => m[1]));
  const broken = [...(html + page).matchAll(/(aria-labelledby|aria-describedby|aria-controls|\bfor)=\\?["']([^"'\\]+)/g)]
    .flatMap((m) => m[2].split(/\s+/).filter((id) => !ids.has(id)).map((id) => m[1] + ' -> ' + id));
  assert.deepEqual(broken, []);
});

test('every data-role in the page is one the code looks for', () => {
  const roles = [...html.matchAll(/data-role="([^"]+)"/g)].map((m) => m[1]);
  const unused = roles.filter((r) => !page.includes("sg('" + r + "')") && !page.includes('data-role="' + r + '"') && !page.includes("'" + r + "'"));
  assert.deepEqual(unused, []);
});

test('every class the code switches on has a style', () => {
  const switched = new Set([...page.matchAll(/classList\.(?:add|toggle)\(\s*'([\w-]+)'/g)].map((m) => m[1]));
  const styled = new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));
  assert.deepEqual([...switched].filter((c) => !styled.has(c)), []);
});

test('the search highlight is visible: it changes the outline or the shadow', () => {
  const rule = (css.match(/\.search-highlight\s*\{[^}]*\}/) || [''])[0];
  assert.match(rule, /outline|box-shadow/, rule || 'no rule');
});

test('a sentence is not styled as a path (a path may break anywhere, a sentence must not)', () => {
  const at = page.indexOf('builtinSkills.claudeNote;');
  const block = page.slice(at - 200, at);
  assert.doesNotMatch(block, /className = 'path'/);
});
