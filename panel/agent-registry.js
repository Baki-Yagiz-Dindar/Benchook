// AGENT REGISTRY - one record per agent. The project files are written from here, never the other
// way round.
//
// WHY IT EXISTS: an agent is a PERSON in this system. Changing the account of an agent in one
// project is not something specific to that project; it is specific to that agent.
//
// THE NAME IS THE IDENTITY. A name is unique and identifies the agent; two projects cannot own two
// different agents under the same name. Creating a second agent with an existing name is refused,
// not merged.
//
// THE FILES DO NOT DISAPPEAR. The catalogue hook and the worker server definition read from INSIDE
// the project, so the file has to sit there physically. Global here means the panel keeps one true
// source and writes those files from it.
//
// BEING IN A PROJECT AND EXISTING ARE SEPARATE. An agent may be used in no project at all and still
// stay in the registry: an agent not being used does not mean it is dead. Removing it from a
// project deletes only the file of that project.

'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const persistent = require('./persistent-json');
const resolution = require('./agent-resolution');

let file = null;

/** Says where the registry will live. The panel calls this once at startup. */
function setup(filePath) { file = filePath; }

const empty = () => ({ agents: [] });

function read() {
  if (!file) return empty();
  const d = persistent.read(file, (x) => x && typeof x === 'object' && Array.isArray(x.agents));
  if (!d || !Array.isArray(d.agents)) return empty();
  return { agents: d.agents.filter((a) => a && typeof a.name === 'string' && a.name) };
}

function write(d) {
  if (!file) throw new Error('Agent registry path is not set.');
  persistent.write(file, { agents: d.agents });
}

/* Normalize names by folding ASCII A-Z only. Locale-sensitive case mapping must not change registry identity. */
const key = (name) => String(name || '').trim().replace(/[A-Z]/g, (c) => c.toLowerCase());

const list = () => read().agents.map((a) => ({ ...a }));
const find = (name) => read().agents.find((a) => key(a.name) === key(name)) || null;

/** Is the name usable. If not, THE REASON is returned; the caller shows that text to the user. */
function nameSuitable(name, ownName = null) {
  const clean = String(name || '').trim();
  if (!clean) return "Enter a name for the agent.";
  if (!/^[A-Za-z0-9._-]+$/.test(clean)) {
    return "Use only letters, digits, dot, dash and underscore in an agent name.";
  }
  const existingEntry = find(clean);
  if (existingEntry && key(existingEntry.name) !== key(ownName || '')) {
    return "An agent named \"" + existingEntry.name + "\" already exists. Agent names are shared across "
         + "every project, so pick a different name.";
  }
  return null;
}

/* Preserve unowned front-matter fields and comments when editing a definition. Provider options and future fields must survive a round trip. */
const KNOWN_FIELDS = ['schema', 'name', 'description', 'model', 'account', 'provider', 'tools'];

/** The fields kept in the registry. NOT ONE field varies per project; that is the rule. */
function normalizeRecord(source) {
  const t = (x) => String(x == null ? '' : x).replace(/[\r\n]+/g, ' ').trim();
  return {
    name: t(source.name),
    description: t(source.description),
    account: t(source.account) || resolution.ORCHESTRATOR,
    provider: t(source.provider) || null,
    model: t(source.model) || resolution.ORCHESTRATOR,
    /* NO LINE IS A CHOICE : '' is the default level and stays ''. Only a record that has no
       tools field at all - one written before the field existed - gets the former line, read-only as it was. */
    tools: source.tools == null ? 'Read, Grep, Glob, Bash' : t(source.tools),
    task: String(source.task == null ? '' : source.task).trim(),
    /* THESE BELONG TO THE AGENT, not to a project: because the agent is the same person in every
       project, the fields carried along are the same in every project too. They are kept as raw
       lines, because the panel does NOT UNDERSTAND them, and reformatting what you do not
       understand is the door to losing it. */
    extraFrontmatter: Array.isArray(source.extraFrontmatter)
      ? source.extraFrontmatter.map(String).filter((s) => s.trim()) : [],
    /* WHAT WAS LAST WRITTEN TO EACH TARGET. Not a field of the agent but the own bookkeeping
       of the panel: `{digest, pending}` per project. It is not an AGENT field that varies per project,
       so that rule still holds; this is the memory of the panel about what it put there and whether
       it managed to. */
    syncState: (source.syncState && typeof source.syncState === 'object'
      && !Array.isArray(source.syncState)) ? { ...source.syncState } : {},
    /* A DELETION LEFT HALF DONE. Not a field of the agent but the own memory of the panel:
       that a deletion of this record was started and could not finish. While it is set, the record
       does not behave like a normal agent: it does not publish, it cannot be added to a project, it
       does not appear in the list as addable, and a leftover file of it does not count as a new agent
       during a scan. `projects` then carries ONLY the targets that could not be deleted - the list of
       work to retry. */
    deletionPending: !!source.deletionPending,
    /* PROJECTS HOLDING A DIFFERENT AGENT UNDER THIS NAME. Keyed by
       project; each entry is where the other definition was found. While any exist the agent is
       locked: nothing but a rename of one copy is allowed, so neither can be changed by mistake. */
    nameConflicts: (source.nameConflicts && typeof source.nameConflicts === 'object'
      && !Array.isArray(source.nameConflicts)) ? { ...source.nameConflicts } : {},
    projects: Array.isArray(source.projects) ? [...new Set(source.projects.map(String))] : [],
  };
}

/** A short content digest. Answers whether two things are the same without copying the full text into the registry. */
const summarize = (text) => crypto.createHash('sha256')
  .update(String(text == null ? '' : text), 'utf8').digest('hex').slice(0, 32);

/**
 * Records the outcome AFTER a write to a project was ATTEMPTED.
 *
 * On success the digest of that project is refreshed and the pending flag is cleared. ON FAILURE THE
 * DIGEST IS LEFT UNTOUCHED - because the file sitting in that project is still the content last
 * written SUCCESSFULLY, and that is exactly what we want to know.
 */
function savePublish(name, project, { succeeded, content }) {
  const d = read();
  const a = d.agents.find((x) => key(x.name) === key(name));
  if (!a) return;
  const k = projectKey(project);
  const previous = (a.syncState && a.syncState[k]) || {};
  const next = succeeded
    ? { digest: summarize(content), pending: false }
    : { digest: previous.digest || null, pending: true };
  // Unchanged state is not written again: every publish called this once per project, and each write
  // rewrites the whole registry and its backup, flushed to disk.
  if (previous.digest === next.digest && previous.pending === next.pending) return;
  a.syncState = { ...(a.syncState || {}), [k]: next };
  write(d);
}

/* Treat a project file as a stale failed-publish copy only when the write is pending and its digest still matches the last successful output. Without origin data, treat the file as an external edit. */
/** Digest of the content the panel last saw or wrote for this agent in this project; null if it
    has never tracked one there. */
function seenDigest(record, project) {
  const status = record && record.syncState && record.syncState[projectKey(project)];
  return (status && status.digest) || null;
}

function isOldCopy(record, project, raw) {
  const status = record && record.syncState && record.syncState[projectKey(project)];
  if (!status || !status.pending || !status.digest) return false;
  return status.digest === summarize(raw);
}

function add(source) {
  const error = nameSuitable(source && source.name);
  if (error) return { error };
  const d = read();
  d.agents.push(normalizeRecord(source));
  write(d);
  return { agent: find(source.name) };
}

/**
 * Updates an existing agent. The name can change too; a new name belonging to someone else is refused.
 * The returned `projects` tells the caller which project files to rewrite.
 */
function update(name, fields) {
  const d = read();
  const i = d.agents.findIndex((a) => key(a.name) === key(name));
  if (i < 0) return { error: "No agent named \"" + name + "\"." };
  const newName = fields && fields.name ? fields.name : d.agents[i].name;
  const error = nameSuitable(newName, d.agents[i].name);
  if (error) return { error };
  /* AN EXPLICIT EDIT CANCELS A PENDING DELETION. The only place that sets the flag is the
     delete path; the user pressing Save in the form means the agent is to exist, and a half-finished
     deletion ends there. Otherwise a single undeletable file would trap the agent in a permanently
     unusable record. */
  d.agents[i] = normalizeRecord({ ...d.agents[i], ...fields, name: newName,
    projects: d.agents[i].projects, deletionPending: false });
  write(d);
  return { agent: { ...d.agents[i] } };
}

/** Removes the agent from the registry entirely. Returns TO THE CALLER which projects it affected. */
function remove(name) {
  const d = read();
  const a = d.agents.find((x) => key(x.name) === key(name));
  if (!a) return { error: "No agent named \"" + name + "\"." };
  d.agents = d.agents.filter((x) => key(x.name) !== key(name));
  write(d);
  return { deleted: a.name, projects: a.projects };
}

/* Retain a pending-deletion record until every target is removed. Remaining files must not be reimported as new agents; projects lists only the targets still requiring deletion. */
function markDeletion(name, remaining) {
  const d = read();
  const a = d.agents.find((x) => key(x.name) === key(name));
  if (!a) return { error: "No agent named \"" + name + "\"." };
  const list = Array.isArray(remaining) ? [...new Set(remaining.map(String))] : [];
  a.projects = list;
  a.deletionPending = true;
  // The origin data of the targets that could be deleted goes too; they are no longer publish targets.
  const remainingTargets = new Set(list.map((x) => projectKey(x)));
  a.syncState = Object.fromEntries(
    Object.entries(a.syncState || {}).filter(([k]) => remainingTargets.has(k)));
  write(d);
  return { agent: { ...a } };
}

const projectKey = (p) => path.resolve(String(p || '')).replace(/\\/g, '/').toLowerCase();

/** Makes the agent ACTIVE in a project. The caller writes the file; this only keeps the record. */
function addToProject(name, project) {
  const d = read();
  const a = d.agents.find((x) => key(x.name) === key(name));
  if (!a) return { error: "No agent named \"" + name + "\"." };
  if (!a.projects.some((p) => projectKey(p) === projectKey(project))) a.projects.push(project);
  write(d);
  return { agent: { ...a } };
}

/** Records that `project` holds a different agent under this name. */
function markConflict(name, project, digest) {
  const d = read();
  const a = d.agents.find((x) => key(x.name) === key(name));
  if (!a) return;
  const k = projectKey(project), entry = { project: path.resolve(String(project)), digest: digest || null };
  const old = a.nameConflicts && a.nameConflicts[k];
  // Reconcile marks the same lock on every pass; only a new or changed lock is written.
  if (old && old.project === entry.project && old.digest === entry.digest) return;
  a.nameConflicts = { ...(a.nameConflicts || {}), [k]: entry };
  write(d);
}
function clearConflict(name, project) {
  const d = read();
  const a = d.agents.find((x) => key(x.name) === key(name));
  if (!a || !a.nameConflicts || !a.nameConflicts[projectKey(project)]) return;
  a.nameConflicts = { ...a.nameConflicts };
  delete a.nameConflicts[projectKey(project)];
  write(d);
}
const conflictIn = (a, project) => !!(a && a.nameConflicts && a.nameConflicts[projectKey(project)]);
const hasConflict = (a) => !!(a && a.nameConflicts && Object.keys(a.nameConflicts).length);
const conflictProjects = (a) => Object.values((a && a.nameConflicts) || {}).map((x) => x.project);

/** Removes it from that project only. THE AGENT IS NOT DELETED - an explicit decision of the user. */
function removeFromProject(name, project) {
  const d = read();
  const a = d.agents.find((x) => key(x.name) === key(name));
  if (!a) return { error: "No agent named \"" + name + "\"." };
  a.projects = a.projects.filter((p) => projectKey(p) !== projectKey(project));
  // The origin data of the removed project goes too; it is no longer a target.
  if (a.syncState) { a.syncState = { ...a.syncState }; delete a.syncState[projectKey(project)]; }
  write(d);
  return { agent: { ...a } };
}

const isInProject = (a, project) =>
  !!(a && (a.projects || []).some((p) => projectKey(p) === projectKey(project)));

/**
 * The content of the project file, built from the registry record. The format stays THE SAME as
 * before: the catalogue hook and the worker server read this front matter, and changing it breaks
 * them.
 *
 * The project-specific guidance section is NO LONGER WRITTEN: such a request can be given to the
 * orchestrator directly when the agent is assigned its task. With that, the last field that varied
 * per project is gone and there is nothing left to drift apart.
 */
function text(a) {
  const press = ['---', 'schema: panel-agent/v1', 'name: ' + a.name,
    'description: ' + (a.description || ''), 'model: ' + (a.model || resolution.ORCHESTRATOR),
    'account: ' + (a.account || resolution.ORCHESTRATOR)];
  if (a.provider) press.push('provider: ' + a.provider);
  /* The default level ('') writes no line, the way the agent file of the provider itself says "everything".
     A record with no tools field at all gets the former line, the same rule as `normalizeRecord`. */
  const tools = a.tools == null ? 'Read, Grep, Glob, Bash' : String(a.tools).trim();
  if (tools) press.push('tools: ' + tools);
  /* FIELDS THE PANEL DOES NOT KNOW GO LAST, IN THE ORDER THEY ARRIVED. Order carries no
     meaning in front matter, but it has to be STABLE: otherwise the sync would think the file had
     changed and rewrite it on every project open. */
  for (const block of a.extraFrontmatter || []) press.push(block);
  press.push('---');
  return [...press, '', String(a.task || '').trim(), ''].join('\n');
}

/* The two headings the panel has written so far. Other sections the user wrote by hand are NOT
   TOUCHED; they are part of the task. */
const PROJECT_SECTION = /^##[ \t]+(Bu projede neye dikkat edeceksin|Project-specific guidance)[ \t]*$/i;

/** Removes the project-specific section, and only that, from the body. Other headings stay as they are. */
function discardProjectSection(body) {
  const lines = String(body || '').split(/\r?\n/);
  const press = lines.findIndex((s) => PROJECT_SECTION.test(s));
  if (press < 0) return lines.join('\n').trim();
  let last = lines.length;
  for (let i = press + 1; i < lines.length; i++) {
    if (/^##[ \t]+\S/.test(lines[i])) { last = i; break; }
  }
  return [...lines.slice(0, press), ...lines.slice(last)].join('\n').trim();
}

/* *
 * Turns a project file into a registry record - used during migration and on an outside edit.
 *
 * IF `corrupt` COMES BACK SET, THE CALLER DOES NOT TOUCH THAT FILE. The panel takes
 * a definition into the registry only when it is SURE it can write it back; publishing what it took
 * while unsure would mean deleting everything in the file that the panel could not read. A diagnosis
 * is given and the file is left exactly as it is. */
function fromFile(raw) {
  const { get, body, entries, corrupt } = resolution.parseFrontmatter(raw);
  if (corrupt) return { corrupt, name: '', task: '', extraFrontmatter: [], projects: [] };

  const extraFrontmatter = [];
  for (const g of entries) {
    if (g.key && KNOWN_FIELDS.includes(g.key)) {
      /* THE PANEL CANNOT SQUEEZE the multi-line value OF A KNOWN FIELD onto one line. Trying would
         break the formatting the user wrote, so the file is not touched at all. */
      if (!resolution.singleLines(g)) {
        return { corrupt: 'Benchook cannot rewrite the multi-line value of "' + g.key
          + '" without changing it.', name: '', task: '', extraFrontmatter: [], projects: [] };
      }
      continue;
    }
    extraFrontmatter.push(g.lines.join('\n'));
  }

  return {
    corrupt: null,
    extraFrontmatter,
    name: get('name') || '',
    description: get('description') || '',
    account: get('account') || resolution.ORCHESTRATOR,
    provider: get('provider') || null,
    model: get('model') || resolution.ORCHESTRATOR,
    // What the file says, nothing filled in: an agent written from a terminal shows the way it was written.
    tools: get('tools') || '',
    /* ONLY THE PROJECT-SPECIFIC SECTION IS DROPPED, NOT everything after the first heading.
       The first version of the rule cut at the first `##` heading, and the migration preview showed
       that this deleted real content: one agent had four legitimate sections in its body and the file
       fell from 73 lines to 12; another had a limits section. Only the two headings the panel writes
       itself are targeted now, and the cut runs to the NEXT heading at the same level. */
    task: discardProjectSection(body),
    projects: [],
  };
}

module.exports = {
  setup, list, find, nameSuitable, add, update, remove, markDeletion,
  addToProject, removeFromProject, isInProject, text, fromFile, key, projectKey,
  summarize, savePublish, isOldCopy, seenDigest,
  markConflict, clearConflict, conflictIn, hasConflict, conflictProjects,
};
