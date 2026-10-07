'use strict';
// Model-free real child process: data transfer, error and process-tree tests.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
if (process.argv.includes('--heartbeat')) {
  setInterval(() => fs.appendFileSync(process.env.BENCHOOK_TEST_BEAT, '.'), 30);
} else if (process.env.BENCHOOK_TEST_MODE === 'tree') {
  const child = spawn(process.execPath, [__filename, '--heartbeat'], { env: process.env, windowsHide: true });
  console.log(JSON.stringify({ child: child.pid }));
  setInterval(() => {}, 1000);
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', s => input += s);
  process.stdin.on('end', () => {
    const mode = process.env.BENCHOOK_TEST_MODE;
    if (mode === 'failure') {
      console.log(JSON.stringify({ type: 'error', message: 'synthetic failure' })); process.exitCode = 7;
    } else if (mode === 'claude-failure') {
      console.log(JSON.stringify({ type: 'result', is_error: true, result: 'synthetic Claude failure' }));
    } else {
      console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message',
        text: JSON.stringify({ input, args: process.argv.slice(2), cwd: process.cwd(), home: process.env.CODEX_HOME }) } }));
      console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 2 } }));
    }
  });
}
