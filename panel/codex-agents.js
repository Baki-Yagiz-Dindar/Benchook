'use strict';
// Read-only adapter for Codex's paginated local history. Never infer parentage from time/name.
const fs = require('node:fs');
const path = require('node:path');

/* On Windows the `threads.cwd` field of Codex comes in the `\?C:...` long-path form (measured
   against a real state_5.sqlite). For comparing projects the prefix is dropped, the path is
   resolved, and on Windows letter case is folded. */
function projectKey(p) {
  let x = String(p || '').replace(/^\\\\\?\\/, '');
  try { x = path.resolve(x); } catch { /* leave it as it is */ }
  x = x.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? x.toLowerCase() : x;
}

function open(root) {
  const state = path.join(root, 'state_5.sqlite');
  const history = path.join(root, 'thread_history_1.sqlite');
  if (!fs.existsSync(state) || !fs.existsSync(history)) return null;
  const { DatabaseSync } = require('node:sqlite');
  return { db: new DatabaseSync(state, { readOnly: true }), hd: new DatabaseSync(history, { readOnly: true }) };
}

/* *
 * EVERY CODEX SUB-AGENT IN THE PROJECT - for the history window. A parent is chosen only
 * by equality of `threads.cwd`; no relationship is inferred from name or time proximity. */
function projectRuns(root, project) {
  if (!root || !project) return { list: [] };
  let opened;
  try { opened = open(root); } catch { return { list: [], none: 'error' }; }
  if (!opened) return { list: [], none: 'support' };
  try {
    const target = projectKey(project);
    const parents = opened.db.prepare(`SELECT DISTINCT p.id, p.cwd FROM thread_spawn_edges e
      JOIN threads p ON p.id=e.parent_thread_id`).all().filter((p) => projectKey(p.cwd) === target);
    const list = [];
    let unsupported = false;
    for (const p of parents) {
      const r = children(opened.db, opened.hd, p.id);
      list.push(...r.list);
      if (r.unsupported) unsupported = true;
    }
    return { list, ...(unsupported ? { none: 'support', error: 'Some native Codex activity uses an unsupported history format.' } : {}) };
  } catch {
    return { list: [], none: 'error', error: 'Native Codex activity could not be read. Its local history may be busy or use a different format.' };
  } finally { try { opened.hd.close(); } catch {} try { opened.db.close(); } catch {} }
}

function list(root, parent) {
  if (!root || !parent) return { list: [], none: 'record' };
  let opened;
  try { opened = open(root); } catch { opened = null; }
  if (!opened) return { list: [], none: 'support',
    error: 'Native Codex activity is unavailable for this history format. Benchook worker runs are still shown.' };
  try {
    const r = children(opened.db, opened.hd, parent);
    return { list: r.list, ...(r.unsupported ? { none: 'support', error: 'Some native Codex activity uses an unsupported history format.' } : {}) };
  } catch {
    return { list: [], none: 'error', error: 'Native Codex activity could not be read. Its local history may be busy or use a different format.' };
  } finally { try { opened.hd.close(); } catch {} try { opened.db.close(); } catch {} }
}

/** `agent_path` ("/root/codex_watcher") -> "codex_watcher"; null when absent. */
function codexAgentName(filePath) {
  const p = String(filePath || '').split(/[\\/]/).filter(Boolean).pop();
  return p || null;
}

/** The children of a parent thread; `unsupported` means a non-paginated child was skipped. */
function children(db, hd, parent) {
  {
    // `t.*`: `agent_path` does not exist in every Codex version; a missing column must not drop the query.
    const children = db.prepare(`SELECT t.*
      FROM thread_spawn_edges e JOIN threads t ON t.id=e.child_thread_id
      WHERE e.parent_thread_id=?`).all(parent);
    const list = [];
    let unsupported = false;
    for (const child of children) {
      if (child.history_mode !== 'paginated') { unsupported = true; continue; }
      const turn = hd.prepare(`SELECT turn_id,status,started_at,completed_at FROM thread_turns
        WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1`).get(child.id);
      const rows = turn ? hd.prepare(`SELECT item_json FROM thread_items WHERE thread_id=? AND turn_id=?
        AND item_type IN ('agentMessage','commandExecution','fileChange','mcpToolCall','userMessage')
        ORDER BY rollout_ordinal DESC LIMIT 200`).all(child.id, turn.turn_id).reverse() : [];
      const flow = [], tools = {};
      let result = '', task = '';
      for (const row of rows) {
        let item; try { item = JSON.parse(row.item_json); } catch { continue; }
        if (item.type === 'agentMessage' && typeof item.text === 'string') {
          flow.push({ tip: 'text', text: item.text });
          if (item.phase === 'final_answer') result = item.text;
        } else if (item.type === 'userMessage') {
          task = (item.content || []).filter(x => x.type === 'text').map(x => x.text || '').join('\n');
        } else {
          const name = item.type === 'commandExecution' ? 'Command'
            : item.type === 'fileChange' ? 'File change' : 'MCP';
          tools[name] = (tools[name] || 0) + 1;
          flow.push({ tip: 'tool', tool: name, target: item.command || item.tool || '' });
        }
      }
      const status = turn?.status === 'completed' ? 'done' : turn?.status === 'failed' ? 'error'
        : turn?.status === 'inProgress' || turn?.status === 'in_progress' ? 'running' : 'unknown';
      const start = turn?.started_at ? turn.started_at * 1000 : null;
      const end = turn?.completed_at ? turn.completed_at * 1000 : null;
      list.push({ file: 'codex:' + child.id, id: child.id, parent,
        /* NAME: role, then the last part of the definition path, then the alias. In a real run the
           sub-agent of Codex showed on the card under its random Codex alias, while `agent_path`
           names the agent itself. Codex turns a hyphen into an underscore; the matching happens in
           the main process. */
        name: child.agent_role || codexAgentName(child.agent_path) || child.agent_nickname || 'Codex agent', model: child.model || null,
        task, result, flow, tools, targets: [], tokens: null, status,
        endSource: status === 'done' ? 'certain' : null, createdAt: start || 0,
        startedAt: start ? new Date(start).toISOString() : null,
        updatedAt: end ? new Date(end).toISOString() : start ? new Date(start).toISOString() : null,
        seconds: start ? Math.max(0, Math.round(((end || Date.now()) - start) / 1000)) : null,
        step: flow.filter(x => x.tip === 'tool').length, session: parent });
    }
    return { list, unsupported };
  }
}
module.exports = { list, projectRuns, projectKey, codexAgentName };
