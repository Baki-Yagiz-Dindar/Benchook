// PROJECT SETUP - the piece that closes the gap between an agent LOOKING assigned and actually
// being callable.
//
// The defect it fixes: the panel showed an agent as belonging to this project while the
// orchestrator said no such agent existed. Both were right - the panel reads the folder, while the
// orchestrator knows what it was TOLD when its session opened, and no hook had been installed.
//
// IN TERMS OF THE safety constraints: `plan` writes nothing and returns EVERY file and every line that
// would be written; the page shows that, approval is asked afterwards, and `apply` is called only
// after that approval. What is automatic is not having to hunt for a separate button - not the
// removal of the approval.
//
// NO SCRIPT IS COPIED INTO THE PROJECT. The files installed are only markers pointing at the own
// script of the panel - the same pattern as `.mcp.json` pointing at `tools/mcp-server.js`. Paths
// are not hard-coded, they are resolved at run time.
//
// WHY BOTH A HOOK AND MCP: they close different gaps and both were measured against real runs. The
// MCP blurb REACHES Codex (seen in the own session record of Codex, at the head of the description
// of every `mcp__worker__*` tool), but under Codex the server record is kept per ACCOUNT, not per
// project. The hook belongs to the project and works on both sides (the `hook: SessionStart` lines
// and the right agent name were seen in the Codex output).

const fs = require('node:fs');
const path = require('node:path');
const operations = require('./folder-transaction');
const resolution = require('./agent-resolution');
const agentFolders = require('./agent-folders');
const mcpStatus = require('./mcp-status');
const { MCP_SERVER_KEY } = require('./product');

const CATALOG = path.resolve(__dirname, '..', 'tools', 'project-catalog.js');
const WORKER = path.resolve(__dirname, '..', 'tools', 'mcp-server.js');

const command = (flag) => 'node "' + CATALOG.replace(/\\/g, '/') + '" ' + flag;

/** Whether this hook calls our script - the path separator makes no difference. */
const ownHook = (k) => String((k && k.command) || '').replace(/\\/g, '/')
  .includes(CATALOG.replace(/\\/g, '/'));

/**
 * Puts our entry into the hook list of an event. The OWN hooks of the project are preserved;
 * ours is updated if present and appended otherwise. Overwriting would silently delete the
 * project's own setup.
 */
function placeHook(existing, flag, extraFields) {
  const list = Array.isArray(existing) ? existing.map((x) => ({ ...x })) : [];
  const entry = { type: 'command', command: command(flag), timeout: 10, ...extraFields };
  for (const group of list) {
    if (!Array.isArray(group.hooks)) continue;
    const place = group.hooks.findIndex(ownHook);
    if (place >= 0) { group.hooks[place] = entry; return list; }
  }
  list.push({ hooks: [entry] });
  return list;
}

function readJson(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const value = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Settings must contain a JSON object: ' + file);
  for (const key of ['hooks', 'mcpServers']) {
    if (key in value && (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])))
      throw new Error('Invalid settings field "' + key + '": ' + file);
  }
  if (value.hooks) for (const hooks of Object.values(value.hooks)) {
    if (!Array.isArray(hooks) || hooks.some(group => !group || !Array.isArray(group.hooks)))
      throw new Error('Invalid hook configuration: ' + file);
  }
  return value;
}

/** The Claude side: the two hooks in `.claude/settings.json`. */
function claudeSetting(project) {
  const file = path.join(project, '.claude', 'settings.json');
  const previous = readJson(file);
  const j = previous ? JSON.parse(JSON.stringify(previous)) : {};
  j.hooks = j.hooks || {};
  j.hooks.SessionStart = placeHook(j.hooks.SessionStart, '--session-start');
  j.hooks.UserPromptSubmit = placeHook(j.hooks.UserPromptSubmit, '--prompt');
  return { file, content: JSON.stringify(j, null, 2) + '\n', previous };
}

/** The Codex side: `.codex/hooks.json`. The same script, the same two events. */
function codexSetting(project) {
  const file = path.join(project, '.codex', 'hooks.json');
  const previous = readJson(file);
  const j = previous ? JSON.parse(JSON.stringify(previous)) : {
    description: "Benchook agent catalog. Hooks reference the installed Benchook scripts.",
  };
  j.hooks = j.hooks || {};
  const extra = { additionalContextLimit: 8000 };
  j.hooks.SessionStart = placeHook(j.hooks.SessionStart, '--session-start', extra);
  j.hooks.UserPromptSubmit = placeHook(j.hooks.UserPromptSubmit, '--prompt', extra);
  return { file, content: JSON.stringify(j, null, 2) + '\n', previous };
}

/** A copy of a parsed `.mcp.json` with exactly one worker entry, under the current key. Every
    entry that runs the worker script is removed first, whatever its key, so an entry from an
    older version is replaced rather than joined by a second server. The project's own servers
    are kept. */
function withOwnMcpServer(json, project) {
  const j = json ? JSON.parse(JSON.stringify(json)) : {};
  j.mcpServers = j.mcpServers || {};
  for (const key of mcpStatus.ownClaudeKeys(j, project, WORKER)) delete j.mcpServers[key];
  j.mcpServers[MCP_SERVER_KEY] = { command: 'node', args: [WORKER] };
  return j;
}

/** The in-project MCP record of Claude. The Codex one is per account, so it is not here. */
function mcpSetting(project) {
  const file = path.join(project, '.mcp.json');
  const previous = readJson(file);
  const j = withOwnMcpServer(previous, project);
  return { file, content: JSON.stringify(j, null, 2) + '\n', previous };
}

/**
 * The missing `provider` line in older definitions.
 *
 * The panel writes this line now; files written before it do not have it, and without the line the
 * orchestrator CANNOT CHOOSE whether to run the agent itself or hand it to `run_agent` - and the rule
 * says do not guess what you do not know. The value is not invented: which provider an account
 * belongs to is written in the registry of the panel and is read from there. For an account that is
 * not in the registry the file is NOT TOUCHED.
 */
function providerRepair(project, accountProvider) {
  const folders = agentFolders.inProject(project, [agentFolders.PANEL]);
  const tasks = [];
  for (const k of folders) {
    let signIns;
    try { signIns = fs.readdirSync(k).filter((x) => x.endsWith('.md')).sort(); } catch { continue; }
    for (const file of signIns) {
      const filePath = path.join(k, file);
      let raw;
      try { raw = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
      /* THE SHARED READER. The copy that used to live here did not check whether the
         front matter was at the START of the file: in a plain task text with NO front matter, a line
         in the body resembling `account:` was taken for a field, and the migration could write the
         `provider:` line into the middle of the TASK TEXT of the user. A file with no front matter,
         or one that cannot be parsed, is not a subject of this migration; it is left alone. */
      const { get, hasOnText, corrupt } = resolution.parseFrontmatter(raw);
      if (!hasOnText || corrupt) continue;
      if (get('provider')) continue;
      const account = get('account');
      if (!account) continue;
      const provider = accountProvider(account.trim());
      if (!provider) continue;
      tasks.push({ file: filePath, account: account.trim(), provider: provider,
        content: raw.replace(/^(account:.*)$/m, '$1\nprovider: ' + provider) });
    }
  }
  return tasks;
}

/**
 * Returns EVERYTHING that would be written, and writes nothing.
 * @param accountKind (id) => 'claude' | 'codex' | null - the registry of the panel
 */
function plan(project, accountProvider) {
  if (!project) return { error: "Select a project first" };
  const steps = [];
  try {
  for (const maker of [claudeSetting, codexSetting, mcpSetting]) {
    const a = maker(project);
    // If the same thing is already there no step is written: the approval screen must not show an unchanged file.
    if (a.previous && JSON.stringify(a.previous, null, 2) + '\n' === a.content) continue;
    steps.push({ kind: a.previous ? 'update' : 'create', file: a.file, content: a.content,
      previousContent: a.previous ? fs.readFileSync(a.file, 'utf8') : null });
  }
  for (const t of providerRepair(project, accountProvider)) {
    steps.push({ kind: 'repair', file: t.file, content: t.content,
      previousContent: fs.readFileSync(t.file, 'utf8'),
      note: "Add missing provider field: " + t.provider
        + ' (' + t.account + " account)" });
  }
  } catch (e) { return { error: 'Cannot prepare project settings; existing files were preserved. ' + e.message }; }
  return { steps };
}

/** REALLY applies the plan. Called only after the page has taken approval. */
function apply(steps) {
  try {
    if (!Array.isArray(steps)) throw new Error('Invalid installation plan.');
    for (const a of steps) {
      if (!a || typeof a.file !== 'string' || typeof a.content !== 'string'
          || !Object.hasOwn(a, 'previousContent')) throw new Error('Invalid installation step.');
      let existing = null;
      try { existing = fs.readFileSync(a.file, 'utf8'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (existing !== a.previousContent)
        throw new Error('File changed since preview. Review a new plan: ' + a.file);
    }
    const result = operations.apply(steps.map(a => ({ target: a.file, kind: 'file',
      prepare: target => fs.writeFileSync(target, a.content, 'utf8') })));
    return { written: steps.map(a => a.file), warning: result.warning };
  } catch (e) { return { error: e.message, written: [] }; }
}

module.exports = { plan, apply, withOwnMcpServer, readJson, CATALOG, WORKER };
