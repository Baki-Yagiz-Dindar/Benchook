'use strict';
// History merging and agent origin - PURE logic, split out of main.js.
//
// WHY A SEPARATE FILE: these two decisions (which copy survives when the same run appears in two
// profiles, and what origin is written for a name with no definition) must be testable without
// starting Electron. Inside main.js they were not, because that file needs ipcMain and app.

/** The same run can exist in several account profiles: switching accounts COPIES the session
 *  record into the target profile. The key is session plus file; when both match it is the same
 *  run and one row is shown. */
const time = (x) => Date.parse((x && x.updatedAt) || '') || (x && x.createdAt) || 0;

/* *
 * Which of two copies of the same run survives - INDEPENDENT OF ORDER.
 *
 * THE MEASURED DEFECT the rule read "more recent OR active". An OLDER but active record
 * overwrote a NEWER inactive one, and which of them won depended on the order of the list - the
 * same two records in reverse order gave a different answer.
 *
 * The steps, in order:
 *   1. time         the most recent information wins (an unreadable time falls back to the birth time)
 *   2. activity     on an EQUAL time, the record of the active pane: the end marker can only be
 *                   read there. `active` does NOT mean running; it says which pane the record
 *                   belongs to.
 *   3. progress     if all else is equal, the further-along reading of the same run (step, result)
 *   4. still equal  the first one stays: the remaining fields are not shown on screen and both say the same thing */
function insteadPasses(created, old) {
  const zy = time(created), ze = time(old);
  if (zy !== ze) return zy > ze;
  if (!!created.enabled !== !!old.enabled) return !!created.enabled;
  const step = (x) => (typeof x.step === 'number' ? x.step : 0);
  if (step(created) !== step(old)) return step(created) > step(old);
  const length = (x) => String(x.result || '').length;
  return length(created) > length(old);
}

function merge(list) {
  const mostNew = new Map();
  for (const a of list) {
    const key = a.session + '|' + a.file;
    const old = mostNew.get(key);
    if (!old || insteadPasses(a, old)) mostNew.set(key, a);
  }
  return [...mostNew.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// The built-in roles of the provider that we know of. For a name that is not on this list and has
// no definition either, the panel does NOT say deleted - it does not know where that name came from.
const BUILTIN_NAMES = new Set(['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide']);

/** Defined agents plus names that appear only in the records. The two sources do not confirm each
 *  other: this is so that "defined but never ran" and "ran but has no definition" stay separate. */
function separateOrigin(defined, usage) {
  const remaining = new Map(usage);
  const output = defined.map((a) => {
    const k = remaining.get(a.name);
    remaining.delete(a.name);
    return { ...a, times: k ? k.times : 0, last: k ? new Date(k.last).toISOString() : null };
  });
  for (const [name, k] of remaining) {
    const builtin = BUILTIN_NAMES.has(name);
    output.push({
      name,
      description: builtin ? "Built-in Claude Code agent"
                      : "Definition unavailable; it may have been removed or loaded externally",
      model: null, undefinedDef: true, builtin, originAmbiguous: !builtin,
      times: k.times, last: new Date(k.last).toISOString(),
    });
  }
  return output;
}

module.exports = { merge, separateOrigin, BUILTIN_NAMES };
