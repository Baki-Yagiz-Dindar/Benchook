'use strict';
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');
const cli = require('./cli-path');
const accounts = require('./accounts');
const { stopTree } = require('./subprocess');
const cache = new Map();
function parse(r) {
  const bucket = r?.rateLimitsByLimitId ? r.rateLimitsByLimitId.codex : r?.rateLimits;
  if (!bucket) throw new Error("Codex usage limits were not returned");
  const window = x => x && Number.isFinite(x.usedPercent) && x.usedPercent >= 0 && x.usedPercent <= 100 ? {
    percent: x.usedPercent,
    minutes: Number.isFinite(x.windowDurationMins) && x.windowDurationMins > 0 ? x.windowDurationMins : null,
    resetsAt: Number.isFinite(x.resetsAt) && x.resetsAt >= 0 ? x.resetsAt : null,
  } : null;
  const quota = { short: window(bucket.primary), long: window(bucket.secondary) };
  if (!quota.short && !quota.long) throw new Error("Usage limits unavailable");
  return quota;
}
// Only initialize and account/rateLimits/read; no thread, turn or login request is ever sent.
function query(h) {
  const c = cli.cliInvocation('codex');
  if (!c) return Promise.resolve({ error: cli.cliProblem('codex').kind === 'broken' ? 'Codex CLI installation is broken' : 'Codex CLI was not found' });
  return new Promise(resolve => {
    let p, finished = false, timer, rl;
    const finish = async result => {
      if (finished) return; finished = true; clearTimeout(timer); rl?.close();
      if (p) {
        p.stdin.end();
        // Closing stdin makes the server exit; do not leave a version behind that does not.
        if (p.exitCode === null) {
          const closed = await new Promise(r => {
            const t = setTimeout(() => { p.removeListener('exit', onExit); r(false); }, 1500);
            const onExit = () => { clearTimeout(t); r(true); }; p.once('exit', onExit);
          });
          if (!closed) {
            const stop = await stopTree(p);
            if (stop) { result = { error: "Could not stop the usage reader: " + stop }; p.stdout.destroy(); p.stderr.destroy(); p.unref(); }
          }
        }
      }
      resolve(result);
    };
    try {
      p = spawn(c.command, [...c.leadingArgs, 'app-server'], { windowsHide: true, shell: false, detached: process.platform !== 'win32',
        cwd: path.dirname(accounts.folderPath(h)),
        env: cli.invocationEnv(c, accounts.env(h)),
        stdio: ['pipe', 'pipe', 'pipe'] });
      const send = o => p.stdin.write(JSON.stringify(o) + '\n');
      p.stdin.on('error', () => finish({ error: "Usage service disconnected" }));
      p.stderr.resume();
      p.once('error', e => finish({ error: e.message }));
      p.once('exit', () => { if (!finished) finish({ error: "Usage service closed before responding" }); });
      rl = readline.createInterface({ input: p.stdout });
      rl.on('line', line => {
        if (finished) return;
        let r; try { r = JSON.parse(line); } catch { return; }
        if (!r || typeof r !== 'object' || Array.isArray(r)) return;
        if (r.id !== 1 && r.id !== 2) return;
        if (r.error) return void finish({ error: r.error.message || "Usage request was rejected" });
        if (r.id === 1) { send({ method: 'initialized' }); send({ method: 'account/rateLimits/read', id: 2 }); }
        else {
          try { finish({ quota: parse(r.result), wasRead: new Date().toISOString(), stale: false }); }
          catch (e) { finish({ error: e.message }); }
        }
      });
      timer = setTimeout(() => finish({ error: "Live usage request timed out" }), 12000);
      send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'benchook_panel', version: require('./product').VERSION } } });
    } catch (e) { finish({ error: e.message }); }
  });
}
async function read(h) {
  if (process.env.BENCHOOK_TEST === '1') return { error: "Live usage requests are disabled in UI tests" };
  const root = accounts.folderPath(h);
  let authStamp = ''; try { const s = fs.statSync(path.join(root, 'auth.json')); authStamp = s.mtimeMs + ':' + s.size; } catch { /* not signed in */ }
  const key = root + ':' + authStamp;
  const old = cache.get(key);
  if (old && Date.now() - old.time < 60000) return old.phrase;
  const phrase = query(h); cache.set(key, { time: Date.now(), phrase });
  while (cache.size > 200) cache.delete(cache.keys().next().value);   // one key per token refresh; bounded
  return phrase;
}
module.exports = { read, query, parse };
