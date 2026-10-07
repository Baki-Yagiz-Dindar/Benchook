'use strict';
const fs = require('node:fs');
const storage = require('./trace-storage');
const cache = new Map();

// Every terminal is given its own log_dir. Files in the shared profile tree are no proof
// of ownership. Accept only the first main session_loop start inside that process.
// If the journal format changes, return null: rather than bind to the wrong session, the fact stays unknown.
function readSessionIds(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd), size = stat.size;
    let c = cache.get(file);
    const replaced = c && (c.ino !== stat.ino || c.birthtime !== stat.birthtimeMs
      || (c.size === size && c.mtime !== stat.mtimeMs));
    if (!c || size < c.offset || replaced) {
      c = (!c ? storage.load(file, stat) : null) || { offset: 0, carry: '', ids: [] };
      cache.set(file, c);
    }
    c.ino = stat.ino; c.birthtime = stat.birthtimeMs;
    c.size = size; c.mtime = stat.mtimeMs;
    const buffer = Buffer.alloc(Math.min(size - c.offset, 1024 * 1024));
    // A large diagnostic journal must not lock the Electron main process in a single query.
    const last = Math.min(size, c.offset + 4 * 1024 * 1024);
    while (c.offset < last) {
      const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, last - c.offset), c.offset);
      if (!n) break;
      c.offset += n;
      const lines = (c.carry + buffer.subarray(0, n).toString('utf8')).split('\n');
      c.carry = lines.pop().slice(-16000);
      for (const line of lines) {
        const m = line.match(/\bsession_loop\{thread_id=([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\}:\s*codex_core::(?:codex|session):\s*new\s*$/i);
        if (m) { c.ids = c.ids.filter(id => id !== m[1]); c.ids.push(m[1]); c.ids = c.ids.slice(-64); }
      }
    }
    c.waiting = c.offset < size;
    storage.keepAndLimit(file, c, stat);
    return c.waiting ? [] : c.ids.slice().reverse();
  } catch { /* not written yet, or this version does not produce that shape */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return [];
}
function readSessionId(file) { return readSessionIds(file)[0] || null; }
function waiting(file) { return !!cache.get(file)?.waiting; }
function forget(file) { cache.delete(file); }
/** Drops the remembered position of every log that no open terminal uses any more. */
function keepOnly(files) {
  const live = new Set(files);
  for (const file of [...cache.keys()]) if (!live.has(file)) cache.delete(file);
}
module.exports = { readSessionId, readSessionIds, waiting, forget, keepOnly };
