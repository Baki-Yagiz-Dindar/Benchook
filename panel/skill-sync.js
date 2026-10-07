// SKILL PUBLISHING - writing from the single source in the registry into the folders of the member
// projects, and the reverse: taking a skill changed from outside in one project (by an orchestrator
// or an editor) into the registry and spreading it to the others. Same direction as `agent-sync.js`:
// THE ONE PLACE THAT IS WRITTEN is the canonical copy in the registry.
//
// skills follow the same model as agents - one list, project membership, and changing one
// in one place changes it everywhere. Built-ins sit underneath and cannot be touched.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const skills = require('./skills');
const registry = require('./skill-registry');
const operation = require('./folder-transaction');

const skillFile = (root) => path.join(root, 'SKILL.md');
// The same plain-language errors as agent publishing (no raw Node text, no internal temporary names).
const { readableError } = require('./readable-error');

/** The newest modification time in the folder (ms). For last-writer-wins: the content digest says
 *  whether two copies are equal, this says which came first. */
function lastChange(root) {
  let last = 0;
  const browse = (d) => {
    for (const g of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, g.name);
      if (g.isDirectory()) browse(p);
      else last = Math.max(last, fs.statSync(p).mtimeMs);
    }
  };
  try { browse(root); } catch { /* unreadable folder: 0 */ }
  return last;
}

/** Makes a source folder the canonical copy of the registry (atomically: a temporary folder, then a replace). */
function writeCanonical(folderName, sourceFolder) {
  const target = registry.copyPath(folderName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  operation.apply([{ target, prepare: (tmp) => skills.copyFolder(sourceFolder, tmp) }]);
  return target;
}

/** Writes the canonical copy to BOTH sides of a project. */
function writeToProject(folderName, project) {
  const source = registry.copyPath(folderName);
  if (!fs.existsSync(skillFile(source))) throw new Error('The registry copy of "' + folderName + '" is missing.');
  const targets = skills.paths(project, folderName);
  /* A side that already holds this exact content is not rewritten. Every publish used to replace both
     folders of every member project, and the staging folders it creates fire the folder watcher. */
  const want = skills.signature(source);
  const same = (target) => { try { return fs.existsSync(skillFile(target)) && skills.signature(target) === want; } catch { return false; } };
  const stale = targets.filter((target) => !same(target));
  if (stale.length) operation.apply(stale.map((target) => ({ target, prepare: (tmp) => skills.copyFolder(source, tmp) })));
  // What was just written is now what the panel knows is in this project.
  registry.markSeen(folderName, project, (registry.find(folderName) || {}).digest);
  return targets;
}

/** Writes the skill to every project it belongs to. A failure in one project does not stop the others. */
function publishAgent(folderName, skip = null) {
  const b = registry.find(folderName);
  if (!b) return { error: 'No skill named "' + folderName + '".' };
  const written = [], errors = [];
  for (const project of b.projects || []) {
    if (skip && registry.projectKey(skip) === registry.projectKey(project)) continue;
    try { written.push(...writeToProject(folderName, project)); }
    catch (e) { errors.push({ project, error: readableError(e) }); }
  }
  return { written, errors };
}

/* *
 * RECONCILE THE PROJECT WITH THE REGISTRY. For every skill sitting in the project:
 *  - not in the registry: its canonical copy is taken and it is entered with membership of this
 *    project (either a new skill was born outside, or the panel wrote per project in an older version);
 *  - in the registry but this project is not a member: membership is established (seeing the
 *    definition establishes membership, the rule);
 *  - content differs from the canonical: whichever was written more recently wins - if the project
 *    copy is newer it is taken into the registry and spread to the other members; if the canonical
 *    is newer it is rewritten into this project;
 *  - the two sides (Claude and Codex) have diverged within the project: this is what real life looks
 *    like, because an orchestrator edits only its own side. The side written more recently is taken
 *    as the source, entered into the registry and spread everywhere, including the other side of this
 *    project. If both sides were written at the same moment no decision is made; the user chooses on
 *    the screen (the existing "copies differ" path). */
function reconcile(project) {
  const result = { created: [], membership: [], imported: [], written: [], errors: [] };
  if (!project) return result;
  let existing;
  try { existing = skills.existing(project); } catch (e) { result.errors.push({ error: readableError(e) }); return result; }
  for (const x of existing) {
    let sourcePath = x.paths.claude || x.paths.codex;
    if (x.divergent) {
      const zc = lastChange(x.paths.claude), zx = lastChange(x.paths.codex);
      if (zc === zx) continue;                      // undecidable: the user chooses
      sourcePath = zc > zx ? x.paths.claude : x.paths.codex;
    }
    let digest;
    try { digest = skills.signature(sourcePath); } catch (e) { result.errors.push({ name: x.folderName, error: readableError(e) }); continue; }
    const record = registry.find(x.folderName);
    try {
      /* SEEING A PROJECT IS NOT EDITING IT. A skill met for the first
         time in a project -- new, or known from another project, or a member tracked before this
         rule -- is recorded as seen and nothing is written to any project. The panel's own
         registry copy is not a project file. */
      if (!record) {
        writeCanonical(x.folderName, sourcePath);
        const r = registry.add({ folderName: x.folderName, name: x.name, description: x.description, projects: [project], digest,
          seen: { [registry.projectKey(project)]: digest } });
        if (r.error) { result.errors.push({ name: x.folderName, error: r.error }); continue; }
        result.created.push(x.folderName);
        continue;
      }
      if (!registry.isInProject(record, project)) {
        registry.addToProject(x.folderName, project);
        registry.markSeen(x.folderName, project, digest);
        result.membership.push(x.folderName);
        continue;
      }
      const seen = registry.seenDigest(record, project);
      if (seen === digest) continue;   // unchanged since the panel last saw or wrote it here
      if (seen === null) {
        // Never tracked in this project: this copy is the only truth; take it, write nothing.
        if (record.digest !== digest) {
          writeCanonical(x.folderName, sourcePath);
          registry.update(x.folderName, { name: x.name, description: x.description, digest });
        }
        registry.markSeen(x.folderName, project, digest);
        continue;
      }
      const canonical = registry.copyPath(x.folderName);
      const hasCanonical = fs.existsSync(skillFile(canonical));
      if (!hasCanonical || lastChange(sourcePath) >= lastChange(canonical)) {
        // The project copy is newer: the outside change is taken into the registry and spread to the others.
        writeCanonical(x.folderName, sourcePath);
        registry.update(x.folderName, { name: x.name, description: x.description, digest });
        result.imported.push(x.folderName);
        const y = publishAgent(x.folderName, project);
        result.written.push(...y.written); result.errors.push(...y.errors.map((h) => ({ name: x.folderName, ...h })));
        // The other side, missing or stale in this project, is completed from the canonical copy too.
        result.written.push(...writeToProject(x.folderName, project));
      } else {
        result.written.push(...writeToProject(x.folderName, project));
      }
    } catch (e) { result.errors.push({ name: x.folderName, error: readableError(e) }); }
  }
  return result;
}

function reconcileAll(projects) {
  const total = { created: [], membership: [], imported: [], written: [], errors: [] };
  for (const p of projects || []) {
    if (!p) continue;
    // A project that cannot be read is reported, not dropped without a word.
    let s; try { s = reconcile(p); } catch (e) { total.errors.push({ project: p, error: readableError(e) }); continue; }
    for (const k of Object.keys(total)) total[k].push(...s[k]);
  }
  return total;
}

/** Full project scope of a form save; removal still uses only the selected project's paths. */
function savePaths(project, folderName) {
  const members = new Map();
  for (const p of [project, ...((registry.find(folderName) || {}).projects || [])]) {
    if (p) members.set(registry.projectKey(p), p);
  }
  return [...members.values()].flatMap((p) => skills.paths(p, folderName));
}

/** Saving from the form: written to this project (the existing door), taken into the registry, spread to the other members. */
function saveForm(project, folderName, content, sourceSide) {
  const r = skills.write(project, folderName, content, sourceSide);
  if (r.error) return r;
  try {
    const sourcePath = skills.paths(project, folderName)[0];
    writeCanonical(folderName, sourcePath);
    const b = skills.readTitle(content, folderName);
    const digest = skills.signature(sourcePath);
    if (registry.find(folderName)) registry.update(folderName, { name: b.name, description: b.description, digest });
    else registry.add({ folderName, name: b.name, description: b.description, projects: [project], digest });
    registry.addToProject(folderName, project);
    registry.markSeen(folderName, project, digest);   // the form just wrote this project's copy
    const y = publishAgent(folderName, project);
    return { ...r, written: [...(r.written || []), ...y.written], errors: y.errors,
      projects: (registry.find(folderName) || {}).projects || [] };
  } catch (e) { return { ...r, errors: [{ error: readableError(e) }] }; }
}

/** Adds a registry skill to a project: membership plus a write to both sides. */
function addToProject(folderName, project) {
  if (!registry.find(folderName)) return { error: 'No skill named "' + folderName + '".' };
  try {
    const written = writeToProject(folderName, project);
    registry.addToProject(folderName, project);
    return { written };
  } catch (e) { return { error: readableError(e) }; }
}

/** Removes it from a project: the two folders of that project are deleted and membership drops. The registry record and the other projects stand. */
function removeFromProject(folderName, project) {
  const r = skills.remove(project, folderName);
  if (r.error) return r;
  registry.removeFromProject(folderName, project);
  return r;
}

/** Deletes it everywhere. Membership of a project that could not be deleted REMAINS: the skill goes on living where its file still is. */
function deleteFully(folderName) {
  const b = registry.find(folderName);
  if (!b) return { error: 'No skill named "' + folderName + '".' };
  const removedPaths = [], errors = [];
  for (const project of b.projects || []) {
    const r = skills.remove(project, folderName);
    if (r.error && !r.absent) { errors.push({ project, error: r.error }); continue; }
    removedPaths.push(...(r.removedPaths || []));
    registry.removeFromProject(folderName, project);
  }
  const remaining = (registry.find(folderName) || {}).projects || [];
  if (!remaining.length) registry.remove(folderName);
  return { removedPaths, errors, pending: remaining, deleted: !remaining.length };
}

/**
 * Importing from a folder outside (another project, or the `~/.agents/skills` of the machine): with
 * no registry entry, a canonical copy plus a record; with one, membership only; then it is written to
 * this project. THE SOURCE FOLDER IS NOT TOUCHED - the original of the user stays as it is. */
function takeExternal(sourceFolder, project, folderName = null) {
  if (!sourceFolder || !project) return { error: 'Invalid request' };
  const name = folderName || path.basename(sourceFolder);
  if (!fs.existsSync(skillFile(sourceFolder))) return { error: 'Source does not contain SKILL.md: ' + sourceFolder };
  try {
    if (!registry.find(name)) {
      writeCanonical(name, sourceFolder);
      const b = skills.readTitle(fs.readFileSync(skillFile(sourceFolder), 'utf8'), name);
      const r = registry.add({ folderName: name, name: b.name, description: b.description, projects: [], digest: skills.signature(sourceFolder) });
      if (r.error) return r;
    }
    return { ...addToProject(name, project), folderName: name };
  } catch (e) { return { error: readableError(e) }; }
}

/** Skills sitting on the machine that the panel does not manage: `~/.agents/skills`, `~/.claude/skills`.
 *  Symlinks are skipped, and the same folder name is counted once. Measured: the panel terminals of
 *  Claude do NOT load these, while those of Codex load them in every project. Once added to a project
 *  they are identical on both sides, which is why they are candidates for "add to this project". */
function machineSkills() {
  const seen = new Map();
  for (const root of [path.join(os.homedir(), '.agents', 'skills'), path.join(os.homedir(), '.claude', 'skills')]) {
    for (const b of skills.scan(root)) {
      if (seen.has(registry.key(b.folderName))) continue;
      seen.set(registry.key(b.folderName), { ...b, source: 'machine' });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'en-US'));
}

/** The own skills of the provider - READ ONLY. Those of Codex are on disk (`<CODEX_HOME>/skills/.system`,
 *  measured); those of Claude are not on disk, so their names are not stated, only their existence. */
function builtins(codexFolders, defaultHomeIncluded = true) {
  const roots = [...(defaultHomeIncluded ? [path.join(os.homedir(), '.codex')] : []), ...(codexFolders || [])];
  const seen = new Map();
  for (const root of roots) {
    if (!root) continue;
    for (const b of skills.scan(path.join(root, 'skills', '.system'))) {
      if (seen.has(registry.key(b.folderName))) continue;
      seen.set(registry.key(b.folderName), { ...b, provider: 'codex', builtin: true });
    }
  }
  return { codex: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'en-US')),
    claudeNote: "Claude also ships built-in skills; they are not stored on disk, so Benchook cannot list or edit them." };
}

module.exports = { reconcile, reconcileAll, publishAgent, saveForm, savePaths, addToProject, removeFromProject, deleteFully,
  takeExternal, machineSkills, builtins, writeCanonical, writeToProject };
