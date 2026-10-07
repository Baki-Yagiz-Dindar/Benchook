// SKILL REGISTRY - one record per skill; the project folders are written from here, never the
// other way round.
//
// WHY IT EXISTS a skill is a PERSON, on the same model as `agent-registry.js`. Its name
// is unique, it has the projects it belongs to, and changing it in one place changes it
// everywhere - regardless of which file it happens to live in.
//
// THE FILES STAY IN THE PROJECT. Measured: Claude loads the `.claude/skills/<name>` folder of the
// project and does not load `.agents/skills`; Codex reads `.agents/skills`. So to be
// installed in a project, a skill must physically sit on BOTH sides of that project. The registry
// knows which single source those copies were written from; that source (a full copy of the
// folder) lives under `skill-copies/<folderName>/` in the data folder of the panel - a skill is
// not necessarily one file, so a FOLDER is stored rather than a file.
//
// BELONGING AND EXISTING ARE SEPARATE: a skill used in no project stays in the registry, and
// removing it from a project deletes only the folders of that project.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const persistent = require('./persistent-json');

let file = null;      // the registry JSON
let copyRoot = null;  // the canonical folder copies

/** The panel calls this once at startup. */
function setup(registryPath, copiesRoot) { file = registryPath; copyRoot = copiesRoot; }

const empty = () => ({ skills: [] });
function read() {
  if (!file) return empty();
  const d = persistent.read(file, (x) => x && typeof x === 'object' && Array.isArray(x.skills));
  if (!d) return empty();
  return { skills: d.skills.filter((b) => b && typeof b.folderName === 'string' && b.folderName) };
}
function write(d) {
  if (!file) throw new Error('Skill registry path is not set.');
  persistent.write(file, { skills: d.skills });
}

/* Fold ASCII case for skill identities without locale-specific casing. The folder name is the provider-facing identity. */
const key = (name) => String(name || '').trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
const projectKey = (p) => path.resolve(String(p || '')).replace(/\\/g, '/').toLowerCase();

const list = () => read().skills.map((b) => ({ ...b, projects: [...(b.projects || [])] }));
const find = (folderName) => read().skills.find((b) => key(b.folderName) === key(folderName)) || null;
const isInProject = (b, project) => (b.projects || []).some((p) => projectKey(p) === projectKey(project));

/** The folder of the canonical copy. The name check matches the one in `skills.paths`: a folder name cannot carry a path. */
function copyPath(folderName) {
  if (!copyRoot) throw new Error('Skill copy root is not set.');
  if (typeof folderName !== 'string' || !folderName || folderName.startsWith('.') || /[\\/:]/.test(folderName) || /[. ]$/.test(folderName)) {
    throw new Error('Invalid skill folder name');
  }
  return path.join(copyRoot, folderName);
}

function add(record) {
  const d = read();
  if (d.skills.some((b) => key(b.folderName) === key(record.folderName))) {
    return { error: 'A skill named "' + record.folderName + '" already exists.' };
  }
  const created = { folderName: record.folderName, name: record.name || record.folderName, description: record.description || '',
    projects: [...new Set((record.projects || []).map((p) => path.resolve(p)))], digest: record.digest || null,
    seen: { ...(record.seen || {}) } };
  d.skills.push(created);
  write(d);
  return { skill: { ...created } };
}

function update(folderName, fields) {
  const d = read();
  const i = d.skills.findIndex((b) => key(b.folderName) === key(folderName));
  if (i < 0) return { error: 'No skill named "' + folderName + '".' };
  const old = d.skills[i];
  // Membership lives apart from content: this function never touches the projects field (the same rule as the agent registry).
  d.skills[i] = { ...old, ...fields, folderName: old.folderName, projects: old.projects || [] };
  write(d);
  return { skill: { ...d.skills[i] } };
}

function addToProject(folderName, project) {
  const d = read();
  const b = d.skills.find((x) => key(x.folderName) === key(folderName));
  if (!b) return { error: 'No skill named "' + folderName + '".' };
  if (!isInProject(b, project)) b.projects = [...(b.projects || []), path.resolve(project)];
  write(d);
  return { skill: { ...b } };
}

/* WHAT THE PANEL LAST SAW OR WROTE IN EACH PROJECT. Seeing a project is not editing it: a copy
   is only an edit when it differs from this digest, and only an edit is carried elsewhere. */
function markSeen(folderName, project, digest) {
  const d = read();
  const b = d.skills.find((x) => key(x.folderName) === key(folderName));
  if (!b) return;
  b.seen = { ...(b.seen || {}), [projectKey(project)]: digest || null };
  write(d);
}
const seenDigest = (b, project) => (b && b.seen && b.seen[projectKey(project)]) || null;

function removeFromProject(folderName, project) {
  const d = read();
  const b = d.skills.find((x) => key(x.folderName) === key(folderName));
  if (!b) return { error: 'No skill named "' + folderName + '".' };
  b.projects = (b.projects || []).filter((p) => projectKey(p) !== projectKey(project));
  write(d);
  return { skill: { ...b } };
}

function remove(folderName) {
  const d = read();
  const n = d.skills.length;
  d.skills = d.skills.filter((x) => key(x.folderName) !== key(folderName));
  if (d.skills.length === n) return { error: 'No skill named "' + folderName + '".' };
  write(d);
  let copy = null;
  try { copy = copyPath(folderName); fs.rmSync(copy, { recursive: true, force: true }); } catch { /* no copy is fine */ }
  return { deleted: true, copy };
}

module.exports = { setup, list, find, add, update, remove, addToProject, removeFromProject, isInProject,
  key, projectKey, copyPath, markSeen, seenDigest };
