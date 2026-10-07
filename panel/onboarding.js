/* Authentication and onboarding are separate provider settings. Set cosmetic welcome marks automatically, but write project trust only after approval. Provider hook trust remains in the provider CLI. Unknown settings schemas leave setup to the CLI. */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const json = require('./persistent-json');
const toml = require('@iarna/toml');

let backupRoot = null;   // set by main.js; backups go to the data folder of the panel, never to a folder of the user

function setup(filePath) { backupRoot = filePath || null; }

/** The configuration file of Claude. In a default install it is in the home directory; for a
 *  separate account it is inside its own folder - `panel/account-identity.js` makes the same split. */
function claudeConfiguration(folder) {
  const defaults = require('./accounts').defaultHome('claude');
  return (!folder || path.resolve(folder) === path.resolve(defaults))
    ? path.join(os.homedir(), '.claude.json')
    : path.join(folder, '.claude.json');
}

/** The project key of Claude: measured, a full path with forward slashes ("C:/Users/example/project"). */
const claudeProjectKey = (project) => path.resolve(project).replace(/\\/g, '/');

// Codex folds ASCII case, not Unicode. JS toLowerCase changes İ to i + U+0307,
// creating a different path and conflating its trust entry with the real project.
// Keep this same comparison for generation, lookup and insertion. Do not migrate
// old keys: a decomposed spelling can name a separate, real directory.
const foldCodexPath = (filePath) => filePath.replace(/[A-Z]/g, c => c.toLowerCase());
const codexProjectKey = (project) => foldCodexPath(path.resolve(project));

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    const object = x => x && typeof x === 'object' && !Array.isArray(x);
    if (!object(v) || (v.projects !== undefined &&
        (!object(v.projects) || Object.values(v.projects).some(p => !object(p))))) {
      throw new Error('Invalid Claude configuration; existing settings were preserved');
    }
    return v;
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
}

/** The current state of the file is copied into the own folder of the panel. We leave no `.backup`
 *  leftovers in the identity folder of the user; the files there belong to the provider. */
function backupFile(file) {
  if (!backupRoot || !fs.existsSync(file)) return null;
  const name = path.basename(file) + '.' + Date.now() + '.bak';
  const target = path.join(backupRoot, name);
  try {
    fs.mkdirSync(backupRoot, { recursive: true });
    fs.copyFileSync(file, target);
    return target;
  } catch (e) { throw new Error('Could not back up existing settings: ' + e.message); }
}

/* ---------------- TOML: only as much as we need ---------------- */

/** Parses a `[projects.'c:\path']` or `[projects."c:\\path"]` heading. */
function titlePath(line) {
  try {
    const parsed = toml.parse(line + '\n__benchook_probe = true');
    const keys = Object.keys(parsed.projects || {});
    if (keys.length === 1 && parsed.projects[keys[0]].__benchook_probe === true) return keys[0];
  } catch { /* Not a project table header. */ }
  return null;
}

function codexConfig(text) {
  let value;
  try { value = toml.parse(String(text || '')); }
  catch { throw new Error('Invalid Codex TOML configuration; existing settings were preserved'); }
  const object = x => x && typeof x === 'object' && !Array.isArray(x);
  if (value.projects !== undefined && (!object(value.projects) || Object.values(value.projects).some(p => !object(p)))) {
    throw new Error('Invalid Codex project configuration; existing settings were preserved');
  }
  return value;
}

/** How a path is written into TOML: a single-quoted literal carries a backslash through as it is. */
function tomlPath(filePath) {
  return filePath.includes("'")
    ? '"' + filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    : "'" + filePath + "'";
}

/**
 * The trust state inside the Codex settings text.
 * @returns {{status:'none'|'safe'|'other', value:string|null}}
 */
function codexTrustStatus(text, key) {
  const projects = codexConfig(text).projects || {};
  const matches = Object.keys(projects).filter(k => foldCodexPath(k) === foldCodexPath(key));
  if (matches.length > 1) throw new Error('Conflicting Codex project paths; review configuration in the CLI');
  const value = projects[matches[0]]?.trust_level;
  if (value !== undefined) {
    if (typeof value !== 'string') throw new Error('Invalid Codex trust setting; existing settings were preserved');
    return { status: value === 'trusted' ? 'safe' : 'other', value: value };
  }
  return { status: 'none', value: null };
}

/** Adds the trust line to the text. An existing section is preserved, never overwritten. */
function addCodexTrust(text, key) {
  const m = String(text || '');
  if (codexTrustStatus(m, key).status !== 'none') return m;
  const lines = m.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const filePath = titlePath(lines[i]);
    if (filePath !== null && foldCodexPath(filePath) === foldCodexPath(key)) {
      lines.splice(i + 1, 0, 'trust_level = "trusted"');
      const result = lines.join('\n');
      codexConfig(result);
      return result;
    }
  }
  const extra = '[projects.' + tomlPath(key) + ']\ntrust_level = "trusted"\n';
  const result = m && !m.endsWith('\n') ? m + '\n\n' + extra : (m ? m + '\n' + extra : extra);
  codexConfig(result);
  return result;
}

/* ---------------- Status and plan ---------------- */

/**
 * What would happen if a terminal were opened in this project under this account?
 *
 * @param {string} folder  the identity folder of the account (accounts.folderPath)
 * @param {string} project the working directory
 */
function status(account, folder, project) {
  const provider = account && account.provider === 'codex' ? 'codex' : 'claude';
  if (provider === 'claude') {
    const file = claudeConfiguration(folder);
    const v = readJson(file) || {};
    const key = claudeProjectKey(project);
    const p = (v.projects || {})[key];
    return {
      provider,
      cosmetic: {
        required: v.hasCompletedOnboarding !== true,
        file,
        line: '"hasCompletedOnboarding": true',
      },
      trust: {
        required: !(p && p.hasTrustDialogAccepted === true),
        file,
        key,
        line: '"projects": { "' + key + '": { "hasTrustDialogAccepted": true } }',
      },
    };
  }

  const file = path.join(folder || require('./accounts').defaultHome('codex'), 'config.toml');
  const text = readText(file);
  const key = codexProjectKey(project);
  const g = codexTrustStatus(text, key);
  return {
    provider,
    // Under Codex the first screen is the LOGIN; no separate first-run-completed mark was measured,
    // so none is invented. There is no cosmetic mark for the panel to write.
    cosmetic: { required: false, file, line: null },
    trust: {
      required: g.status === 'none',
      // If the user said they do not trust it, the panel does NOT change that; it says so on screen.
      otherDecision: g.status === 'other' ? g.value : null,
      file,
      key,
      line: '[projects.' + tomlPath(key) + ']\ntrust_level = "trusted"',
    },
  };
}

/** The lines shown in the confirmation dialog - every file and every line that will be written, in the open. */
function plan(account, folder, project) {
  const d = status(account, folder, project);
  const items = [];
  if (d.cosmetic.required) items.push({ kind: 'cosmetic', file: d.cosmetic.file, line: d.cosmetic.line });
  if (d.trust.required) items.push({ kind: 'trust', file: d.trust.file, line: d.trust.line });
  return { ...d, items };
}

/* ---------------- Uygulama ---------------- */

function writeClaude(file, change) {
  const v = readJson(file) || {};
  change(v);
  backupFile(file);
  json.atomic(file, v);   // temporary file plus rename: it never leaves a half-written settings file
}

/**
 * Writes the selected pieces. No piece is selected on its own; the caller says what it wants.
 * @param {{cosmetic?:boolean, trust?:boolean}} selection
 */
function apply(account, folder, project, selection = {}) {
  const d = status(account, folder, project);
  const written = [];

  if (selection.cosmetic && d.cosmetic.required && d.provider === 'claude') {
    writeClaude(d.cosmetic.file, (v) => { v.hasCompletedOnboarding = true; });
    written.push({ kind: 'cosmetic', file: d.cosmetic.file });
  }

  if (selection.trust && d.trust.required) {
    if (d.provider === 'claude') {
      writeClaude(d.trust.file, (v) => {
        if (!v.projects || typeof v.projects !== 'object') v.projects = {};
        const p = v.projects[d.trust.key] || {};
        p.hasTrustDialogAccepted = true;
        v.projects[d.trust.key] = p;
      });
    } else {
      const text = readText(d.trust.file);
      backupFile(d.trust.file);
      fs.mkdirSync(path.dirname(d.trust.file), { recursive: true });
      json.atomicText(d.trust.file, addCodexTrust(text, d.trust.key));
    }
    written.push({ kind: 'trust', file: d.trust.file });
  }

  return { written, status: status(account, folder, project) };
}

module.exports = {
  setup, status, plan, apply,
  claudeConfiguration, claudeProjectKey, codexProjectKey,
  codexTrustStatus, addCodexTrust,
};
