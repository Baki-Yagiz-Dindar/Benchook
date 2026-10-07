'use strict';
// A real descendant of the terminal PTY. No provider calls and no inherited Benchook ID.
const fs = require('node:fs'), path = require('node:path');
const records = require('../../panel/worker-records');
const [root, project, pane] = process.argv.slice(2);
let record;
const timer = setInterval(() => {
  let control; try { control = JSON.parse(fs.readFileSync(path.join(root, 'monitor-control.json'), 'utf8')); } catch { return; }
  if (control.pane !== pane) return;
  if (!record) {
    record = { id: 'live-monitor-worker', name: 'live-monitor-worker', task: 'Deterministic process ancestry check',
      account: 'synthetic', model: 'fixture', serverPid: process.pid, parent: null,
      status: 'running', startedAt: new Date().toISOString() };
    records.write(path.join(root, 'profile'), project, record);
    fs.writeFileSync(path.join(root, 'monitor-worker.json'), JSON.stringify({ pid: process.pid,
      inheritedParent: process.env.BENCHOOK_SESSION || null }));
  }
  if (control.complete) {
    records.write(path.join(root, 'profile'), project, { ...record, status: 'done',
      result: 'CODEX_MONITOR_COMPLETE', done: new Date().toISOString() });
    clearInterval(timer); process.exit(0);
  }
}, 100);
setTimeout(() => process.exit(1), 85000);
