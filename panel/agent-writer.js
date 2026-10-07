// CREATING AN AGENT FROM THE PANEL - the side that BUILDS the file.
//
// A panel agent is written in the shared `panel-agent/v1` shape that both orchestrators can read.
//
// IN TERMS OF THE safety constraints:
// - `write` is called only after the page has taken APPROVAL; `preview` writes nothing and
//   returns the full content and path of the file that would be written. Overwriting an existing
//   file has to be asked for separately.
// - Nothing is sent to the orchestrator. The panel only prepares the call text; putting it into the
//   terminal is the job of the user.
// - Every agent gets a chosen ACCOUNT and MODEL, so that the token of the main account is preserved
//   and the work is spread across other accounts.
// - The file is written once under `.benchook/agents/` and carries the required `account:` and
//   `model:` in its front matter. If the orchestrator is on the same account of the same provider it
//   runs it as a local agent. Otherwise the same definition is run on the target account by the tool
//   of the panel (`tools/mcp-server.js`) through `run_agent`.
// - A Codex model can be chosen now, because the worker runs through `codex exec` on Codex and that
//   path was tried against a real run (text came back, with a token count). The older restriction
//   (Codex keeps no sub-agent record) applied only to the SUB-AGENT path.

const fs = require('node:fs');
const path = require('node:path');
const accounts = require('./accounts');
const resolution = require('./agent-resolution');
const mcpStatus = require('./mcp-status');

/** The sentence shown when the ASSIGNED account of the agent is signed out; null otherwise.
 *  For an agent bound to the orchestrator there is nothing to say: the panel does not know that
 *  account, the orchestrator does. */
function setupSignInWarning(fileAccount) {
  const record = fileAccount ? accounts.findLoose(fileAccount) : null;
  if (!record || accounts.hasSignIn(record)) return null;
  return mcpStatus.MESSAGE.signInNone(record.name || record.id);
}
// Resolving the target path in one place the preview and the write must point at the same file.
const sync = require('./agent-sync');
const registry = require('./agent-registry');

/* CLAUDE MODELS. The list used to hold only ALIASES, and an alias always gives the NEWEST member of
   its family, so a specific version could not be chosen at all.

   THE TWO FAMILIES ARE KEPT APART, and so are their names:
     an alias ('sonnet')             -> the newest of that family; it shifts when a version changes
     a full name ('claude-sonnet-5') -> exactly that version, fixed
   `claude --model` accepts both; read from the `claude --help` output, not invented.

   THE FULL NAMES ARE NOT INVENTED: they are the identities the Claude Code on this machine knows.
   The list goes stale when the provider ships a new version - if the panel writes a wrong name the
   CLI refuses it by name and does not silently fall back to another model (measured). `default` means
   sending no model at all: the own setting of the user applies. */
/* ONLY NAMED VERSIONS ARE OFFERED (user decision, 6 October 2026: "only model names and their versions").
   The family names Claude Code also accepts (`opus`, `sonnet`,...) are not offered; an agent saved with one
   keeps working and is shown with the version it currently stands for (`claudeLatest`). */
const CLAUDE_MODELS = [
  'default',
  'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5',
];
const CLAUDE_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];

/* *
 * THE CLAUDE MODELS OF AN ACCOUNT, as Claude Code itself last fetched them . The list
 * above was the only source and went stale when a model came out. Claude Code saves the catalog it gets
 * from its server in `<profile>/cache/model-catalog/*-cc.json` (measured on 2.1.280: `catalog.config
 *.models`, each with `id`, `name` and `section` "main" or "overflow"). Reading it sends nothing and
 * costs no token; it is as fresh as the last time that account ran Claude Code. The current models
 * come first, the older ones after. With no readable catalog the built-in list is the answer.
 * @param {string|null} profileFolder  the `CLAUDE_CONFIG_DIR` of the account
 * @returns {string[]} */
function claudeModels(profileFolder) {
  const newest = claudeCatalog(profileFolder);
  if (!newest) return CLAUDE_MODELS;
  const ids = (main) => newest.models
    .filter((m) => m && typeof m.id === 'string' && /^claude-[a-z0-9-]+$/.test(m.id) && (m.section === 'main') === main)
    .map((m) => m.id);
  const full = [...new Set([...ids(true), ...ids(false)])];
  return full.length ? ['default', ...full] : CLAUDE_MODELS;
}

/** The newest catalog Claude Code saved for this account (`{at, models}`), or null. */
function claudeCatalog(profileFolder) {
  if (!profileFolder) return null;
  const folder = path.join(profileFolder, 'cache', 'model-catalog');
  let names;
  /* BOTH CLAUDE CODE SURFACES. The command line saves `*-cc.json`, the desktop app `*-ccd.json` in the same
     profile (measured 6 October 2026). A profile used mostly from the desktop app had a command-line catalog
     from September naming an older Sonnet, next to a desktop catalog from that day. Both list the models
     of the same account (inferred: same account, same model families), so the newest of either is used. */
  try { names = fs.readdirSync(folder).filter((x) => /-ccd?\.json$/.test(x)); } catch { return null; }
  let newest = null;
  for (const name of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
      const models = j && j.catalog && j.catalog.config && j.catalog.config.models;
      if (!Array.isArray(models) || !models.some((m) => m && typeof m.id === 'string'
        && /^claude-[a-z0-9-]+$/.test(m.id))) continue;
      const at = Number(j.fetchedAt) || 0;
      if (!newest || at > newest.at) newest = { at, models };
    } catch { /* an unreadable catalog is skipped */ }
  }
  return newest;
}

/* WHICH VERSION A "LATEST" NAME MEANS RIGHT NOW (user decision, 6 October 2026: the short names stay, and
 * the version they currently stand for is shown next to them). `opus`, `sonnet`,... are not models: they
 * point at the version the provider currently recommends and move by themselves (code.claude.com model
 * configuration). The account's newest catalog lists that version as the "main" entry of the family
 * (`short_name` "Opus", `name` "Opus 5.5"); it is what Claude Code's own model picker shows. With no
 * catalog, or no main entry for a family, nothing is returned for it: no version is invented.
 * @returns {Object<string,string>}  e.g. { opus: 'Opus 5.5', sonnet: 'Sonnet 5.5' } */
function claudeLatest(profileFolder) {
  const newest = claudeCatalog(profileFolder);
  const latest = {};
  if (!newest) return latest;
  for (const alias of CLAUDE_ALIASES) {
    const m = newest.models.find((x) => x && x.section === 'main' && typeof x.short_name === 'string'
      && x.short_name.toLowerCase() === alias && typeof x.name === 'string' && x.name.trim());
    if (m) latest[alias] = m.name.trim();
  }
  return latest;
}
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const validName = name => NAME_PATTERN.test(name || '') && name.length <= 120 && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name);

const agentFolders = require('./agent-folders');
/* `filePath` and `allowedDefinition` USED TO BE HERE - removed with only the write and delete
   paths that were themselves removed used them. The same rule lives on in `agent-sync.js` `allowed`. */

/** The default model of Codex on this machine - not invented, read from config.toml. */
function codexDefaultModel(codexFolder) {
  try {
    const raw = fs.readFileSync(path.join(codexFolder, 'config.toml'), 'utf8');
    const m = raw.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch { return null; }
}

/* ---------------- DEPENDENCY SCAN ----------------
 *
 * The panel has to be able to say that an agent is risky and carries dependencies of its own.
 *
 * The reason was measured: the bodies of some agents contain no working code at all - they say to
 * apply a procedure, the procedure is in another file, and the search tool that procedure uses is in
 * yet another. When the panel copies an agent it carries ONE file, so such an agent is born quietly
 * crippled in the target project. It is a layer above the gap between assigned and callable.
 *
 * WHY AUTOMATIC rather than declared in the definition: writing a `requires:` line works only for
 * agents whose author remembered to write it, and those agents do not. A scan works for an agent
 * somebody else wrote too.
 *
 * THE PANEL DOES NOT SPECULATE HERE. It extracts the file paths mentioned in the text of the agent
 * and checks whether they EXIST in the target project - both knowable things. It does not say the
 * agent is broken; it says which files are not in this project. A requirement of safety contract. */

// Anything that looks like a path: a whitespace-free run carrying at least one slash.
const PATH_SEARCH = /(?:^|[\s"'`(\[<>|])((?:\.[A-Za-z][A-Za-z0-9_-]*|[A-Za-z0-9_][A-Za-z0-9_.-]*)(?:\/[A-Za-z0-9_.*-]+)+\/?)/g;
// File names with an extension but no slash: sibling mentions such as "a.py and b.py". Because WHERE
// they are is not written, presence cannot be decided - they are kept separate.
const BARE_NAME = /(?:^|[\s"'`(\[<>|])([A-Za-z0-9_][A-Za-z0-9_-]*\.(?:md|py|js|mjs|cjs|ts|sh|ps1|cmd|bat|toml|jsonl))(?=$|[\s"'`)\]<>|,;:.])/g;
// Roots whose NAME makes it clear they belong to the project: counted as paths even without an extension.
const PROJECT_ROOT = new RegExp('^(\\.claude|\\.codex|'
  + require('./product').PROJECT_FOLDER.replace(/\./g, '\\.')
  + '|docs|scripts|tools|src|tests|config|panel|lib|app)/');
// Anything carrying a file extension: counted as a path even when the root is unfamiliar.
const EXTENSION = /\.(md|py|js|mjs|cjs|ts|sh|ps1|cmd|bat|json|toml|ya?ml|txt|csv|jsonl)$/i;

/* THE STRONG / SOFT DISTINCTION - REWRITTEN.
 *
 * The first version looked at two things: whether the extension is executable (.py/.sh/.js), and
 * whether a running verb appeared before the path ON THE SAME LINE. Both gave wrong answers, measured:
 *
 *   - An informational sentence naming a `.py` file in prose does not tell the agent to run it. The
 *     extension alone made it STRONG and lit an amber warning on the card.
 *   - A sentence with the verb on one line and the path on the next fell to SOFT, which is exactly
 *     the case the warning should catch.
 *   - "You can call docs/notes/meeting.md a reference" came out STRONG because `call` is an ordinary
 *     English word that happened to be on the list.
 *
 * THE MECHANISM CHANGED, the word list was not patched: the question is no longer whether a running
 * verb appears on this line, but whether this verb GOVERNS THIS PATH. At most six words may stand
 * between the verb and the path, and no sentence end may intervene. Line breaks become spaces,
 * because where a sentence was wrapped does not change its meaning.
 *
 * The panel still does NOT know the intent; this is a heuristic. That is why the tooltip does not say
 * the agent is broken, it says what it saw.
 */
const OWNER_VERB = /\b(execute|executes|run|runs|running|invoke|invokes|apply|applies|follow|follows|watch|watches|bash|sh|python3?|node|source)\b/i;
// A sentence-ending token: a word ending in a full stop, exclamation or question mark that is not itself a path.
const SENTENCE_END = /[.!?]$/;
const MAX_WORDS = 6;
/* IN TURKISH THE VERB COMES LAST. Looking only backwards would miss every agent written in the own
   language of this project: with Turkish word order the verb comes AFTER the path. Our own test
   caught it. The forward window is NARROWER (four words): in English a verb following a path usually
   does not govern it. */
const MAX_WORDS_AHEAD = 4;

/**
 * Is there a verb governing the path in the window BEFORE it?
 * The window: at most six words back, stopping at a sentence end.
 */
function isVerbOwned(before, after) {
  const clean = (x) => x.replace(/^[`"'([<]+/, '');
  const sentenceDone = (x) => SENTENCE_END.test(x)
    && !EXTENSION.test(x.replace(/[.!?]+$/, '')) && !x.includes('/');

  // Backwards: "Execute <path>", "bash <path>" - English word order.
  const back = before.split(/\s+/).filter(Boolean);
  for (let i = back.length - 1, n = 0; i >= 0 && n < MAX_WORDS; i--, n++) {
    const s = clean(back[i]);
    if (sentenceDone(s)) break;
    if (OWNER_VERB.test(s)) return true;
  }

  // Forwards: the path first and the verb after it - Turkish word order.
  const forward = String(after || '').split(/\s+/).filter(Boolean);
  for (let i = 0; i < forward.length && i < MAX_WORDS_AHEAD; i++) {
    const s = clean(forward[i]);
    if (OWNER_VERB.test(s)) return true;
    if (sentenceDone(s)) break;
  }
  return false;
}

/**
 * Extracts the file paths mentioned in the text of an agent and checks whether they exist in the target project.
 *
 * @param {string} content    the full text of the agent definition
 * @param {string} target     the project folder the agent WILL RUN IN (the target project when copied)
 * @param {string|null} ownPath  the own file of the agent; a reference to itself does not count
 */
function dependency(content, target, ownPath = null) {
  const empty = { all: [], missingStrong: [], missingSoft: [], placeAmbiguous: [] };
  if (!content || !target) return empty;
  const own = ownPath ? path.resolve(ownPath) : null;

  // Front matter fields (`tools: Read, Grep`) are not paths and are removed from the scan. In the rest,
  // a line break becomes a space: a wrap between the verb and the path does not change the meaning.
  const text = String(content).split('\n')
    .filter((s) => !/^\s*(tools|model|account|name|description|schema|provider)\s*:/i.test(s))
    .join(' ');

  const found = new Map();
  PATH_SEARCH.lastIndex = 0;
  let m;
  while ((m = PATH_SEARCH.exec(text)) !== null) {
    const raw = m[1].replace(/[.,;:)\]}>"'`]+$/, '').replace(/\/+$/, '');
    if (!raw.includes('/')) continue;
    if (/^(https?|file|mailto)$/i.test(raw.split('/')[0])) continue;
    if (!PROJECT_ROOT.test(raw) && !EXTENSION.test(raw)) continue;
    const press = m.index + m[0].length - m[1].length;
    const before = text.slice(0, press);
    const after = text.slice(press + m[1].length);
    // A procedure file (`.claude/skills/<name>/SKILL.md`) is by its structure the thing being APPLIED;
    // it is strong even with no verb in the sentence.
    const strong = isVerbOwned(before, after)
      || /\.claude\/skills\/[^/]+\/SKILL\.md$/i.test(raw);
    const old = found.get(raw);
    found.set(raw, { filePath: raw, strong: strong || (old ? old.strong : false) });
  }

  // Mentions with no slash: the name is there, the location is not. Presence cannot be decided.
  const bare = new Set();
  BARE_NAME.lastIndex = 0;
  while ((m = BARE_NAME.exec(text)) !== null) {
    const name = m[1];
    if ([...found.keys()].some((y) => y.endsWith('/' + name))) continue;
    if (ownPath && path.basename(ownPath) === name) continue;
    bare.add(name);
  }

  const all = [];
  for (const record of found.values()) {
    const full = path.resolve(target, record.filePath);
    if (own && full === own) continue;
    all.push({ filePath: record.filePath, strong: record.strong, exists: fs.existsSync(full) });
  }
  all.sort((a, b) => (b.strong - a.strong) || a.filePath.localeCompare(b.filePath, "en-US"));
  return {
    all,
    missingStrong: all.filter((x) => x.strong && !x.exists).map((x) => x.filePath),
    missingSoft: all.filter((x) => !x.strong && !x.exists).map((x) => x.filePath),
    // It does NOT raise the warning: because where it should be is not written, it CANNOT be called missing.
    placeAmbiguous: [...bare].sort((a, b) => a.localeCompare(b, "en-US")),
  };
}

/** The agents already sitting in this project - their name and what they are called for. */
function existing(project) {
  if (!project) return [];
  const output = [];
  // The folder of the panel, then `.claude/agents`. Files there are read, but no new file is written there.
  for (const place of agentFolders.LISTED) {
  const k = path.join(project, ...place);
  // 'panel' = the panel's own folder; false = Claude Code's folder, which panel.js reads as provider "claude".
  const worker = place === agentFolders.PANEL ? 'panel' : false;
  let signIns;
  try { signIns = fs.readdirSync(k); } catch { continue; }
  for (const name of signIns) {
    if (!name.endsWith('.md')) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(k, name), 'utf8'); } catch { continue; }
    /* A FIFTH READING SITE, WIRED TO THE SHARED READER. A BYTE-FOR-BYTE COPY of the old
       parser had been written here; fixing `agent-resolution` would have left this card-drawing path
       broken, so a task sitting in the file would still have looked empty in the list of the panel.
       The own rule of the project already says it - read the SOURCE, not a copy. */
    const { get, body } = resolution.parseFrontmatter(raw);
    output.push({
      file: name,
      dependency: dependency(raw, project, path.join(k, name)),
      name: get('name') || name.replace(/\.md$/, ''),
      description: get('description') || '',
      model: get('model') || null,
      account: get('account') || null,
      /* THE TOOL RESTRICTION IS CARRIED ON THE CARD. This list was not read here; because the
         form never saw it, the default list was written on save, and an agent given ONLY `Read` widened
         to `Read, Grep, Glob, Bash` merely because its description had been edited. Widening a
         restriction means taking a security decision of the user on their
         vermektir. */
      tools: get('tools') || null,
      // The provider is shown on the card as an ICON; if the definition names one it is used, otherwise
      // the page falls back to the kind recorded for the account. Nothing is guessed.
      provider: get('provider') || null,
      // What will REALLY run. The page keeps the `account`/`model` fields to show what the FILE SAYS;
      // what the card and the list show is this. A missing or deleted account does not make an agent
      // invisible, it binds it to the orchestrator.
      resolution: resolution.resolve({ account: get('account'), provider: get('provider'), model: get('model') },
        (x) => accounts.findLoose(x)),
      /* IF THE ASSIGNED ACCOUNT IS SIGNED OUT THE CARD SAYS SO. `worker.js` already refuses at call
         time ("X is signed out"); seeing it BEFORE running saves a run. The text lives in
         `mcp-status.js`, because the catalogue the orchestrator reads has to say the same sentence -
         if they drift apart the user hears two different things. */
      signInWarning: setupSignInWarning(get('account')),
      worker,
      body,
      filePath: path.join(k, name),
    });
  }
  }
  return output.sort((a, b) => a.name.localeCompare(b.name, "en-US"));
}

/* `otherProjects` USED TO BE HERE - removed with. Since an agent is a single central
   record; there is no separate list of agents in other projects and no separate resolution path for
   one. The invariant it protected (an agent coming from another project resolves the same account and
   model as the one in its own) is now structural: one record, one resolution. */


/** Reduces to a single line: front matter fields cannot be multi-line. */
const singleLine = (m) => String(m || '').replace(/\s+/g, ' ').trim();

/**
 * BUILDS the file that would be written but DOES NOT WRITE it. The page shows this, and approval is asked afterwards.
 * @returns {{filePath:string, content:string, existingEntry:boolean}|{error:string}}
 */
function preview(project, field) {
  if (!project) return { error: "Select a project first" };
  const name = singleLine(field.name).toLowerCase().replace(/\s+/g, '-');
  if (!validName(name)) {
    return { error: "Use lowercase letters, numbers, and hyphens for the name" };
  }
  if (!singleLine(field.description)) return { error: "A usage description is required so the orchestrator can select this agent" };
  if (!String(field.task || '').trim()) return { error: "Instructions cannot be empty" };

  // Same as the orchestrator is an EXPLICIT choice, not an omission: `orchestrator` is written into
  // the file and account, model and provider are all three bound to it. Splitting the three would be
  // meaningless - a Codex model name is invalid on a Claude account.
  let account = singleLine(field.account);
  let model = singleLine(field.model);
  let provider = singleLine(field.provider);
  if (account === resolution.ORCHESTRATOR) { model = resolution.ORCHESTRATOR; provider = resolution.ORCHESTRATOR; }
  if (!account) return { error: "Select an account" };
  if (!model) return { error: "Select a model" };
  // `panel` is the single provider-independent source. The run path is chosen at call time.
  const worker = 'panel';

  /* THE BODY IS THE TASK AND NOTHING ELSE. A project-specific section used to be appended
     here; that field was removed by decision of the user and this append went with it. Left in place,
     old calls would keep producing the section although the form no longer asks for it. */
  const body = [String(field.task).trim()];
  const press = ['---', 'schema: panel-agent/v1', 'name: ' + name,
    'description: ' + singleLine(field.description), 'model: ' + model, 'account: ' + account];
  if (provider) press.push('provider: ' + provider);
  /* THE FORM SENDS A LEVEL  and the file gets that level's tool list, which is exactly
     what the run enforces. A hand-written list ("custom", or no level sent) is kept as it was. */
  const level = singleLine(field.permission);
  /* The default level writes no line. A caller that states nothing still gets the former line, which the
     sync never lets loosen a narrow agent. */
  const tools = level === 'default' || resolution.PERMISSION_TOOLS[level] ? resolution.toolsForPermission(level)
    : (singleLine(field.tools) || 'Read, Grep, Glob, Bash');
  if (tools) press.push('tools: ' + tools);
  press.push('---');

  let content = [
    ...press,
    '',
    body.join('\n'),
    '',
  ].join('\n');
  /* THE PREVIEW IS THE TEXT THAT WILL BE WRITTEN. The save keeps the edited agent's unknown front matter
     fields and a narrower tool list (`agent-sync.formFields`); the preview used to leave them out, so the
     user approved a text that differed from the file. The identity is found the way the save finds it. */
  const before = (field.oldPath && registry.find(path.basename(String(field.oldPath), '.md'))) || registry.find(name);
  if (before) {
    const read = registry.fromFile(content);
    if (!read.corrupt) content = registry.text({ ...sync.formFields(read, before), name });
  }

  /* Use the same target resolver for preview and write, including definitions stored in legacy agent directories. */
  let filePath = sync.targetPath(project, name);
  // A move out of Claude Code's own folder was asked for: the preview shows where the file will live.
  if (field.moveToPanel && sync.inOldFolder(project, filePath)) filePath = sync.panelPath(project, name);
  const sameName = existing(project).find((a) => a.name === name
    && (!field.oldPath || path.resolve(a.filePath) !== path.resolve(field.oldPath)));
  if (sameName) return { error: '"' + name + "\" is already in use; choose another name" };
  // If it is written to the same file there is no move, and no old-will-be-deleted warning either.
  const oldPath = (field.oldPath && path.resolve(field.oldPath) !== path.resolve(filePath))
    ? field.oldPath : null;
  return { filePath, content, name, worker, account, existingEntry: fs.existsSync(filePath), oldPath };
}

/* `write` and `writeSource` USED TO BE HERE - removed with. Since the write path is
   `agent-sync.js` `saveForm` plus `publish`; the `allowed` check there carries the same protection
   (agent folder only, `.md` only, symlinks refused). Because the target path is computed from the
   registry and the project rather than from user input, the write-to-a-given-path door is structurally
   closed as well. */

/* `delete` USED TO BE HERE - removed with. Removing from a project has been `agent-sync.js`
   `removeFromProject` (the file first, then membership) and `deleteEverywhere` since. */

/** The Codex models of this account - THE LIST IS NOT INVENTED.
 *  Codex has no list-the-models command (`codex --help`). The list therefore comes from two real
 *  sources: (1) the default in the config.toml of that account, and (2) the model names REALLY used
 *  in past sessions of that account, together with how many records they appear in.
 *  Because the count stands next to it, a misspelled name shows up too. For a model that is not on
 *  the list the form offers a type-it-yourself option. */
function codexModels(codexFolder) {
  const defaults = codexDefaultModel(codexFolder);
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(codexFolder, 'models_cache.json'), 'utf8'));
    const unique = new Set();
    const seen = (Array.isArray(cache?.models) ? cache.models : [])
      .filter((m) => {
        if (!m || m.visibility !== 'list' || typeof m.slug !== 'string' || !m.slug.trim()
          || unique.has(m.slug)) return false;
        unique.add(m.slug); return true;
      })
      .map((m) => ({ name: m.slug,
        label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.slug, record: null }));
    if (seen.length) return { defaults, seen, source: 'models_cache.json' };
  } catch { /* fall back to the past records */ }
  const counter = new Map();
  const browse = (d, deep) => {
    if (deep > 5) return;
    let signIns;
    try { signIns = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const x of signIns) {
      const y = path.join(d, x.name);
      if (x.isDirectory()) { browse(y, deep + 1); continue; }
      if (!x.name.endsWith('.jsonl')) continue;
      let raw;
      try { raw = fs.readFileSync(y, 'utf8'); } catch { continue; }
      for (const m of raw.matchAll(/"model":"([^"]+)"/g)) {
        counter.set(m[1], (counter.get(m[1]) || 0) + 1);
      }
    }
  };
  browse(path.join(codexFolder, 'sessions'), 0);

  const seen = [...counter.entries()]
    .map(([name, record]) => ({ name, record }))
    .sort((a, b) => b.record - a.record);
  return { defaults, seen };
}

module.exports = { existing, preview, CLAUDE_MODELS, claudeModels, claudeLatest, codexDefaultModel, codexModels, dependency };
