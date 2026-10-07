'use strict';
/* "(resumed)" only on a pane that really was resumed.
 *
 * What it protects against: a Claude terminal opened from scratch showed "Local Claude · haiku (resumed)".
 * The page derived the label from the presence of `b.sessionId`; a clean Claude start also creates an
 * identity for `--session-id`. The main process now states the truth in the `resumeDid` field; the page
 * builds the label only from that.
 *
 * main.js needs Electron and is not loaded here; its share is read from the source: resumeDid is set
 * EVERYWHERE a resume argument is added, nowhere else, and is carried back in the reply. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'panel', 'panel.js'), 'utf8');
// Line endings depend on the checkout (Git on Windows writes CRLF); the rules below are about the code.
const main = fs.readFileSync(path.join(__dirname, '..', 'panel', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const box = vm.createContext({});
vm.runInContext(page.slice(page.indexOf('const paneLabel ='), page.indexOf('function createPane(')), box);
const paneLabel = vm.runInContext('paneLabel', box);

test("the label is built from the resume flag, not from the identity", () => {
  assert.equal(paneLabel('Local Claude · haiku', false), 'Local Claude · haiku');
  assert.equal(paneLabel('Local Claude · haiku', true), 'Local Claude · haiku (resumed)');
  assert.doesNotMatch(page, /b\.sessionId \? b\.label \+ ' \(resumed\)'/, 'the old sessionId-based label must be gone');
  assert.doesNotMatch(page, /if \(b\.sessionId\) b\.name\.textContent = b\.label \+ ' \(resumed\)'/);
  assert.match(page, /b\.resumeDid = !!r\.resumeDid;/);
});

test("the main process sets the resumeDid mark only together with a resume argument", () => {
  const body = main.slice(main.indexOf("ipc.handle('terminal:open'"), main.indexOf('return { id, sessionId: sessionId || null'));
  const markers = body.match(/resumeDid = true/g) || [];
  const resumes = body.match(/args\.push\('(?:--)?resume', sessionId\)/g) || [];
  assert.equal(resumes.length, 2, 'one resume path each for Claude and Codex');
  assert.equal(markers.length, resumes.length, 'every resume path is marked and nothing beyond that');
  for (const m of body.matchAll(/args\.push\('(?:--)?resume', sessionId\);([^\n]*)/g)) {
    assert.match(m[1], /resumeDid = true/, 'the mark sits on the same line as the resume');
  }
  assert.match(body, /--session-id', sessionId\); \}\n/, 'a clean start path sets no mark');
  assert.match(main, /return \{ id, sessionId: sessionId \|\| null, connection, resumeWarning, resumeDid \}/);
});
