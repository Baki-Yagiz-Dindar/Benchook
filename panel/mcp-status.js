/* Display the configured agent connection state. Share status text with panel/mcp-status.js so the UI and generated catalog agree. */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const toml = require('@iarna/toml');
const path = require('node:path');
/* The rule that reduces a project path to a single identity was written for and is NEEDED
   here too: the own record file of the provider also keys projects by the raw path string, and the
   same project can sit there twice under two spellings (seen in a real profile). Writing the same
   rule a second time would guarantee the two drift apart. */
const { projectId } = require('./catalog-state');
const { MCP_SERVER_KEY } = require('./product');

/** The worker server of the panel. If this path is not in the record, the connection belongs to ANOTHER installation. */
const TOOL = path.resolve(__dirname, '..', 'tools', 'mcp-server.js');

const same = (a, b) => String(a).replace(/\\/g, '/') === String(b).replace(/\\/g, '/');

/* Classify configuration as installed, closed, otherProject, none, or unknown. Disabled and project-pinned definitions are not usable installations. Disk configuration cannot prove a tool is loaded in a running session. */
const STATES = ['installed', 'closed', 'otherProject', 'none'];

/* Report configuration, enablement, and session access separately. Configuration and recorded approval are observable on disk; actual session access remains unknown. */
const response = (status, provider, note, extra = {}) => ({
  installed: status === 'installed', status, provider, note,
  configuration: !!extra.configuration,
  enablement: extra.enablement || 'unknown',
  sessionAccess: 'unknown',
  // The note asks for setup to run again: the setup button stays usable for exactly that.
  needsRerun: !!extra.needsRerun,
});

// Parse values with the same TOML parser used for provider onboarding.
function codexServers(text) {
  const value = toml.parse(String(text || ''));
  return value.mcp_servers || {};
}

// Locate table boundaries without treating comments or quoted names as part of the key.
function tablePath(line) {
  if (!line.trim().startsWith('[')) return null;
  try {
    let value = toml.parse(line + '\n__benchook_table_probe = true');
    const keys = [];
    while (value && typeof value === 'object' && !Array.isArray(value)) {
      if (value.__benchook_table_probe === true) return keys;
      const own = Object.keys(value);
      if (own.length !== 1) return null;
      keys.push(own[0]); value = value[own[0]];
    }
  } catch { /* Not a table header. */ }
  return null;
}

/* THE PANEL'S OWN ENTRY IS THE ONE THAT RUNS ITS SCRIPT. An entry is recognised by the file it
   starts, not by the key it sits under: a key can come from an older version or be renamed by
   hand, and setup must replace every such entry rather than add a second server beside it. */

/** Keys in a parsed `.mcp.json` whose entry runs the worker script, current key first. */
function ownClaudeKeys(json, project, tool = TOOL) {
  const servers = (json && json.mcpServers) || {};
  const keys = Object.keys(servers).filter((key) => {
    const x = servers[key];
    return !!(x && x.command === 'node' && Array.isArray(x.args)
      && x.args.some((a) => same(path.resolve(project || '.', String(a)), tool) || same(path.resolve(String(a)), tool)));
  });
  return keys.sort((a, b) => (b === MCP_SERVER_KEY) - (a === MCP_SERVER_KEY));
}

/** Server names in a Codex `config.toml` whose section runs the worker script, current name first. */
function ownCodexSections(text, tool = TOOL) {
  let servers;
  try { servers = codexServers(text); } catch { return []; }
  const own = Object.keys(servers).filter(name => {
    const entry = servers[name];
    return entry && typeof entry.command === 'string' && entry.command.length > 0
      && [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])]
        .some(x => typeof x === 'string' && x && same(path.resolve(x), tool));
  });
  return own.sort((a, b) => (b === MCP_SERVER_KEY) - (a === MCP_SERVER_KEY));
}

/**
 * The Claude side: the connection lives in the PROJECT file (`.mcp.json`).
 * @returns {{installed:boolean, provider:'claude', note:string}}
 */
/**
 * The OWN decision of the account: has it enabled or disabled the worker server in this project.
 *
 * THE ABSENCE OF A RECORD IS NOT A NO - measured: the profiles of two accounts both had empty
 * `enabledMcpjsonServers`/`disabledMcpjsonServers`, yet checking with `/mcp` showed the connection
 * CONNECTED. Turning that absence into not-approved raises a false warning about a working setup.
 *
 * @param {string|null} profile  the `CLAUDE_CONFIG_DIR` folder of the account
 * @returns {'opened'|'closed'|'unknown'}
 */
/* THE APPROVAL LIVES IN THE PROJECT SETTINGS - measured against a real Claude Code 2.1.272: on
   approval the CLI writes `enabledMcpjsonServers` into `<project>/.claude/settings.local.json`;
   `disabledMcpjsonServers` drops the server from the list; `enableAllProjectMcpServers` enables all
   of them. The CLI DELETES the `.claude.json` fields in the profile when it rewrites that file -
   that is why a profile could be empty while the connection was live. The project settings are read
   first (local, then shared), then the profile for older versions. */
function claudeEnablement(profile, project, name = MCP_SERVER_KEY) {
  const inside = (list) => Array.isArray(list) && list.includes(name);
  const decision = (v) => {
    if (!v || typeof v !== 'object') return null;
    if (inside(v.disabledMcpjsonServers)) return 'closed';
    if (inside(v.enabledMcpjsonServers)) return 'opened';
    if (v.enableAllProjectMcpServers === true) return 'opened';
    return null;
  };
  if (project) {
    for (const file of ['settings.local.json', 'settings.json']) {
      let v = null;
      try { v = JSON.parse(fs.readFileSync(path.join(project, '.claude', file), 'utf8')); } catch { continue; }
      const k = decision(v);
      if (k) return k;
    }
  }
  if (!profile) return 'unknown';
  let j;
  /* The default account keeps this file in the home folder, not inside `~/.claude`: the account card
     used to read `~/.claude/.claude.json` for it. `onboarding.claudeConfiguration` makes that split. */
  try { j = JSON.parse(fs.readFileSync(require('./onboarding').claudeConfiguration(profile), 'utf8')); }
  catch { return 'unknown'; }
  const projects = (j && j.projects) || {};
  const wanted = projectId(project);
  const record = Object.entries(projects).find(([filePath]) => projectId(filePath) === wanted);
  return (record && decision(record[1])) || 'unknown';
}

/**
 * The Claude side: the connection lives in the PROJECT file (`.mcp.json`), while the decision of the
 * account lives in the profile of that account.
 * @param {string|null} profile  the `CLAUDE_CONFIG_DIR` folder of the account; without it, enablement is unknown
 */
function claudeStatus(project, profile = null, tool = TOOL) {
  let key;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8'));
    key = ownClaudeKeys(j, project, tool)[0];
    if (!key) return response('none', 'claude', "Project connection not configured.");
  } catch {
    return response('none', 'claude', "Worker connection is missing from .mcp.json.");
  }

  /* AN `enabled` FIELD INSIDE `.mcp.json` IS NOT READ: that the provider reads it could not be
     verified. The disable decision is kept in the profile of the account, and that is the measurable place.
     The provider records that decision under the server's key, so it is looked up under the
     key the entry actually has. */
  const enablement = claudeEnablement(profile, project, key);
  if (enablement === 'closed') {
    /* NOT "/mcp": Claude's /mcp list does not show a declined project server (measured on 2.1.280),
       so that advice led nowhere. The way back is the bar above the Claude terminal. */
    return response('closed', 'claude', "Benchook's connection is turned off for this project (declined in Claude), so "
      + "agents on other accounts cannot be called. Use Ask again above the Claude terminal.",
    { configuration: true, enablement });
  }
  return response('installed', 'claude', enablement === 'opened'
    ? "Project connection configured and approved for this account. That is configuration "
      + "evidence, not proof the tool is loaded in a running session."
    : "Project connection configured. Whether this account approved it is not recorded, so a "
      + "new session may ask. That is configuration evidence, not proof the tool is loaded.",
  { configuration: true, enablement });
}

/**
 * The Codex side: the connection lives in the home of the ACCOUNT (`config.toml`), not per project.
 * @param {string} homePath  the CODEX_HOME folder of that account
 */
function codexStatus(homePath, tool = TOOL) {
  let text;
  try { text = fs.readFileSync(path.join(homePath, 'config.toml'), 'utf8'); }
  catch { return response('none', 'codex', "Connection not configured for this Codex account."); }

  const missing = "This Codex account's connection is missing or out of date.";
  /* A NAME APPEARING IN A FILE IS NOT PROOF OF A CONNECTION. It used to be enough for the worker path
     to appear anywhere in the text of the section; even an example in a comment line counted as
     installed. The path is now looked for in REAL fields, and a command to run is required. */
  const name = ownCodexSections(text, tool)[0];
  if (!name) return response('none', 'codex', missing);
  const entry = codexServers(text)[name];

  /* A DISABLED DEFINITION IS NOT INSTALLED. That `enabled` is a setting of an MCP server was verified
     inside the installed `codex.exe`: the fields of the server configuration structure include
     `command, args, env,... , enabled, disabled_reason`.
     AN UNWRITTEN `enabled` MEANS ON. Not invented: the line was absent from a working Codex setup of
     the user and the connection worked in a real run - and that is the Codex default too. */
  const opened = entry.enabled;
  if (opened === false) {
    return response('closed', 'codex', "This Codex account's connection is defined but disabled "
      + "(enabled = false). Enable it before agents on this account can be called.",
    { configuration: true, enablement: 'closed' });
  }
  const extra = { configuration: true, enablement: 'opened' };

  /* A RECORD PINNED TO A PROJECT. Under Codex the server record is kept per ACCOUNT, not per project;
     if `BENCHOOK_PROJECT` is written into env, EVERY project opened under that account sees the
     agents of the pinned project. Measured against a real run: with the pin empty the server finds
     the folder Codex is running in correctly, so the pin is both unnecessary and misleading. Calling
     this installed would be wrong - it shows the wrong project. */
  const fixed = typeof entry.env?.BENCHOOK_PROJECT === 'string' ? entry.env.BENCHOOK_PROJECT : null;
  if (fixed) {
    return response('otherProject', 'codex',
      "This Codex account's connection is fixed to one project (" + fixed + "). It will show that project's agents "
      + "in every workspace. Run setup again to use the active project.", extra);
  }

  /* THE MODEL AND PANE OF THE TERMINAL REACH THE SERVER THROUGH `env_vars` - /060.
     Measured: Codex does NOT pass the parent environment to an MCP server, but if `env_vars = [name,...]` is written it copies those names from the environment of the calling process. A name that
     is on the list but absent from the parent is not an error, only empty. An older setup without
     this line still works; it only means the same-model-as-the-orchestrator promise falls back to the
     default, and a Codex run is bound to its pane through the process ancestry instead. */
  /* REGISTERED UNDER ANOTHER NAME. The server works, but Codex records each call under the
     registration's name, and `codex-mcp-matching.js` links a run to its pane only under the
     current name -- so those runs would not appear under the pane that started them. */
  if (name !== MCP_SERVER_KEY) {
    return response('installed', 'codex', "Connection configured for this Codex account under an older "
      + "name (" + name + "). Agents can be called, but their runs will not appear under the terminal "
      + "that started them. Run setup again and open a new terminal. That is configuration evidence, "
      + "not proof the tool is loaded in a running session.", { ...extra, needsRerun: true });
  }

  const moved = Array.isArray(entry.env_vars) ? entry.env_vars : [];
  const missingInherited = INHERITED_ENV.filter((x) => !moved.includes(x));
  if (missingInherited.length) {
    return response('installed', 'codex', "Connection configured for this Codex account, but it was set up "
      + "before Benchook passed the session's model and pane to agents. Run setup again and open "
      + "a new terminal so agents on \"Same as orchestrator\" use your model. That is configuration "
      + "evidence, not proof the tool is loaded in a running session.",
    { ...extra, inheritedMissing: true, needsRerun: true });
  }

  /* THE WAIT LIMIT - 25 September 2026, measured: Codex gives up on an MCP call after 300 s by default, so an
     agent waiting longer than 5 minutes for the user's answer on the live run card would lose its result. */
  if (entry.tool_timeout_sec === undefined) {
    return response('installed', 'codex', "Connection configured for this Codex account, but it was set up "
      + "before Benchook raised Codex's 5 minutes limit for an agent call: if you take longer than 5 minutes to "
      + "answer an agent's question, the orchestrator loses its result. Run setup again and open a new terminal.", { ...extra, needsRerun: true });
  }

  return response('installed', 'codex', "Connection configured for this Codex account. That is "
    + "configuration evidence, not proof the tool is loaded in a running session.", extra);
}

/** The environment names that vary per terminal and must be carried to the worker server. */
const INHERITED_ENV = ['BENCHOOK_ORCHESTRATOR_MODEL', 'BENCHOOK_SESSION'];

/**
 * Puts the `env_vars` line under `[mcp_servers.worker]` in the `config.toml` text.
 * Textual and narrow: it does not touch the rest of the file (comments, trust records, hooks); with
 * no such section it returns the text unchanged. If the line is already complete it is not rewritten.
 * @param {string} text  the contents of config.toml
 * @returns {{text:string, changed:boolean}}
 */
function updateServerField(text, key, field, value) {
  const original = String(text || '');
  const lines = original.split(/\r?\n/);
  const head = lines.findIndex(line => {
    const parts = tablePath(line);
    return parts?.length === 2 && parts[0] === 'mcp_servers' && parts[1] === key;
  });
  if (head < 0) throw new Error('Cannot safely update inline MCP settings; use a separate server table.');
  let end = head + 1;
  while (end < lines.length && !tablePath(lines[end])) end++;
  const pattern = new RegExp('^\\s*(?:' + field + '|"' + field + '"|\'' + field + '\')\\s*=');
  const offset = lines.slice(head + 1, end).findIndex(line => pattern.test(line));
  const replacement = field + ' = ' + (Array.isArray(value)
    ? '[' + value.map(item => JSON.stringify(item)).join(', ') + ']'
    : JSON.stringify(value));
  if (offset < 0) lines.splice(head + 1, 0, replacement);
  else {
    const first = head + 1 + offset;
    let last = first, complete = false;
    for (; last < end; last++) {
      try { const parsed = toml.parse(lines.slice(first, last + 1).join('\n'));
        if (Object.hasOwn(parsed, field)) { complete = true; break; }
      } catch { /* Continue through a multiline value. */ }
    }
    if (!complete) throw new Error('Cannot safely update MCP field: ' + field);
    lines.splice(first, last - first + 1, replacement);
  }
  const result = lines.join(original.includes('\r\n') ? '\r\n' : '\n');
  const expected = toml.parse(original);
  expected.mcp_servers[key][field] = value;
  if (!require('node:util').isDeepStrictEqual(toml.parse(result), expected))
    throw new Error('MCP update would change unrelated settings; existing settings were preserved.');
  return { text: result, changed: result !== original };
}

function addEnvVars(text, names = INHERITED_ENV, key = MCP_SERVER_KEY) {
  const entry = codexServers(text)[key];
  if (!entry) return { text: String(text || ''), changed: false };
  const existing = entry.env_vars === undefined ? [] : entry.env_vars;
  if (!Array.isArray(existing) || existing.some(name => typeof name !== 'string'))
    throw new Error('Invalid MCP env_vars; existing settings were preserved.');
  if (names.every(name => existing.includes(name))) return { text: String(text), changed: false };
  return updateServerField(text, key, 'env_vars', [...new Set([...existing, ...names])]);
}

/* Keep the tool call open while an agent awaits approval. The long transport timeout avoids expiring an otherwise idle approval request. */
const TOOL_TIMEOUT_SEC = 31536000;

/**
 * Puts `tool_timeout_sec` under `[mcp_servers.benchook]` when the section has none. A value already there -
 * the user's own - is kept. Textual and narrow, like `addEnvVars`.
 * @returns {{text:string, changed:boolean}}
 */
function addToolTimeout(text, key = MCP_SERVER_KEY) {
  const entry = codexServers(text)[key];
  if (!entry || entry.tool_timeout_sec !== undefined) return { text: String(text || ''), changed: false };
  return updateServerField(text, key, 'tool_timeout_sec', TOOL_TIMEOUT_SEC);
}

/* *
 * THE PANEL path: the connection state for an account in the registry.
 * @param {object} account      the registry record ({ provider,... })
 * @param {string} project      the open project
 * @param {(h:object)=>string} folderPath  a function giving the home folder of the account */
function accountFor(account, project, folderPath, tool = TOOL) {
  if (!account || !project) return { installed: false, provider: null, error: "Select a project and account first." };
  return account.provider === 'claude'
    ? claudeStatus(project, folderPath(account), tool)
    : codexStatus(folderPath(account), tool);
}

/**
 * THE HOOK path: does this connection exist in the session that is running me.
 *
 * If the provider CANNOT BE DETERMINED it returns `unknown` and the caller STAYS QUIET. The first
 * never of the panel: it does not show what it does not know as if it knew. A false not-installed
 * warning pushes the user into breaking a working setup.
 *
 * @returns {{installed:boolean, provider:string, note:string}|{unknown:true}}
 */
function sessionFor(env, project, tool = TOOL) {
  const o = env || {};
  /* THE PROFILE OF THE SESSION: in a terminal opened from the panel, `CLAUDE_CONFIG_DIR` is set; in a
     session opened outside the panel the record is in the `.claude.json` of the home directory. */
  if (o.CLAUDECODE) return claudeStatus(project, o.CLAUDE_CONFIG_DIR || os.homedir(), tool);
  if (o.CODEX_HOME) return codexStatus(o.CODEX_HOME, tool);
  return { unknown: true, status: 'unknown' };
}

/* THE TEXTS THAT APPEAR ON SCREEN AND IN THE CATALOGUE LIVE HERE - so the card of the panel and the
   catalogue the orchestrator reads say the same sentence. If they drift apart the user hears two
   different things, and that is exactly the shape of the defect this module was written to fix. */
const MESSAGE = {
  /** The OWN account of the agent is signed out: a call would already be refused by `worker.js`; it is said in advance. */
  signInNone: (accountName) =>
    "Assigned account (" + accountName + ") is signed out; sign in from the panel before running this agent.",

  /** This agent cannot be reached from the selected orchestrator: the tool is not defined in that session. */
  connectionNone: (orchestratorName) =>
    "MCP connection is not set up for " + orchestratorName + "; this agent cannot be called from there.",

  /* * The connection is DISABLED: there is nothing to install, there is something to enable. A separate
   *  sentence, because what the user has to do is different. */
  connectionClosed: (orchestratorName) =>
    "The worker connection is turned off for " + orchestratorName + "; enable it before this agent can be called.",

  /** The connection is pinned to ANOTHER project: it shows the agents of that project in every workspace. */
  connectionOtherProject: (orchestratorName) =>
    "The worker connection for " + orchestratorName + " is fixed to another project; run setup again for the active project.",

  /** AFTER a setup: an already open session does not pick up the new record. Measured. */
  openRe:
    "Open a new terminal for this account; a session that is already running does not pick up a new connection.",
};

/* THE STATE CHOOSES THE SENTENCE ON THE AGENT CARD. Every state other than installed used
   to print the same thing: "MCP connection is not set up". A disabled connection is not an
   uninstalled one, and what the user has to do differs. If the provider cannot be determined, IT
   STAYS QUIET. */
MESSAGE.reachability = (status, orchestratorName) => {
  if (status === 'closed') return MESSAGE.connectionClosed(orchestratorName);
  if (status === 'otherProject') return MESSAGE.connectionOtherProject(orchestratorName);
  if (status === 'none') return MESSAGE.connectionNone(orchestratorName);
  return null;                       // installed or unknown: no warning is produced
};

/* *
 * ASK AGAIN AFTER A DECLINED CONNECTION . Claude records "continue without" for a
 * project server in `<project>/.claude/settings.local.json` (`disabledMcpjsonServers`) and never asks
 * again. Removing Benchook's own entry puts the server back to "Pending approval" (measured with
 * `claude mcp get`), so Claude asks on its next start. Only that entry is removed and only from the
 * personal file; a decline in the shared `settings.json` belongs to the project and is reported.
 * @returns {{done: true, file: string} | {error: string}} */
function askAgainClaude(project, tool = TOOL) {
  let keys = [];
  try { keys = ownClaudeKeys(JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')), project, tool); }
  catch { keys = []; }
  if (!keys.length) return { error: "This project has no Benchook connection in .mcp.json." };
  const declined = (v) => !!v && Array.isArray(v.disabledMcpjsonServers)
    && v.disabledMcpjsonServers.some((k) => keys.includes(k));
  const localFile = path.join(project, '.claude', 'settings.local.json');
  let local = null;
  try { local = JSON.parse(fs.readFileSync(localFile, 'utf8')); } catch { local = null; }
  if (declined(local)) {
    const kept = local.disabledMcpjsonServers.filter((k) => !keys.includes(k));
    const next = { ...local };
    if (kept.length) next.disabledMcpjsonServers = kept; else delete next.disabledMcpjsonServers;
    require('./persistent-json').atomicText(localFile, JSON.stringify(next, null, 2) + '\n');
    return { done: true, file: localFile };
  }
  let shared = null;
  try { shared = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8')); } catch { shared = null; }
  if (declined(shared)) {
    return { error: "The connection is turned off in this project's shared .claude/settings.json. "
      + "Benchook does not change that file; remove \"" + keys[0] + "\" from disabledMcpjsonServers there." };
  }
  return { error: "Benchook's connection is not declined in this project." };
}

module.exports = { TOOL, STATES, askAgainClaude, INHERITED_ENV, addEnvVars, addToolTimeout, TOOL_TIMEOUT_SEC, claudeStatus, claudeEnablement, codexStatus,
  ownClaudeKeys, ownCodexSections, accountFor, sessionFor, MESSAGE };
