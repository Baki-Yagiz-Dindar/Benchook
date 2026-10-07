// Context-window and quota readers.
//
// DESIGN NOTE 1 - every pane reads ITS OWN session.
// The first version said "the most recently written record in the folder"; that record could belong
// to ANOTHER session open in the same folder, and the panel then showed a completely unrelated
// fill level. A new file alone is no proof of ownership: the project and the source are checked,
// and when there are several candidates nothing is guessed. A known resume identity always wins.
//
// DESIGN NOTE 2 - the two sides look nothing alike:
//   Claude: the percentage is NOT in the file, it is computed. The modification time is updated, so
//           mtime is trustworthy.
//   Codex:  the window is given (model_context_window), but there are TWO separate token blocks and
//           reading the wrong one produces nonsense such as 200%. The modification time is NOT
//           updated, so mtime is not trustworthy.
//
// DESIGN NOTE 3 - the Codex trap, caught on screen:
//   info.total_token_usage.total_tokens = 508,444   <- the CUMULATIVE total of the session
//   info.last_token_usage.input_tokens  =  48,145   <- the current request = THE CONTEXT WINDOW
//   508,444 / 258,400 = 197%. The right answer is 48,145 / 258,400 = 18.6%.
//   The context window is the input_tokens of the last call, NOT the cumulative total.

const fs = require('node:fs');
const path = require('node:path');
const sessionTrace = require('./session-trace');
const folderOperation = require('./folder-transaction');

// MEASURED VALUES ONLY. For a new model, run /context under that model and read the "x/y tokens" line.
// Enter y here. Do not write an estimate.
const CLAUDE_BOUNDS = {
  'claude-opus-5': 1000000,   // measured, three comparisons, within 0.3-0.4 points
};

/* LONG PROJECT PATHS. Claude Code (read from its 2.1.289 build) cuts a sanitized folder name longer
   than 200 characters and appends a hash of the original path:
     name.slice(0, 200) + '-' + Math.abs(hash(path)).toString(36), hash = 32-bit (h << 5) - h + charCode.
   Without the same rule a project with a long path never found its sessions, so every restart said
   "profile does not contain this session". The uncut name stays a candidate for older versions. */
const CLAUDE_NAME_LIMIT = 200;
function claudeHash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return h;
}
function claudeFolderName(projectPath) {
  const name = String(projectPath).replace(/[^a-zA-Z0-9]/g, '-');
  if (name.length <= CLAUDE_NAME_LIMIT) return name;
  return name.slice(0, CLAUDE_NAME_LIMIT) + '-' + Math.abs(claudeHash(String(projectPath))).toString(36);
}
const claudeFolders = (projectPath, accountFolder) => {
  const root=path.join(accountFolder || require('./accounts').defaultHome('claude'),'projects');
  const canonical=path.join(root,claudeFolderName(projectPath));
  const uncut=path.join(root,String(projectPath).replace(/[^a-zA-Z0-9]/g,'-'));
  const legacy=path.join(root,String(projectPath).replace(/[\\/:]/g,'-').replace(/-+$/,''));
  return [...new Set([canonical,uncut,legacy])];
};
const claudeFolder=(projectPath,accountFolder)=>{
  const candidates=claudeFolders(projectPath,accountFolder);
  return candidates.find(p=>fs.existsSync(p))||candidates[0];
};

const codexFolder = (accountFolder) => path.join(accountFolder || require('./accounts').defaultHome('codex'), 'sessions');

function listJsonl(folder, deep) {
  if (!fs.existsSync(folder)) return [];
  const output = [];
  const browse = (d) => {
    let signIns;
    try { signIns = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const g of signIns) {
      const full = path.join(d, g.name);
      if (g.isDirectory()) { if (deep) browse(full); }
      else if (g.name.endsWith('.jsonl')) output.push(full);
    }
  };
  browse(folder);
  return output;
}

/** The set of files as it was just before the pane opened. */
function snapshot(provider, projectPath, accountFolder) {
  if(provider==='claude')return new Set(claudeFolders(projectPath,accountFolder).flatMap(k=>listJsonl(k,false)));
  const folder = provider === 'codex' ? codexFolder(accountFolder) : claudeFolder(projectPath, accountFolder);
  return new Set(listJsonl(folder, provider === 'codex'));
}

/** Compares project paths using the case rule of the platform. */
function sameProject(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const normal = x => { const p = path.resolve(x); return process.platform === 'win32' ? p.toLowerCase() : p; };
  return normal(a) === normal(b);
}

/** The first JSON line of a session file (at most 1 MB), or null. Read in 64 KB steps: most first
 *  lines are short, and a full 1 MB buffer per file was allocated on every lookup. */
function readStart(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const parts = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, 1024 * 1024 - total), total);
      if (n <= 0) break;
      const chunk = buf.subarray(0, n);
      parts.push(chunk);
      total += n;
      if (chunk.includes(10) || total >= 1024 * 1024) break;
    }
    const line = Buffer.concat(parts).toString('utf8').split('\n')[0];
    return JSON.parse(line);
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/* THE FIRST LINE OF A SESSION FILE DOES NOT CHANGE once written, so a Codex lookup by id (every 3 s per
   pane) no longer re-reads every rollout in the history: the result is kept per file, keyed by its
   identity (inode and creation time), and re-read only for a new or replaced file. */
const startCache = new Map();
function cachedStart(file) {
  let d;
  try { d = fs.statSync(file); } catch { return null; }
  const key = d.ino + ':' + d.birthtimeMs;
  const old = startCache.get(file);
  if (old && old.key === key && old.meta) return old.meta;
  const meta = readStart(file);
  // A file whose first line is still being written (null) is read again next time.
  startCache.set(file, { key, meta });
  while (startCache.size > 5000) startCache.delete(startCache.keys().next().value);
  return meta;
}

function newCandidates(provider, projectPath, old, accountFolder) {
  const folder = provider === 'codex' ? codexFolder(accountFolder) : claudeFolder(projectPath, accountFolder);
  const files=provider==='claude'?claudeFolders(projectPath,accountFolder).flatMap(k=>listJsonl(k,false)):listJsonl(folder,true);
  return files.filter(d => {
    if (old.has(d)) return false;
    const first = readStart(d);
    if (provider !== 'codex') return !!first && sameProject(first.cwd, projectPath);
    const meta = first?.type === 'session_meta' ? first.payload : null;
    return !!meta && sameProject(meta.cwd, projectPath) && meta.source === 'cli';
  });
}

function findNewFile(provider, projectPath, old, accountFolder) {
  const candidates = newCandidates(provider, projectPath, old, accountFolder);
  return candidates.length === 1 ? candidates[0] : null;
}

function sessionFile(o) {
  if (o.traceFile) {
    const ids = sessionTrace.readSessionIds(o.traceFile);
    if (sessionTrace.waiting(o.traceFile)) return null;
    for (const id of ids) {
      const file = findSessionFile(o.provider, o.project, id, o.accountFolder);
      if (!file) continue;
      const meta = readStart(file)?.payload;
      if (!meta || meta.source !== 'cli' || !sameProject(meta.cwd, o.project)) continue;
      o.sessionId = id;
      return file;
    }
  }
  // When the identity is known, no other session is fallen back to even if its file is not visible yet.
  if (o.sessionId) return findSessionFile(o.provider, o.project, o.sessionId, o.accountFolder);
  if (o.traceFile) return null;
  return findNewFile(o.provider, o.project, o.old, o.accountFolder);
}

/** The session identity from the file name - so a closed and reopened pane can resume where it left off. */
function sessionIdFromFile(provider, file) {
  const name = path.basename(file, '.jsonl');
  if (provider === 'codex') {
    // rollout-2026-09-04T17-26-23-01a06cf1-....  -> the uuid formed by the last five hyphen-separated parts
    const m = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    return m ? m[1] : null;
  }
  return name;   // under Claude the file name already is the session identity
}

function lastLines(file, howMany) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    // Do not load a huge journal into the main process just to find its last lines.
    const length = Math.min(size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, size - length);
    const text = buf.subarray(0, read).toString('utf8');
    const lines = (size > length ? text.slice(text.indexOf('\n') + 1) : text).split('\n');
    return lines.slice(-(howMany || 4000));
  } finally { fs.closeSync(fd); }
}

/** Claude: the percentage is computed. If a field is missing, NO percentage is produced. */
function readClaude(file) {
  const lines = lastLines(file);
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i];
    if (!s || s.indexOf('"usage"') < 0) continue;
    let k; try { k = JSON.parse(s); } catch { continue; }
    const u = k && k.message && k.message.usage;
    if (!u) continue;

    const required = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
    const missing = required.filter((name) => typeof u[name] !== 'number');
    const used = required.reduce((t, name) => t + (typeof u[name] === 'number' ? u[name] : 0), 0);
    const model = (k.message && k.message.model) || null;
    const limit = model ? (CLAUDE_BOUNDS[model] || null) : null;

    return {
      provider: 'claude', model, used, limit, missing,
      percent: (limit && missing.length === 0) ? (used / limit) * 100 : null,
      time: k.timestamp || null, file: path.basename(file),
    };
  }
  return { provider: 'claude', error: "Token usage is not available for this session yet", file: path.basename(file) };
}

/** Codex: the window is given. The RIGHT field is last_token_usage.input_tokens - NOT the cumulative total. */
function readCodex(file) {
  const lines = lastLines(file);
  let info = null, quota = null, model = null, time = null, quotaTime = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i];
    if (!s) continue;
    let k; try { k = JSON.parse(s); } catch { continue; }
    if (!k || typeof k !== 'object') continue;
    const y = k.payload;
    if (y?.type === 'token_count') {
      // Usage and quota are independent observations; a quota update may have no new usage.
      if (quota === null && y.rate_limits && typeof y.rate_limits === 'object') {
        quota = y.rate_limits; quotaTime = k.timestamp || null;
      }
      if (info === null && y.info?.last_token_usage) { info = y.info; time = k.timestamp || null; }
    }
    if (model === null) {
      const candidate = k.type === 'turn_context' ? y?.model : !k.type ? k.model : null;
      if (typeof candidate === 'string' && candidate) model = candidate;
    }
    if (info !== null && model !== null && quota !== null) break;
  }

  if (!info) return { provider: 'codex', error: "Token usage is not available for this session yet", file: path.basename(file) };

  const numeric = x => Number.isFinite(x) && x >= 0 ? x : null;
  const used = numeric(info.last_token_usage.input_tokens);   // the CURRENT request = the context
  const limit = numeric(info.model_context_window) || null;
  const cumulative = info.total_token_usage ? info.total_token_usage.total_tokens : null;
  const window = x => x && numeric(x.used_percent) !== null && x.used_percent <= 100 ? {
    percent: x.used_percent,
    minutes: numeric(x.window_minutes) > 0 ? x.window_minutes : null,
    resetsAt: numeric(x.resets_at) !== null ? x.resets_at
      : typeof x.resets_at === 'string' && Number.isFinite(Date.parse(x.resets_at)) ? x.resets_at : null,
  } : null;

  return {
    provider: 'codex', model, used, limit, missing: used === null ? ['input_tokens'] : [],
    percent: (limit && used !== null) ? (used / limit) * 100 : null,
    cumulative, time, file: path.basename(file),
    quotaTime,
    quota: quota ? {
      // primary = the five-hour window, secondary = the weekly one. Read from window_minutes.
      short: window(quota.primary),
      long: window(quota.secondary),
      plan: quota.plan_type || null,
    } : null,
  };
}

/* AN UNCHANGED FILE IS NOT READ AGAIN. The context indicator asks every 3 s per pane, and each answer
   parsed up to the last 4 MB of the session log even when nothing had been written. The result depends
   only on the file's content, so it is kept while the file's identity, size and modification time are the
   same (a session log only grows; any write changes its size). */
const readCache = new Map();
function read(provider, file) {
  if (!file) return { error: "Waiting for a session log" };
  let d;
  try { d = fs.statSync(file); } catch { return { error: "Waiting for a session log" }; }
  const key = provider + ':' + d.ino + ':' + d.size + ':' + d.mtimeMs;
  const old = readCache.get(file);
  if (old && old.key === key) return { ...old.result };
  let result;
  try { result = provider === 'codex' ? readCodex(file) : readClaude(file); }
  catch (e) { return { error: "Could not read: " + e.message }; }
  readCache.delete(file);
  readCache.set(file, { key, result });
  while (readCache.size > 200) readCache.delete(readCache.keys().next().value);
  return { ...result };
}


/** Finds the file from a known session identity.
 *  WHY IT IS NEEDED: resuming with `--resume` creates NO new file, it appends to the existing one.
 *  The "a new file that appeared after the snapshot" rule then finds nothing at all and the panel
 *  says "no session record yet" forever. */
function findSessionFile(provider, projectPath, sessionId, accountFolder) {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(sessionId)) return null;
  if (provider === 'codex') {
    const all = listJsonl(codexFolder(accountFolder), true);
    const found = all.filter(d => {
      const name = path.basename(d, '.jsonl');
      const named = name === sessionId || name.endsWith('-' + sessionId);
      const first = cachedStart(d);
      const meta = first?.type === 'session_meta' ? first.payload : null;
      if (!meta) return named; // Legacy records without metadata keep the filename lookup.
      // A caller that does not know the project (worker model check, pane binding by session id) skips this check.
      if (meta.cwd && projectPath && !sameProject(meta.cwd, projectPath)) return false;
      return meta.id ? meta.id === sessionId : named;
    });
    return found.length === 1 ? found[0] : null;
  }
  const candidates=claudeFolders(projectPath,accountFolder).map(k=>path.join(k,sessionId+'.jsonl')).filter(p=>{
    if(!fs.existsSync(p))return false;
    const meta=readStart(p);
    return !meta?.cwd||sameProject(meta.cwd,projectPath);
  });
  return candidates.length===1?candidates[0]:null;
}

/** Moves the session record into the new profile when switching to another account of the same provider. */
function copySession(provider, projectPath, sessionId, sourceFolder, targetFolder) {
  const source = findSessionFile(provider, projectPath, sessionId, sourceFolder);
  if (!source) throw new Error("The source account does not contain this session log");
  let target;
  if (provider === 'claude') {
    target = path.join(targetFolder, 'projects', path.basename(path.dirname(source)), path.basename(source));
  } else {
    const sessionRoot = codexFolder(sourceFolder);
    target = path.join(codexFolder(targetFolder), path.relative(sessionRoot, source));
  }
  // A NEWER RECORD ON THE TARGET IS NOT OVERWRITTEN. The risky order: work under account B, switch
  // provider in between, come back to A, then move from A to B - the old record of A would overwrite
  // the newer one of B. The panel already catches the failure: when the copy fails it reopens the old
  // session and gives the reason.
  if (fs.existsSync(target)) {
    {
      // mtime is not trustworthy for live Codex records. Advance only when the source continues the target.
      const a = fs.readFileSync(source), b = fs.readFileSync(target);
      if (b.length > a.length || !a.subarray(0, b.length).equals(b)) {
        throw new Error('The destination has a newer or divergent session record; it was not overwritten.');
      }
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const plans = [{ target, kind: 'file', prepare: tmp => fs.copyFileSync(source, tmp) }];
  if (provider === 'claude') {
    const sourceBottom = path.join(path.dirname(source), sessionId);
    const targetBottom = path.join(path.dirname(target), sessionId);
    if (fs.existsSync(sourceBottom)) plans.push({ target: targetBottom,
      prepare: tmp => {
        if (fs.existsSync(targetBottom)) fs.cpSync(targetBottom, tmp, { recursive: true, force: true });
        // Keep destination-only subagent records and reject diverging histories.
        function merge(source, dest) {
          for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
            const from = path.join(source, entry.name), to = path.join(dest, entry.name);
            if (entry.isSymbolicLink()) throw new Error('Session folder contains a symbolic link.');
            if (entry.isDirectory()) { fs.mkdirSync(to, { recursive: true }); merge(from, to); }
            else {
              const incoming = fs.readFileSync(from);
              if (fs.existsSync(to)) {
                const current = fs.readFileSync(to);
                if (!incoming.subarray(0, current.length).equals(current))
                  throw new Error('Destination subagent record differs: ' + entry.name);
              }
              fs.writeFileSync(to, incoming);
            }
          }
        }
        merge(sourceBottom, tmp);
      } });
  }
  folderOperation.apply(plans);
  return target;
}
/** The most recently written Codex session file. With a single terminal there may be no Codex pane;
 *  this is so the quota can still be shown. The number is INEVITABLY STALE, which is why the time it
 *  was written comes back with it, so it is never displayed undated. */
/* THE WALK IS NOT REPEATED EVERY POLL. When the live quota read fails (offline, for example) this ran
   on every 5-second account poll and walked the whole Codex history of the account. The answer is
   reused for 60 seconds; a session written since then is picked up at the next walk. */
const lastSessionCache = new Map();
function lastCodexSession(accountFolder) {
  const key = String(accountFolder || '');
  const hit = lastSessionCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  const value = walkLastCodexSession(accountFolder);
  lastSessionCache.set(key, { at: Date.now(), value });
  return value;
}
function walkLastCodexSession(accountFolder) {
  const all = listJsonl(codexFolder(accountFolder), true);
  let mostNew = null, mostTime = 0;
  for (const d of all) {
    let z = 0;
    try {
      const stat = fs.statSync(d);
      let c = quotaTimes.get(d);
      if (!c || c.size !== stat.size || c.mtime !== stat.mtimeMs) {
        const observation = readCodex(d);
        c = { size: stat.size, mtime: stat.mtimeMs, time: Date.parse(observation.quotaTime || observation.time) || stat.mtimeMs };
        quotaTimes.set(d, c);
        while (quotaTimes.size > 5000) quotaTimes.delete(quotaTimes.keys().next().value);   // bounded for long runs
      }
      z = c.time;
    } catch { continue; }
    if (z > mostTime) { mostTime = z; mostNew = d; }
  }
  return mostNew ? { file: mostNew, writing: new Date(mostTime).toISOString() } : null;
}
const quotaTimes = new Map();

module.exports = { readStart, claudeFolderName, claudeFolder, snapshot, findNewFile, newCandidates, sessionFile, sameProject, findSessionFile, copySession, read, sessionIdFromFile,
                   lastCodexSession, CLAUDE_BOUNDS };
