'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const json = require('./persistent-json');
const HOLD = 2 * 1024 * 1024;
const STEP = 4 * 1024 * 1024;
const notes = new Map();
const operations = new Map();
function load(file, stat) {
  try {
    const c = JSON.parse(fs.readFileSync(file + '.id.json', 'utf8'));
    if (c.version !== 1 || c.birthtime !== stat.birthtimeMs || c.ino !== stat.ino
      || !Number.isSafeInteger(c.offset) || c.offset < 0 || c.offset > stat.size
      || !Array.isArray(c.ids) || c.ids.length > 64 || c.ids.some(id => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
      || typeof c.carry !== 'string' || c.carry.length > 16000) return null;
    return c;
  } catch { return null; }
}
function reclaim(file, last) {
  if (process.platform !== 'win32') throw new Error("Trace storage reclamation requires Windows sparse file support");
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  {
    const arg = ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, '../tools/reclaim-trace-storage.ps1'), '-LogPath', file, '-EndOffset', String(last)];
    return new Promise((resolve, reject) => execFile(exe, arg,
      { windowsHide: true, shell: false, encoding: 'utf8', timeout: 10000 },
      (error, stdout, stderr) => error ? reject(new Error("Could not reclaim trace storage: " + (stderr || error.message).trim())) : resolve()));
  }
}
function keepAndLimit(file, c, stat) {
  if (operations.has(file)) return;
  if (c.offset < STEP || c.offset - (c.freed || 0) < STEP) return;
  const last = Math.floor((c.offset - HOLD) / 65536) * 65536;
  if (last <= (c.freed || 0)) return;
  const once = notes.get(file);
  if (once && Date.now() - once.time < 60000) return;
  try {
    // First the atomic, fsynced identity checkpoint, then only the prefix that was read. Neither
    // the file length nor the position of an open writer changes. Bytes appended concurrently survive.
    json.atomic(file + '.id.json', { version: 1, birthtime: stat.birthtimeMs, ino: stat.ino,
      // If the helper fails or the panel closes, do not skip the retry.
      // Re-punching a range that already succeeded is safe; treating an unfinished one as done is not.
      offset: c.offset, carry: c.carry, ids: c.ids, freed: c.freed || 0 });
    const operation = reclaim(file, last).then(() => { c.freed = last; notes.delete(file); })
      .catch(e => { notes.set(file, { time: Date.now(), error: e.message }); })
      .finally(() => operations.delete(file));
    operations.set(file, operation);
  } catch (e) { notes.set(file, { time: Date.now(), error: e.message }); }
}
function warning(file) { return notes.get(file)?.error || null; }
async function wait(file) { await operations.get(file); }
module.exports = { load, keepAndLimit, reclaim, warning, wait, HOLD, STEP };
