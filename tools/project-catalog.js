#!/usr/bin/env node
// PROJECT CATALOGUE - the hook script that announces the agents of the panel in a project, whichever
// orchestrator is opened.
//
// WHY A SEPARATE SCRIPT: it says only which agents exist and is NEVER COPIED into any project - the
// panel installs only a marker file into a project that says to take the note from this script. The
// same pattern as `.mcp.json` pointing at `tools/mcp-server.js`. A hook copied into a project would
// also carry the rules of the project it came from into every project it was copied to.
//
// TWO EVENTS:
//   --session-start  when a session opens: the full list of the agents assigned to this project.
//   --prompt         on every message: if the list has CHANGED since it was last announced it says
//                    what changed, and if nothing changed it writes nothing. It exists so an agent
//                    added mid-job is heard without waiting for a new session; while it stays silent
//                    it spends no tokens.
//
// WHERE THE STATE IS KEPT: in the own data folder of the panel, per PROJECT IDENTITY and per SESSION.
// Nothing is written inside the project - apart from agent definitions the panel leaves no file in
// the folder of the user. The schema itself and the two defects it fixes are written in the header
// of `panel/catalog-state.js`.
//
// STDOUT IS SACRED: only the JSON of the hook is written there, nothing else.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const accounts = require(path.join(__dirname, '..', 'panel', 'accounts.js'));
const resolution = require(path.join(__dirname, '..', 'panel', 'agent-resolution.js'));
const mcpStatus = require(path.join(__dirname, '..', 'panel', 'mcp-status.js'));
const catalogStatus = require(path.join(__dirname, '..', 'panel', 'catalog-state.js'));

const project = process.env.BENCHOOK_PROJECT || process.cwd();
const event = process.argv.includes('--session-start') ? 'start'
  : process.argv.includes('--prompt') ? 'change' : null;
/* An argument this version does not know -- for example from a hook installed by an older
   version -- prints nothing. Treating it as a session start would put the full agent list into
   the conversation on every prompt, spending tokens in the background. */
if (!event) process.exit(0);

// The own data folder of the panel. The `userData` of Electron lands here too; if the environment
// variable is set it is used, so a test does not pollute the real user folder.
const dataRoot = require('../panel/data-path').resolve();
const agentFolders = require('../panel/agent-folders');

/* WHICH SESSION TRIGGERED THIS RUN. With no identity none is INVENTED; every session without an
   identity shares one bucket, and the reason for that limit is in the header of `panel/catalog-state.js`. */
const session = catalogStatus.sessionIdFromFile(process.env);

// The registry, in the data folder of the panel. With the panel never opened it starts empty.
accounts.setup(path.join(dataRoot, 'accounts.json'));

/** The agents ASSIGNED to this project. Two folders, ONE rule.
 *  No filter: every `.md` in the folder is an agent, and `agent-resolution` binds what is missing to
 *  the orchestrator. The reason is written in the header of `panel/agent-resolution.js`. */
function agents() {
  const folders = agentFolders.inProject(project, [agentFolders.PANEL]);
  const output = [];
  const seen = new Set();
  for (const k of folders) {
    let signIns;
    try { signIns = fs.readdirSync(k).filter((x) => x.endsWith('.md')).sort(); }
    catch { continue; }
    for (const file of signIns) {
      let raw;
      try { raw = fs.readFileSync(path.join(k, file), 'utf8'); } catch { continue; }
      const { get } = resolution.parseFrontmatter(raw);
      const name = get('name') || file.replace(/\.md$/, '');
      if (seen.has(name)) continue;
      seen.add(name);
      const c = resolution.resolve(
        { account: get('account'), provider: get('provider'), model: get('model') },
        (x) => accounts.findLoose(x));
      /* IF THE ASSIGNED ACCOUNT IS SIGNED OUT IT IS SAID IN ADVANCE. `worker.js` already refuses at
         call time; the orchestrator knowing it before running saves a run. */
      const record = c.asOrchestrator ? null : accounts.findLoose(get('account'));
      const signInNone = !!(record && !accounts.hasSignIn(record));
      output.push({
        name,
        assigned: !c.asOrchestrator,
        signInWarning: signInNone ? mcpStatus.MESSAGE.signInNone(record.name || record.id) : null,
        description: get('description') || '',
        account: resolution.accountLabel(c),
        provider: c.asOrchestrator ? "Same as orchestrator" : (c.provider || '?'),
        model: resolution.modelLabel(c),
        reason: c.reason,
        file: path.relative(project, path.join(k, file)),
      });
    }
  }
  return output;
}

/* THE ROUTING TEXT IS BUILT PER SESSION. The old text told the orchestrator to determine its active
   account and not to guess, but a session had no way of knowing its own panel identity. The panel
   knows -- it gives the terminal its profile folder itself. If it is not found the text says so
   plainly and no identity is invented. */
const ROUTING = resolution.routing(accounts.sessionAccount(process.env));

const line = (a) => '- ' + a.name + " — When to use: " + (a.description || "(Not specified)")
  + " — Account: " + a.account + " — Provider: " + a.provider + " — Model: " + a.model
  + " — Definition: " + a.file + (a.reason ? " — Note: " + a.reason : '')
  + (a.signInWarning ? " — Note: " + a.signInWarning : '');

/** The record of this session in this project. If it cannot be written the hook still runs and only
 *  announces the same thing again next round - missing an announcement is worse than repeating one.
 *  @param {{signature:string, connection:string}} record */
const writeStatus = (record) =>
  catalogStatus.write(dataRoot, project, session.id, { ...record, source: session.source });

function tell(text) {
  const eventName = event === 'change' ? 'UserPromptSubmit' : 'SessionStart';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
  }) + '\n');
}

/* Report whether the configured agent tool is reachable from the session. If the provider is unknown, avoid an unsupported missing-connection diagnosis. */
function connectionNote(all) {
  if (!all.some((a) => a.assigned)) return null;   // with no agent assigned to another account there is nothing to say
  const d = mcpStatus.sessionFor(process.env, project);
  if (d.unknown || d.installed) return null;
  return "MCP connection is not set up for this session: " + d.note
    + " Agents assigned to another account cannot be called from here. Set it up in the panel, "
    + "then open a new terminal.";
}

/* Store the connection state with the catalog signature using the vocabulary from panel/mcp-status.js. */
const connectionStatus = () => mcpStatus.sessionFor(process.env, project).status || 'unknown';

/* The signature includes fields that affect agent selection and execution. Exclude informational file paths and unannounced task bodies. Sort entries by name to avoid changes caused only by file order. */
const signatureLine = (a) => JSON.stringify([a.name, a.description || '', a.account, a.provider, a.model,
  a.reason || null, a.signInWarning || null]);
const resolveName = (line) => { try { return JSON.parse(line)[0]; } catch { return null; } };

const list = agents();
const signature = list.map(signatureLine).sort().join('\n');
const connection = connectionStatus();
const previous = catalogStatus.read(dataRoot, project, session.id);

/* MIGRATING FROM THE OLD SCHEMA. The old state file kept ONE record per project; which session had
   heard what was not written there. Counting that record as seen by this session would produce a
   false already-notified - the user adds an agent and the session never hears about it. So the old
   file is NO LONGER READ; it is not deleted either, so that nothing is lost silently.
   The cost is one-off: a session open at the moment of migration receives the full list once more. */
const baseNone = previous.signature === null;

/** The full list given at startup. A session with an unknown baseline gets this too: the state as it
 *  is rather than an invented difference. */
function tellFullList() {
  if (!list.length) process.exit(0);
  const warning = connectionNote(list);
  tell("Agents assigned to this project:\n" + list.map(line).join('\n') + '\n\n' + ROUTING
    + (warning ? '\n\n' + warning : ''));
  process.exit(0);
}

if (event === 'start') {
  writeStatus({ signature, connection });
  catalogStatus.cleanOld(dataRoot, project);
  tellFullList();
}

/* Announce connection-state transitions even when agent definitions are unchanged, since an existing session may need to refresh its tool list. */
const connectionChanged = !baseNone && previous.connection !== null && previous.connection !== connection;

// --prompt: silence is the default. If nothing changed not a single character is written.
if (!baseNone && previous.signature === signature && !connectionChanged) process.exit(0);

/* A SESSION WITH NO BASELINE: the session-start event never ran, or the record is left over from the
   old schema. What this session has heard IS UNKNOWN, so no fake difference is invented - the full
   startup list is given, the baseline is written, and it goes quiet from the next round. */
if (baseNone) {
  writeStatus({ signature, connection });
  tellFullList();
}

const previousNames = new Set(String(previous.signature || '').split('\n').filter(Boolean)
  .map(resolveName).filter(Boolean));
const created = list.filter((a) => !previousNames.has(a.name));
const removed = [...previousNames].filter((name) => !list.some((a) => a.name === name));

writeStatus({ signature, connection });

const parts = [];
if (previous.signature !== signature) {
  if (created.length) parts.push("Agent added to this project:\n" + created.map(line).join('\n'));
  if (removed.length) parts.push("Agent removed from this project: " + removed.join(', ')
    + " — no longer available.");
  if (!created.length && !removed.length) {
    // The same list of names but a changed account, model or provider: the routing changes, so the full list is given.
    parts.push("Project agent settings changed:\n" + list.map(line).join('\n'));
  }
  parts.push(ROUTING);
}

if (connectionChanged && connection === 'installed') {
  /* INSTALLED DOES NOT MEAN READY: this session read its record when it started. */
  parts.push("The MCP connection is now configured for this session's account. "
    + "A session that started before this change does not have the tool: if `run_agent` is "
    + "missing, refresh the agent list or open a new terminal. Do not work around it by "
    + "starting the worker server yourself.");
} else if (connectionChanged) {
  /* Use the shared status description for every non-installed connection state. */
  const d = mcpStatus.sessionFor(process.env, project);
  parts.push("The MCP connection is no longer usable for this session's account. "
    + (d.note ? d.note + ' ' : '')
    + "Agents assigned to another account cannot be called until it is set up in the panel.");
}

const connectionWarning = connectionNote(list);
if (connectionWarning && !connectionChanged) parts.push(connectionWarning);
/* NO EMPTY ANNOUNCEMENT IS MADE: with nothing left to say the silence default applies. */
if (!parts.length) process.exit(0);
tell(parts.join('\n\n'));
