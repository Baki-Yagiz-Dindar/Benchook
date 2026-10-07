'use strict';
// Exercise the production IPC handler, not only the standalone ancestry helper.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('production worker IPC binds a running orphan to its PTY without a completed rollout', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../panel/main.js'), 'utf8');
  const handlers = new Map();
  const context = vm.createContext({
    require: name => require(path.join(__dirname, '../panel', name)),
    process: { platform: 'win32' }, path, fs, Date, setTimeout, clearTimeout,
    terminals: new Map([[1, { pid: 100 }], [2, { pid: 200 }]]),
    sessions: new Map([[1, { provider: 'codex', connection: 'pane-A' }], [2, { provider: 'codex', connection: 'pane-B' }]]),
    context: {}, app: { getPath: () => 'profile' },
    workerRecords: { list: () => [
      { id: 'worker-A', serverPid: 300, parent: null, status: 'running' },
      { id: 'unrelated', serverPid: 999, parent: null, status: 'running' },
    ],
    // Open permission prompts ride along (`worker-records.test.js`); none here.
    withQuestions: (_root, _project, list) => list },
    ipc: { handle: (name, fn) => handlers.set(name, fn) },
    spawn: () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {};
      queueMicrotask(() => { child.stdout.emit('data', '300 250\n250 100\n100 1\n200 1\n999 1\n'); child.emit('close', 0); });
      return child;
    },
  });
  vm.runInContext(source.slice(source.indexOf('  const rolloutCache ='), source.indexOf("  ipc.handle('handover:status'")), context);
  const result = await handlers.get('workers:project')(null, { project: 'project' });
  assert.equal(result.list.find(k => k.id === 'worker-A').parent, 'pane-A');
  assert.equal(result.list.find(k => k.id === 'unrelated').parent, null);
  assert.equal(result.error, undefined);
});
