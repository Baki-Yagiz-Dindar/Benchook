'use strict';
/* CODEX NEEDS ITS WINDOWS SANDBOX NAMED (measured 24 September 2026, Codex 0.154.0). Since 0.152 Codex on
   Windows runs commands only when the configuration names a Windows sandbox (`[windows] sandbox =...`);
   without it every command, reading a file included, is rejected "blocked by policy" (openai/codex#42172).
   Codex writes that line into the user's own `~/.codex/config.toml` at setup, but Benchook runs each Codex
   account from its own profile folder, whose configuration never had it. The setting is passed on the
   command line and the account's file is left untouched; an account that already names a sandbox keeps
   its own choice. The sandbox itself is never turned off. */
const fs = require('node:fs');
const path = require('node:path');

/** Does this TOML text name a Windows sandbox (`sandbox` under `[windows]`, or `windows.sandbox`)?
 *  Read with the TOML parser, so an inline table (`windows = { sandbox = ... }`) or a quoted key also
 *  counts as the user's own choice; the line scan below remains only for a file the parser refuses. */
function namesWindowsSandbox(text) {
  try {
    const value = require('@iarna/toml').parse(String(text || ''));
    return !!(value && value.windows && typeof value.windows === 'object' && 'sandbox' in value.windows);
  } catch { return scanForSandbox(text); }
}
function scanForSandbox(text) {
  let section = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const header = line.match(/^\[\s*([^\]]+?)\s*\]$/);
    if (header) { section = header[1]; continue; }
    if (section === 'windows' && /^sandbox\s*=/.test(line)) return true;
    if (!section && /^windows\.sandbox\s*=/.test(line)) return true;
  }
  return false;
}

/**
 * The extra Codex arguments that name the Windows sandbox, or none.
 * @param {string|null} codexHome  the account's CODEX_HOME folder
 * @param {string} platform        process.platform
 * @returns {string[]}
 */
function sandboxArgs(codexHome, platform = process.platform) {
  if (platform !== 'win32') return [];
  let text = '';
  try { text = codexHome ? fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8') : ''; } catch { text = ''; }
  return namesWindowsSandbox(text) ? [] : ['-c', 'windows.sandbox="elevated"'];
}

module.exports = { sandboxArgs, namesWindowsSandbox };
