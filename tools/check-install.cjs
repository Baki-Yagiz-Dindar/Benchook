'use strict';
// A first check on another machine: no personal account file and no model call.
const path = require('node:path');
const cli = require('../panel/cli-path');
let error = false;
function write(name, ok, info) { console.log((ok ? 'OK ' : 'MISSING ') + name + ': ' + info); if (!ok) error = true; }
write('platform', process.platform === 'win32', process.platform);
const [major, minor] = process.versions.node.split('.').map(Number);
write('Node >=22.12', major > 22 || (major === 22 && minor >= 12), process.versions.node);
for (const name of ['electron', '@lydell/node-pty', '@xterm/xterm']) {
  try { require.resolve(name, { paths: [path.join(__dirname, '../panel')] }); write(name, true, 'installed'); }
  catch { write(name, false, 'run npm ci --prefix panel'); }
}
let available = 0;
for (const name of ['codex', 'claude']) {
  const r = cli.runCli(name, ['--version'], { timeout: 10000 });
  const ok = !r.error && r.code === 0;
  if (ok) available++;
  // A broken install is not "optional": it is installed and will fail at sign-in, so its fix is printed.
  const problem = ok ? null : (cli.cliInvocation(name) ? null : cli.cliProblem(name));
  console.log(name + ': ' + (ok ? String(r.output).trim()
    : problem && problem.kind === 'broken' ? 'BROKEN\n  ' + problem.message.replace(/\n/g, '\n  ')
    : r.error && !/not installed/.test(r.error) ? 'could not run: ' + r.error
    : 'not available (optional if using the other provider)'));
}
write('provider CLI', available > 0, available ? 'available' : 'install Claude Code or Codex and sign in');
process.exitCode = error ? 1 : 0;
