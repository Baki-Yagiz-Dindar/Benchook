'use strict';
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

// Stops only the process tree this call spawned. No shell command is constructed.
function stopTree(p) {
  return new Promise((resolve) => {
    if (!p.pid) return resolve(null);
    if (process.platform !== 'win32') {
      try { process.kill(-p.pid, 'SIGKILL'); resolve(null); }
      catch (e) { resolve(e.code === 'ESRCH' ? null : e.message); }
      return;
    }
    const k = spawn('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, shell: false });
    let stderr = '';
    k.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-1000); });
    let done = false;
    const finish = (error) => { if (!done) { done = true; clearTimeout(timer); resolve(error); } };
    const timer = setTimeout(() => { k.kill(); finish("Timed out stopping the process tree"); }, 10000);
    k.on('error', e => finish(e.message));
    k.on('close', code => finish(code === 0 ? null : "Could not stop the process tree: " + stderr.trim()));
  });
}

/* A TIME LIMIT THAT DOES NOT COUNT WAITING FOR THE USER (25 September 2026, no limit on the answer). While `hold`
   is true the job waits on a permission prompt and that time is not counted; the rest is counted as before.
   Without `hold` it is a plain timer. Returns the function that cancels it. */
function limit(durationMs, hold, expire) {
  const total = Math.max(1, durationMs);
  if (!hold) { const t = setTimeout(expire, total); return () => clearTimeout(t); }
  const step = Math.max(1, Math.min(250, Math.floor(total / 4)));
  let counted = 0, last = Date.now(), t = null;
  const tick = () => {
    const now = Date.now();
    if (!hold()) counted += now - last;
    last = now;
    if (counted >= total) return expire();
    t = setTimeout(tick, step);
  };
  t = setTimeout(tick, step);
  return () => clearTimeout(t);
}

function run({ command, arg = [], env, cwd, entry = '', durationMs = 600000, signal, maxOutput = 32 * 1024 * 1024, hold }) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ error: "Task cancelled", cancel: true });
    let p;
    try { p = spawn(command, arg, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32' }); }
    catch (e) { return resolve({ error: e.message }); }
    let stdout = '', stderr = '', bytes = 0, stopping = null, done = false;
    const out = new StringDecoder('utf8'), err = new StringDecoder('utf8');
    let timer;
    const finish = (result) => {
      if (done) return;
      done = true; if (timer) timer.cancel(); signal?.removeEventListener('abort', cancel);
      resolve({ output: stdout, errorOutput: stderr, ...result });
    };
    const stop = (reason) => {
      if (stopping || done) return;
      stopping = { error: reason };
      stopTree(p).then(error => {
        // Even on a successful kill the outcome does not depend on the close event: an open pipe must not hang.
        finish({ ...stopping, ...(error ? { error: reason + '; ' + error, couldNotStop: true } : {}) });
        if (error) { p.stdin.destroy(); p.stdout.destroy(); p.stderr.destroy(); p.unref(); }
      });
    };
    const cancel = () => stop("Task cancelled");
    const data = (d, stream) => {
      bytes += d.length;
      if (bytes > maxOutput) return stop("Worker exceeded the output size limit");
      if (stream === 'out') stdout += out.write(d); else stderr += err.write(d);
    };
    p.stdout.on('data', d => data(d, 'out'));
    p.stderr.on('data', d => data(d, 'err'));
    p.on('error', e => finish({ error: "Could not start process: " + e.message }));
    p.on('close', (code, signal) => {
      stdout += out.end(); stderr += err.end();
      if (!stopping) finish({ code, signal }); // stopping waits for the whole tree
    });
    p.stdin.on('error', e => stop("Could not send task instructions: " + e.message));
    const cancelLimit = limit(durationMs, hold, () => stop("Worker timed out"));
    timer = { cancel: cancelLimit };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try { p.stdin.end(String(entry)); } catch (e) { stop("Could not send task instructions: " + e.message); }
  });
}
module.exports = { run, stopTree, limit };
