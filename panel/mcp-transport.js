'use strict';

// Newline-delimited JSON-RPC. Requests run independently so cancellation and ping
// remain responsive while a tool is waiting for a child process.
function serve({ input = process.stdin, output = process.stdout, handle, onIdle = () => {} }) {
  const active = new Map();
  const send = message => output.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  let buffer = '', ended = false, discarding = false;
  const MAX_LINE = 4 * 1024 * 1024;
  const error = (id, code, message) => send({ id, error: { code, message } });
  const idle = () => { if (ended && !active.size) onIdle(); };
  function dispatch(line) {
    if (!line.trim()) return;
    let request;
    try { request = JSON.parse(line); }
    catch { error(null, -32700, 'Parse error'); return; }
    if (!request || typeof request !== 'object' || Array.isArray(request)
        || request.jsonrpc !== '2.0' || typeof request.method !== 'string'
        || ('id' in request && typeof request.id !== 'string' && typeof request.id !== 'number')) {
      error(null, -32600, 'Invalid request'); return;
    }
    if (!Object.hasOwn(request, 'id')) {
      if (request.method === 'notifications/cancelled') active.get(request.params?.requestId)?.abort();
      return;
    }
    if (active.has(request.id)) { error(request.id, -32600, 'Duplicate request ID'); return; }
    const controller = new AbortController();
    active.set(request.id, controller);
    Promise.resolve().then(() => handle(request, controller.signal)).then(
      result => send({ id: request.id, result }),
      failure => error(request.id, Number.isInteger(failure?.rpcCode) ? failure.rpcCode : -32603,
        typeof failure?.message === 'string' ? failure.message : 'Internal error'),
    ).finally(() => { active.delete(request.id); idle(); });
  }
  input.setEncoding('utf8');
  input.on('data', chunk => {
    buffer += chunk;
    let position;
    while ((position = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, position); buffer = buffer.slice(position + 1);
      if (!discarding) {
        if (line.length > MAX_LINE) error(null, -32600, 'Request exceeds size limit');
        else dispatch(line);
      }
      discarding = false;
    }
    if (buffer.length > MAX_LINE) {
      if (!discarding) error(null, -32600, 'Request exceeds size limit');
      buffer = ''; discarding = true;
    }
  });
  input.on('end', () => {
    if (buffer && !discarding) dispatch(buffer);
    ended = true; idle();
  });
  input.on('error', () => { ended = true; for (const controller of active.values()) controller.abort(); idle(); });
  output.on('error', () => { for (const controller of active.values()) controller.abort(); });
  return { abortAll: () => { for (const controller of active.values()) controller.abort(); }, pending: () => active.size };
}

module.exports = { serve };
