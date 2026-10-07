// PROJECT SKILLS - scans, adds, edits and removes the skills of a project.
//
// Whenever a skill enters the system it must be created identically for both Claude and Codex, so
// that continuing the same project from the other orchestrator the next day needs no extra work.
//
// Provider-specific project skill directories:
//
//   <project>/.claude/skills/  -> Claude SEES it,  Codex does not
//   <project>/.agents/skills/  -> Codex SEES it,   Claude does not
//   ~/.agents/skills/          -> both see it (~/.claude/skills is junctioned there)
//
// There is no SHARED folder at project level. The panel therefore writes every skill to BOTH
// places and keeps them identical. A junction was tried and rejected: it needs no administrator
// rights, but git records the same file under two paths, and when the repository is cloned on
// another machine the link breaks into a copy - so the promise of staying in sync cannot be kept.
//
// THE PANEL DOES NOT PAPER OVER, IT SHOWS: a skill present on one side only, or whose copies have
// diverged, is not hidden; it is written on the card. That is safety contract of the panel.

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const operation = require('./folder-transaction');

/** Which side looks where at project level. Measured, not assumed. */
const SIDES = { claude: ['.claude', 'skills'], codex: ['.agents', 'skills'] };

const folder = (project, side) => path.join(project, ...SIDES[side]);
const skillPath = (project, side, name) => path.join(folder(project, side), name);
const skillFile = (root) => path.join(root, 'SKILL.md');

function paths(project, name) {
  if (!project || typeof name !== 'string' || !name || name.startsWith('.') || /[\\/:]/.test(name) || /[. ]$/.test(name)) throw new Error("Invalid skill folder name");
  const root = path.resolve(project);
  return Object.keys(SIDES).map(t => {
    const target = path.resolve(skillPath(root, t, name));
    // No write or delete may reach outside the project through a junction or a symlink.
    let p = target;
    while (p !== root) {
      if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error("Cannot modify a linked skill folder: " + p);
      p = path.dirname(p);
    }
    return target;
  });
}

function signature(root, helper = false) {
  const hash = createHash('sha256');
  function browse(d, relative) {
    for (const g of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (helper && !relative && g.name === 'SKILL.md') continue;
      const rel = relative + g.name;
      hash.update(JSON.stringify([rel, g.isDirectory()]));
      if (g.isSymbolicLink()) throw new Error("Skill contains a symbolic link: " + rel);
      if (g.isDirectory()) browse(path.join(d, g.name), rel + '/');
      else hash.update(createHash('sha256').update(fs.readFileSync(path.join(d, g.name))).digest());
    }
  }
  browse(root, '');
  return hash.digest('hex');
}

/** `name` and `description` are read from the front matter; without them the folder name is used. */
function readTitle(content, defaultName) {
  const press = String(content || '').split('\n---', 2)[0] || '';
  const lines = press.split(/\r?\n/);
  const get = (field) => {
    const i = lines.findIndex((l) => l.startsWith(field + ':'));
    if (i < 0) return null;
    let value = lines[i].slice(field.length + 1).trim();
    /* A FOLDED BLOCK (`description: >` or `|`) - seen in a real skill: the value is on the following
       indented lines, and the ">" marker itself is not the description. */
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const part = [];
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) part.push(lines[j].trim());
      return part.join(' ').trim() || null;
    }
    // The built-in SKILL.md files of Codex write the value in quotes (measured: `name: "imagegen"`);
    // in YAML the quotes are not part of the value, and they must not appear on screen either.
    // A double-quoted value written by Benchook is a JSON string: escapes are read back, not shown.
    if (/^".*"$/.test(value)) { try { return String(JSON.parse(value)).trim() || null; } catch { /* plain below */ } }
    return value.replace(/^(["'])(.*)\1$/, '$2').trim() || null;
  };
  return { name: get('name') || defaultName, description: get('description') || '' };
}

function readSkill(root, folderName) {
  let content;
  try { content = fs.readFileSync(skillFile(root), 'utf8'); } catch { return null; }
  let files = [];
  try { files = fs.readdirSync(root); } catch { /* unreadable: count it as a single file */ }
  const b = readTitle(content, folderName);
  return { ...b, folderName, content, fileCount: files.length, filePath: root };
}

/** Reads every skill in a folder. A missing folder gives an empty list - it is not an error. */
function scan(root) {
  let signIns;
  try { signIns = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const output = [];
  for (const g of signIns) {
    if (!g.isDirectory() || g.name.startsWith('.')) continue;
    const b = readSkill(path.join(root, g.name), g.name);
    if (b) output.push(b);
  }
  return output;
}

/**
 * The skills of the project, with THE TWO SIDES MERGED.
 *
 * Every row carries which sides it exists on and whether the two copies are IDENTICAL.
 * Divergence is not hidden: if a skill of the same name behaves differently under the two
 * orchestrators, the user needs to see it.
 */
function existing(project) {
  if (!project) return [];
  const map = new Map();
  for (const side of Object.keys(SIDES)) {
    for (const b of scan(folder(project, side))) {
      const k = map.get(b.folderName) || {
        name: b.name, folderName: b.folderName, description: b.description,
        sides: [], paths: {}, contents: {}, fileCount: b.fileCount,
      };
      k.sides.push(side);
      k.paths[side] = b.filePath;
      k.contents[side] = b.content;
      if (!k.description) k.description = b.description;
      map.set(b.folderName, k);
    }
  }
  return [...map.values()].map((k) => ({
    name: k.name,
    folderName: k.folderName,
    description: k.description,
    sides: k.sides,
    paths: k.paths,
    content: k.contents.claude || k.contents.codex,
    fileCount: k.fileCount,
    missingSide: Object.keys(SIDES).filter((t) => !k.sides.includes(t)),
    divergent: k.sides.length === 2 && (() => {
      try { return signature(k.paths.claude) !== signature(k.paths.codex); } catch { return true; }
    })(),
  })).sort((a, b) => a.name.localeCompare(b.name, "en-US"));
}

/** Copies a folder as it is - a skill is not necessarily a single file. */
function copyFolder(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const g of fs.readdirSync(source, { withFileTypes: true })) {
    if (g.isSymbolicLink()) throw new Error("Skill contains a symbolic link: " + g.name);
    const k = path.join(source, g.name);
    const h = path.join(target, g.name);
    if (g.isDirectory()) copyFolder(k, h);
    else fs.copyFileSync(k, h);
  }
}

/**
 * Adds the skill to the project - to BOTH SIDES, with the same content.
 * If one side is written and the other fails, NO HALF JOB is left behind: what was written is rolled back.
 */
function add(project, sourceFolder, folderName) {
  if (!project || !sourceFolder) return { error: "Invalid request" };
  const name = folderName || path.basename(sourceFolder);
  if (!fs.existsSync(skillFile(sourceFolder))) {
    return { error: "Source does not contain SKILL.md: " + sourceFolder };
  }
  let targets;
  try { targets = paths(project, name); } catch (e) { return { error: e.message }; }
  const existingEntry = targets.filter((h) => fs.existsSync(h));
  if (existingEntry.length) return { error: '"' + name + "\" already exists in this project", existingEntry };

  try {
    let snapshot;
    const r = operation.apply(targets.map(target => ({ target, prepare: tmp => {
      copyFolder(snapshot || sourceFolder, tmp); snapshot ||= tmp;
    } })));
    return { written: targets, ...r };
  } catch (e) {
    return { error: "Could not copy: " + e.message };
  }
}

/** Updates the SKILL.md content on BOTH SIDES at once. This is how divergence is prevented. */
function write(project, folderName, content, sourceSide) {
  if (!project || !folderName || typeof content !== 'string') return { error: "Invalid request" };
  if (!content.trim()) return { error: "Skill instructions cannot be empty" };
  try {
    const targets = paths(project, folderName);
    const existingEntry = targets.filter(h => fs.existsSync(skillFile(h)));
    if (sourceSide && !SIDES[sourceSide]) throw new Error("Unknown source provider");
    if (!sourceSide && existingEntry.length === 2 && signature(existingEntry[0], true) !== signature(existingEntry[1], true)) {
      throw new Error("Supporting files differ. Choose the source to keep.");
    }
    const source = sourceSide ? skillPath(project, sourceSide, folderName) : existingEntry[0];
    if (sourceSide && !fs.existsSync(skillFile(source))) throw new Error("The selected source does not contain this skill");
    let snapshot;
    const r = operation.apply(targets.map(target => ({ target, prepare: tmp => {
      if (snapshot || source) copyFolder(snapshot || source, tmp);
      fs.writeFileSync(skillFile(tmp), content, 'utf8');
      snapshot ||= tmp;
    } })));
    return { written: targets.map(skillFile), ...r };
  } catch (e) {
    return { error: "Could not save: " + e.message };
  }
}

/** Removes the skill from the project - from both sides. The files ARE DELETED; approval is taken on the page. */
function remove(project, folderName) {
  if (!project || !folderName) return { error: "Invalid request" };
  try {
    const removedPaths = paths(project, folderName).filter(p => fs.existsSync(p));
    // `absent` lets a caller tell "nothing to delete" apart from a failure without reading the sentence.
    if (!removedPaths.length) return { error: "This skill is not in this project", absent: true };
    const result = operation.apply(removedPaths.map(target => ({ target, remove: true })));
    return { removedPaths, ...result };
  } catch (e) { return { error: "Could not delete: " + e.message, removedPaths: [] }; }
}

/** SYNCS a skill that is missing on one side or has diverged: which side is right is passed in. */
function syncSkill(project, folderName, sourceSide) {
  if (!SIDES[sourceSide]) return { error: "Unknown source provider" };
  try { paths(project, folderName); } catch (e) { return { error: e.message }; }
  const source = skillPath(project, sourceSide, folderName);
  if (!fs.existsSync(skillFile(source))) return { error: "The source provider does not contain this skill" };
  const targetSide = Object.keys(SIDES).find((t) => t !== sourceSide);
  const target = skillPath(project, targetSide, folderName);
  try {
    const r = operation.apply([{ target, prepare: tmp => copyFolder(source, tmp) }]);
    return { synced: target, source, ...r };
  } catch (e) { return { error: "Could not synchronize: " + e.message }; }
}

/**
 * Completes one-sided skills with the only safe reading: the side that exists is taken as the source
 * and the whole folder is copied to the missing side. When two copies exist it makes no automatic
 * choice; if they differ, the user decides which one is right.
 */
function completeMissing(project) {
  const result = { synced: [], errors: [] };
  for (const x of existing(project).filter((b) => b.sides.length === 1)) {
    const sourceSide = x.sides[0];
    const targetSide = Object.keys(SIDES).find((t) => t !== sourceSide);
    const target = skillPath(project, targetSide, x.folderName);
    // A missing SKILL.md does not mean the folder is empty. The automatic path is safe only when the
    // target does not exist at all; otherwise unrecognised files are preserved and reported.
    try {
      fs.lstatSync(target);
      result.errors.push({ name: x.name, targetSide,
        error: "The destination folder already exists. Its contents were preserved" });
      continue;
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        result.errors.push({ name: x.name, targetSide, error: "Could not inspect destination: " + e.message });
        continue;
      }
    }
    const r = syncSkill(project, x.folderName, sourceSide);
    if (r.error) result.errors.push({ name: x.name, targetSide, error: r.error });
    else result.synced.push({ name: x.name, source: r.source, target: r.synced });
  }
  return result;
}

module.exports = {
  SIDES, folder, skillPath,
  scan, existing, add, write, remove, syncSkill, completeMissing, readTitle,
  paths, signature, copyFolder,   // skill-sync uses these same doors and writes no second copy
};
