/* Resolve account and model consistently for every Markdown agent definition. The schema field is a version marker, not an inclusion filter. Missing accounts resolve at call time to the orchestrator account; never invent an account identity. */

const ORCHESTRATOR = 'orchestrator';

/* Read front matter only when the file begins with a delimiter and has a closing delimiter. Without front matter, preserve the entire body, including horizontal rules. Mark unsupported or incomplete metadata as corrupt and leave the source untouched. */

const LINE = /^---[ \t]*$/;
/** A `key:` line. Continuation lines are indented or start with `- `. */
const FIELD_LINE = /^([A-Za-z_][A-Za-z0-9_.\-]*)[ \t]*:(.*)$/;
const COMMENT_LINE = /^[ \t]*#/;
const RESUME_LINE = /^([ \t]+\S|[ \t]*-[ \t])/;
/* YAML block indicators. If the value of a field starts with one of these, the value is NOT ON ONE LINE. */
const BLOCK_VALUE = /^[|>][-+0-9]*[ \t]*$/;

const trim = (s) => String(s).replace(/\r$/, '');

/**
 * Splits raw text into front matter entries and a body.
 *
 *   get: (field:string)=>string|null,   // a single-line value from the front matter
 *   body: string,                       // the task text
 *
 *   corrupt: string|null,               // THE REASON when it cannot be converted safely; the caller does not write
 * }}
 */
function parseFrontmatter(raw) {
  const text = String(raw == null ? '' : raw).replace(/^﻿/, '');
  const lines = text.split('\n');
  const result = (extra) => ({
    get: (field) => {
      const g = (extra.entries || []).find((x) => x.key === field);
      return g && g.value ? g.value : null;
    },
    body: '', hasOnText: false, entries: [], corrupt: null, ...extra,
  });

  // WITH NO FRONT MATTER THE WHOLE TEXT IS THE BODY. That is in one sentence.
  if (!LINE.test(trim(lines[0] || ''))) return result({ body: text.trim() });

  const shutdown = lines.findIndex((s, i) => i > 0 && LINE.test(trim(s)));
  if (shutdown < 0) {
    return result({ hasOnText: true, corrupt: 'The front matter opens with --- but never closes.' });
  }

  const entries = [];
  for (let i = 1; i < shutdown; i++) {
    const line = trim(lines[i]);
    const last = entries[entries.length - 1];
    if (!line.trim()) { if (last) last.lines.push(line); continue; }
    if (COMMENT_LINE.test(line)) { entries.push({ key: null, value: null, lines: [line] }); continue; }
    const m = line.match(FIELD_LINE);
    if (m) { entries.push({ key: m[1], value: m[2].trim() || null, lines: [line] }); continue; }
    /* A CONTINUATION LINE can only follow a field. A stray line of text says that this is not front
       matter but a horizontal rule that fell inside the body. */
    if (last && last.key && RESUME_LINE.test(line)) { last.lines.push(line); continue; }
    return result({
      hasOnText: true,
      corrupt: 'The front matter has a line Benchook cannot read: "' + line.trim() + '".',
    });
  }
  // Trailing blank lines belong to no field; taken as belonging to one, they multiply on every write.
  for (const g of entries) {
    while (g.lines.length > 1 && !g.lines[g.lines.length - 1].trim()) g.lines.pop();
  }

  const body = lines.slice(shutdown + 1).map(trim).join('\n').trim();
  return result({ hasOnText: true, entries, body });
}

/** Does the value of an entry fit on one line - the panel can only write back those that do. */
const singleLines = (g) =>
  g.lines.length === 1 && !(g.value && BLOCK_VALUE.test(g.value));

const written = (x) => {
  const s = String(x == null ? '' : x).trim();
  return s ? s : null;
};

/**
 * Which account and model a definition will really run on.
 *
 * @param {object} definition  { account, provider, model } - the values WRITTEN in the file
 * @param {(id:string)=>object|null} findAccount  the function that consults the registry of the panel
 * @returns {{
 *   asOrchestrator: boolean, // will it run on the own account of the orchestrator
 *   account: string|null, provider: string|null, model: string|null,  // the ones that WILL BE USED
 *   reason: string|null,     // WHY it was bound to the orchestrator - shown to the user
 *   fileAccount: string|null, fileModel: string|null   // what the file SAID
 * }}
 *
 * Three cases, all three knowable - none of them a guess:
 *   1. no account written          -> bound to the orchestrator
 *   2. account is `orchestrator`   -> the user chose this explicitly
 *   3. an account is written but is not in the registry -> the account was deleted; the agent does
 *      not go silent, it is bound to the orchestrator and the reason is written on the card.
 *
 * THE MODEL FOLLOWS THE ACCOUNT. If the account is bound to the orchestrator the model comes from
 * there too; it could not be otherwise, because a Codex model name is invalid on a Claude account. If
 * the account is REAL, the model written in the file is trusted; if no model is written, the own
 * default of that account is used - not that of the orchestrator.
 */
function resolve(definition, findAccount) {
  const fileAccount = written(definition && definition.account);
  const fileModel = written(definition && definition.model);
  const fileProvider = written(definition && definition.provider);

  const asOrchestrator = (reason) => ({
    asOrchestrator: true,
    account: ORCHESTRATOR, provider: ORCHESTRATOR, model: ORCHESTRATOR,
    reason, fileAccount, fileModel,
  });

  // NO REASON IS WRITTEN FOR AN AGENT WITH NO ACCOUNT AT ALL. If it falls back to the orchestrator
  // anyway, there is no event to describe; the card already says it is the same as the orchestrator
  // and that covers it. A reason is written only when SOMETHING HAPPENED - such as the deleted
  // account case below.
  if (!fileAccount) return asOrchestrator(null);
  if (fileAccount === ORCHESTRATOR) return asOrchestrator(null);

  const record = typeof findAccount === 'function' ? findAccount(fileAccount) : null;
  /* SHORT AND FACTUAL. A speculative "it may have been removed" tail was dropped: it was a guess and
     the user found the on-screen warning long. The NAME of the account stays, because which account
     went missing is the fact itself, and the orchestrator reads this text too. */
  if (!record) return asOrchestrator("Linked account (" + fileAccount + ") is not registered.");

  /* THE IDENTITY COMES FROM THE REGISTRY, not from the file. The user may have written the DISPLAY
     NAME of the account into the file, while the orchestrator compares by identity when asking
     whether an account is its own. Turning a name into an identity is the job of the panel.

     THE PROVIDER COMES FROM THE REGISTRY TOO. A `provider:` line in the file is a hint; which
     provider an account belongs to is a fact WRITTEN in the registry. In a real case the file named
     a provider that does not exist. The fact beats the hint - but the disagreement is not swallowed:
     it stays visible through `providerConflict`. */
  const realProvider = record.provider || fileProvider || null;
  return {
    asOrchestrator: false,
    account: record.id || fileAccount,
    provider: realProvider,
    model: fileModel,          // null when unwritten: the own default of that account runs
    reason: null, fileAccount, fileModel,
    providerConflict: (fileProvider && realProvider && fileProvider !== realProvider)
      ? 'dosyada "' + fileProvider + "\" conflicts with the account provider \"" + realProvider + '"'
      : null,
  };
}

/** The single-line account label shown in lists and on cards. */
const accountLabel = (c) => (c.asOrchestrator ? "Same as orchestrator" : c.account);
const modelLabel = (c) => (c.asOrchestrator ? "Same as orchestrator" : (c.model || "Account default"));

/* Use one routing description for every catalog reader. Supply the account identity from accounts.sessionAccount because the provider session cannot infer its Benchook registry identifier. @param {object|null} account Registry record, or null when unknown. */
function routing(account) {
  const lines = ["Agent routing."];
  if (account) {
    lines.push(
      "You are running as account " + account.id + " (" + (account.name || account.id) + "),",
      "provider " + account.provider + ". Benchook read this from the profile it gave this terminal,",
      "so it is a fact, not a guess. Compare each agent's Account below against it.");
  } else {
    /* WHAT IS UNKNOWN IS NOT STATED. A wrong identity is worse than no routing at all. */
    lines.push(
      "Benchook could not determine which account this session runs as, so it is not stated.",
      "Do not assume an agent's account is yours.");
  }
  lines.push(
    "",
    "- Agent Account is the same as yours: run it on your own account, as a native subagent if that",
    "  definition exists in your harness; if it does not, use `run_agent`.",
    "- Agent Account differs from yours: invoke it by name with `run_agent`.",
    "- Agent Account is \"Same as orchestrator\": it has no assigned account and runs on yours.",
    "  Use a native subagent if that definition exists in your harness; if it does not,",
    "  `run_agent` runs it on your own account.",
    "",
    "Benchook does not invoke agents autonomously. You choose the route.");
  return lines.join(String.fromCharCode(10));
}

/** The text that applies when the session is unknown. The old name is kept: four reading sites looked at it. */
const ROUTING = routing(null);
/* Recognize the legacy tool list as read-only so existing definitions retain their effective permissions. */
const DEFAULT_TOOLS = ['read', 'grep', 'glob', 'bash'];

/* Map permission levels to provider controls. The default omits a tool list and uses account settings with approval prompts. Edit limits tools; full adds command execution. Preserve the legacy read-only list for existing definitions. */
const PERMISSION_LEVELS = ['default', 'read', 'edit', 'full'];
const PERMISSION_TOOLS = {
  read: ['Read', 'Grep', 'Glob'],
  edit: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
  full: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
};
const listOf = (tools) => String(tools == null ? '' : tools).split(',').map((x) => x.trim()).filter(Boolean);
const keyOf = (list) => [...list].map((x) => x.toLowerCase()).sort().join(',');

/** Is this the former default line the panel filled in by itself? It never loosens a narrow agent. */
function formerDefaultTools(tools) {
  const list = listOf(tools);
  return list.length > 0 && keyOf(list) === keyOf(DEFAULT_TOOLS);
}

/** The tool line of a level: '' for 'default' (no line), otherwise the level's list. */
function toolsForPermission(level) {
  if (level === 'default') return '';
  return (PERMISSION_TOOLS[level] || PERMISSION_TOOLS.read).join(', ');
}

/** The level a tool line stands for: 'default' | 'read' | 'edit' | 'full', or 'custom' for a hand-written list. */
function permissionOf(tools) {
  if (!listOf(tools).length) return 'default';
  if (formerDefaultTools(tools)) return 'read';
  const key = keyOf(listOf(tools));
  for (const [level, list] of Object.entries(PERMISSION_TOOLS)) if (keyOf(list) === key) return level;
  return 'custom';
}

/**
 * The tools a run is limited to, or null for none: no line runs with the account's own settings. The former
 * default line is read-only; any other list is enforced as written. It lives in one place because saving and
 * running ask the same question.
 */
function toolRestriction(tools) {
  if (!listOf(tools).length) return null;
  return formerDefaultTools(tools) ? [...PERMISSION_TOOLS.read] : listOf(tools);
}

/**
 * The Codex sandbox for a tool line, or null when there is no line (Codex's own settings apply). Codex cannot
 * limit single tools; its sandbox limits what commands may change. Writing is allowed only when the list allows
 * editing, and the network only with commands on top. Never wider than the list: commands without editing stay
 * read-only. The sandbox is never turned off.
 * @returns {{mode: 'read-only'|'workspace-write', network: boolean}|null}
 */
function codexSandbox(tools) {
  const restriction = toolRestriction(tools);
  if (!restriction) return null;
  const names = new Set(restriction.map((x) => x.toLowerCase()));
  const writes = names.has('edit') || names.has('write');
  return { mode: writes ? 'workspace-write' : 'read-only', network: writes && names.has('bash') };
}

/* Resolve the orchestrator marker from the model of the terminal that launched the MCP server. It is a selection marker, never a provider model name. In-session model changes may not be reflected in the startup environment. */
const ORCH_MODEL_ENV = 'BENCHOOK_ORCHESTRATOR_MODEL';

/** What the panel puts into the environment when opening an orchestrator terminal. */
const orchestratorEnv = (model) => ({
  [ORCH_MODEL_ENV]: String(model || '').trim() || 'default',
});

/**
 * The model the worker will inherit. If `unknown` is true the panel CANNOT NAME the model; running on
 * the default is legitimate in that case, but it is NOT called the same model.
 */
function inheritedModel(env) {
  const raw = String((env && env[ORCH_MODEL_ENV]) || '').trim();
  if (!raw) return { model: null, unknown: true };
  if (raw === 'default') return { model: null, unknown: false };
  return { model: raw, unknown: false };
}

module.exports = {
  toolRestriction, DEFAULT_TOOLS, PERMISSION_TOOLS, PERMISSION_LEVELS, formerDefaultTools, toolsForPermission, permissionOf, codexSandbox, orchestratorEnv, inheritedModel, ORCH_MODEL_ENV, ORCHESTRATOR, parseFrontmatter, singleLines, resolve, accountLabel, modelLabel, ROUTING, routing };
