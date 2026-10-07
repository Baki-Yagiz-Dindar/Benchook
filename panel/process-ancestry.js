'use strict';
/* FINDING THE PANE FROM THE PROCESS ANCESTRY - the pure half.
 * The worker server writes its own pid into the record; Codex passes no environment through, so
 * no pane identity arrives with it. The process tree is walked upwards (pid -> ppid); if the pty
 * process of a pane is reached, that is the pane.
 * This is ancestry, not a guess: if nothing is reached, null. The tree snapshot and the pane pids
 * are supplied from outside. */

/**
 * @param {number} pid the starting point (the pid of the worker server)
 * @param {Map<number,number>} tree pid -> ppid
 * @param {Map<number,string>} panePids pty pid -> the connection identity of the pane
 * @param {number} [maxStep]
 * @returns {string|null}
 */
function fromAncestryPane(pid, map, panePids, maxStep = 16) {
  let p = Number(pid);
  const seen = new Set();
  for (let step = 0; step < maxStep && Number.isFinite(p) && p > 0 && !seen.has(p); step++) {
    seen.add(p);
    const connection = panePids.get(p);
    if (connection) return connection;
    const top = map.get(p);
    if (!Number.isFinite(top) || top === p) return null;
    p = top;
  }
  return null;
}

/** PowerShell output ("pid ppid" lines) -> a map. A corrupt line is skipped. */
function resolveMap(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(pid) && Number.isFinite(ppid)) map.set(pid, ppid);
  }
  return map;
}

module.exports = { fromAncestryPane, resolveMap };
