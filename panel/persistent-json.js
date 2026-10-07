'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function atomic(file, data) {
  atomicText(file, JSON.stringify(data, null, 2));
}

/**
 * Writes text atomically: a temporary file in the same directory, then a replace of the target.
 *
 * THE TEMPORARY NAME DOES NOT END WITH THE TARGET NAME (`<target>.<uuid>.tmp`). That is not a
 * detail: the agent definition folder is scanned by the `.md` extension, so a temporary file
 * sitting there is never mistaken for an agent.
 *
 * @param {object} [options]
 *   `verify(onDisk)` - before the target is replaced, the temporary file is read back from disk
 *     and handed to this function. If it returns a string the write stops for that reason and
 *     THE TARGET IS LEFT UNTOUCHED: no target is replaced by a definition that was not read back
 *     complete and parseable.
 *   `protectPermissions` - if the target already exists its mode is carried to the temporary file,
 *     so the replacement keeps the permissions of the file it replaced.
 */
function atomicText(file, text, options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  let fd, preserveTemporary = false;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;

    if (typeof options.verify === 'function') {
      const reason = options.verify(fs.readFileSync(tmp, 'utf8'));
      if (reason) throw new Error(reason);
    }
    /* PERMISSIONS COME FROM THE FILE BEING REPLACED. The replace leaves a new file behind; without
       carrying the mode over, a read-only or specially permissioned definition would quietly
       become an ordinary one. */
    if (options.protectPermissions) {
      try { fs.chmodSync(tmp, fs.statSync(file).mode); } catch { /* no target, or the mode cannot be read */ }
    }

    try { fs.renameSync(tmp, file); }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM','EACCES','EBUSY'].includes(error.code)) throw error;
      try { require('./windows-atomic').replace(tmp,file); }
      catch (replacementError) {
        preserveTemporary=!!replacementError.outcomeUncertain;
        /* IF THE OUTCOME IS UNKNOWN THE EVIDENCE STAYS, so the caller can say where it stopped. */
        if (preserveTemporary) replacementError.preservedTemp = tmp;
        throw replacementError;
      }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    // A failed cleanup must not replace the real write error with its own.
    if (!preserveTemporary) { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* left for the next cleanup */ } }
  }
}

function read(file, verify = x => x && typeof x === 'object' && !Array.isArray(x)) {
  const parse = p => {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!verify(data)) throw new Error("Invalid saved data format");
    return data;
  };
  try { return parse(file); }
  catch (e) {
    if (!fs.existsSync(file) && !fs.existsSync(file + '.bak')) return null;
    let backup;
    try { backup = parse(file + '.bak'); }
    catch { throw new Error("Saved data and backup could not be read; files were preserved: " + file); }
    // The corrupt file is kept as evidence; the backup itself is not modified.
    if (fs.existsSync(file)) fs.renameSync(file, file + '.corrupt-' + randomUUID());
    atomic(file, backup);
    return backup;
  }
}

function write(file, data, verify) {
  if (verify && !verify(data)) throw new Error("Invalid data format; the file was not changed");
  const old = read(file, verify);
  atomic(file + '.bak', old || data);
  atomic(file, data);
}
module.exports = { atomic, atomicText, read, write };
