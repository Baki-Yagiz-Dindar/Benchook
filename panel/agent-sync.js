// AGENT PUBLISHING - writes the single registry record into the file of EVERY project the agent is
// active in.
//
// changing the account of an agent in one project is not something specific to that project
// but to that agent - and it has to happen live.
//
// THE DIRECTION WAS REVERSED. The form used to write into one project file and the other projects
// never heard about it; that is where divergence came from. The form now writes to the registry, and
// the registry spreads from here to every project. The one-writer rule still holds; only the place
// changed.
//
// PARTIAL SUCCESS DOES NOT STAY SILENT. A project folder may have been deleted or made read-only. If
// the write to that project fails the work does not stop - the others are written - but which
// project could not be written is RETURNED to the caller and appears on screen. A half-spread agent
// that stays silent is exactly the error this module exists to fix.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const registry = require('./agent-registry');
const resolution = require('./agent-resolution');
const persistent = require('./persistent-json');

const agentFolders = require('./agent-folders');
const BENCHOOK_FOLDER = agentFolders.PANEL;
/* The location outside the own folder of the panel (`.claude/agents`). The panel does NOT create new
   files there, but it updates an existing one in place: moving a file of the user without telling
   them falls under safety contract. */
const OLD_FOLDERS = [agentFolders.CLAUDE];

// Errors are shown in the user's language; the panel's own temporary names are removed.
const { readableError } = require('./readable-error');

/* IS IT THE SAME FILE. In a rename that changes only letter case, the old and the new path
   are THE SAME file on Windows. Without telling them apart, the delete-the-old-file step would delete
   the file we had just written. The comparison follows the platform: on Windows case is ignored. */
const sameFile = (a, b) => {
  const x = path.resolve(String(a || '')), y = path.resolve(String(b || ''));
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/** Where the file of this agent sits in this project, or where it will be created. */
function targetPath(project, name) {
  /* THE SAME ORDER AS EVERY READER: Benchook's own folder first. With the agent in both folders, a save
     used to write only the `.claude` copy while reconcile read the untouched `.benchook` copy first,
     took it for an outside edit and undid the save. */
  const own = panelPath(project, name);
  if (fs.existsSync(own)) return own;
  for (const k of OLD_FOLDERS) {
    const y = path.join(project, ...k, name + '.md');
    if (fs.existsSync(y)) return y;
  }
  return path.join(project, ...BENCHOOK_FOLDER, name + '.md');
}

/** Where this agent's file lives in Benchook's own folder of the project. */
function panelPath(project, name) {
  return path.join(project, ...BENCHOOK_FOLDER, name + '.md');
}

/** Whether a file sits in one of the older folders (Claude Code's own `.claude/agents`). */
function inOldFolder(project, filePath) {
  return OLD_FOLDERS.some((k) => sameFile(path.dirname(String(filePath || '')), path.join(project, ...k)));
}

/* MOVING AN AGENT OUT OF CLAUDE CODE'S OWN FOLDER (user decision, 6 October 2026). An agent in
   `.claude/agents` is run by Claude Code itself, on the orchestrator's account: the account and model
   chosen in Benchook never applied to it in that project. When the user changes its account or model
   and approves the move, its file in every project is moved into Benchook's folder first and then
   rewritten, so it runs on the chosen account. Moving first means a failed write still leaves the
   agent in place (with its old text) rather than lost. Only files this agent owns are touched. */
function moveOutOfOldFolders(record) {
  const moved = [], errors = [];
  for (const p of (record && record.projects) || []) {
    for (const k of OLD_FOLDERS) {
      const from = path.join(p, ...k, record.name + '.md');
      if (!fs.existsSync(from)) continue;
      const to = panelPath(p, record.name);
      try {
        if (fs.existsSync(to)) { errors.push({ project: p, filePath: from, error: "A file with this name is already in Benchook's folder; nothing was moved." }); continue; }
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
        moved.push({ project: p, from, to });
      } catch (e) { errors.push({ project: p, filePath: from, error: readableError(e), detail: e.message }); }
    }
  }
  return { moved, errors };
}

/** Verifies that the path really is inside one of the agent folders of this project. */
function allowed(project, filePath) {
  if (!project || !filePath || path.extname(filePath).toLowerCase() !== '.md') return false;
  const target = path.resolve(filePath);
  const folders = [BENCHOOK_FOLDER, ...OLD_FOLDERS]
    .map((k) => path.resolve(path.join(project, ...k)));
  if (!folders.includes(path.dirname(target))) return false;
  // A symlink chain: this is the quietest way to write outside the project.
  for (let p = target; ; p = path.dirname(p)) {
    try { if (fs.lstatSync(p).isSymbolicLink()) return false; }
    catch (e) { if (e.code !== 'ENOENT') return false; }
    if (p === path.dirname(p)) break;
  }
  return true;
}

/**
 * Writes an agent to every project it is active in.
 *
 * @param {object} record  the registry record
 * @returns {{written:string[], errors:{project:string,error:string}[]}}
 */
function publishAgent(record) {
  const written = [];
  const errors = [];
  if (!record || !record.name) return { written, errors };
  /* AN AGENT BEING DELETED IS NOT PUBLISHED. In a half-finished deletion the record stays in
     the registry; publishing it like a normal record would recreate the files the user had just
     managed to delete. Silently doing nothing would be equally wrong: the work did not finish. */
  if (record.deletionPending) {
    errors.push({ project: null, error: 'Benchook is still deleting "' + record.name
      + '"; it was not written anywhere. Finish the delete, or save the agent to cancel it.' });
    return { written, errors };
  }
  const content = registry.text(record);
  /* THE ORIGIN RECORD MUST NOT TOPPLE THIS WORK. The own write of the registry can fail too - when
     the disk is full both fail together. Letting that throw would lose the partial result of the
     publish entirely, and that result is exactly what the caller needs to learn. */
  const saveOrigin = (project, status) => {
    try { registry.savePublish(record.name, project, status); }
    catch (e) { errors.push({ project, detail: e.message,
      error: "Written, but Benchook could not update its own record: " + readableError(e) }); }
  };
  for (const project of record.projects || []) {
    /* Skip missing project roots so atomic writes cannot recreate a deleted project. Preserve membership so publishing can resume if the project returns. */
    if (!fs.existsSync(project)) {
      errors.push({ project, error: "That project folder no longer exists." });
      saveOrigin(project, { succeeded: false });
      continue;
    }
    const filePath = targetPath(project, record.name);
    if (!allowed(project, filePath)) {
      errors.push({ project, error: "The target path is outside the project's agent folders." });
      saveOrigin(project, { succeeded: false });
      continue;
    }
    try {
      // If the same content is already written the file is NOT TOUCHED: the watcher must not wake for
      // nothing and the modification time of the file must not lie.
      if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === content) {
        // Untouched, but THIS IS THE CONTENT ON THE TARGET: the origin data is refreshed here too,
        // otherwise migrated old records could never acquire any origin at all.
        saveOrigin(project, { succeeded: true, content });
        written.push(filePath); continue;
      }
      /* ATOMIC WRITE. This used to write to the target DIRECTLY; an error mid-write (a full
         disk, a lock) deleted the old sound definition and left a half file in its place. The old
         path (`agent-writer.js`) already had this guarantee; the new publish path LOST it when the
         central person model came in.

         The same helper is used and no second atomic write is written: two paths written separately
         mean two behaviours that drift apart - a lesson measured in this repository. */
      persistent.atomicText(filePath, content, {
        protectPermissions: true,
        verify: (onDisk) => (onDisk === content ? null
          : 'The definition on disk did not match what Benchook meant to write; '
            + 'the existing file was left untouched.'),
      });
      saveOrigin(project, { succeeded: true, content });
      written.push(filePath);
    } catch (e) {
      /* ONE FILE BEING ATOMIC DOES NOT MAKE SEVERAL PROJECTS ATOMIC (a note). One project can
         be written while another cannot. What this target is WAITING FOR is recorded in the registry:
         the file sitting in that project is now the content we last wrote successfully, and when it
         is read later it must not be mistaken for a new edit - that is the second half of. */
      saveOrigin(project, { succeeded: false });
      errors.push({ project, filePath, error: readableError(e), detail: e.message,
        preservedTemp: e.preservedTemp || null });
    }
  }
  return { written, errors };
}

/**
 * Removes the agent from ONE project only: it deletes the file of that project and keeps the registry
 * record. An agent not being used does not mean it is dead.
 */
/* SAME NAME, DIFFERENT AGENTS: LOCKED. When two projects hold different
   definitions under one name, Benchook cannot tell which one an edit is for, and an edit would
   overwrite the other. Until one copy is renamed, nothing but that rename is accepted. */
const lockedMessage = (name) => 'Another project holds a different agent named "' + name + '", so '
  + 'Benchook cannot tell them apart. Give one of them a new name first; until then only the name can be changed.';
const locked = (record) => (record && registry.hasConflict(record)
  ? { error: lockedMessage(record.name), locked: true } : null);

function removeFromProject(name, project) {
  const filePath = targetPath(project, name);
  if (!allowed(project, filePath)) return { error: "The target path is outside the project's agent folders." };
  const existingEntry = registry.find(name);
  if (!existingEntry) return { error: "No agent named \"" + name + "\"." };
  const lock = locked(existingEntry);
  if (lock) return lock;
  /* THE FILE FIRST, THEN MEMBERSHIP. The order used to be reversed: membership was removed
     from the registry and the file deleted afterwards. When the delete failed, membership was gone
     and the file remained - and the next scan saw that file and restored the membership. The
     removal by the user silently undid itself.
     In this order a failure means ONE thing: nothing changed, and it can be retried. */
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
  catch (e) {
    return { error: "Could not remove \"" + name + "\" from this project: " + readableError(e)
      + " Nothing was changed; you can try again.", detail: e.message, agent: existingEntry };
  }
  const result = registry.removeFromProject(name, project);
  if (result.error) return result;
  return { agent: result.agent, removedPaths: filePath };
}

/**
 * THE ONLY CHANGE A LOCKED AGENT ACCEPTS: a new name for the copy in this project.
 *
 * The file keeps its folder and every byte except its `name:` line; no other project is touched.
 * The renamed copy becomes its own agent in this project. When this project was the only one the
 * locked agent belonged to, that agent is dropped from the registry, so the other copy is read
 * afresh under the freed name.
 */
function renameCopy(project, oldName, newName, filePath) {
  const record = registry.find(oldName);
  if (!record || !registry.hasConflict(record)) return { error: 'This agent is not locked; edit it in the form as usual.' };
  const target = String(newName || '').trim();
  if (registry.key(target) === registry.key(record.name)) return { error: 'Choose a new name: this one is shared with another agent.' };
  const nameError = registry.nameSuitable(target);
  if (nameError) return { error: nameError };
  if (!project || !filePath || !allowed(project, filePath) || !fs.existsSync(filePath)) {
    return { error: "That agent's file is not in this project." };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const read = registry.fromFile(raw);
  if (registry.key(read.name || path.basename(filePath, '.md')) !== registry.key(record.name)) {
    return { error: 'That file does not define "' + record.name + '".' };
  }
  const newPath = path.join(path.dirname(filePath), target + '.md');
  if (fs.existsSync(newPath)) return { error: 'A file named ' + target + '.md already exists in that folder.' };

  const lines = raw.split('\n');
  const eol = (l) => (l.endsWith('\r') ? '\r' : '');
  let end = -1;
  if (/^---\r?$/.test(lines[0] || '')) {
    for (let i = 1; i < lines.length; i++) if (/^---\r?$/.test(lines[i])) { end = i; break; }
  }
  if (end > 0) {
    const i = lines.slice(1, end).findIndex((l) => /^name:/.test(l));
    if (i >= 0) lines[i + 1] = 'name: ' + target + eol(lines[i + 1]);
    else lines.splice(1, 0, 'name: ' + target + eol(lines[0]));
  } else {
    lines.unshift('---', 'name: ' + target, '---');
  }
  const next = lines.join('\n');
  try {
    persistent.atomicText(newPath, next, { protectPermissions: true,
      verify: (onDisk) => (onDisk === next ? null : 'The renamed file on disk did not match; nothing was removed.') });
    fs.unlinkSync(filePath);
  } catch (e) {
    return { error: 'Could not rename the agent: ' + readableError(e), detail: e.message };
  }

  if (registry.conflictIn(record, project)) {
    registry.clearConflict(record.name, project);
  } else if (registry.isInProject(record, project)) {
    registry.removeFromProject(record.name, project);
    const after = registry.find(record.name);
    if (after && !(after.projects || []).length) registry.remove(record.name);
  }
  const r = externalChanged(project, newPath);
  return { renamed: true, name: target, filePath: newPath, error: r && r.error };
}

/** Makes the agent active in a project and writes the file of that project. */
function addToProject(name, project) {
  const existingEntry = registry.find(name);
  const lock = locked(existingEntry);
  if (lock) return lock;
  /* A HALF-DELETED AGENT IS NOT BOUND TO A NEW PROJECT. Adding it would silently cancel the
     deletion and copy it somewhere new on top of that. Cancelling is an explicit action (Save in the
     form); this door does not take it on. */
  if (existingEntry && existingEntry.deletionPending) {
    return { error: 'Benchook is still deleting "' + existingEntry.name
      + '". Finish the delete, or open the agent and save it to cancel the delete.' };
  }
  const result = registry.addToProject(name, project);
  if (result.error) return result;
  const { written, errors } = publishAgent(result.agent);
  return { agent: result.agent, written, errors };
}

/* *
 * CONTINUE THE DELETION - removes the files on the remaining targets of the record and, if the work
 * IS DONE, deletes the record.
 *
 *. The delete-everywhere path used to collect file errors but delete the central record
 * UNCONDITIONALLY: when the project of the undeletable file was read again, that file was taken in as
 * a NEW agent. The user had said delete and the agent came back.
 *
 * THE CHOICE: a pending deletion, NOT a full rollback. Writing back the files that could be deleted
 * would override the decision of the user. The record stands as pending, publishes nothing and
 * reserves the name; once the block is gone, either the same button or a project scan finishes it.
 *
 * One function drives both the first deletion and the retry: two paths written separately are two
 * behaviours that drift apart - a lesson measured in this repository. */
function continueDeletion(record) {
  const removedPaths = [];
  const errors = [];
  const remaining = [];
  for (const project of record.projects || []) {
    const filePath = targetPath(project, record.name);
    if (!allowed(project, filePath)) {
      errors.push({ project, error: "The target path is outside the project's agent folders." });
      remaining.push(project); continue;
    }
    try { if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); removedPaths.push(filePath); } }
    catch (e) {
      errors.push({ project, filePath, error: readableError(e), detail: e.message });
      remaining.push(project);
    }
  }
  /* IF THE TARGET IS ALREADY GONE, THAT TARGET IS DONE: what removed the obstacle may have been the
     user deleting the file themselves. Otherwise the record would stay pending forever. */
  if (!remaining.length) {
    const d = registry.remove(record.name);
    return { deleted: d.deleted || record.name, removedPaths, errors: [], pending: [] };
  }
  const g = registry.markDeletion(record.name, remaining);
  return { deleted: null, removedPaths, errors, pending: remaining, agent: g.agent };
}

/** Deletes the agent from the registry and removes its file from every project it is active in. */
function deleteFully(name) {
  const record = registry.find(name);
  if (!record) return { error: "No agent named \"" + name + "\"." };
  const lock = locked(record);
  if (lock) return lock;
  return { projects: record.projects, ...continueDeletion(record) };
}

/**
 * AN EDIT MADE FROM OUTSIDE IS APPLIED TO THE AGENT ITSELF - if an orchestrator or an editor changed
 * a file, that means the agent changed. The panel takes the change into the registry and spreads it
 * to the other projects. Silently writing back over it would lose real work done outside.
 *
 * Once the change has spread, that file already matches the registry, so no loop forms.
 */
function externalChanged(project, filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (e) { return { error: e.message }; }
  const read = registry.fromFile(raw);
  /* AN UNPARSEABLE FILE DOES NOT ENTER THE REGISTRY. If it did, the panel would write
     it back with its own narrow schema and delete everything it could not read - and spread that to
     the OTHER projects of the agent as well. The file stays as it is and the reason goes to the caller. */
  if (read.corrupt) return { error: read.corrupt };
  const name = read.name || path.basename(filePath, '.md');
  const existingEntry = registry.find(name);

  /* A FILE LEFT OVER FROM A HALF-FINISHED DELETION DOES NOT RESURRECT THE AGENT. had
     left a seam here: seeing a file established membership, and an undeletable file went through that
     same path. The pending deletion is now CONSULTED.

     If this target is on the deletion list the work continues here: if the block is gone the file
     goes, and if it was the last target the record closes too - the user need not press the button a
     second time.

     If a file of the same name is found somewhere NOT on the list, the panel DOES NOT TOUCH it.
     Deleting a file the user did not approve falls under safety contract; taking it in would
     resurrect the agent. The file stays as it is and the reason goes to the caller. */
  if (existingEntry && existingEntry.deletionPending) {
    if (!registry.isInProject(existingEntry, project)) {
      return { error: 'Benchook has not finished deleting "' + existingEntry.name
        + '", so this file was left where it is. Finish the delete, or open the agent and '
        + 'save it to cancel the delete.' };
    }
    const t = continueDeletion(existingEntry);
    return { deletionPending: true, removedPaths: t.removedPaths, errors: t.errors,
      pending: t.pending, deleted: t.deleted };
  }

  /* A COPY LEFT OVER FROM A FAILED PUBLISH IS NOT A NEW EDIT. Every differing file that
     landed here used to count as someone having changed it outside. But if we could not write to that
     project, the file there is the content we last put down SUCCESSFULLY; nobody touched it. Taking
     it into the registry would undo the setting the user had just saved, and spread that to the other
     projects as well.

     The last-writer-wins decision for a REAL concurrent edit by the user is preserved: if the file
     differs from what we last wrote, this branch does not run and the normal path below does. */
  if (existingEntry && registry.isOldCopy(existingEntry, project, raw)) {
    // Try the repair here: if the block is gone the project quietly falls into place, and if not the
    // pending state is kept. Publishing does not write the same content twice, so no loop forms.
    const t = publishAgent(existingEntry);
    return { oldCopy: true, agent: existingEntry, written: t.written, errors: t.errors };
  }

  /* SEEING A PROJECT IS NOT EDITING IT (the program must attach to any
     project and show the agents already there, without changing that project). The first time
     the panel meets a definition in a project -- a new agent, or a known agent in a project it is
     not yet a member of, or a member tracked before this rule -- it records what it saw and writes
     nothing. Only a file that differs from what the panel last saw or wrote IN THAT PROJECT is an
     edit, and only an edit is carried to the agent's other projects. */
  if (!existingEntry) {
    // A NEW agent was created outside: it is taken into the registry and counts as active in this project.
    const r = registry.add({ ...read, name, projects: [project] });
    if (r.error) return r;
    registry.savePublish(r.agent.name, project, { succeeded: true, content: raw });
    return { isNew: true, agent: registry.find(r.agent.name), written: [], errors: [] };
  }
  if (!registry.isInProject(existingEntry, project)) {
    /* A copy identical to what the panel knows is the same agent. A DIFFERENT definition under the
       same name is another agent: it is not joined to this one, the name is locked instead. */
    const digest = registry.summarize(raw);
    const known = [registry.summarize(registry.text(existingEntry)),
      ...Object.values(existingEntry.syncState || {}).map((s) => s && s.digest)].filter(Boolean);
    if (!known.includes(digest)) {
      registry.markConflict(existingEntry.name, project, digest);
      return { conflict: true, agent: registry.find(existingEntry.name), written: [], errors: [] };
    }
    registry.clearConflict(existingEntry.name, project);
    /* SEEING THE DEFINITION ESTABLISHES MEMBERSHIP -- but does not rewrite anything: the agent keeps the
       definition it already has, this project's file stays as it is, and later edits made in the
       panel reach this project because it is now a member. */
    const u = registry.addToProject(existingEntry.name, project);
    if (u.error) return u;
    registry.savePublish(existingEntry.name, project, { succeeded: true, content: raw });
    return { membershipAdded: true, agent: registry.find(existingEntry.name), written: [], errors: [] };
  }
  const seen = registry.seenDigest(existingEntry, project);
  if (seen === registry.summarize(raw)) {
    // Unchanged since the panel last saw or wrote it here.
    return { unchanged: true, agent: existingEntry, written: [], errors: [] };
  }
  if (seen === null) {
    /* A member the panel has never tracked in this project: the file is the only truth there is.
       The definition is taken from it, and nothing is written anywhere. */
    const u = registry.update(existingEntry.name, { ...read, name: existingEntry.name });
    if (u.error) return u;
    registry.savePublish(existingEntry.name, project, { succeeded: true, content: raw });
    return { updatedAt: true, membershipAdded: false, agent: registry.find(existingEntry.name), written: [], errors: [] };
  }
  const r = registry.update(existingEntry.name, { ...read, name: existingEntry.name });
  if (r.error) return r;

  // A real edit in a project the agent already belongs to: carried to its other projects.
  return { updatedAt: true, membershipAdded: false, agent: r.agent, ...publishAgent(r.agent) };
}

/* *
 * RECONCILE A PROJECT WITH THE REGISTRY - the way an outside change is caught.
 *
 * WHY NOT BY FILE NAME: the watcher only says the agent list changed, not which file changed. Rather
 * than change its signature, the project is read from scratch; a handful of small files has no
 * measurable cost.
 *
 * NO LOOP FORMS: a file the panel wrote itself already matches the registry, so this function ignores
 * it and triggers no new write.
 *
 * A DELETION CAN COMPLETE IN THE BACKGROUND AND THAT MUST NOT STAY SILENT: removing a file
 * from disk is irreversible. The user may not have clicked anywhere at that moment - the block was
 * lifted, the watcher woke, and the work finished here. Which agent finished deleting and which is
 * still pending is therefore RETURNED to the caller, and the page writes it on screen.
 *
 * @returns {{changed:{name:string,isNew:boolean}[], errors:object[],
 *            deletionCompleted:string[], deletionPending:string[]}} */
function reconcile(project) {
  const changed = [];
  const errors = [];
  const deletionCompleted = [];
  const deletionPending = [];
  if (!project) return { changed, errors, deletionCompleted, deletionPending };
  const folders = [BENCHOOK_FOLDER, ...OLD_FOLDERS];
  const namesHere = new Map();     // name key -> digest of the first definition seen in this project
  const doubledHere = new Set();   // names defined twice, differently, inside this project
  for (const k of folders) {
    const folder = path.join(project, ...k);
    let names = [];
    try { names = fs.readdirSync(folder).filter((x) => x.endsWith('.md')); } catch { continue; }
    for (const file of names) {
      const filePath = path.join(folder, file);
      let raw;
      try { raw = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
      const read = registry.fromFile(raw);
      if (read.corrupt) {
        errors.push({ name: path.basename(file, '.md'), filePath, error: read.corrupt });
        continue;
      }
      const name = read.name || path.basename(file, '.md');
      // Two different definitions under one name in the same project: the name is locked too.
      const nameKey = registry.key(name), digest = registry.summarize(raw);
      if (namesHere.has(nameKey)) {
        if (namesHere.get(nameKey) !== digest) {
          doubledHere.add(nameKey);
          const first = registry.find(name);
          if (first) registry.markConflict(first.name, project, digest);
        }
        continue;
      }
      namesHere.set(nameKey, digest);
      const record = registry.find(name);
      /* A PENDING DELETION IS NOT COVERED BY THIS SKIP the file may be byte-identical to the
         registry and the membership may still stand - because it could not be deleted. Skipping it
         would mean the work is never continued. */
      if (record && !record.deletionPending
        && registry.text(record) === raw && registry.isInProject(record, project)) continue;
      /* AN ERROR IN ONE FILE DOES NOT TOPPLE THE RECONCILE. The own write of the registry can
         fail too - `update` throws when the disk is full. That used to cut the reconcile off in the
         middle: the remaining files were never read and the caller never learned what happened. Every
         file is now reported on its own and the scan completes. */
      let r;
      try { r = externalChanged(project, filePath); }
      catch (e) { errors.push({ name, filePath, error: e.message }); continue; }
      if (r.error) { errors.push({ name, error: r.error }); continue; }
      /* AN OLD COPY IS NOT A CHANGE. A repair was attempted; if it failed, which project
         could not be written is still reported, but the page is not told that this agent changed -
         nothing changed, only a missing publish was attempted. */
      if (r.oldCopy) { for (const h of (r.errors || [])) errors.push({ name, ...h }); continue; }
      /* CONTINUING A DELETION IS NOT A CHANGE. The agent did not change; a half-finished
         deletion either completed or is still pending. A failed target is still reported. */
      if (r.deletionPending) {
        for (const h of (r.errors || [])) errors.push({ name, ...h });
        if (r.deleted) deletionCompleted.push(name); else deletionPending.push(name);
        continue;
      }
      // Nothing changed since the panel last saw this file, or the name is locked: not reported.
      if (r.unchanged || r.conflict) continue;
      changed.push({ name, isNew: !!r.isNew });
    }
  }
  /* A conflict is over once its copy has left this project (renamed or removed), or, for two
     definitions inside one project, once only one remains. */
  for (const a of registry.list()) {
    if (!registry.conflictIn(a, project)) continue;
    const k = registry.key(a.name);
    if (!namesHere.has(k) || (registry.isInProject(a, project) && !doubledHere.has(k))) {
      registry.clearConflict(a.name, project);
    }
  }
  return { changed, errors, deletionCompleted, deletionPending };
}

/* THE THREE INTENTS OF THE FORM.
   Creating a new person, editing an existing one, and adding an existing one to this project are
   three different jobs. All three used to enter the same call under the same flag (`overwrite`) - but
   that is a FILE question (may I write over it), not an identity question. The result: the panel said
   "save and it will be added to this project" while the save refused with "that name already exists",
   so the action the screen promised could never be carried out. */
const INTENTS = ['new', 'edit', 'addToProject'];

/**
 * SAVING FROM THE FORM - the one place the decision is made.
 *
 * The decision used to live in the IPC handler of main.js, which cannot be tested. The rule is here now:
 *
 * - `new`: the name must be FREE. Name uniqueness was not removed; this is the only place it means
 *   something.
 * - `edit` / `addToProject`: the name already IS a PERSON; that person is updated and made a member
 *   of this project. They are two intents with the same outcome; the difference is what the screen says.
 * - with an unknown intent, THE OLD STRICT BEHAVIOUR: writing to an existing name from a project that
 *   is not a member is refused. Treating the unknown as the same person would silently merge two agents.
 *
 * @param {{project:string, name:string, content:string, intent?:string}} request
 */
/**
 * What a form save keeps from the agent it edits.
 * THE FORM CANNOT DELETE A FIELD IT DOES NOT MENTION: front matter fields the panel does not know are
 * carried over from the existing record. A real edit made from outside goes through a different door
 * (`changedOutside`); THERE the file is the source and deleting a field is a real intent.
 * An existing restriction is kept when a legacy default tool list is omitted or inserted automatically;
 * explicit permission-level choices are handled separately.
 * Shared with the preview (`agent-writer.preview`), so the text the user approves is the text written.
 */
function formFields(read, existingEntry) {
  if (!existingEntry) return read;
  const protectRestriction = resolution.formerDefaultTools(read.tools)
    && !resolution.formerDefaultTools(existingEntry.tools);
  return { ...read, ...(protectRestriction ? { tools: existingEntry.tools } : {}),
    extraFrontmatter: existingEntry.extraFrontmatter };
}

function saveForm(request) {
  const { project, name, content, intent, oldName, oldPath, moveToPanel } = request || {};
  if (!project || !content) return { error: 'Invalid request' };
  const read = registry.fromFile(content);
  if (read.corrupt) return { error: read.corrupt };
  const targetName = read.name || name;
  /* THE IDENTITY IS THE NAME AT THE MOMENT THE FORM OPENED. The save used to look only at the
     NAME in the form; when the new name was not found in the registry it counted as a new agent and one
     person split into TWO identities: the old definition was orphaned and the other projects the agent
     was active in went on living under the old name. */
  /* THE IDENTITY CAN BE READ FROM TWO PLACES: the `oldName` the page sends, or the name of the FILE
     being edited. The second lets a rename be recognised even in a call that does not send the
     identity explicitly - not a guess, but the name of the file the form actually opened. */
  const fromPathName = oldPath ? path.basename(String(oldPath), '.md') : null;
  const id = (oldName ? registry.find(oldName) : null)
    || (fromPathName ? registry.find(fromPathName) : null);
  if (oldName && !id) {
    return { error: 'There is no agent named "' + oldName + '" anymore. '
      + 'It may have been deleted or renamed elsewhere. Refresh the list and try again.' };
  }
  const existingEntry = id || registry.find(targetName);
  const lock = locked(existingEntry);
  if (lock) return lock;   // a locked agent is only renamed, through renameCopy
  const requested = INTENTS.includes(intent) ? intent : null;

  if (existingEntry && (requested === 'new'
    || (!requested && !registry.isInProject(existingEntry, project)))) {
    return { error: registry.nameSuitable(targetName) };
  }
  if (!existingEntry && requested === 'edit') {
    /* AN EDIT REQUIRES AN IDENTITY. With no identity and a name not found in the registry, a
       NEW agent used to be created silently; that is exactly what split one person in two. An explicit
       error instead of a silent split: the caller either sends the identity
       or says "new agent". */
    return { error: 'Benchook does not know which agent this edit belongs to. '
      + 'Close the form, open the agent again, and save.' };
  }
  if (!existingEntry && requested === 'addToProject') {
    /* An agent deleted concurrently must not be recreated by an add-existing operation. */
    return { error: 'There is no agent named "' + targetName + '" anymore. '
      + 'Refresh the list, or create it as a new agent.' };
  }

  const wasMember = !!(existingEntry && registry.isInProject(existingEntry, project));
  /* THE OLD PATHS ARE COLLECTED NOW: once the registry is updated nobody knows the old name. */
  const nameChanged = !!(existingEntry && existingEntry.name !== targetName);
  const oldPaths = nameChanged
    ? (existingEntry.projects || []).map((p) => ({ project: p, filePath: targetPath(p, existingEntry.name) }))
    : [];
  const result = existingEntry
    ? registry.update(existingEntry.name, { ...formFields(read, existingEntry), name: targetName })
    : registry.add({ ...read, name: targetName, projects: [project] });
  if (result.error) return result;

  const added = registry.addToProject(targetName, project);
  if (added.error) return added;
  const relocation = moveToPanel ? moveOutOfOldFolders(added.agent) : { moved: [], errors: [] };
  const publish = publishAgent(added.agent);

  /* THE OLD NAME IS DELETED ONLY AFTER THE NEW ONE IS WRITTEN. The reverse order would mean
     deleting the agent from that project altogether when the write failed. An old definition that
     cannot be deleted does not stay silent either: which project it remains in goes back to the caller
     and can be retried. */
  const oldNameRemaining = [];
  const moved = [];
  for (const { project: p, filePath } of oldPaths) {
    const newPath = targetPath(p, targetName);
    if (sameFile(filePath, newPath)) continue;             // only the letter case changed
    if (!publish.written.some((x) => sameFile(x, newPath))) {
      oldNameRemaining.push({ project: p, filePath,
        error: "The new name could not be written here yet, so the old definition was kept." });
      continue;
    }
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      /* IF THE FOLDER CHANGED TOO IT IS REPORTED: a definition in an old folder (such as
         `.claude/agents`) lands in the folder of the panel under the new name. The user approved the
         rename and must be able to look separately at the file moving to another folder. */
      if (path.dirname(filePath) !== path.dirname(newPath)) {
        moved.push({ project: p, from: filePath, to: newPath });
      }
    } catch (e) {
      oldNameRemaining.push({ project: p, filePath, error: readableError(e), detail: e.message });
    }
  }

  return {
    filePath: targetPath(project, targetName),
    name: targetName,
    oldName: existingEntry ? existingEntry.name : null,
    nameChanged,
    oldNameRemaining,
    // A move out of Claude Code's folder is reported like a rename move; a file it could not move is an error.
    moved: [...relocation.moved, ...moved],
    projects: added.agent.projects,
    membershipAdded: !wasMember,
    /* PARTIAL SUCCESS DOES NOT STAY SILENT which project could not be written goes back to
       the page and no success is shown. Membership having been established does not mean it is done everywhere. */
    publishErrors: [...relocation.errors, ...publish.errors],
  };
}

/** The agent definition files in a folder (the new store and the two older locations). */
function definitionFiles(folder) {
  const output = [];
  if (!folder) return output;
  for (const k of [BENCHOOK_FOLDER, ...OLD_FOLDERS]) {
    const place = path.join(folder, ...k);
    let names = [];
    try { names = fs.readdirSync(place).filter((x) => x.endsWith('.md')); } catch { continue; }
    for (const d of names) output.push(path.join(place, d));
  }
  return output;
}

/* Inspect a selected folder without writing files or registry records. Import is a separate approved action. List unreadable definitions with an error and mark them non-importable to prevent destructive round trips. */
function scanFolder(folder) {
  const found = [];
  for (const filePath of definitionFiles(folder)) {
    const name = path.basename(filePath, '.md');
    let raw;
    try { raw = fs.readFileSync(filePath, 'utf8'); }
    catch (e) { found.push({ name, filePath, importable: false, corrupt: readableError(e, 'read') }); continue; }
    const read = registry.fromFile(raw);
    if (read.corrupt) { found.push({ name, filePath, importable: false, corrupt: read.corrupt }); continue; }
    const realName = read.name || name;
    const existingEntry = registry.find(realName);
    found.push({
      name: realName, filePath, importable: true, corrupt: null,
      description: read.description || '', account: read.account || null, model: read.model || null,
      tools: read.tools || null,
      alreadyExists: !!existingEntry,
      alreadyHere: !!(existingEntry && registry.isInProject(existingEntry, folder)),
    });
  }
  return { folder: folder || null, found };
}

/* *
 * IMPORT WHAT THE USER SELECTED. A file that was not selected is not touched.
 *
 * The import goes through the same door as seeing an edit made outside (`changedOutside`): the agent
 * becomes active in the folder it sits in, and if the name already exists no SECOND person is created. */
function takeFromFolder(folder, names) {
  const selected = new Set((names || []).map((x) => registry.key(x)));
  const imported = [];
  const errors = [];
  for (const filePath of definitionFiles(folder)) {
    const fileName = path.basename(filePath, '.md');
    let raw;
    try { raw = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
    const read = registry.fromFile(raw);
    const name = (!read.corrupt && read.name) || fileName;
    if (!selected.has(registry.key(name))) continue;
    if (read.corrupt) { errors.push({ name, filePath, error: read.corrupt }); continue; }
    let r;
    try { r = externalChanged(folder, filePath); }
    catch (e) { errors.push({ name, filePath, error: readableError(e) }); continue; }
    if (r.error) { errors.push({ name, filePath, error: r.error }); continue; }
    imported.push({ name, isNew: !!r.isNew });
    for (const h of (r.errors || [])) errors.push({ name, ...h });
  }
  return { imported, errors };
}

/* *
 * SYNC EVERY OPEN PROJECT.
 *
 * The panel used to sync only the SELECTED project; a real edit sitting in a background project never
 * reached the centre and was overwritten by the next save. The main process calls this both when the
 * watching is set up and whenever the project changes.
 *
 * AN ERROR IN ONE PROJECT DOES NOT STOP THE OTHERS - as in reconcile. An unreadable project (deleted,
 * or an unmounted drive) is skipped silently: that is not an error, it is out of scope. */
function reconcileAll(projects) {
  const changed = [];
  const errors = [];
  const deletionCompleted = [];
  const deletionPending = [];
  const seen = new Set();
  for (const project of (projects || [])) {
    if (!project || seen.has(project)) continue;
    seen.add(project);
    let r;
    try { r = reconcile(project); }
    catch (e) { errors.push({ project, error: readableError(e), detail: e.message }); continue; }
    for (const d of r.changed) changed.push({ project, ...d });
    for (const h of r.errors) errors.push({ project, ...h });
    for (const a of r.deletionCompleted) deletionCompleted.push(a);
    for (const a of r.deletionPending) deletionPending.push(a);
  }
  return { changed, errors, deletionCompleted, deletionPending };
}

module.exports = {
  formFields,
  publishAgent, addToProject, removeFromProject, deleteFully, externalChanged, reconcile, reconcileAll,
  saveForm, scanFolder, takeFromFolder, targetPath, allowed, INTENTS, renameCopy, panelPath, inOldFolder,
};
