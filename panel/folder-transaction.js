'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const json = require('./persistent-json');
const product = require('./product');
let logRoot;
const prefix = product.TRANSACTION_PREFIX;
/* Only this program's own journal files are recovered; anything else in the folder is left alone. */
const journalFile = new RegExp('^' + prefix.replace(/\./g, '\\.') + '[0-9a-f-]{36}\\.json$');
function setup(root) { logRoot = path.resolve(root); return recover(logRoot); }
function remove(p) { fs.rmSync(p, { recursive: true, force: true }); }
function persist(p) {
  const stat = fs.lstatSync(p);
  if (stat.isSymbolicLink()) throw new Error("Prepared copy contains a symbolic link: " + p);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(p)) persist(path.join(p, name));
  } else {
    const fd = fs.openSync(p, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}
function safe(d) {
  if (typeof d.target !== 'string' || !path.isAbsolute(d.target) || d.target !== path.resolve(d.target)
      || d.target === path.dirname(d.target) || typeof d.existed !== 'boolean' || typeof d.remove !== 'boolean'
      || !/^[0-9a-f-]{36}$/.test(d.id)) throw new Error("Invalid recovery record");
  const root = path.dirname(d.target);
  if (d.staging !== path.join(root, product.STAGING_PREFIX + d.id) || d.backup !== path.join(root, product.BACKUP_PREFIX + d.id)) throw new Error("Invalid recovery path");
  // Never reach other files through a junction planted after the fact.
  for (let p = root; ; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error("Recovery path contains a symbolic link: " + p);
    if (p === path.dirname(p)) break;
  }
  for (const p of [d.target, d.staging, d.backup]) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error("Recovery destination contains a symbolic link: " + p);
  }
}
function complete(record, file) {
  record.states.forEach(safe);
  for (const d of record.states.slice().reverse()) {
    if (record.done) {
      remove(d.backup); remove(d.staging);
    } else {
      if (fs.existsSync(d.backup)) {
        remove(d.target); fs.renameSync(d.backup, d.target);
      } else if (!d.existed && !fs.existsSync(d.staging)) {
        remove(d.target);
      }
      remove(d.staging);
    }
  }
  fs.unlinkSync(file);
}
function recover(root) {
  if (!fs.existsSync(root)) return;
  for (const g of fs.readdirSync(root)) {
    if (!journalFile.test(g)) continue;
    const file = path.join(root, g);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.version !== 1 || !Array.isArray(record.states) || typeof record.done !== 'boolean') throw new Error("Could not read transaction journal: " + file);
    complete(record, file);
  }
}
// The journal is written durably before any target changes. With no done marker, startup
// restores the old content; with one, only the spent backups are cleaned. Recovery is repeatable.
function apply(plans) {
  if (!plans.length) return { warning: null };
  const root = logRoot || path.dirname(path.resolve(plans[0].target));
  fs.mkdirSync(root, { recursive: true });
  recover(root);
  const states = plans.map(plan => {
    const target = path.resolve(plan.target), id = randomUUID();
    return { target, id, staging: path.join(path.dirname(target), product.STAGING_PREFIX + id),
      backup: path.join(path.dirname(target), product.BACKUP_PREFIX + id), existed: fs.existsSync(target), remove: !!plan.remove };
  });
  if (new Set(states.map(d => d.target)).size !== states.length) throw new Error("Duplicate transaction destination");
  states.forEach(safe);
  const file = path.join(root, prefix + randomUUID() + '.json');
  const record = { version: 1, done: false, states };
  json.atomic(file, record);
  try {
    for (let i = 0; i < states.length; i++) {
      const d = states[i], plan = plans[i];
      fs.mkdirSync(path.dirname(d.target), { recursive: true });
      if (!d.remove) {
        if (plan.kind !== 'file') fs.mkdirSync(d.staging);
        plan.prepare(d.staging);
        persist(d.staging);
      }
    }
    for (const d of states) {
      if (d.existed) fs.renameSync(d.target, d.backup);
      if (!d.remove) fs.renameSync(d.staging, d.target);
    }
    json.atomic(file, { ...record, done: true });
  } catch (e) {
    // An uncertain completion marker may already be committed. Leave the durable
    // journal and backups for recovery; never roll back against a possibly committed marker.
    if (e.outcomeUncertain) throw new Error(e.message + '; transaction journal preserved: ' + file);
    try { complete(record, file); }
    catch (r) { throw new Error(e.message + "; recovery journal preserved: " + file + '; ' + r.message); }
    throw e;
  }
  try { complete({ ...record, done: true }, file); }
  catch (e) { return { warning: "Operation completed; leftover backups will be cleaned up at next startup: " + e.message }; }
  return { warning: null };
}
module.exports = { apply, setup, recover };
