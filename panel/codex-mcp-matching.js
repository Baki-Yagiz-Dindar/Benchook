'use strict';
/* BINDING A WORKER RUN CALLED BY A CODEX ORCHESTRATOR BACK TO ITS PANE.
 *
 * MEASURED: Codex does NOT pass the environment of the terminal to an MCP server. Under Claude the
 * worker record carries `BENCHOOK_SESSION`, which says which pane called it; under Codex the record
 * arrives with `parent: null` and no card ever appears under the pane.
 *
 * METHOD: Codex writes every MCP call into its own conversation record (the rollout). The single
 * parentless record with the same agent, the same task text and a start inside the time window of
 * the call is bound to that pane. If there are two candidates, neither is bound: a card is never
 * placed on the wrong pane.
 *
 * LIMIT: Codex writes this event when the call FINISHES, so no card appears while the run is in
 * progress; it appears once it ends. This is not a guess but an exact match between two records;
 * a record that does not match still shows in the Agent activity window. */

/* Codex records each call under the key the server was registered with; setup always
   registers it under this one (`mcp-status.js` reports an older registration as out of date). */
const { MCP_SERVER_KEY } = require('./product');

/** The worker/run_agent calls in the rollout text. A corrupt line is skipped, never invented. */
function mcpCalls(text) {
  const list = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.includes('McpToolCall')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const p = o && o.payload, it = p && p.item;
    if (!it || it.type !== 'McpToolCall' || it.server !== MCP_SERVER_KEY || it.tool !== 'run_agent') continue;
    const a = it.arguments || {};
    if (typeof a.agent !== 'string') continue;
    const startedAt = Number(p.started_at_ms), done = Number(p.completed_at_ms);
    if (!Number.isFinite(startedAt) || !Number.isFinite(done)) continue;
    list.push({ agent: a.agent, task: typeof a.task === 'string' ? a.task : '', startedAt, done });
  }
  return list;
}

/**
 * Matches parentless worker records against calls.
 *
 * @param {Array} records parentless worker records
 * @param {number} [marginMs] window margin (for clock skew on the record start)
 * @returns {Set<string>} the ids of the records bound to this pane
 */
function match(records, callList, payMs = 3000) {
  const linked = new Set();
  const candidates = (records || []).filter((k) => k && !k.parent && k.id);
  for (const c of callList || []) {
    const wake = candidates.filter((k) => {
      const t = Date.parse(k.startedAt);
      return k.name === c.agent && (k.task || '') === c.task
        && Number.isFinite(t) && t >= c.startedAt - payMs && t <= c.done + payMs;
    });
    if (wake.length !== 1) continue;            // zero: no record; two or more: ambiguous, not bound
    const k = wake[0];
    const otherCall = (callList || []).filter((d) => d !== c && d.agent === c.agent && d.task === c.task
      && Date.parse(k.startedAt) >= d.startedAt - payMs && Date.parse(k.startedAt) <= d.done + payMs);
    if (otherCall.length) continue;            // two calls fit the same record: ambiguous
    linked.add(k.id);
  }
  return linked;
}

/**
 * Calls from several open sessions: a record is bound ONLY if it fits a single session.
 * A record that fits two sessions is not bound.
 * @param {Array} records parentless worker records
 * @param {Map<string, ReturnType<typeof mcpCalls>>} sessionCalls session id -> calls
 * @returns {Map<string,string>} record id -> session id
 */
function matchBySession(records, sessionCalls, payMs = 3000) {
  // Check ambiguity across ALL calls before discarding any session's candidates.
  // Otherwise an internally ambiguous session disappears and another wins falsely.
  const all = [];
  for (const [session, callList] of sessionCalls) {
    for (const calls of callList) all.push({ ...calls, session });
  }
  const unique = match(records, all, payMs);
  const result = new Map();
  for (const [session, callList] of sessionCalls) {
    for (const id of match(records, callList, payMs)) {
      if (unique.has(id)) result.set(id, session);
    }
  }
  return result;
}

module.exports = { mcpCalls, match, matchBySession };
