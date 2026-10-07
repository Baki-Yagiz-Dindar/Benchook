'use strict';
// The same folder does not appear twice in the project list (seen in a real window).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../panel/panel.js'), 'utf8');

function load(platform) {
  const ctx = vm.createContext({ navigator: { platform } });
  const press = source.indexOf('function projectPathNormalize(filePath)');
  const last = source.indexOf('\nasync function projectChangeInner', press);
  vm.runInContext(source.slice(press, last), ctx);
  return ctx;
}

test('Windows: a slash becomes a backslash, a trailing separator drops, and letter case is the same project', () => {
  const c = load('Win32');
  assert.equal(c.projectPathNormalize('C:/Users/example/x/Sample Project/'), 'C:\\Users\\example\\x\\Sample Project');
  assert.equal(c.projectPathNormalize('C:\\Users\\\\example\\x'), 'C:\\Users\\example\\x');
  assert.equal(c.projectPathNormalize('C:\\'), 'C:\\', 'a drive root is not mangled');
  // `sameProject` is a const: it does not become a global property in the vm context, so it is run as an expression.
  const same = (a, b) => vm.runInContext('sameProject(' + JSON.stringify(a) + ',' + JSON.stringify(b) + ')', c);
  assert.equal(same('C:/users/example/x/Sample Project', 'C:\\Users\\example\\x\\SAMPLE PROJECT\\'), true);
  assert.equal(same('C:\\a', 'C:\\b'), false);
});

test('on another platform the separator does not change; only the trailing one drops', () => {
  const c = load('Linux x86_64');
  assert.equal(c.projectPathNormalize('/home/u/project/'), '/home/u/project');
  assert.equal(c.projectPathNormalize('/home/u/p\\q'), '/home/u/p\\q');
});
