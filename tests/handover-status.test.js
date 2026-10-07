'use strict';

// Summary of the handover record shown when the provider changes.
// It came from the question whether the panel does anything to keep the handover record current - the
// answer then was no. The panel now DOES NOT DECIDE, it only shows two dates; these tests check that
// this display does not lie.

const test = require('node:test');
const assert = require('node:assert/strict');
const { digest } = require('../panel/handover-status');

const NOW = Date.parse('2026-09-05T12:00:00.000Z');
const minutes = (n) => NOW - n * 60000;

test('a record OLDER than the session is reported as stale with a warning', () => {
  const r = digest(minutes(90), minutes(30), NOW);      // record 90 minutes ago, session 30 minutes ago
  assert.equal(r.stale, true);
  assert.ok(r.lines.some((s) => s.includes('predate')), 'the warning line is missing');
});

test('a record NEWER than the session is not stale', () => {
  const r = digest(minutes(10), minutes(60), NOW);
  assert.equal(r.stale, false);
  assert.ok(!r.lines.some((s) => s.includes('predate')));
});

test('if the handover record cannot be read it does NOT guess - stale stays null', () => {
  const r = digest(null, minutes(30), NOW);
  assert.equal(r.stale, null, 'it produced a verdict about something it does not know');
  assert.ok(r.lines.some((s) => s.includes('Cannot determine')));
  assert.ok(r.lines.some((s) => s.includes('unavailable')));
});

test('it does not guess when the session start cannot be read either', () => {
  const r = digest(minutes(10), null, NOW);
  assert.equal(r.stale, null);
  assert.ok(r.lines.some((s) => s.includes('Cannot determine')));
});

test('when neither can be read it still produces no verdict', () => {
  assert.equal(digest(null, null, NOW).stale, null);
});

test('both timestamps are written with their clock time and how long ago they were', () => {
  const text = digest(minutes(10), minutes(75), NOW).lines.join('\n');
  assert.match(text, /Handoff notes last updated: \d\d:\d\d \(10 minutes ago\)/);
  assert.match(text, /Session started: \d\d:\d\d \(1 h 15 minutes ago\)/);
});

test('a record less than a minute old reads "just now" and never writes negative minutes', () => {
  const text = digest(NOW - 5000, minutes(30), NOW).lines.join('\n');
  assert.ok(text.includes('Just now'), text);
  assert.doesNotMatch(text, /-\d/);
});

/* THE HANDOFF-NOTES FILE IS A SETTING, AND IT STAYS INSIDE THE PROJECT.
   Each project can name its own notes file; nothing outside the project folder is ever read. */
const { notePath } = require('../panel/handover-status');
const path = require('node:path');
const PROJECT = path.resolve('/work/demo');

test('with no setting the notes are looked for at docs/HANDOVER.md', () => {
  assert.equal(notePath(PROJECT, ''), path.join(PROJECT, 'docs', 'HANDOVER.md'));
  assert.equal(notePath(PROJECT, undefined), path.join(PROJECT, 'docs', 'HANDOVER.md'));
});

test('a relative path chosen by the user is used inside the project', () => {
  assert.equal(notePath(PROJECT, 'notes/handoff.md'), path.join(PROJECT, 'notes', 'handoff.md'));
});

test('an absolute path or one that leaves the project is refused', () => {
  assert.equal(notePath(PROJECT, '../elsewhere.md'), null);
  assert.equal(notePath(PROJECT, 'docs/../../elsewhere.md'), null);
  assert.equal(notePath(PROJECT, path.resolve('/etc/passwd')), null);
  assert.equal(notePath(PROJECT, 'C:/Windows/win.ini'), null);
});

test('without a project there is no file to read', () => {
  assert.equal(notePath(null, 'docs/HANDOVER.md'), null);
});
