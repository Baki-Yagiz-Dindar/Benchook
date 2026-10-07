// ACCOUNT REGISTRY - the central promise of the panel: every agent runs on ITS OWN account and ITS
// OWN model.
//
// Any number of accounts can be added, so that the token of the main account is preserved and the
// work is spread across the others.
//
// WHY A SEPARATE FOLDER (measured):
// `CLAUDE_CONFIG_DIR` separates a Claude installation completely - run against an empty folder,
// `claude --print` said "Not logged in - Please run /login" and built its own `.claude.json`,
// `projects` and `sessions` tree there. So accounts are NOT SWAPPED, they live side by side.
// `CODEX_HOME` does the same job on the Codex side (`codex exec --help`: "auth still uses
// CODEX_HOME"). There is therefore no moment of switching accounts; all of them stay signed in.
//
// WHERE IT LIVES: the registry is in the own data folder of the panel, NOT in the repository. It
// holds account labels and local paths, and nothing personal goes into the published source.
//
// The registry stores account labels and profile paths, not credentials. Identity lookup separately
// reads Codex's auth.json; Claude identity is queried through its CLI.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const persistentJson = require('./persistent-json');

let storePath = null;   // set by main.js (app.getPath('userData') is known there)

function setup(filePath) { storePath = filePath; }

/** The program starts with no accounts: only accounts the user adds appear. */
function defaults() {
  return [];
}

/* *
 * CLEAN UP THE LABEL. Fixing the name inside `defaults` was NOT enough, because the registry is
 * saved to disk and read from there; the code changed while the old label stayed on screen. The
 * migration happens at read time: the label is cleaned and THE ID IS NOT TOUCHED - agent definitions
 * look at the id, and changing it would make agents lose their account. */
const cleanName = (name) => String(name || '')
  .replace(/\s+/g, ' ')
  .trim();

/* A readable accounts array is authoritative, including an empty array. Fall back to defaults only when the registry is missing or corrupt; never restore removed accounts because the list is empty. */
function read() {
  if (!storePath) return defaults();
  const d = persistentJson.read(storePath, registryValid);
  return d ? d.accounts.map((h) => ({ ...h, name: cleanName(h.name) || h.id })) : defaults();
}

function registryValid(d) {
  return !!d && Array.isArray(d.accounts) && d.accounts.every(h => h
    && typeof h.id === 'string' && h.id.length > 0
    && (h.provider === 'claude' || h.provider === 'codex')
    && (h.folder == null || typeof h.folder === 'string'))
    && new Set(d.accounts.map(h => h.id)).size === d.accounts.length;
}

function write(accounts) {
  if (!storePath) throw new Error("Account store path is not configured");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  persistentJson.write(storePath, { accounts }, registryValid);
  return accounts;
}

/** Where a provider keeps its own profile when no folder is given (`~/.claude`, `~/.codex`). The one
    place that says it; every module that falls back to the default profile asks here. */
function defaultHome(provider) {
  return path.join(os.homedir(), provider === 'codex' ? '.codex' : '.claude');
}

/** The identity folder of an account. null = the default location of that program. */
function folderPath(account) {
  if (!account) return null;
  if (account.folder) return account.folder;
  return defaultHome(account.provider);
}

/* Create the account profile folder before starting its CLI. Codex requires CODEX_HOME to exist. Creating this approved folder does not sign in or write credentials; authentication remains with the provider. */
function prepareFolder(account) {
  const k = folderPath(account);
  if (!k) return { filePath: null };
  try {
    fs.mkdirSync(k, { recursive: true });
    return { filePath: k };
  } catch (e) {
    return { filePath: k, error: "Could not create profile folder: " + e.message };
  }
}

/* Clear inherited provider session variables so each embedded terminal creates its own session identity and transcript. Preserve identities created by the child CLI. The account-less terminal path uses the same exclusion list. */
const INHERITED_VARIABLES = /^(CODEX_HOME|CODEX_SESSION_ID|CODEX_THREAD_ID|CODEX_INTERNAL_ORIGINATOR_OVERRIDE)$/i;
function cleanInherited(source) {
  const o = {};
  for (const [name, value] of Object.entries(source || process.env)) {
    if (/^CLAUDE/i.test(name) || INHERITED_VARIABLES.test(name)) continue;
    o[name] = value;
  }
  return o;
}

/** The environment of the process that runs the worker: these two variables are the only thing separating accounts. */
function env(account) {
  const o = cleanInherited(process.env);
  if (!account) return o;
  // An explicit account profile must not inherit another shell's authentication.
  for (const name of Object.keys(o)) {
    if (/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL)$/i.test(name)) delete o[name];
  }
  // The default is pinned explicitly too: the login check and the run must look at the same profile.
  if (account.provider === 'codex') o.CODEX_HOME = folderPath(account);
  else o.CLAUDE_CONFIG_DIR = folderPath(account);
  return o;
}

/** Is it signed in - WITHOUT looking at the token, only at whether the identity file exists. */
function hasSignIn(account) {
  const k = folderPath(account);
  if (!k) return false;
  const d = account.provider === 'codex'
    ? path.join(k, 'auth.json')
    : path.join(k, '.credentials.json');
  try { return fs.statSync(d).size > 0; } catch { return false; }
}

function list() {
  return read().map((h) => ({ ...h, folderPath: folderPath(h), signedIn: hasSignIn(h) }));
}

/** The SUGGESTED folder for a new account of the same kind. If the default location is already taken
 *  it is derived from the label; the user can change it. */
function suggestedFolder(provider, name) {
  /* WITH NO LABEL THE FOLDER MUST STILL BE UNIQUE. A label is no longer required; an empty one used
     to always give 'account2', so the second and third accounts suggested THE SAME folder and the
     second was refused with a message about the folder already being used. Because the label will
     arrive later from the e-mail, the folder is derived from a momentary number instead. The path is
     not shown to the user; being unique is enough. */
  const clean = String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    // Uniqueness rests on randomness, NOT only on a counter: two accounts added within the same
    // millisecond would come out identical and suggest the same folder (caught by our own test).
    || ('account-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
  return path.join(os.homedir(), (provider === 'codex' ? '.codex-' : '.claude-') + clean);
}

function profileId(filePath) {
  let existing = path.resolve(filePath);
  const missing = [];
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    missing.unshift(path.basename(existing)); existing = path.dirname(existing);
  }
  const real = path.join(fs.realpathSync.native(existing), ...missing);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function add(account) {
  if (!account || !['claude', 'codex'].includes(account.provider)) throw new Error('Select a supported provider.');
  const all = read();
  const id = account.id || (account.provider + '-' + Date.now().toString(36));
  if (all.some((h) => h.id === id)) throw new Error("An account with this ID already exists");
  const provider = account.provider === 'codex' ? 'codex' : 'claude';
  const folder = account.folder || null;

  // TWO ACCOUNTS ARE NEVER WRITTEN TO ONE FOLDER. Otherwise the panel says it ran on the second
  // account while the work comes out of the quota of the FIRST - precisely the silent error the
  // ninth rule exists to prevent. It happened once: the folder was left empty and the second account
  // pointed at the folder of the first.
  const samePlace = all.find((h) => h.provider === provider
    && profileId(folderPath(h)) === profileId(folderPath({ provider, folder })));
  if (samePlace) {
    const e = new Error("This profile folder is already used by \"" + samePlace.name + "\". Each account needs a separate "
      + "profile folder. Suggested folder: " + suggestedFolder(provider, account.name));
    e.suggestion = suggestedFolder(provider, account.name);
    throw e;
  }

  /* AN ACCOUNT IS NOT GIVEN A NAME. Showing the part of the e-mail address before the @ is enough
     when choosing an account for an agent.

     The reason is mechanical: a hand-typed name both appeared on screen and took part in matching
     during agent resolution, so changing the label could silently break an agent. The panel will end
     up in other hands, and someone losing a working agent because they renamed a label is not
     acceptable. The display label now comes ONLY from the part of the e-mail read at login that
     precedes the @, and matching is done by id alone (see findLoose).

     A temporary label stands until a login happens; it is overwritten as soon as the e-mail is read. */
  const created = { id, name: provider === 'codex' ? "Codex account" : "Claude account",
    provider, folder, temp: true };
  // The folder is created FIRST: Codex does not start at all with a CODEX_HOME that does not exist,
  // which would leave an account in the registry that could never be signed into.
  const h = prepareFolder(created);
  if (h.error) throw new Error(h.error);
  all.push(created);
  write(all);
  return list();
}

/**
 * WRITE THE DISPLAY LABEL - its only source is the part of the e-mail read at login before the @.
 *
 * The user cannot name an account, so there is no hand-typed name to preserve; the label is
 * refreshed at every login. The label determines no path, no identity and no matching - it is only
 * what appears on screen.
 */
function updateName(id, name) {
  const clean = cleanName(name);
  if (!clean) return list();
  const all = read();
  const h = all.find((x) => x.id === id);
  if (!h) return list();
  h.name = clean;
  delete h.temp;      // a real label from the e-mail now, no longer a temporary one
  write(all);
  return list();
}

/**
 * IS THE SAME E-MAIL ALSO ON ANOTHER ACCOUNT - the subject of the ninth answer-key rule.
 *
 * It happened in a real attempt: the user expected one account in a given folder, the browser was
 * already signed in as another, that other account was authorised, and the registry ended up with
 * the SAME account on two rows. With such a registry the panel says it ran on the second account
 * while the work comes out of the quota of the first - which destroys the reason the panel exists.
 *
 * The panel does NOT PREVENT this (a user may want two rows deliberately); it SAYS so.
 */
function emailTwin(id, email) {
  /* AN E-MAIL IS NOT LOWERCASED BY TURKISH RULES. The first version used Turkish lowercasing and our
     own test caught it: in Turkish the letter 'I' becomes a dotless one, so two spellings of the same
     address counted as DIFFERENT e-mails and no twin was found. An e-mail address is case-insensitive
     by ASCII rules; Turkish lowercasing is right for a name and wrong for an e-mail. */
  const shrink = (x) => String(x || '').trim().toLowerCase();
  const e = shrink(email);
  if (!e) return null;
  const all = read();
  const current = all.find((h) => h.id === id);
  if (!current) return null;
  return all.find((h) => h.id !== id && h.provider === current.provider && shrink(h.email) === e) || null;
}

/** Writes the e-mail read at login into the registry: the twin check looks at this. */
function writeEmail(id, email) {
  const all = read();
  const h = all.find((x) => x.id === id);
  if (!h) return list();
  h.email = String(email || '').trim() || undefined;
  write(all);
  return list();
}

function remove(id) {
  const remaining = read().filter((h) => h.id !== id);
  write(remaining);
  return list();
}

function find(id) {
  return read().find((h) => h.id === id) || null;
}

/**
 * FINDS THE account VALUE OF A DEFINITION IN THE REGISTRY - BY ID ONLY.
 *
 * There used to be name matching here as well: writing `account: someone` in an agent file made the
 * panel resolve it by label. The concept of an account name was then removed entirely, because
 * changing a label could silently break an agent. Before removing it, every agent definition in the
 * five projects the panel knew about was scanned: NOT ONE agent resolved by name, so removing it
 * broke nothing that worked.
 *
 * If the id is not found, null is returned; `agent-resolution` then binds that agent to the
 * orchestrator and writes the reason on the card. Nothing is guessed: choosing between two accounts
 * on behalf of the user is not the job of the panel.
 */
function findLoose(value) {
  const d = String(value == null ? '' : value).trim();
  if (!d) return null;
  return read().find((h) => h.id === d) || null;
}

/* Map the session profile directory to its account registry entry. Return null when the environment does not identify a registered profile.
 * @param {object} env Session environment variables.
 * @returns {object|null} Matching registry entry, or null. */
function sessionAccount(env) {
  const o = env || {};
  const filePath = o.CODEX_HOME || o.CLAUDE_CONFIG_DIR || null;
  if (!filePath) return null;
  const matches = (a, b) => {
    try { return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase(); }
    catch { return false; }
  };
  return read().find((h) => matches(folderPath(h), filePath)) || null;
}

module.exports = {
  defaultHome, setup, list, add, remove, find, env, cleanInherited, folderPath, hasSignIn, suggestedFolder, prepareFolder, findLoose, updateName, emailTwin, writeEmail, sessionAccount };
