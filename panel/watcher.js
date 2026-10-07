// FOLDER WATCHER - so the panel sees a change made from outside WITHOUT WAITING for it.
//
// A change made to the account or model of any agent from any orchestrator has to be reflected in
// the panel, and the same goes for the agent list itself.
//
// WHAT IT CHANGES: the agent list was already scanned every ten seconds (`panel.js`), so the
// reflection EXISTED but lagged; the skill list was refreshed only when that tab was clicked, so it
// was not live at all. The watcher feeds both from events.
//
// POLLING IS NOT REMOVED, IT IS THINNED OUT. `fs.watch` trusts the operating system and does not
// behave the same everywhere: on a network drive, in some virtual folders and under the
// write-and-replace pattern of some editors, no event may arrive at all. If an event IS MISSED the
// panel does not show something wrong, only something late - which is why a sparse poll stays
// behind it. An event arriving and nothing having changed are different things, and we do not
// assume the second.
//
// THE PANEL WRITES NOTHING FROM THIS EVENT. The watcher only says that something changed in a
// folder; what is read and what is shown is decided by the page. The file-writing paths still go
// through approval - safety contract is not broken.

const fs = require('node:fs');
const path = require('node:path');
const skills = require('./skills');
const agentFolders = require('./agent-folders');

// One save produces several events (write, rename, mtime update).
// Events arriving back to back collapse into one notice; otherwise a single edit would make the page
// refresh five times over.
const WAITING_MS = 250;

/* HOW MANY PROJECTS ARE WATCHED. Each project means five folders, and an operating-system
   watcher is not free. Without a cap, every project opened during a long session would accumulate.
   The HEAD of the queue is the selected project; what the cap drops is the project opened longest ago. */
const MAX_PROJECTS = 12;

/* A FOLDER THAT DOES NOT EXIST CAN BE BORN LATER (the acceptance: a folder created later is
   detected). `fs.watch` cannot be attached to a path that does not exist; those targets go on a
   waiting list and are retried at a sparse interval. This is not a scan: only a few known paths are checked. */
const RETRY_MS = 4000;

/**
 * Watches a set of paths and calls `report(label)` on a change.
 * A path that does not exist is skipped silently - a project need not carry every folder.
 */
function setupWatcher(report, options = {}) {
  const reTryMs = options.reTryMs || RETRY_MS;
  let watchers = [];
  let waiting = [];        // targets whose folder does not exist yet
  let again = null;
  let timers = new Map();

  /* THE NOTICE CARRIES WHICH PROJECT IT CAME FROM. With a single project watched this was
     unnecessary; with several projects open there is no other way to match an event to its project. */
  const notifyGive = (label, project) => {
    const key = label + '|' + (project || '');
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      try { report(label, project || null); } catch { /* the page may have closed */ }
    }, WAITING_MS));
  };

  /** @returns {boolean} whether a watcher really was attached */
  const watch = (h) => {
    if (!h || !h.filePath) return false;
    try {
      /* Use non-recursive watching for registry files. Recursive file watches can attribute unrelated directory changes to the registry. */
      const status = fs.statSync(h.filePath);
      // `recursive` is supported on Windows and macOS; where it is not, a change in a subfolder is
      // missed and falls to the poll. That is why the error is swallowed and the panel does not stop.
      const w = fs.watch(h.filePath, { recursive: status.isDirectory() },
        () => notifyGive(h.label, h.project));
      w.on('error', () => { /* the folder was deleted or access was lost: polling continues */ });
      watchers.push(w);
      return true;
    } catch { return false; /* if it cannot be watched, polling is enough */ }
  };

  const setupAgain = () => {
    if (again || !waiting.length) return;
    again = setInterval(() => {
      const toTry = waiting;
      waiting = [];
      for (const h of toTry) {
        if (!watch(h)) { waiting.push(h); continue; }
        // The folder may have been JUST born with content already in it, and those files produced no
        // event: report once as soon as it is attached, or a new project stays silent.
        notifyGive(h.label, h.project);
      }
      if (!waiting.length) { clearInterval(again); again = null; }
    }, reTryMs);
    if (again.unref) again.unref();
  };

  return {
    /** Attaches a new set of targets and closes the previous ones. Called when the set of open projects changes. */
    setup(targets) {
      this.close();
      for (const h of targets || []) { if (!watch(h)) waiting.push(h); }
      setupAgain();
    },
    close() {
      for (const w of watchers) { try { w.close(); } catch { /* already closed */ } }
      watchers = [];
      waiting = [];
      if (again) { clearInterval(again); again = null; }
      for (const t of timers.values()) clearTimeout(t);
      timers = new Map();
    },
  };
}

/** The places watched in a single project and which list each one refreshes. */
function projectFolders(project) {
  if (!project) return [];
  return [
    ...agentFolders.inProject(project, agentFolders.LISTED)
      .map((filePath) => ({ filePath, label: 'agent', project })),
    /* Read skill roots from the storage module so synchronization and watching use identical paths. */
    ...Object.keys(skills.SIDES).map((side) =>
      ({ filePath: skills.folder(project, side), label: 'skill', project })),
  ];
}

/* Watch projects opened in this session, including background tabs. Keep the selected project at the head of the bounded queue. Registered but unopened projects are outside the active watch set. @param {string[]} projects Open projects, selected first. */
function targets(projects, registryPath) {
  const h = [];
  const seen = new Set();
  for (const p of (projects || [])) {
    if (!p || seen.has(p)) continue;
    if (seen.size >= MAX_PROJECTS) break;
    seen.add(p);
    h.push(...projectFolders(p));
  }
  // The registry lives in the own folder of the panel. Deleting an account changes how agents resolve
  // (they fall back to the orchestrator), so the agent list has to be refreshed too.
  if (registryPath) h.push({ filePath: registryPath, label: 'agent', project: null });
  return h;
}

/** The older call shape for a single project; does the same thing as `targets`. */
const projectTargets = (project, registryPath) => targets(project ? [project] : [], registryPath);

/* ---------- file fingerprint: did it change from outside ---------- */

// If the file changes from outside while the form is open, the panel does NOT silently OVERWRITE
// it: it warns and lets the user choose, and the warning says what changed, down to the field.
//
// Why the content and not mtime: two writes in the same second can carry the same mtime, and some
// file systems have second resolution. The content itself cannot be wrong.

function fingerTrace(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

/**
 * Produces the difference between two versions that CAN BE TOLD TO THE USER.
 * The header fields are compared one by one; a body difference is summarised in one line.
 * @returns {{field:string, from:string|null, to:string|null}[]}
 */
function diffs(oldRaw, newRaw) {
  const toRead = ['name', 'description', 'model', 'account', 'provider', 'tools'];
  /* Use the shared definition parser to preserve plain Markdown bodies and distinguish front matter from body text when reporting changes. */
  const resolution = require('./agent-resolution');
  const read = (raw) => resolution.parseFrontmatter(raw);
  const e0 = read(oldRaw), y0 = read(newRaw);

  const output = [];
  /* NO FIELD IS CLAIMED FOR A FILE THAT CANNOT BE PARSED. Rather than invent a field difference out
     of unparseable text, only the fact that the text changed is reported. */
  if (e0.corrupt || y0.corrupt) {
    if (String(oldRaw || '') !== String(newRaw || '')) {
      output.push({ field: "Instructions", from: null, to: null });
    }
    return output;
  }
  for (const field of toRead) {
    const e = e0.get(field);
    const y = y0.get(field);
    if (e !== y) output.push({ field, from: e, to: y });
  }
  if (e0.body !== y0.body) output.push({ field: "Instructions", from: null, to: null });
  return output;
}

/** Turns the differences into a single line the user can read. */
function diffSentence(list) {
  if (!list.length) return "File changed";
  const part = list.map((f) => (f.from === null && f.to === null)
    ? f.field + " changed"
    : f.field + ': ' + (f.from || "Empty") + ' → ' + (f.to || "Empty"));
  return part.join(', ');
}

module.exports = { setupWatcher, targets, projectTargets, projectFolders,
  fingerTrace, diffs, diffSentence, WAITING_MS, MAX_PROJECTS, RETRY_MS };
