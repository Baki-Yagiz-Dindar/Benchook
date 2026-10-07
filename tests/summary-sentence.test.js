'use strict';
/* The top strip and the live card must not say more than they know.
 *
 * What it protects against: with status `done` and end source `estimated`, the card said "Completed" and
 * the strip "All completed". In the same turn, with only an MCP worker run, the card showed a
 * result while the strip said "No agent activity yet". */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'panel', 'panel.js'), 'utf8');
const box = vm.createContext({});
const countStart = page.indexOf('function countOf(');
vm.runInContext(page.slice(countStart, page.indexOf('\n}', countStart) + 2), box);
vm.runInContext(page.slice(page.indexOf('function summarySentence('), page.indexOf('function writeSummary(')), box);
vm.runInContext(page.slice(page.indexOf('function runStatusWord('), page.indexOf('function renderHistory(')), box);
const summarySentence = vm.runInContext('summarySentence', box);
const runStatusWord = vm.runInContext('runStatusWord', box);

test("a run whose completion is only estimated does not become a definite \"All completed\" in the strip", () => {
  const certain = summarySentence([{ status: 'done', endSource: 'certain' }]);
  const estimate = summarySentence([{ status: 'done', endSource: 'estimated' }]);
  assert.equal(certain, '1 agent run · All completed');
  assert.notEqual(estimate, certain);
  assert.match(estimate, /probable/i);
});

test("the running and failed counts come before the estimate", () => {
  assert.match(summarySentence([{ status: 'running' }, { status: 'done', endSource: 'estimated' }]), /1 running/);
  assert.match(summarySentence([{ status: 'error' }, { status: 'done', endSource: 'estimated' }]), /1 failed/);
});

test("a run with an unknown state is not summarised as completed", () => {
  const digest = summarySentence([{ status: 'done' }, { status: 'unknown' }]);
  assert.match(digest, /1 with unknown status/);
  assert.doesNotMatch(digest, /All completed/);
});

test("the live card uses the same word for an estimated end as the detail view", () => {
  assert.match(runStatusWord('done', 'estimated'), /probable/i);
  // The card no longer carries its own "Completed" constant; it calls the same function.
  assert.match(page, /setupText\(k\.status, running \? 'Running' : runStatusWord\(a\.status, a\.endSource\)\)/);
  assert.doesNotMatch(page, /a\.status === 'error' \? 'Failed' : 'Completed'/);
});

test("a no-record flag cannot silence the strip while the list is full", () => {
  // writeSummary touches the DOM; the decision order is read from the source: list length BEFORE c.none.
  const body = page.slice(page.indexOf('function writeSummary('), page.indexOf('agentSummaryText = m;'));
  const listOrder = body.indexOf('list.length');
  const recordOrder = body.indexOf("c.none === 'record'");
  assert.ok(listOrder > 0 && recordOrder > 0);
  assert.ok(listOrder < recordOrder, 'a filled list must be handled before the no-record branch');
  assert.match(body, /m = summarySentence\(list\)/);
});
