'use strict';
/* — the model Codex is running. Measured in a real run:
 * `codex exec --json` output does not give the model name; the `payload.model` field of the `turn_context`
 * records in the run's rollout file does (`gpt-6-astra`). The key is `thread.started.thread_id`. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const worker = require('../panel/worker');

function home(t, id, lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf026-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const d = path.join(root, 'sessions', '2026', '09', '12');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'rollout-2026-09-12T00-23-41-' + id + '.jsonl'), lines.map((x) => JSON.stringify(x)).join('\n') + '\n');
  return root;
}
const ID = '01a0925a-d568-7e40-b1f1-6d0a61f90385';

test("thread_id is read from the output and the model from the turn_context record in the rollout file", (t) => {
  const root = home(t, ID, [
    { type: 'session_meta', payload: { id: ID, model_provider: 'openai' } },
    { type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-6-astra' } },
    { type: 'response_item', payload: { type: 'message' } },
    { type: 'turn_context', payload: { turn_id: 't2', model: 'gpt-6-astra' } },
  ]);
  const c = worker.parseCodex(JSON.stringify({ type: 'thread.started', thread_id: ID }) + '\n'
    + JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } }) + '\n');
  assert.equal(c.sessionIdFromFile, ID);
  assert.deepEqual(worker.codexRunningModels(root, c.sessionIdFromFile), ['gpt-6-astra']);
  assert.equal(worker.modelCheck('gpt-6-astra', ['gpt-6-astra'], 'codex').verified, true);
  assert.equal(worker.modelCheck('gpt-5', ['gpt-6-astra'], 'codex').verified, false);
});

test("with no file or no id the model list stays EMPTY; nothing is invented", (t) => {
  const root = home(t, 'other-id', [{ type: 'turn_context', payload: { model: 'gpt-6-astra' } }]);
  assert.deepEqual(worker.codexRunningModels(root, ID), []);
  assert.deepEqual(worker.codexRunningModels(root, null), []);
  assert.deepEqual(worker.codexRunningModels(path.join(root, 'none'), ID), []);
  assert.equal(worker.modelCheck('gpt-6-astra', [], 'codex').verified, null, 'a model that could not be found is never marked verified');
});

test("a real rollout carries the project folder (cwd) and is still found when the caller does not know the project", (t) => {
  /* Measured 6 October 2026: every Codex rollout on the development machine (50 of 50) has
   * `session_meta.payload.cwd`. With the project unknown, the cwd check refused every one of them,
   * so the running model was never verified and workers never bound to a Codex pane. */
  const root = home(t, ID, [
    { type: 'session_meta', payload: { id: ID, cwd: path.join(os.tmpdir(), 'some-project') } },
    { type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-6-astra' } },
  ]);
  assert.deepEqual(worker.codexRunningModels(root, ID), ['gpt-6-astra']);
  const sessions = require('../panel/sessions');
  assert.ok(sessions.findSessionFile('codex', path.join(os.tmpdir(), 'some-project'), ID, root), 'the right project still matches');
  assert.equal(sessions.findSessionFile('codex', path.join(os.tmpdir(), 'another-project'), ID, root), null, 'another project still does not');
});
