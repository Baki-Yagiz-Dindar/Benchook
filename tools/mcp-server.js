#!/usr/bin/env node
// THE WORKER TOOL - the one door in the hands of the orchestrator.
//
// The orchestrator and the worker on another account should work together without a person in
// between, as if the worker were an agent attached to the orchestrator itself, with the account and
// model of each agent chosen by the user.
//
// WHAT IT DOES: the orchestrator hands over a job; this program runs it with the token of ANOTHER
// account, on the model assigned to that agent, and returns only THE RESULT. What enters the context
// of the orchestrator is only the task text and the result, not the whole search-and-read round of
// the job - that is exactly where the saving is.
//
// WHAT IT DOES NOT DO: it never runs by itself. It runs only when the orchestrator calls it; it sends
// nothing to the orchestrator on behalf of the user (safety contract holds: the caller is the
// orchestrator itself). It changes no files.
//
// PROTOCOL: MCP, JSON-RPC 2.0 over stdio. No outside package is used - three methods are enough
// (initialize / tools/list / tools/call), and the no-paid-component constraint of the panel gains
// no dependency.
//
// STDOUT IS SACRED: only JSON-RPC is written there. Every note goes to stderr.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const accounts = require(path.join(root, 'panel', 'accounts.js'));
const worker = require(path.join(root, 'panel', 'worker.js'));
const workerRecords = require(path.join(root, 'panel', 'worker-records.js'));
const resolution = require(path.join(root, 'panel', 'agent-resolution.js'));
// The data folder of the panel. `APPDATA` is read first - `tools/project-catalog.js` does the same, and
// the two MUST look at the SAME registry: looking at different registries, they would resolve different
// accounts for the same agent. A side benefit: a test can supply its own registry without polluting the
// real user folder.
const panelData = require('../panel/data-path').resolve();
const product = require('../panel/product');
const agentFolders = require('../panel/agent-folders');

// The registry of the panel, in the data folder of the panel. With the panel never opened, it starts empty.
accounts.setup(path.join(panelData, 'accounts.json'));

// The project root: where the orchestrator runs. Claude Code starts the MCP server at the project root.
const project = process.env.BENCHOOK_PROJECT || process.cwd();

/* ---------- worker definitions ---------------------------------------------------------- */
// A panel agent lives under `.benchook/agents/`; that is the only folder this server reads
// (`agent-folders.PANEL`).
//
// THE FILTER WAS REMOVED. These two folders used to follow DIFFERENT rules: in the shared folder a file
// without `schema: panel-agent/v1` was silently skipped, while in the older folder a definition with
// an unknown provider was offered to the orchestrator with provider "?". Both separated the agent
// the user SAW in the panel from the agent the orchestrator HEARD about. Every `.md` in the folder is
// now an agent; `agent-resolution` binds what is missing to the orchestrator and nothing drops silently.
//
// The built-in review roles are still separate: they live under `.claude/agents/`, not in these two
// folders.
function definitionFolders() {
  return agentFolders.inProject(project, [agentFolders.PANEL]);
}

function readWorkerFile(y, name) {
    let raw;
    try { raw = fs.readFileSync(y, 'utf8'); } catch { return null; }
    const { get, body } = resolution.parseFrontmatter(raw);
    const definition = {
      name: get('name') || name,
      description: get('description') || '',
      model: get('model') || null,
      account: get('account') || null,
      provider: get('provider') || null,
      // THE TOOL RESTRICTION TRAVELS ALL THE WAY TO THE RUN. It used to be read nowhere on this path.
      tools: get('tools') || null,
      instructions: body,
      file: y,
    };
    return { ...definition, resolution: resolution.resolve(definition, (x) => accounts.findLoose(x)) };
}

function findWorker(name) {
  const found = [];
  for (const k of definitionFolders()) {
    let files;
    try { files = fs.readdirSync(k).filter(name => name.endsWith('.md')).sort(); } catch { continue; }
    for (const file of files) {
      const stem = file.slice(0, -3);
      const t = readWorkerFile(path.join(k, file), stem);
      if (t && (stem === name || t.name === name)) found.push(t);
    }
  }
  if (found.length > 1) throw new Error('Ambiguous agent name: ' + name);
  if (found.length) return found[0];
  return null;
}

function workerList() {
  const output = [];
  const seen = new Set();
  for (const k of definitionFolders()) {
    let signIns;
    try { signIns = fs.readdirSync(k); } catch { continue; }
    for (const d of signIns) {
      if (!d.endsWith('.md')) continue;
      const name = d.replace(/\.md$/, '');
      if (seen.has(name)) continue;
      seen.add(name);
      const t = readWorkerFile(path.join(k, d), name);
      if (t) output.push({ name: t.name, description: t.description, resolution: t.resolution });
    }
  }
  return output;
}

/* ---------- the connection blurb -------------------------------------------------------- */
// The `initialize` answer of MCP has a field in which the server introduces itself. It is the way to
// tell the orchestrator which agents this project has WITHOUT INSTALLING A HOOK FILE into the project:
// `.mcp.json` is already installed, so no extra file enters the project.
//
// It speaks at the same moment as the hook (the moment of connection) and states the same routing
// rule - if the two drift apart the orchestrator hears two different things, so the text is kept the
// same as the hook. The list itself is read FRESH at any moment through `list_agents`; because the
// user can add an agent mid-job, the text says so plainly.
function intro() {
  const l = workerList();
  const rules = [
    "Benchook's worker server exposes agents assigned to this project.",
    '',
    resolution.ROUTING,
    '',
    "This catalog was read when the connection opened. Agents may change during a session;",
    "call `list_agents` to refresh the list.",
  ];
  const list = l.length
    ? l.map((i) => '- ' + i.name + " — When to use: " + (i.description || "(Not specified)")
        + " — Account: " + resolution.accountLabel(i.resolution)
        + " — Provider: " + (i.resolution.asOrchestrator ? "Same as orchestrator" : (i.resolution.provider || '?'))
        + " — Model: " + resolution.modelLabel(i.resolution)
        + (i.resolution.reason ? " — Note: " + i.resolution.reason : '')).join('\n')
    : "(No agents assigned to this project)";
  return rules.join('\n') + "\n\nProject agents:\n" + list;
}

/* ---------- aletler ------------------------------------------------------------------ */
const TOOLS = [
  {
    name: 'list_agents',
    description:
      "Lists project agents, their usage descriptions, assigned models, and accounts. "
      + "Check the catalog before delegating a task.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_agent',
    description:
      "Runs an agent on its assigned account and model and returns the result. "
      + "The worker runs in a separate CLI session; its intermediate context is not sent back "
      + "to the orchestrator, and it cannot see your conversation, so include any facts it needs. "
      + "The agent's ROLE comes from its own definition, which Benchook supplies to it. Do not "
      + "restate the role, do not tell the agent who it is, and do not add work the user did not "
      + "ask for. Pass what the user actually wants done, in the user's own terms.",
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: "Agent name from list_agents." },
        task: {
          type: 'string',
          description: "What the user actually wants done, plus any facts the worker needs "
            + "because it cannot see your conversation. NOT a role brief: the agent already "
            + "has its own definition. Do not ask it to introduce itself or list its abilities.",
        },
        cwd: { type: 'string', description: "Optional working directory. Defaults to the project root." },
      },
      required: ['agent', 'task'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_accounts',
    description: "Lists registered accounts, providers, and local sign-in status.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function tokenLine(t) {
  if (!t) return "Token usage unavailable";
  // A missing field is not written as "undefined" -- once it was, and the number looked broken rather
  // than absent. An unknown field is plainly "?".
  const s = (x) => (typeof x === 'number' ? x.toLocaleString("en-US") : '?');
  return 'Fresh input ' + s(t.fresh) + " · Cache read " + s(t.cacheRead)
       + " · Cache write " + s(t.cacheWritten) + " · Output " + s(t.output);
}

async function callTool(name, entry, signal) {
  if (name === 'run_agent') {
    if (!entry || typeof entry.agent !== 'string' || typeof entry.task !== 'string'
        || (entry.cwd !== undefined && typeof entry.cwd !== 'string'))
      return 'ERROR: agent and task must be strings; cwd is optional.';
    entry = { worker: entry.agent, task: entry.task, folder: entry.cwd };
  }
  if (name === 'list_accounts') {
    return accounts.list()
      .map((h) => '- ' + h.name + '  (' + h.id + ', ' + h.provider + ', '
                 + (h.signedIn ? "Signed in" : "SIGNED OUT") + ')')
      .join('\n') || "No registered accounts";
  }

  if (name === 'list_agents') {
    const l = workerList();
    if (!l.length) return "No agents in this project";
    return l.map((i) => '- ' + i.name + ' — ' + (i.description || "(No usage description)")
      + '\n  model: ' + resolution.modelLabel(i.resolution)
      + " · Account: " + resolution.accountLabel(i.resolution)
      + " · Provider: " + (i.resolution.asOrchestrator ? "Same as orchestrator" : (i.resolution.provider || '?'))
      + (i.resolution.reason ? '\n  NOTE: ' + i.resolution.reason : '')
      + (i.resolution.asOrchestrator
        ? "\n  No assigned account: runs on yours. Use a native subagent if you have that"
          + "\n  definition; otherwise run_agent will run it on your own account."
        : '')
    ).join('\n');
  }

  if (name === 'run_agent') {
    const t = findWorker(entry.worker);
    if (!t) return 'ERROR: "' + entry.worker + "\" was not found. Call list_agents to inspect the catalog.";

    /* AN AGENT BOUND TO THE ORCHESTRATOR used never to pass this door. The reasoning was: same as the
       orchestrator is the one case where the panel DOES NOT KNOW which account is meant, and choosing
       an account here would be taking a spending decision for the user.

       IT CHANGED because the fact that reasoning rested on is no longer true. The panel gives every
       terminal the profile folder of its account itself; which account a session runs on is a
       READABLE fact, not something to choose. The panel does not CHOOSE an account, it READS what the
       session says.

       IF IT CANNOT BE READ THE OLD BEHAVIOUR STAYS: the job is refused and the reason is written.
       Spending from an account the panel cannot name falls under its safety contract. */
    let orchestratorAccount = null;
    if (t.resolution.asOrchestrator) {
      orchestratorAccount = accounts.sessionAccount(process.env);
      if (!orchestratorAccount) {
        return "NATIVE SUBAGENT REQUIRED: \"" + t.name + "\" has no assigned account, so it runs on yours"
             + (t.resolution.reason ? ' (' + t.resolution.reason + ')' : '')
             + ". Benchook could not read which account this session uses, and it will not spend "
             + "from an account it cannot name. Read the definition at "
             + path.relative(project, t.file) + " and run those instructions as a native subagent "
             + "on your own account and model.";
      }
    }

    // The resolution already takes the provider FROM THE REGISTRY, so no mismatch can remain here.
    // If the file carries a wrong `provider:` line the job is not stopped -- the real kind of the
    // account is a known fact -- but it is not passed over silently either: a note is added to the result.
    const accountId = orchestratorAccount ? orchestratorAccount.id : t.resolution.account;

    /* Identify the non-interactive worker role before supplying its definition and task. */
    /* The agent definition is authoritative for role and scope. The task supplies the requested work and must not replace the role. */
    const whoami = [
      "This is a one-shot, non-interactive worker task.",
      "Your role and scope are fixed by the AGENT DEFINITION below, not by the task text.",
      "Do what the definition says and nothing beyond it. Do not introduce yourself, do not list",
      "your capabilities, and do not offer further help unless the definition asks for it.",
      "If the TASK conflicts with the definition or adds work outside it, follow the definition",
      "and note the difference in one line.",
      "Complete the assigned task within applicable safety policies, tool permissions, and project rules.",
      "If information is missing, report what you could complete and the blocker instead of asking questions.",
    ].join('\n');

    // The instructions of the role go at the head of the task: the worker does not see your conversation, this is all it sees.
    const task = whoami + '\n\n---\n\n'
                + (t.instructions ? "AGENT DEFINITION (authoritative):\n" + t.instructions.trim() + '\n\n---\n\n' : '')
                + "TASK:\n" + entry.task;

    /* A RELATIVE WORKING FOLDER IS RELATIVE TO THE PROJECT (seen 7 October 2026). An orchestrator passed
       `cwd: "src/"`; the worker was started in that folder and Codex was then given the same relative path
       again (`-C src/`), so it looked for src/src and failed with "file not found". The folder is resolved
       once, against the project, and a folder that does not exist is refused with its name. */
    const workingProject = entry.folder ? path.resolve(project, entry.folder) : project;
    if (!fs.existsSync(workingProject) || !fs.statSync(workingProject).isDirectory()) {
      return 'ERROR: the working folder does not exist: ' + workingProject;
    }
    const runId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    /* WHICH DEFINITION RAN - not its name but its FILE and its content at that moment.
       `findWorker` rereads the disk on every call, so the definition may have changed between listing
       and running; with only the name in the record, which version ran could not be known later. The
       digest names the state of the file at run time: two runs of the same name with different
       digests mean the definition changed in between. The content is not recorded, only its digest. */
    let definitionDigest = null;
    try {
      definitionDigest = require('node:crypto').createHash('sha256')
        .update(fs.readFileSync(t.file)).digest('hex').slice(0, 16);
    } catch { /* if the file cannot be read no digest is written; nothing is invented */ }

    /* WHICH TERMINAL STARTED THE RUN. This server is a child of the terminal and inherits the
       `BENCHOOK_SESSION` identity the panel writes per pane; the panel drops the live card onto the
       right pane accordingly. In a terminal not opened from the panel there IS NO identity and none is
       invented: the record stays in the project history and is bound to no pane by guesswork. */
    const parent = String(process.env.BENCHOOK_SESSION || '').trim() || null;
    /* CODEX PASSES NO ENVIRONMENT - measured: BENCHOOK_SESSION does not reach this server when Codex
       starts it, so the record stayed parentless and no live card appeared. The server writes its own
       process id; the panel walks up the process tree and finds which terminal this server runs under
       (`processFromTreeParent` in main.js). Not a guess: process ancestry. */
    const record = {
      id: runId, name: t.name, task: entry.task, account: accountId, parent,
      serverPid: process.pid,
      definitionFile: path.relative(project, t.file),
      definitionDigest,
      model: t.resolution.model || 'default', status: 'running', startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), result: '', tokens: null, seconds: null,
    };
    /* IF THE RECORD CANNOT BE WRITTEN THE JOB DOES NOT STOP, BUT IT DOES NOT STAY SILENT EITHER.
       If a monitoring warning is to be shown at all, the indicator itself cannot be silent. This error
       used to be swallowed entirely -- the job ran, the result returned, but the monitoring window of
       the panel stayed empty and the reason was written NOWHERE. An empty window reads as no work
       having happened; the two are different things. */
    const watchErrors = [];
    const save = () => {
      try { workerRecords.write(panelData, project, record); }
      catch (e) { watchErrors.push(e.message); }
    };
    save();

    /* MODEL INHERITANCE. Only `default` used to be translated; the `orchestrator` marker passed
       through as it was and went to the CLI as `-m orchestrator`. The inheritance is taken only when the
       agent REALLY runs on the account of this session: copying the model of another account would
       produce a model name meaningless across providers. When it cannot be resolved the run uses the
       default, but it is NOT called the same model. */
    let runModel = t.resolution.model === 'default' ? null : (t.resolution.model || null);
    let modelNote = null;
    if (runModel === resolution.ORCHESTRATOR) {
      if (orchestratorAccount) {
        const m = resolution.inheritedModel(process.env);
        runModel = m.model;
        if (m.unknown) {
          modelNote = "Benchook could not read which model this session uses, so the agent ran "
            + "on the provider's default model. That may differ from yours.";
        }
      } else {
        runModel = null;
        modelNote = "This agent runs on another account, so Benchook did not copy your model to "
          + "it; it ran on that provider's default model.";
      }
    }
    let s;
    try {
      s = await worker.run({
        accountId,
        model: runModel,
        task,
        tools: t.tools,
        folder: workingProject,
        signal,
        // The questions of a default-level agent wait here for the user's answer on the live run card.
        approvals: workerRecords.approvalsFolder(panelData, project, runId),
      });
    } catch (e) {
      s = { error: e.message };
    }

    Object.assign(record, {
      // A run the caller cancelled is not a failure: it is recorded as cancelled and shown neutrally.
      status: signal?.aborted ? 'cancelled' : s.error ? 'error' : 'done', error: signal?.aborted ? null : (s.error || null),
      updatedAt: new Date().toISOString(),
      result: s.error || s.text || '', tokens: s.tokens || null, seconds: s.seconds ?? null,
      cost: s.cost ?? null, accountName: s.account || null,
      // LET IT BE WHAT IT IS CALLED - the third rule of CLAUDE.md. This field used to be written as
      // the real model while its value was the REQUESTED model. The two are now recorded SEPARATELY, and
      // the real one is read from the measured `modelUsage` field.
      requestedModel: s.model || null,
      observedModels: s.observedModels || [],
      modelVerified: s.verified ?? null,
      modelWarning: s.modelWarning || null,
      unverifiedReason: s.unverifiedReason || null,
    });
    save();

    // It is APPENDED to the result, it does not replace it: the job really ran; what is missing is the record.
    const watchNote = watchErrors.length
      ? "\nMONITORING WARNING: this run could not be recorded, so it will not appear in the panel's"
        + " activity view (" + watchErrors[watchErrors.length - 1] + "). The work itself ran."
      : '';

    if (s.error) return "WORKER FAILED: " + s.error + watchNote;

    // THE MODEL LINE SEPARATES THREE THINGS: what was requested, what ran, and whether what ran could be
    // verified. Writing default model and moving on would mean appearing to know which model spent the
    // tokens while not knowing.
    const modelLine = s.verified === true
      ? (s.observedModels || []).join(', ') + " (verified)"
      : s.verified === false
        ? (s.model || "Default") + " requested; observed " + (s.observedModels || []).join(', ') + ""
        : (s.model || "Default model") + " (running model unverified"
          + (s.unverifiedReason ? ': ' + s.unverifiedReason : '') + ')';

    return s.text
      + (s.modelWarning ? "\n\n[WARNING] " + s.modelWarning : '')
      + (modelNote ? "\n\n[NOTE] " + modelNote : '')
      + (t.resolution.providerConflict
        ? "\n\n[NOTE] Provider mismatch: " + t.resolution.providerConflict
          + ". The registered account provider was used." : '')
      + watchNote
      + '\n\n---\n[' + s.account + ' · ' + modelLine + ' · '
      + s.seconds + " s · " + tokenLine(s.tokens)
      + (s.cost != null ? ' · ' + s.cost.toFixed(4) + ' USD' : '') + ']';
  }

  return "ERROR: Unknown tool: " + name;
}

/* ---------- JSON-RPC / stdio --------------------------------------------------------- */

async function processRequest(m, signal) {
  if (m.method === 'initialize') {
    return {
      protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: product.MCP_SERVER_NAME, version: product.VERSION },
      instructions: intro(),
    };
  }
  if (m.method === 'tools/list') return { tools: TOOLS };
  if (m.method === 'tools/call') {
    const name = m.params && m.params.name;
    const entry = (m.params && m.params.arguments) || {};
    let text;
    try { text = await callTool(name, entry, signal); }
    catch (e) { text = "ERROR: " + e.message; }
    return { content: [{ type: 'text', text: String(text) }],
      isError: /^(ERROR:|WORKER FAILED:)/.test(String(text)) };
  }
  if (m.method === 'ping') return {};
  const error = new Error('Unknown method: ' + m.method);
  error.rpcCode = -32601;
  throw error;
}

const transport = require("../panel/mcp-transport").serve({ handle: processRequest, onIdle: () => process.exit(0) });
/* THE ORCHESTRATOR THAT STARTED THIS SERVER CAN GO AWAY WHILE A RUN WAITS (its terminal closed while an
   agent was asking for permission). Nobody could answer or read the result, and the run stayed
   "Running" for good. When the parent process is gone, the waiting runs are cancelled and recorded so. */
const parentPid = process.ppid;
if (parentPid && typeof setInterval === 'function' && transport) {
  const parentWatch = setInterval(() => {
    try { process.kill(parentPid, 0); }
    catch (e) {
      if (e.code !== 'ESRCH') return;
      clearInterval(parentWatch);
      transport.abortAll();
      /* EXIT ONCE THE CANCELLED RUNS HAVE RECORDED THEMSELVES. A fixed 3-second exit could come before
         the worker's process tree was stopped (up to 10 s) and its final record written, leaving a
         run "Running" for good. The longer limit is only a fallback. */
      const started = Date.now();
      const leave = setInterval(() => {
        if (transport.pending() === 0 || Date.now() - started > 20000) { clearInterval(leave); process.exit(0); }
      }, 200);
    }
  }, 5000);
  parentWatch.unref();
}
