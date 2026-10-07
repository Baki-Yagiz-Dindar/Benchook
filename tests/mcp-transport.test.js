'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { once } = require('node:events');
const script = path.join(__dirname, 'fixtures/mcp-transport.cjs');
function launch(t, entry = script) {
  const child = spawn(process.execPath, [entry], { windowsHide: true, env: { ...process.env, BENCHOOK_PROJECT: __dirname } });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const lines = [], waiters = []; let buffer = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk; let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1);
      for (const wake of waiters.splice(0)) wake();
    }
  });
  async function response(id) {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const result = lines.find(line => line.id === id); if (result) return result;
      await Promise.race([new Promise(resolve => waiters.push(resolve)), new Promise(resolve => setTimeout(resolve, 25))]);
    }
    throw new Error('Response timeout: ' + id + ': ' + stderr);
  }
  return { child, lines, response, send: message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n') };
}
test('malformed messages return protocol errors and do not kill the real MCP process', async t => {
  const server = launch(t, path.join(__dirname, '../tools/mcp-server.js'));
  server.child.stdin.write('null\n[]\n42\n{broken\n');
  server.send({ id: 10, method: 'ping' });
  assert.deepEqual((await server.response(10)).result, {});
  assert.equal(server.lines.filter(line => line.error).length, 4);
  server.child.stdin.end(); const [code] = await once(server.child, 'exit'); assert.equal(code, 0);
});
test('split UTF-8, split lines, batched requests and final unterminated lines retain identity and content', async t => {
  const server = launch(t);
  const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: 'ş漢🙂' }) + '\n');
  for (const byte of payload) { server.child.stdin.write(Buffer.from([byte])); await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.equal((await server.response(1)).result.echo, 'ş漢🙂');
  server.child.stdin.end('{"jsonrpc":"2.0","id":2,"method":"ping"}\n{"jsonrpc":"2.0","id":3,"method":"ping"}');
  assert.ok((await server.response(2)).result); assert.ok((await server.response(3)).result);
});
test('ping and cancellation remain responsive while a real worker process runs', { timeout: 20000 }, async t => {
  const server = launch(t);
  server.send({ id: 'work', method: 'work' });
  await new Promise(resolve => setTimeout(resolve, 300));
  server.send({ id: 'ping', method: 'ping' });
  assert.ok((await server.response('ping')).result);
  assert.equal(server.lines.some(line => line.id === 'work'), false);
  server.send({ method: 'notifications/cancelled', params: { requestId: 'work' } });
  const result = (await server.response('work')).result;
  assert.match(result.error, /cancelled/); assert.equal(result.couldNotStop, undefined);
  assert.equal(server.lines.length, 2);
  server.child.stdin.end(); const [code] = await once(server.child, 'exit'); assert.equal(code, 0);
});
