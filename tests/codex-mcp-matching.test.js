'use strict';
// A worker run called by the Codex orchestrator is attached to its pane.
// Measured: Codex passes no environment to the MCP server; the record arrived without a parent and no card appeared.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { mcpCalls, match } = require('../panel/codex-mcp-matching');

const line = (o) => JSON.stringify(o) + '\n';
const calls = (agent, task, startedAt, done) => line({ timestamp: new Date(startedAt).toISOString(), type: 'event_msg',
  payload: { type: 'item_completed', thread_id: 't1', item: { type: 'McpToolCall', server: 'benchook', tool: 'run_agent',
    arguments: { agent, task }, status: 'completed' }, started_at_ms: startedAt, completed_at_ms: done } });
const T = Date.parse('2026-09-12T18:22:26.892Z');   // started_at_ms from a real run

test('rollout: only benchook/run_agent McpToolCall lines are read; a corrupt line is skipped', () => {
  const text = calls('scout', 'say OK', T, T + 18639)
    + line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'other', tool: 'run_agent', arguments: { agent: 'x' } }, started_at_ms: T, completed_at_ms: T } })
    + 'corrupt { line\n'
    + line({ type: 'response_item', payload: { type: 'custom_tool_call', input: 'McpToolCall run_agent' } });
  assert.deepEqual(mcpCalls(text), [{ agent: 'scout', task: 'say OK', startedAt: T, done: T + 18639 }]);
});

test('matching: the SINGLE orphan record with the same agent, same task and inside the window is linked', () => {
  const records = [
    { id: 'a', name: 'scout', task: 'say OK', startedAt: '2026-09-12T18:22:36.155Z', parent: null },   // the real record
    { id: 'b', name: 'scout', task: 'say OK', startedAt: '2026-09-12T18:10:00.000Z', parent: null },   // outside the window
    { id: 'c', name: 'scout', task: 'say OK', startedAt: '2026-09-12T18:22:37.000Z', parent: 'pane-1' }, // Claude's, has a parent
    { id: 'd', name: 'other', task: 'say OK', startedAt: '2026-09-12T18:22:37.000Z', parent: null },   // a different agent
  ];
  const c = mcpCalls(calls('scout', 'say OK', T, T + 18639));
  assert.deepEqual([...match(records, c)], ['a']);
});

test('ambiguity does not link: two candidates in one window, or two calls for one record', () => {
  const two = [
    { id: 'a', name: 'scout', task: 'say OK', startedAt: '2026-09-12T18:22:30.000Z', parent: null },
    { id: 'b', name: 'scout', task: 'say OK', startedAt: '2026-09-12T18:22:40.000Z', parent: null },
  ];
  assert.equal(match(two, mcpCalls(calls('scout', 'say OK', T, T + 18639))).size, 0, 'two candidates: neither');
  const one = [two[0]];
  const twoCalls = mcpCalls(calls('scout', 'say OK', T, T + 18639) + calls('scout', 'say OK', T + 1000, T + 20000));
  assert.equal(match(one, twoCalls).size, 0, 'two calls fit one record: no link');
});

test('pane filter: a Codex pane matches on parentThread, a Claude pane on parent', () => {
  const page = fs.readFileSync(path.join(__dirname, '../panel/panel.js'), 'utf8');
  const press = page.indexOf('function paneWorkers(');
  const ctx = vm.createContext({});
  vm.runInContext(page.slice(press, page.indexOf('\nasync function refreshAgent', press)), ctx);
  const all = [
    { id: 'claude', parent: 'pane-1' },
    { id: 'codex', parent: null, parentThread: 'thread-9' },
    { id: 'ownerless', parent: null },
  ];
  const f = ctx.paneWorkers;
  assert.deepEqual(f(all, 'pane-1', null).map((x) => x.id), ['claude']);
  assert.deepEqual(f(all, 'pane-2', 'thread-9').map((x) => x.id), ['codex']);
  assert.equal(f(all, null, null).length, 0, 'an empty id list matches nothing');
  assert.equal(f(all, 'pane-2', 'thread-1').length, 0);
});

test('the name of a Codex sub-agent: role, then the last part of agent_path, then the alias', () => {
  const { codexAgentName } = require('../panel/codex-agents');
  assert.equal(codexAgentName('/root/codex_scout'), 'codex_scout');
  assert.equal(codexAgentName('C:\\x\\agents\\reviewer'), 'reviewer');
  assert.equal(codexAgentName(''), null);
  assert.equal(codexAgentName(null), null);
});

test('across sessions: a record that fits two Codex sessions is not linked; one that fits a single session is', () => {
  const { matchBySession } = require('../panel/codex-mcp-matching');
  const records = [
    { id: 'a', name: 'scout', task: 'say OK', startedAt: '2026-09-12T18:22:36.155Z', parent: null },
    { id: 'b', name: 'other', task: 'x', startedAt: '2026-09-12T18:22:36.155Z', parent: null },
  ];
  const c1 = mcpCalls(calls('scout', 'say OK', T, T + 18639) + calls('other', 'x', T, T + 18639));
  const c2 = mcpCalls(calls('scout', 'say OK', T + 500, T + 19000));   // the other session, same agent and task, overlapping time
  const result = matchBySession(records, new Map([['session-1', c1], ['session-2', c2]]));
  assert.equal(result.get('a'), undefined, 'a record fitting two sessions is not linked');
  assert.equal(result.get('b'), 'session-1', 'a record fitting a single session is linked');
});

test('another session with internally ambiguous calls still prevents assignment', () => {
  const { matchBySession } = require('../panel/codex-mcp-matching');
  const records = [{ id: 'a', name: 'scout', task: 'say OK', startedAt: new Date(T + 2000).toISOString(), parent: null }];
  const a = mcpCalls(calls('scout', 'say OK', T, T + 10000));
  const b = mcpCalls(calls('scout', 'say OK', T, T + 10000) + calls('scout', 'say OK', T + 1000, T + 11000));
  for (const entries of [[['A', a], ['B', b]], [['B', b], ['A', a]]]) {
    assert.equal(matchBySession(records, new Map(entries)).size, 0);
  }
});
