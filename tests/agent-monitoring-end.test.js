'use strict';
// EARLY COMPLETION AND A FROZEN CACHE IN MONITORING.
// 
// THE MEASURED DEFECT had two parts:
// 1. With no notification SHAPE at all in the main session record, the fallback marker was used, and
// "the last record carries only text" made the agent count as finished. An intermediate text in the
// MIDDLE of a run fits that shape too (measured: it happened in two of six agents).
// 2. The record of an agent once called finished was NEVER READ AGAIN. So one wrong finished made all
// later activity of that agent permanently invisible.
// 
// THE DISTINCTION: a CERTAIN end (the notification in the main record), an ESTIMATED end (the fallback
// marker) and UNKNOWN must not be confused. An estimate is not sticky: it is reassessed when the record
// grows. A journal going quiet is neither a success nor a failure.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const watch = require('../panel/agent-runs');

function field(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-end-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = path.join(root, 'session.jsonl');
  const folder = path.join(root, 'session', 'subagents');
  fs.mkdirSync(folder, { recursive: true });
  return { root, session, folder };
}

const line = (o) => JSON.stringify(o) + '\n';
const textRecord = (text, time = '2026-09-11T10:00:00Z') =>
  line({ type: 'assistant', timestamp: time, message: { content: [{ type: 'text', text: text }] } });
const toolRecord = (name, target, time = '2026-09-11T10:00:05Z') =>
  line({ type: 'assistant', timestamp: time,
    message: { content: [{ type: 'tool_use', name: name, input: { file_path: target } }] } });

/** Sets up an agent record; `id` is the toolUseId that matches the notification in the main record. */
function agent(folder, name, id, content) {
  fs.writeFileSync(path.join(folder, name + '.meta.json'),
    JSON.stringify({ agentType: 'auditor', description: 'Review', toolUseId: id }));
  fs.writeFileSync(path.join(folder, name + '.jsonl'), content);
  return path.join(folder, name + '.jsonl');
}

/** The main record: the two states, with and without the notification shape. */
const notified = (id) => line({ type: 'user',
  message: '<tool-use-id>' + id + '</tool-use-id> <status>completed</status>' });
const silent = () => line({ type: 'user', message: 'Start the review' });

/* ---- AN INTERMEDIATE TEXT DOES NOT PRODUCE A PERMANENT FINISHED ---- */

test("activity that arrives after the search text is VISIBLE", (t) => {
  const { session, folder } = field(t);
  fs.writeFileSync(session, silent());
  const filePath = agent(folder, 'agent-one', 'toolu_one', textRecord('I will inspect the files now.'));

  const first = watch.list(session)[0];
  assert.equal(first.status, 'done', 'the fallback signal still works');
  assert.equal(first.endSource, 'estimated', 'but it must be written down that this is an ESTIMATE');

  fs.appendFileSync(filePath, toolRecord('Read', 'example.js'));
  const second = watch.list(session)[0];

  assert.equal(second.status, 'running', 'an estimated end must not be sticky');
  assert.equal(second.step, 1, 'activity appended later must be read');
  assert.equal(second.endSource, null);
});

test("a certain end marker is not confused with an estimate", (t) => {
  const { session, folder } = field(t);
  fs.writeFileSync(session, notified('toolu_one'));
  agent(folder, 'agent-one', 'toolu_one', textRecord('Done.'));

  const a = watch.list(session)[0];
  assert.equal(a.status, 'done');
  assert.equal(a.endSource, 'certain', 'the notification in the main record is not an estimate');
});

test("a record that keeps growing AFTER a certain end is read too", (t) => {
  const { session, folder } = field(t);
  fs.writeFileSync(session, notified('toolu_one'));
  const filePath = agent(folder, 'agent-one', 'toolu_one', textRecord('Done.'));
  assert.equal(watch.list(session)[0].step, 0);

  // A resumed task: the same agent starts writing again.
  fs.appendFileSync(filePath, toolRecord('Grep', 'src'));
  const a = watch.list(session)[0];

  assert.equal(a.step, 1, 'the record of an agent believed finished must not be frozen');
});

/* ---- SILENCE IS NEITHER SUCCESS NOR FAILURE ---- */

test("a record that ends on a tool call and stops growing does not count as finished", (t) => {
  const { session, folder } = field(t);
  fs.writeFileSync(session, silent());
  agent(folder, 'agent-one', 'toolu_one', textRecord('Working.') + toolRecord('Read', 'a.js'));

  const a = watch.list(session)[0];
  assert.equal(a.status, 'running');
  assert.equal(a.endSource, null, 'going quiet is not finishing');
});

test("a session with no readable end marker is reported as UNKNOWN", (t) => {
  const { session, folder } = field(t);
  fs.writeFileSync(session, silent());
  agent(folder, 'agent-one', 'toolu_one', textRecord('Done.'));

  const a = watch.list(session, false)[0];
  assert.equal(a.status, 'unknown', 'what was not measured is called neither running nor done');
  assert.equal(a.endSource, null);
});

/* ---- IF THE SHAPE APPEARS LATER IT IS REASSESSED ---- */

test("when the notification arrives later the estimate turns CERTAIN", (t) => {
  const { session, folder } = field(t);
  fs.writeFileSync(session, silent());
  agent(folder, 'agent-one', 'toolu_one', textRecord('Done.'));
  assert.equal(watch.list(session)[0].endSource, 'estimated');

  fs.appendFileSync(session, notified('toolu_one'));
  assert.equal(watch.list(session)[0].endSource, 'certain');
});

test("a notification belonging to ANOTHER agent does not finish this one", (t) => {
  const { session, folder } = field(t);
  fs.writeFileSync(session, silent());
  agent(folder, 'agent-one', 'toolu_one', textRecord('Done.'));
  assert.equal(watch.list(session)[0].status, 'done', 'fallback signal: estimated');

  // The real marker can be read now, and there is no notification for THIS agent.
  fs.appendFileSync(session, notified('toolu_other'));
  const a = watch.list(session)[0];

  assert.equal(a.status, 'running', 'while a real signal exists the estimate does not hold');
  assert.equal(a.endSource, null);
});

/* ---- A FINISHED RUN OF A CLOSED SESSION IS FINISHED IN THE HISTORY ---- */

test('project history: the end marker in the main record of a session that is no longer active is read too', (t) => {
  // Measured in a real run: a native run showing Completed in the open pane turned Unknown once the
  // session was closed and the history window opened; only the main record of the active session was scanned.
  const { root, session, folder } = field(t);
  fs.writeFileSync(session, notified('toolu_one'));
  agent(folder, 'agent-one', 'toolu_one', textRecord('Done.'));

  const list = watch.projectRuns(root, path.join(root, 'other-session.jsonl'));
  const a = list.find((x) => x.session === 'session');
  assert.ok(a, 'the run of a closed session must appear in the history');
  assert.equal(a.enabled, false);
  assert.equal(a.status, 'done', 'a certain end in the main record holds for a closed session as well');
  assert.equal(a.endSource, 'certain');
});

test('project history: with no end marker at all, neither unknown nor running is invented', (t) => {
  const { root, session, folder } = field(t);
  fs.writeFileSync(session, silent());
  agent(folder, 'agent-one', 'toolu_one', textRecord('Done.'));
  const a = watch.projectRuns(root, null).find((x) => x.session === 'session');
  assert.notEqual(a.endSource, 'certain', 'with no marker a certain end is not invented');
});

/* ---- CACHE: AN UNCHANGED FILE IS NOT READ AGAIN ---- */

test("an unchanged record is not parsed again", (t) => {
  const { session, folder } = field(t);
  fs.writeFileSync(session, silent());
  const filePath = agent(folder, 'agent-one', 'toolu_one', toolRecord('Read', 'aaaaa.js'));
  /* The file must have settled: its mtime outside the margin of the system tick. A file written a moment
     ago is DELIBERATELY read again on the next scan (TICK_MARGIN_MS in agent-runs.js); the cache is only
     expected to hold once that margin has passed. Rather than wait, the clock is set back. */
  const oldTime = new Date(Date.now() - 1000);
  fs.utimesSync(filePath, oldTime, oldTime);

  /* MEASUREMENT: every parse produces NEW arrays. If the file is not touched at all between two
     refreshes the returned array must be the SAME object; if not, the file was read again.
     The point of the card: change tracking that never needs a full file read forever. */
  const one = watch.list(session)[0];
  const two = watch.list(session)[0];

  assert.equal(one.step, 1);
  assert.equal(two.targets, one.targets,
    'the cache must hold for an unchanged file - no full read on every refresh');
});

test("if the content CHANGES at the same size it is read again", (t) => {
  const { session, folder } = field(t);
  fs.writeFileSync(session, silent());
  const filePath = agent(folder, 'agent-one', 'toolu_one', toolRecord('Read', 'aaaaa.js'));
  watch.list(session);

  // This time the timestamp is left alone: there is a trace of change.
  fs.writeFileSync(filePath, toolRecord('Read', 'bbbbb.js'));
  const a = watch.list(session)[0];

  assert.equal(a.targets[0].target, 'bbbbb.js', 'with a trace of change it must be read again');
});

/* ---- THE SCREEN END: AN ESTIMATE IS NOT SHOWN AS CERTAIN ---- */

const vm = require('node:vm');
const page = fs.readFileSync(path.join(__dirname, '..', 'panel', 'panel.js'), 'utf8');
const slice = page.slice(page.indexOf('function runStatusWord('),
  page.indexOf('function renderHistory('));
const box = vm.createContext({});
vm.runInContext(slice, box);
const runStatusWord = vm.runInContext('runStatusWord', box);

test("an estimated end is not shown on screen as a certain one", () => {
  assert.equal(runStatusWord('done', 'certain'), "Completed");
  assert.notEqual(runStatusWord('done', 'estimated'), "Completed");
  assert.match(runStatusWord('done', 'estimated'), /probable/i);
});

test("the other states are preserved", () => {
  assert.equal(runStatusWord('running', null), "Running");
  assert.equal(runStatusWord('error', null), "Failed");
  assert.equal(runStatusWord('unknown', null), "Unknown",
    'an unmeasured status is not shown as "running"');
});
