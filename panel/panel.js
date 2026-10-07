/* Benchook - the page side.
   The same rules apply here: it does not show a number it does not know, it does not send a command
   on behalf of the user, and it does not select a project folder on its own. */

let project = null;                 // NEVER a default: nothing is selected until the user picks it
/* DOM LOOKUP INSIDE A PAGE. Because one project can hold several pages, these elements have no id,
   they have a ROLE; which page they belong to depends on the active page. */
/* PAGES - several panels in one project. Every page has its own orchestrator, its own agent grid and
   its own layout. The one-orchestrator-per-page rule still holds: because panes belong to a page, the
   check inside createPane works unchanged.

   A BACKGROUND PAGE IS NOT CLOSED. Its visibility goes, its terminal keeps running - that is the
   parallel work this was built for. Switching pages does not kill a process.

   The shared variables (panes, cards, active, layout,...) ALWAYS BELONG TO THE ACTIVE PAGE: on a
   switch they are written to the old one and read from the new one. That is how more than sixty use
   sites keep working unchanged. */
let pages = [];
let activePage = null;
let pageCounter = 0;
let workspaceBusy = false;
function workspaceBlocked() {
  if (!workspaceBusy) return false;
  writeStatus('Workspace change in progress.', 'Wait for the current operation to finish.');
  return true;
}
async function changeWorkspace(action) {
  if (workspaceBlocked()) return;
  workspaceBusy = true;
  try { return await action(); }
  catch (error) { showError('Could not complete workspace change', error); }
  finally { workspaceBusy = false; }
}
async function createPaneAndWait(...args) {
  const pane = createPane(...args);
  if (pane) await pane.starting;
  return pane;
}

/* The text for an empty terminal area. Produced in ONE place and ALWAYS exactly one: any existing one
   is removed first, then the new one is put in. With no text supplied, one is chosen from the state. */
/* An error is written in two places at once: the terminal area (when there is one) and the left column
   (always there). When a page cannot be created there is no terminal area either -- the left column is
   then the only way out. */
/** The reason of a failed call, in one form. Electron prefixes an error thrown in the main process with
    "Error invoking remote method ...: Error: "; the user needs the reason, not the prefix. */
function errorText(e) {
  return String(e && e.message ? e.message : e).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}
/** Waits for a call and turns a thrown error into `{ error }`, so the caller's own error path shows it
    instead of leaving a button disabled or a screen on "Opening…". */
async function settle(call) {
  try { return await call; } catch (e) { return { error: errorText(e) }; }
}

function showError(title, e) {
  const text = title + ': ' + errorText(e);
  writeEmptyGive(text);
  const d = g('orchestratorStatus');
  if (d) d.textContent = text;
  try { console.error(title, e); } catch { /* not important */ }
}

function writeEmptyGive(text) {
  const top = sg('topRight');
  if (!top) return null;
  for (const old of top.querySelectorAll('[data-role="space"]')) old.remove();
  const d = document.createElement('div');
  d.className = 'spacer';
  d.dataset.role = 'space';
  const saved = activePage && activePage.savedSession;
  d.textContent = text || (saved ? savedSessionText(saved)
    : project ? "Start an orchestrator from the sidebar." : "Open a project folder from Overview → Open project.");
  top.appendChild(d);
  return d;
}

/* A TAB REMEMBERS ITS LAST CONVERSATION. Closing the orchestrator, or a start that failed when the
   layout was restored, used to save "no orchestrator" for the tab: the session id was gone and the next
   Start began a new conversation. The tab now keeps the session until a new terminal opens on it; Start
   resumes it with the chosen account of the same provider. */
function savedSessionText(saved) {
  return "Saved " + saved.provider + " session" + (saved.label ? " (" + saved.label + ")" : '')
    + ". Choose its account and a model, then Start orchestrator to resume it.";
}
function rememberSession(b) {
  if (!b || !b.owner || !b.sessionId) return;
  b.owner.savedSession = { provider: b.provider, sessionId: b.sessionId, label: b.label,
    accountId: b.accountId || null, model: b.model || null, connection: b.connection || null };
}

function sg(role) {
  return activePage && activePage.root
    ? activePage.root.querySelector('[data-role="' + role + '"]') : null;
}
const panes = [];
/* State that code at the top level of this file reaches before the section that uses it most:
   `refreshDefinitions` runs during load and, through `setupWatching`, reads all three.
   Declared later, they were read before initialisation and the first file watcher at startup
   failed with an unhandled rejection. */
const projectFields = new Map();   // one field per open project; see "project fields" below
const FIELDLESS = "(No project)";  // a key no real project path can have: pages before a project is chosen
let watchedKey;                    // the watched project set; see setupWatching
let skillOpen = null;   // the open skill form: { folderName, base, accepted } (see checkSkillConflict)
const idMap = new Map();
let enabled = null;
let textSize = 13;
let shareRatio = null;   // the terminal/agent split; it stays where the user dragged it
let layout = 'stacked';   // 'stacked' | 'sideBySide'
let layoutReversed = false;  // the terminal at the bottom or on the right
let terminalHidden = false;
// A tab's resumable conversation lives on the tab itself (sy.savedSession), not in one global.
let orchChangeMode = false;
/* The agents defined in this project. THE DECLARATION IS HERE, not further down: from further down,
   the first `refreshDefinitions` call at startup touched this variable before it was declared and
   fell over SILENTLY with "Cannot access... before initialization" - because it was a promise
   rejection it left no trace on screen at all. The error listener in a real window caught it. */
let definedAgents = [];

const format = (n) => Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
const formatY = (y) => Number.isFinite(y) ? y.toFixed(1) + '%' : '—';
// For token counts in the millions: 3.37 M rather than 3,371,234. Smaller ones are written in full.
const short = (n) => (n >= 1000000 ? (n / 1000000).toFixed(2) + ' M' : format(n));
const g = (k) => document.getElementById(k);

/* APPEARANCE. A theme only swaps CSS links; open terminals and project state stay in place. The
   choice is kept in the global section of the layout file. */
let theme = window.PanelTema.DEFAULTS;
function applyTheme(name, save = false) {
  theme = window.PanelTema.apply(document, name);
  for (const card of document.querySelectorAll('.theme-card')) {
    const selected = card.dataset.theme === theme;
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-pressed', String(selected));
  }
  if (save) saveTheme();
}

async function saveTheme() {
  const notification = g('themeSaveStatus');
  if (notification) notification.textContent = "Saving…";
  let r;
  try { r = await window.panel.writeLayoutAndWait(layoutData()); }
  catch (e) { r = { error: errorText(e) }; }
  if (r && r.error) {
    if (notification) notification.textContent = "Could not save theme: " + r.error;
    writeStatus("Could not save theme.", r.error);
    return false;
  }
  if (notification) notification.textContent = "Saved on this device.";
  return true;
}

function renderThemeCards() {
  const container = g('themeCards');
  container.textContent = '';
  for (const option of window.PanelTema.OPTIONS) {
    const card = document.createElement('button');
    card.className = 'theme-card';
    card.dataset.theme = option.id;
    card.type = 'button';
    card.innerHTML = '<span class="theme-color ' + option.id + '"></span><b>'
      + option.name + '</b><small>' + option.description + '</small>';
    card.onclick = () => applyTheme(option.id, true);
    container.appendChild(card);
  }
  applyTheme(theme);
}

/* HANDOFF NOTES FILE. Empty means the default (docs/HANDOVER.md). The main process resolves it
   inside the project and refuses anything outside; this check only explains the refusal early. */
let handoverFile = '';
const handoverOutside = (value) => /^([\\/]|[a-zA-Z]:)/.test(value) || /(^|[\\/])\.\.([\\/]|$)/.test(value);

async function saveHandoverFile() {
  const notification = g('handoverSaveStatus');
  const value = g('handoverFile').value.trim();
  if (handoverOutside(value)) {
    notification.textContent = "Use a path inside the project folder, such as docs/HANDOVER.md.";
    return false;
  }
  handoverFile = value;
  notification.textContent = "Saving…";
  let r;
  try { r = await window.panel.writeLayoutAndWait(layoutData()); }
  catch (e) { r = { error: errorText(e) }; }
  if (r && r.error) {
    notification.textContent = "Could not save: " + r.error;
    return false;
  }
  notification.textContent = "Saved on this device.";
  return true;
}

function openSettings() {
  renderThemeCards();
  g('themeSaveStatus').textContent = '';
  g('handoverFile').value = handoverFile;
  g('handoverSaveStatus').textContent = '';
  g('settingsOverlay').hidden = false;
  const selected = g('themeCards').querySelector('.theme-card.selected');
  if (selected) selected.focus();
}

function closeSettings() {
  g('settingsOverlay').hidden = true;
  g('settingsOpen').focus();
}

/* Just the folder name from a path. A BACKSLASH IS A SEPARATOR TOO: this panel runs on Windows and
   the old code looked only for `/`, so the top bar and the project list showed the full path instead
   of the folder name. Caught by clicking in a real window. */
function folderName(filePath) {
  if (!filePath) return null;
  return String(filePath).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(filePath);
}

/* SIDEBAR TABS. The sidebar is split into three and only one subject is visible at a time. Which tab
   was last open is saved together with the layout. */
let sidebarTab = 'status';
/* The panel DISCOVERS no projects. It remembers only the projects you opened; the list of agents from
   other projects grows out of that. It does not scan somewhere it does not know and invent a project. */
let projects = [];
/* WHAT IS RUNNING RIGHT NOW: which agents are actively running in this project. It is filled from two
   sources: the sub-agent cards and the MCP worker records. No number is INVENTED -- with no record the
   set stays empty and the list simply looks dimmed. */
let runningAgents = new Set();      // agent name
let runningAccounts = new Set();     // account id (from the worker records)
let waitingTabs = new Set(), waitingProjects = new Set(), waitingRound = 0;   // permission questions off screen
/* The Add account button sits next to the heading and is always visible, rather than behind a
   disclosure at the bottom. Its handler is bound HERE and not inside `selectTab`: while it was there,
   `selectTab` was never called when no tab had been saved, and clicking the button did nothing. */

function selectTab(name) {
  // The accounts tab was removed (it is pinned at the bottom); an old layout may still have saved it.
  if (!document.querySelector('#sidebar .page[data-page="' + name + '"]')) name = 'status';
  sidebarTab = name;
  for (const b of document.querySelectorAll('#sidebarTabs button')) {
    b.classList.toggle('selected', b.dataset.tab === name);
  }
  for (const p of document.querySelectorAll('#sidebar .page')) {
    p.hidden = p.dataset.page !== name;
  }
  showLeftStatus();
  // Skills are read from disk; the tab is re-read on every switch so a change made from another
  // window does not look stale here.
  if (name === 'skills') refreshSkills();
}

function showProject() {
  const y = g('projectPath');
  y.textContent = project || "No project selected";
  y.title = project || "Select a project folder before starting an orchestrator.";
  /* THE PROJECT NAME WAS REMOVED FROM THE TOP BAR: which project we are in is already visible on the
     left. Keeping the same information in two places bloated the top bar, and the selected row in the
     left list is already highlighted. */
  refreshButtons();
}

/* Require explicit approval before writing trust settings or changing project files. */
function refreshButtons() {
  const opened = panes.length > 0;
  for (const id of ['orchestratorAccount', 'orchestratorModel', 'orchestratorStart']) {
    if (!g(id)) continue;
    g(id).disabled = !project || (opened && !orchChangeMode);
    g(id).hidden = opened && !orchChangeMode;
  }
  if (g('orchestratorSwitch')) {
    g('orchestratorSwitch').disabled = !project || !opened;
    g('orchestratorSwitch').textContent = orchChangeMode ? "Cancel switch" : "Switch account or model";
  }
  if (g('orchestratorStart')) g('orchestratorStart').textContent = orchChangeMode ? "Apply changes" : "Start orchestrator";
  const b = panes[0];
  if (b) {
    /* "Resumed" only when the CLI was really told to resume - the half of that was skipped on
       this line (seen twice in real runs): an identity exists on a clean start as well. */
    writeStatus(b.label + (b.resumeDid ? " · Resumed session" : " · New session"),
      b.resumeDid ? "Resuming the saved conversation."
                  : "Starting a new conversation in this pane.");
  } else {
    // With no orchestrator the line stays EMPTY: the Start orchestrator button is directly below it
    // already, and saying the same thing twice took up space.
    writeStatus('', '');
  }
}

/* SHORT text on screen, the detail in the tooltip: anything that needs extra information should show
   that information on hover. */
function writeStatus(short, long = '') {
  const d = g('orchestratorStatus');
  if (!d) return;
  d.textContent = short;
  d.title = long;
  /* The same sentence also goes to the tab-independent line, so the result of work done on the Agents
     or Skills tab ("deleted", "Could not save",...) is not hidden away on Overview. */
  const s = g('sidebarStatus');
  if (!s) return;
  s.textContent = short;
  s.title = long;
  showLeftStatus();
}

/** The tab-independent result line: hidden on Overview (where #orchestratorStatus already shows it), hidden when empty. */
function showLeftStatus() {
  const s = g('sidebarStatus');
  if (!s) return;
  s.hidden = sidebarTab === 'status' || !s.textContent;
}

/* ---------------- pane ---------------- */
/* * The pane label: the text, plus "(resumed)" only when the CLI was really told to resume. */
const paneLabel = (label, resumeDid) => resumeDid ? label + ' (resumed)' : label;

/* THE PANE IDENTITY OF THE SAME CONVERSATION IS PRESERVED. Switching between accounts made the cards
   of agents that had run in the past disappear. Cards are tied to the connection identity of the pane
   (BENCHOOK_SESSION); when a new identity was generated on an account or model change and on reopen,
   the earlier runs of the same conversation were left with no pane. If the same conversation continues
   (`--resume`), the old connection identity is handed to the new pane, and the catalogue notification
   and the worker cards go on following the same conversation. A new conversation gets a new identity. */
function createPane(provider, sessionId, label, accountId = null, model = null, connection = null) {
  if (!project) { writeStatus("Open a project folder first (Overview → Open project).", "The orchestrator and agents belong to the selected project."); return; }
  // ONE orchestrator PER PAGE. The rule still holds; it is now per page, because panes belong to the
  // active page. Which session an agent card belongs to still has exactly one answer.
  if (panes.length > 0) {
    writeStatus("This tab already has an orchestrator.",
      "Each tab has one orchestrator. Use + to open another tab.");
    return;
  }
  if (!activePage || !sg('topRight')) {
    writeStatus("This tab is not ready.", "Restart Benchook and try again.");
    return;
  }
  sg('space')?.remove();
  const select = sg('selectionContainer'); if (select) select.remove();

  const container = document.createElement('div');
  container.className = 'pane';
  container.innerHTML =
    '<div class="title"><span class="name"></span><span class="status"></span>' +
    '<span class="agent-badge"></span>' +
    "<span class=\"empty\"></span><span class=\"x\" title=\"Close\">&#10005;</span></div>" +
    '<div class="screen"></div>' +
    '<div class="bottom"><span class="bottom-left">&#8212;</span><span class="bottom-right"></span></div>';
  sg('topRight').appendChild(container);

  const terminal = new Terminal({
    fontFamily: 'Consolas,"Cascadia Mono",monospace', fontSize: textSize, cursorBlink: true,
    scrollback: 10000, rightClickSelectsWord: false,
    windowsPty: { backend: 'conpty' },
    theme: { background: '#111110', foreground: '#d5d1cb', cursor: '#d98b4a', selectionBackground: '#3d3428' },
  });
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  terminal.loadAddon(new WebLinksAddon.WebLinksAddon((_o, url) => window.panel.openLink(url)));

  const screen = container.querySelector('.screen');
  terminal.open(screen);
  fit.fit();
  /* THE TERMINAL IS REFITTED WHEN THE BOX SIZE CHANGES. Hiding the agent area opens a strip on the
     right while the terminal stayed at its old, wider column count, so line breaks ran off into the
     invisible area. The measurement is taken not from one particular path but from the box itself:
     whatever layout change caused it, a refit runs when the box narrows or widens. */
  if (typeof ResizeObserver === 'function') {
    let pending = null;
    const scout = new ResizeObserver(() => {
      if (pending) cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        pending = null;
        if (!container.isConnected) { scout.disconnect(); return; }
        if (screen.offsetParent) { fit.fit(); ptySize(b); }
      });
    });
    scout.observe(screen);
  }

  const b = {
    container, terminal, fit, search, project, owner: (activePage && (activePage.savedSession = null), activePage), closed: false, id: null, provider, sessionId: sessionId || null, accountId, model,
    inheritedConnection: (sessionId && connection) ? connection : null,
    label: label || provider || 'shell', context: null, firstOutput: null,
    name: container.querySelector('.name'), status: container.querySelector('.status'),
    agentBadge: container.querySelector('.agent-badge'), agents: null,
    bottomLeft: container.querySelector('.bottom-left'), bottomRight: container.querySelector('.bottom-right'),
  };
  b.name.textContent = b.label;
  panes.push(b);

  function paste() {
    const m = window.panel.readClipboard();
    // NOT raw text: terminal.paste applies bracketed paste, so what is pasted is recognised as one
    // piece and can be undone. Measured.
    if (m && b.id) terminal.paste(m);
  }

  terminal.attachCustomKeyEventHandler((o) => {
    if (o.type !== 'keydown') return true;
    const k = o.ctrlKey, s = o.shiftKey;
    if (k && (o.key === 'v' || o.key === 'V')) { paste(); return false; }
    if (k && (o.key === 'c' || o.key === 'C')) {
      const select = terminal.getSelection();
      if (select) { window.panel.writeClipboard(select); if (!s) terminal.clearSelection(); return false; }
      return true;
    }
    if (k && s && (o.key === 'F' || o.key === 'f')) { searchAsk(b); return false; }
    if (k && (o.key === '+' || o.key === '=')) { textSizeChange(1); return false; }
    if (k && o.key === '-') { textSizeChange(-1); return false; }
    if (k && o.key === '0') { textSizeChange(0); return false; }
    return true;
  });

  screen.addEventListener('contextmenu', (o) => { o.preventDefault(); paste(); });
  container.addEventListener('mousedown', () => makeEnabled(b));
  container.querySelector('.x').onclick = async (o) => {
    o.stopPropagation();
    if (b.id && !await confirm("Close " + (b.label || b.provider) + "?\n\n" + (b.provider === 'codex' ? 'Codex' : 'Claude Code')
      + " stops. This tab keeps the conversation: Start orchestrator resumes it.")) return;
    closePane(b);
  };

  makeEnabled(b);
  b.starting = launch(b);
  return b;
}

/** Continue where it left off: with an identity, a resume command is built. */
function setupCommand(provider, sessionId, model) {
  const m = model && model !== 'default' ? ' --model ' + model : '';
  if (provider === 'claude') return (sessionId ? 'claude --resume ' + sessionId : 'claude') + m;
  if (provider === 'codex')  return (sessionId ? 'codex resume ' + sessionId : 'codex') + m;
  return null;
}

/* Prepare provider onboarding before opening a terminal. Cosmetic welcome marks are written first. Project trust requires explicit approval; cancellation leaves trust unchanged. Tooltips list affected files. Completed setup passes without another prompt. */
async function prepareFirstSetup(b) {
  const targetProject = b.project;
  if (!b.accountId || !targetProject) return;
  let p;
  try { p = await window.panel.onboardingPlan(targetProject, b.accountId); }
  catch { return; }                                    // if it cannot be planned the old behaviour continues
  if (!p || p.error || !Array.isArray(p.items) || !p.items.length) {
    if (p && p.trust && p.trust.otherDecision) {
      writeStatus("Folder access is restricted.",
        "Saved access setting: " + p.trust.otherDecision + ". To change it: "
        + p.trust.file);
    }
    return;
  }

  let cosmeticWritten = false;
  if (p.items.some((k) => k.kind === 'cosmetic')) {
    try {
      const s = await window.panel.applyOnboarding(targetProject, b.accountId, { cosmetic: true });
      cosmeticWritten = !!(s && Array.isArray(s.written) && s.written.length);
    } catch { /* if it cannot be written the wizard appears; the work does not stop */ }
  }

  const trust = p.items.find((k) => k.kind === 'trust');
  if (!trust) return;

  const program = p.provider === 'codex' ? 'Codex' : 'Claude';
  const question = [
    "Folder access",
    '',
    targetProject,
    '',
    program + " will be able to read, modify, and execute files in this folder.",
    "Allowing access saves this choice for future sessions.",
    '',
    "Cancel to leave this unchanged and review access in the terminal.",
    '',
    "Allow access to this folder?",
  ].join('\n');

  if (b.closed || !await confirm(question) || b.closed) {
    writeStatus("Folder access was not granted.",
      "Review access in the terminal. No preference was saved: " + trust.file);
    return;
  }
  /* A thrown error used to reject the launch before the pane was cleaned up, and the tab then refused
     Start with "This tab already has an orchestrator". It is reported like any other failure. */
  const s = await settle(window.panel.applyOnboarding(targetProject, b.accountId, { trust: true }));
  if (s && s.error) { writeStatus("Could not save folder access.", s.error); return; }
  // EVERY file touched is listed here -- short on screen, long in the tooltip.
  writeStatus("Folder access saved.",
    'Saved: ' + trust.line.replace(/\n/g, '  ') + ' → ' + trust.file
    + (cosmeticWritten ? "\nWelcome screen preference saved: "
      + p.cosmetic.file : ''));
  // On the Codex side the HOOK trust is separate and the panel cannot write it (the stamp is derived
  // from the hook file). `completeSetup` already says this; it is not repeated here.
}

async function launch(b) {
  await prepareFirstSetup(b);
  if (b.closed) return;
  let r;
  try {
    r = await window.panel.openTerminal({
      command: setupCommand(b.provider, b.sessionId, b.model), provider: b.provider, sessionId: b.sessionId,
      accountId: b.accountId, column: b.terminal.cols, line: b.terminal.rows, workingDirectory: b.project,
      orchestrator: true, model: b.model, connection: b.inheritedConnection || null,
    });
  } catch (e) {
    r = { error: errorText(e) };
  }
  if (b.closed) { if (r?.id) window.panel.closeTerminal(r.id); return; }
  // If it could not open THE REASON is written and the pane is closed; otherwise the page looked full
  // and also blocked starting a new orchestrator.
  if (!r || !r.id) {
    const reason = (r && (r.error || r.error === '')) ? r.error : "Could not open terminal";
    b.status.textContent = "● Failed to start";
    b.status.style.color = 'var(--red)';
    try { b.terminal.write("\r\n  Could not open terminal: " + reason + '\r\n'); } catch { /* not important */ }
    // The pane cleanup resets the status line, so the reason is written after it, not before.
    closePane(b, true);
    /* A missing or broken CLI comes with its fix on separate lines (the command to run). The status
       line holds one line, so its first sentence goes there and the whole text opens in a notice the
       user can read and copy from; the pane that carried it is already gone. */
    if (b.owner === activePage) {
      const lines = String(reason).split('\n');
      writeStatus("Could not start: " + lines[0], reason);
      if (lines.length > 1) notice("Could not start the orchestrator.\n\n" + reason);
    }
    return;
  }
  b.id = r.id;
  b.connection = r.connection || null;
  if (r.sessionId) b.sessionId = r.sessionId;
  /* IF THE SAVED SESSION WAS NOT FOUND IT IS SAID. The panel opens a clean session; doing that
     silently would silently break the expectation of continuing where they left off. The old record is
     not deleted - it may be sitting under another account. */
  if (r.resumeWarning) {
    try { b.terminal.write('\r\n  ' + r.resumeWarning + '\r\n'); } catch { /* not important */ }
  }
  idMap.set(r.id, b);
  if (b.owner === activePage) renderAccountMenu();   // the menu now names the account this page runs
  b.status.textContent = "● Running";
  b.status.style.color = 'var(--green)';
  /* "(resumed)" only when it really resumed the presence of an identity is not enough, a
     clean start carries one too. The main process says this separately. The buttons and status line
     are refreshed AFTER this; refreshed before, the line read the old value. */
  b.resumeDid = !!r.resumeDid;
  b.name.textContent = paneLabel(b.label, b.resumeDid);
  refreshButtons();
  // Written after refreshButtons, which rewrites the status line: the reason stays readable.
  if (r.resumeWarning && b.owner === activePage) writeStatus("New session started.", r.resumeWarning);
  renderPageStrip();   // the tab's running dot
  b.terminal.onData((v) => window.panel.writeTerminal(r.id, v));
  if (b.owner === activePage) b.terminal.focus();
  saveLayout();
}

function closePane(b, processClosed = false) {
  if (!processClosed && workspaceBlocked()) return;
  if (b.closed) return;
  b.closed = true;
  rememberSession(b);
  if (b.owner && b.owner !== activePage) {
    if (b.id) { if (!processClosed) window.panel.closeTerminal(b.id); idMap.delete(b.id); }
    b.owner.panes = (b.owner.panes || []).filter(pane => pane !== b);
    b.terminal.dispose(); b.container.remove(); saveLayout(); return;
  }
  mark("Close pane");
  if (b.id) { if (!processClosed) window.panel.closeTerminal(b.id); idMap.delete(b.id); }
  const i = panes.indexOf(b);
  if (i >= 0) panes.splice(i, 1);
  const previous = b.container.previousElementSibling;
  if (previous && previous.classList.contains('divider')) previous.remove();
  else { const s = b.container.nextElementSibling; if (s && s.classList.contains('divider')) s.remove(); }
  /* FOCUS IS HANDED OVER BEFORE THE REMOVAL. The journal showed this:
       textarea.xterm-helper-textarea  ->  NOWHERE (keystrokes land here)
     Removing the focused element from the DOM drops focus to nowhere, and handing it over afterwards
     leaves an interval in which keystrokes are lost. The order was reversed: the surviving pane is
     focused first, then the closing one is removed. The interval disappears rather than being
     compensated for later. */
  const remaining = panes.length ? panes[Math.max(0, i - 1)] : null;
  if (remaining) { try { remaining.terminal.focus(); } catch { /* not ready yet */ } }

  measureStep("Close pane: terminal.dispose()", () => b.terminal.dispose());
  measureStep("Close pane: remove DOM", () => b.container.remove());
  if (!remaining) {
    orchChangeMode = false;
    writeEmptyGive();
    enabled = null;
  } else measureStep("Close pane: activate pane", () => makeEnabled(remaining));
  measureStep("Close pane: refresh controls", () => refreshButtons());
  measureStep("Close pane: save layout", () => saveLayout());
  measureStep("Close pane: refresh sidebar", () => refreshLeft());
  renderPageStrip();
}

function makeEnabled(b) {
  enabled = b;
  for (const x of panes) x.container.classList.toggle('active', x === b);
  b.terminal.focus();
  refreshLeft();
  writeSummary(b, b && b.agents);
  renderGrid(b, b && b.agents);   // on a pane change, do not wait a round
}

function textSizeChange(direction) {
  textSize = direction === 0 ? 13 : Math.min(24, Math.max(9, textSize + direction));
  // Every live terminal, not only this tab's: the size is one setting, and it is saved with the layout.
  for (const b of new Set([...panes, ...idMap.values()])) {
    b.terminal.options.fontSize = textSize;
    if (panes.includes(b)) { b.fit.fit(); ptySize(b); }
  }
  saveLayout();
}

/* The prompt box is inside the page too: `prompt` is also an operating-system window and carries
   the same Shift defect as `confirm`. The key handler does not wait; the dialog opens on its own. */
async function searchAsk(b) { const s = await askText("Search this terminal:"); if (s) b.search.findNext(s); }
function ptySize(b) { if (b.id) window.panel.resizeTerminal(b.id, b.terminal.cols, b.terminal.rows); }

function measureAll() {
  mark("Resize terminal");
  for (const b of panes) { b.fit.fit(); ptySize(b); }
}

/* The divider between the terminal and the agent view. A RATIO is written, NOT a fixed pixel size:
   boxes written in fixed pixels would not shrink and an added box fell outside the edge. With a ratio
   overflow is impossible. */
function setupSeparatorY(root) {
  const ay = root.querySelector('[data-role="separatorY"]');
  const top = root.querySelector('[data-role="topRight"]');
  const bottom = root.querySelector('[data-role="flowContainer"]');
  ay.addEventListener('mousedown', (press) => {
    press.preventDefault();
    const side = layout === 'sideBySide';
    const y0 = side ? press.clientX : press.clientY;
    const measure = (el) => (side ? el.getBoundingClientRect().width : el.getBoundingClientRect().height);
    const u0 = measure(top), a0 = measure(bottom);
    const action = (o) => {
      const d = (side ? o.clientX : o.clientY) - y0, yu = u0 + d, ya = a0 - d;
      if (yu < (side ? 260 : 140) || ya < (side ? 240 : 90)) return;
      top.style.flex = yu + ' 1 0';
      bottom.style.flex = ya + ' 1 0';
      shareRatio = { top: yu, bottom: ya };
    };
    const drop = () => {
      document.removeEventListener('mousemove', action);
      document.removeEventListener('mouseup', drop);
      measureAll();
      saveLayout();   // so it does not have to be adjusted again
    };
    document.addEventListener('mousemove', action);
    document.addEventListener('mouseup', drop);
  });
}
/* STALL DETECTOR - the page side. See its counterpart in `panel/main.js`.
   The browser reports any work that occupies the paint thread for more than 50 ms as a longtask.
   Those are exactly the stalls felt while typing. The name of the work being done AT THAT MOMENT is
   written next to it (`mark`), without which the journal says no more than "something was slow". */
/* The agent summary text. The section in the left column was removed; the strip reads this variable. */
let agentSummaryText = '';
let lastTask = "Startup";
function mark(name) { lastTask = name; }

/* STEP TIMERS - they time the steps of the close and page-switch paths separately and record only
   those above 80 ms. The keystroke-by-keystroke DIAGNOSTIC MODE was REMOVED once the defect was
   closed (it wrote everything typed to disk); the timers that remain are sparse and harmless, and if
   a freeze happens again they name the place. */
function measureStep(name, f) {
  const b = performance.now();
  try { return f(); } finally {
    const s = Math.round(performance.now() - b);
    if (s >= 80) window.panel.reportStall({ side: "Step", duration: s, task: name });
  }
}
async function measureStepAsync(name, f) {
  const b = performance.now();
  try { return await f(); } finally {
    const s = Math.round(performance.now() - b);
    if (s >= 80) window.panel.reportStall({ side: "Step", duration: s, task: name });
  }
}

window.addEventListener('blur', () => mark("Window lost focus"));
/* When the window takes focus back, the place the typing WILL GO has to be given back too. Even with
   the window focused, if no element inside the page has focus the keystrokes are still lost - which is
   exactly what happened when focus escaped while a terminal was closing. */
window.addEventListener('focus', () => {
  mark("Window regained focus");
  if (enabled && enabled.terminal) { try { enabled.terminal.focus(); } catch { /* closed */ } }
});

/* WHO IS TAKING THE FOCUS - where the journal pointed.
 *
 * The keystroke trace showed this: NO key event at all for capital letters, while lower-case letters
 * came through in 0 ms. What sat between them were the escape sequences reporting that the terminal
 * had lost and regained focus. So the keystroke is not lost, IT NEVER REACHES THE TERMINAL: focus is
 * somewhere else at that moment.
 *
 * The question here is no longer whether something is slow but what is stealing the focus. Only the
 * name of the ELEMENT the focus went to can answer that; without it there is only guesswork. So every
 * time focus changes hands, where it went from and to is written down. Both directions are recorded:
 * focus leaving the terminal and focus returning to it.
 */
const describeElement = (el) => {
  if (!el || el === document.body) return "Document body (no control)";
  const name = el.tagName ? el.tagName.toLowerCase() : '?';
  const className = el.className && typeof el.className === 'string'
    ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
  return name + (el.id ? '#' + el.id : '') + className;
};
let previousFocus = null;
document.addEventListener('focusin', (o) => {
  const created = describeElement(o.target);
  if (created === previousFocus) return;
  window.panel.reportStall({ side: 'focus', duration: 0,
    task: (previousFocus || '(none)') + '  →  ' + created });
  previousFocus = created;
});
document.addEventListener('focusout', (o) => {
  // If focus goes nowhere (`relatedTarget` empty) the keystrokes ARE LOST; this is the case we are after.
  if (o.relatedTarget) return;
  window.panel.reportStall({ side: 'focus', duration: 0,
    task: describeElement(o.target) + "  →  No focused control" });
  previousFocus = null;
});

/* A confirmation dialog BLOCKS the thread of the page: terminal data arriving while it is open piles
   up and is processed all at once when it closes. That is one of the candidates for the stall the
   user described. A one-line wrapper makes it appear in the stall journal under the name of its cause. */
/* *
 * CONFIRMATION - drawn INSIDE the panel; no operating-system window is used.
 *
 * WHY. Read from the journal. The complaint: after a close, nothing could be typed IN CAPITALS while
 * lower-case letters worked, and it only cleared up after going to another window and back. The
 * keystroke trace gave the cause: in that interval there was not a single event carrying `+Shift` and
 * no event for the Shift key at all - while `CapsLock` and `Alt` did appear in the same journal. So
 * Shift+F was arriving at the page as `f` with `shiftKey:false`.
 *
 * The cause was `confirm`: the operating-system window takes the state of Shift as it opens and
 * does not give it back to the page when it closes. Alt+Tab reactivated the window, which is why that
 * was the only thing that reset it.
 *
 * This also explains the A/B observation of the user exactly - it happened when an orchestrator was
 * opened and closed and not when closing without one: the confirmation dialog is shown only while a
 * terminal is open. The variable was not the terminal but the dialog itself.
 *
 * An in-page confirmation opens no operating-system window and therefore does not touch the key
 * state. An added benefit: it does not BLOCK the page either - with `confirm` open, terminal data
 * piled up and flooded in all at once when it closed. */
/**
 * The SHARED body of the in-page dialogs. `confirmDialog` and `askText` use the same skeleton:
 * keeping it in one place also makes it harder for one of them to slip back to an OS window.
 *
 * @param setup (box, finish) => the element to focus
 */
/* ONE ESCAPE CLOSES ONE DIALOG. Every open dialog listened on the document, so a single Escape
   cancelled all of them at once (several folder-access questions while tabs were restored). Only
   the topmost dialog answers a key now. */
const openWindows = [];
function pageWindow(text, setup) {
  mark("Confirmation dialog");
  const previousFocused = document.activeElement;
  return new Promise((resolution) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const box = document.createElement('div');
    box.className = 'confirm-box';

    const textEl = document.createElement('div');
    textEl.className = 'confirm-text';
    textEl.textContent = text;          // the text AS IT IS: line breaks are preserved through CSS
    box.appendChild(textEl);

    let key = null;
    const finish = (response) => {
      document.removeEventListener('keydown', key, true);
      const at = openWindows.indexOf(overlay);
      if (at >= 0) openWindows.splice(at, 1);
      overlay.remove();
      mark("After confirmation");
      // Focus returns to wherever it was BEFORE the dialog; otherwise the keystrokes land nowhere.
      if (previousFocused && previousFocused.focus) { try { previousFocused.focus(); } catch { /* gone */ } }
      else if (enabled && enabled.terminal) { try { enabled.terminal.focus(); } catch { /* gone */ } }
      resolution(response);
    };

    const toFocus = setup(box, finish);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    key = (o) => {
      if (o.key !== 'Escape' || openWindows[openWindows.length - 1] !== overlay) return;
      o.preventDefault(); o.stopImmediatePropagation();
      finish(null);                     // Escape ALWAYS means cancel
    };
    openWindows.push(overlay);
    document.addEventListener('keydown', key, true);
    // Clicking outside MEANS CANCEL: confirming by accident is worse than cancelling by accident.
    overlay.addEventListener('mousedown', (o) => { if (o.target === overlay) finish(null); });
    if (toFocus) toFocus.focus();
  });
}

/** A notice with one Close button; its text can be selected and copied (a command to run, a path). */
function notice(text) {
  return pageWindow(text, (box, finish) => {
    box.querySelector('.confirm-text').style.userSelect = 'text';
    const dg = document.createElement('div');
    dg.className = 'buttons';
    const close = document.createElement('button');
    close.textContent = "Close";
    close.onclick = () => finish(true);
    dg.appendChild(close);
    box.appendChild(dg);
    return close;
  });
}

function confirm(text) {
  return pageWindow(text, (box, finish) => {
    const dg = document.createElement('div');
    dg.className = 'buttons';
    const yes = document.createElement('button');
    yes.textContent = "Confirm";
    yes.onclick = () => finish(true);
    const no = document.createElement('button');
    no.textContent = "Cancel";
    no.onclick = () => finish(false);
    dg.appendChild(yes); dg.appendChild(no);
    box.appendChild(dg);
    /* ENTER PRESSES THE FOCUSED BUTTON. It used to confirm whatever had focus, so Enter on the focused
       Cancel deleted folders. Focus starts on Cancel; reaching Confirm takes a deliberate Tab. */
    return no;
  }).then((c) => c === true);
}

/* *
 * A CHECKABLE LIST DIALOG.
 *
 * Show first, then ask requires this: the user sees ONE BY ONE what would be imported and ticks it.
 * Cancelling means importing nothing.
 *
 * @returns {Promise<string[]|null>} the selected values, or null if cancelled */
function selectableWindow(text, options) {
  return pageWindow(text, (box, finish) => {
    const list = document.createElement('div');
    list.className = 'confirm-options';
    const boxes = [];
    for (const s of options) {
      const optionLabel = document.createElement('label');
      optionLabel.className = 'confirm-option';
      const k = document.createElement('input');
      k.type = 'checkbox';
      k.checked = !!s.selected;
      k.value = s.value;
      boxes.push(k);
      optionLabel.appendChild(k);
      optionLabel.appendChild(document.createTextNode(' ' + s.label));
      list.appendChild(optionLabel);
    }
    box.appendChild(list);
    const dg = document.createElement('div');
    dg.className = 'buttons';
    const yes = document.createElement('button');
    yes.textContent = "Import selected";
    yes.onclick = () => finish(boxes.filter((k) => k.checked).map((k) => k.value));
    const no = document.createElement('button');
    no.textContent = "Cancel";
    no.onclick = () => finish(null);
    dg.appendChild(yes); dg.appendChild(no);
    box.appendChild(dg);
    return no;
  }).then((c) => (Array.isArray(c) ? c : null));
}

/* *
 * A SINGLE-BUTTON INFORMATION DIALOG.
 *
 * WHY A TOOLTIP IS NOT ENOUGH: the second parameter of the status line goes into the `title`
 * attribute, so it appears only if the pointer rests on it. After a half-finished deletion there are
 * three things the user has to READ: which project still has a file, why, and how to retry.
 * Burying that in a tooltip is another way of quietly passing a partial success off as a success. */
function infoWindow(text) {
  return pageWindow(text, (box, finish) => {
    const dg = document.createElement('div');
    dg.className = 'buttons';
    const done = document.createElement('button');
    done.textContent = "OK";
    done.onclick = () => finish(true);
    dg.appendChild(done);
    box.appendChild(dg);
    box.addEventListener('keydown', (o) => {
      if (o.key === 'Enter') { o.preventDefault(); finish(true); }
    });
    return done;
  });
}

/* Confirm account removal and offer sign-out as an explicit option in the same dialog. */
function confirmWithOptions(text, optionText, defaultSelected = false) {
  return pageWindow(text, (box, finish) => {
    const optionLabel = document.createElement('label');
    optionLabel.className = 'confirm-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !!defaultSelected;
    optionLabel.appendChild(checkbox);
    optionLabel.appendChild(document.createTextNode(' ' + optionText));
    box.appendChild(optionLabel);

    const dg = document.createElement('div');
    dg.className = 'buttons';
    const yes = document.createElement('button');
    yes.textContent = "Remove";
    yes.onclick = () => finish({ confirm: true, selection: checkbox.checked });
    const no = document.createElement('button');
    no.textContent = "Cancel";
    no.onclick = () => finish({ confirm: false, selection: false });
    dg.appendChild(yes); dg.appendChild(no);
    box.appendChild(dg);
    // Enter presses the focused button (Cancel at first), as in confirm().
    return no;
  }).then((c) => (c && c.confirm ? c : { confirm: false, selection: false }));
}

/* * The in-page dialog that asks for text. It replaces `prompt`; on cancel it returns `null`. */
function askText(text, defaults = '') {
  return pageWindow(text, (box, finish) => {
    const field = document.createElement('input');
    field.type = 'text';
    field.value = defaults;
    field.className = 'confirm-field';
    field.onkeydown = (o) => {
      if (o.key === 'Enter') { o.preventDefault(); finish(field.value); }
    };
    box.appendChild(field);
    const dg = document.createElement('div');
    dg.className = 'buttons';
    const done = document.createElement('button');
    done.textContent = "OK";
    done.onclick = () => finish(field.value);
    const cancel = document.createElement('button');
    cancel.textContent = "Cancel";
    cancel.onclick = () => finish(null);
    dg.appendChild(done); dg.appendChild(cancel);
    box.appendChild(dg);
    return field;
  });
}
try {
  new PerformanceObserver((list) => {
    for (const g of list.getEntries()) {
      if (g.duration < 120) continue;
      window.panel.reportStall({ duration: Math.round(g.duration), task: lastTask, pane: panes.length });
    }
  }).observe({ entryTypes: ['longtask'] });
} catch { /* if the browser does not report longtasks, give up quietly */ }

/* While the window is being resized, `resize` fires dozens of times a second. Sending a new size to
   the PTY of every pane each time makes the TUI running inside (Codex, Claude) REDRAW THE WHOLE SCREEN
   every time - that is what a stall while typing looks like. The places that call it directly (a page
   or project switch, releasing the splitter) still measure immediately; what is throttled is only the
   flood arriving during a drag. The interval is 80 ms: imperceptible, and it cuts the flood. */
let measureTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(measureTimer);
  measureTimer = setTimeout(measureAll, 80);
});

window.panel.onTerminalData(({ id, data }) => {
  const b = idMap.get(id);
  if (!b) return;
  // The moment something first appears on screen. That, and not the DOM being built, is the
  // now-visible marker of the switch measurement: the command is written 400 ms later in main.js.
  if (b.firstOutput == null) b.firstOutput = performance.now();
  b.terminal.write(data);
});
window.panel.onTerminalExit(({ id, exitCode }) => {
  const b = idMap.get(id); if (!b) return;
  b.terminal.writeln("\r\n[Process exited with code " + exitCode + ']');
  // The login terminal has no title strip: there may be no status area.
  if (b.status && b.status.style) {
    b.status.textContent = "○ Exited";
    b.status.style.color = 'var(--muted)';
  }
  b.id = null; idMap.delete(id);
  /* THE SESSION ENDED BY ITSELF (/exit, a crash). The context ring, the bottom line and the status line
     used to keep the last session's numbers as if it were still running. */
  b.context = null;
  if (b.bottomLeft) b.bottomLeft.textContent = b.provider ? "Session closed" : 'shell';
  if (b.bottomRight) b.bottomRight.textContent = '';
  if (b.provider && b.owner === activePage) {
    refreshLeft();
    writeStatus((b.label || b.provider) + " · Session ended",
      "The " + b.provider + " process exited. Close the terminal with ×; Start orchestrator resumes the conversation.");
  }
  renderPageStrip();
});

/* ---------------- context and quota ----------------
   EVERY PANE READS ITS OWN SESSION. On Codex the right field is last_token_usage.input_tokens -
   reading the cumulative total produces nonsense such as 200%. */
let contextRefreshing = false;
async function refreshContext() {
  if (contextRefreshing) return;
  contextRefreshing = true;
  try {
  // The id map carries every live terminal in the background as well.
  for (const b of [...idMap.values()]) {
    if (!b.id || !b.provider) { b.bottomLeft.textContent = b.provider ? "Session closed" : 'shell'; b.bottomRight.textContent = ''; b.context = null; continue; }
    const id = b.id;
    let s;
    try { s = await window.panel.readContext(id); }
    catch (e) { s = { error: "Could not read session details: " + e.message }; }
    if (b.id !== id || idMap.get(id) !== b) continue;
    b.context = s;
    if (s && s.sessionId && s.sessionId !== b.sessionId) { b.sessionId = s.sessionId; saveLayout(); }
    if (!s || s.error) { b.bottomLeft.textContent = (s && s.error) || '—'; b.bottomRight.textContent = ''; continue; }
    b.bottomRight.textContent = modelName(s.model || '');
    b.bottomRight.title = s.model || '';

    /* IF THE MODEL CHANGES IN THE TERMINAL THE TITLE CHANGES TOO. The question was whether changing
       the model of the orchestrator from the terminal inside the program would also change it in the
       interface. It did not: the label of the pane was built AT START TIME and never updated again.
       When the user typed `/model`, the bottom line showed the new model while the title showed the
       old one -- the panel contradicted itself on one screen.

       THE SOURCE IS THE SESSION ITSELF: the model is read from the session record (or from the status
       line of Claude), so it is the model that is REALLY running, not the value the panel sent. The
       panel does no guessing here; it writes what it read.

       THE STARTING MODEL IS NOT LOST: it stays in the tooltip as the start model, because the two
       differing is something the user would want to know. */
    if (s.model && s.model !== b.runningModel) {
      b.runningModel = s.model;
      const newLabel = b.label.includes(' · ')
        ? b.label.slice(0, b.label.indexOf(' · ')) + ' · ' + modelName(s.model)
        : b.label;
      if (newLabel !== b.label) {
        b.label = newLabel;
        b.name.textContent = paneLabel(b.label, b.resumeDid);
        b.name.title = b.model && b.model !== s.model
          ? "Current model: " + s.model + "\nRequested model: " + b.model
          : "Current model: " + s.model;
        if (b === panes[0]) refreshButtons();
        saveLayout();
      }
    }
    const tokenText = Number.isFinite(s.used) ? format(s.used) + (s.used === 1 ? ' token' : ' tokens') : "Waiting for token usage";
    b.bottomLeft.textContent = Number.isFinite(s.percent)
      ? "Context " + formatY(s.percent) + ' · ' + tokenText
        + (Number.isFinite(s.limit) ? ' / ' + format(s.limit) : '')
      : tokenText + " · Percentage unavailable";
    b.bottomLeft.title = (s.source || "Session log") + (s.time ? ' · ' + s.time : '');
    if (s.warning) { b.bottomLeft.textContent += " · Log warning"; b.bottomLeft.title += '\n' + s.warning; }
  }
  refreshLeft();
  } finally { contextRefreshing = false; }
}

/* QUOTA -- two sources and two separate honesty labels:
   Claude is read LIVE (once a minute, a real percentage; measured as not being on disk);
   Codex is the percentage written to the file on the last Codex TURN -- as old as that turn.
   Neither is shown without saying on screen when it is from. */
function hourShort(iso) {
  if (!iso) return '?';
  return new Date(iso).toLocaleTimeString("en-US", { hour: '2-digit', minute: '2-digit' });
}

/* The reset moment: the hour and minute ONLY - the date is unnecessary. The time remaining stands
   next to it; what is really wanted is not when but how much longer, and a moment that falls on
   another day can be told from that too. */
function writeReset(iso) {
  if (!iso) return null;
  // Codex reports Unix seconds; Claude reports ISO. Use the same instant for
  // both the clock label and the remaining duration.
  const t = new Date(typeof iso === 'number' ? iso * 1000 : iso);
  if (Number.isNaN(t.getTime())) return null;
  const remainingMin = Math.round((t - new Date()) / 60000);
  if (remainingMin <= 0) return hourShort(t) + " (elapsed)";
  const remaining = remainingMin < 60 ? remainingMin + " min"
    : remainingMin < 1440 ? Math.floor(remainingMin / 60) + " h " + (remainingMin % 60) + " min"
    : Math.floor(remainingMin / 1440) + "d";
  return hourShort(t) + ' · ' + remaining + " remaining";
}


/* The context ring. Radius 55 -> circumference 2*pi*55 = 345.6. The filled part is drawn with
   dashoffset. With a null percentage the ring stays EMPTY: an unknown number is never shown as full. */
function setupRing(percent) {
  const h = g('ctxRing');
  if (!h) return;
  const surroundings = 345.6;
  if (percent === null || percent === undefined || Number.isNaN(percent)) {
    h.style.strokeDashoffset = surroundings;
    return;
  }
  const y = Math.max(0, Math.min(100, percent));
  h.style.strokeDashoffset = surroundings - (surroundings * y / 100);
  h.style.stroke = y >= 80 ? 'var(--red)' : y >= 60 ? 'var(--yellow)' : 'var(--green)';
}

/* AGENT LISTS. The agents of this project on top, and below them the ones that can be taken from
   other projects. Importing IS NOT DONE WITHOUT APPROVAL: pressing + shows the file that would be
   written and takes approval. */
function renderAgentList() {
  const container = g('agentList');
  if (!container) return;
  container.textContent = '';
  const own = definedAgents.filter((a) => !a.undefinedDef);

  /* THE BUTTON MUST BE THERE FOR AN EMPTY LIST TOO. The early return was ABOVE the button,
     so with no agents at all -- the moment the button is needed most -- it was never drawn. It is
     built first now and added in the empty state as well. */
  const takeButton = () => {
    const d = document.createElement('button');
    d.textContent = "Import agents from a folder…";
    d.style.marginTop = '9px';
    d.title = "Look inside a folder and choose which agents to bring in. Nothing is changed until you confirm.";
    d.onclick = takeFromFolderAgent;
    return d;
  };

  if (!own.length && !externalAgents.length) {
    const b = document.createElement('div');
    b.className = 'path';
    b.textContent = project ? "No agents yet." : "Open a project folder first (Overview → Open project).";
    container.appendChild(b);
    container.appendChild(takeButton());
    return;
  }

  if (own.length) {
    writeTitle(container, "This project", "Available to the orchestrator in this project. "
      + "Click to edit.");
    // Running ones on top: what you are looking for should be on the first row.
    const ordered = [...own].sort((x, y) =>
      (runningAgents.has(y.name) ? 1 : 0) - (runningAgents.has(x.name) ? 1 : 0));
    container.appendChild(setupGrid(ordered.map(ownLine)));
  }

  if (externalAgents.length) {
    writeTitle(container, "Not in this project", "Every agent you have, with its real account and model. An agent that is in no project is not gone; add it here to use it.");
    container.appendChild(setupGrid(externalAgents.map(externalLine)));
  }

  container.appendChild(takeButton());
}

/* *
 * THE ONE SENTENCE OF THE SCAN. Nothing is imported before the user has seen what they are
 * approving. A pure function: it does not touch the DOM, so it can be tested. */
function scanSummary(scan, folder) {
  const short = String(folder || '').split(/[\\/]/).filter(Boolean).pop() || String(folder || '');
  const found = (scan && scan.found) || [];
  const importable = found.filter((x) => x.importable);
  const unreadable = found.filter((x) => !x.importable);
  if (!found.length) {
    return "No agent definitions were found in \"" + short + "\".\n\n"
      + "Benchook looked in .benchook/agents and .claude/agents.";
  }
  const lines = ["Found " + countOf(importable.length, "agent", "agents") + " in \"" + short + "\"."];
  if (unreadable.length) {
    lines.push(countOf(unreadable.length, "file", "files") + " could not be read and cannot be imported:");
    for (const x of unreadable) lines.push("  " + x.name + " — " + (x.corrupt || 'Unknown error'));
  }
  const known = importable.filter((x) => x.alreadyExists);
  if (known.length) {
    lines.push("Benchook already knows " + known.length + " of them ("
      + known.map((x) => x.name).join(', ') + "); importing updates them from this folder.");
  }
  /* THE TWO EFFECTS OF AN IMPORT ARE STATED IN ADVANCE. Measured: `agent-sync.importFolder`
     takes the agent into the registry and writes it to the member projects through `publish`, while
     `panel.js importAgentsFromFolder` also adds the folder to the project list. So the.md files of
     the selected agents in that folder are rewritten in the Benchook format and the folder enters the
     list. The user has to know this BEFORE approving; safety contract is changing no file without approval. */
  lines.push("Importing adds this folder to Benchook's project list and manages the agents "
    + "you choose here: their .md files in this folder are rewritten in Benchook's format and "
    + "kept in sync from now on. Files you do not choose are left untouched.");
  lines.push("Nothing has been changed yet. Choose what to import.");
  return lines.join('\n');
}

/**
 * IMPORT AGENTS FROM A FOLDER - show first, then ask.
 *
 * The old form only added the folder to the project list of the panel and nothing in the list
 * changed; the button did not do the job its name promised (measured).
 */
async function takeFromFolderAgent() {
  const filePath = await window.panel.pickFolder();
  if (!filePath) return;                                   // cancelled: nothing happens
  let scan;
  try { scan = await window.panel.scanAgentFolder(filePath); }
  catch (e) { writeStatus("Could not read that folder.", String(e && e.message || e)); return; }

  const importable = ((scan && scan.found) || []).filter((x) => x.importable);
  if (!importable.length) { await infoWindow(scanSummary(scan, filePath)); return; }

  const selection = await selectableWindow(scanSummary(scan, filePath), importable.map((x) => ({
    value: x.name,
    label: x.name + (x.description ? ' — ' + x.description : '') + (x.alreadyHere ? " (already here)" : ''),
    selected: !x.alreadyHere,
  })));
  if (!selection || !selection.length) return;                // cancelled, or an empty selection

  const r = await settle(window.panel.importAgentsFromFolder(filePath, selection));
  if (r && r.error) { writeStatus("Could not import agents.", r.error); return; }
  if (!projects.some((x) => sameProject(x, filePath))) { projects.push(projectPathNormalize(filePath)); renderProjectList(); saveLayout(); }
  await refreshDefinitions();
  refreshExternalAgent();
  const imported = (r && r.imported) || [];
  const errors = (r && r.errors) || [];
  writeStatus(countOf(imported.length, "agent", "agents") + " imported.",
    errors.length ? errors.map((x) => x.name + ': ' + x.error).join('\n')
      : "They are in the list below; open one to add it to this project.");
  if (errors.length) {
    await infoWindow(countOf(imported.length, "agent", "agents") + " imported, " + errors.length + " could not be:\n\n"
      + errors.map((x) => '  ' + x.name + ' — ' + x.error).join('\n'));
  }
}

/* The container that lays the cards out TWO PER ROW. Headings stay OUTSIDE this grid - a heading laid
   out two per row would lose which heading belongs to which card. */
function setupGrid(cards) {
  const trace = document.createElement('div');
  trace.className = 'agent-grid';
  for (const k of cards) trace.appendChild(k);
  return trace;
}

function writeTitle(container, text, hint) {
  const t = document.createElement('div');
  t.className = 'agent-title';
  t.textContent = text;
  t.title = hint;
  container.appendChild(t);
}

/** An agent of this project: green-bordered, slightly brighter, and edited when clicked. */
function ownLine(a) {
  const running = runningAgents.has(a.name);
  const r = document.createElement('div');
  r.className = 'agent-card own' + (running ? ' running' : '');
  const nk = document.createElement('span');
  nk.className = 'status-dot' + (running ? ' live' : '');
  nk.style.color = 'var(--green)';
  const gv = document.createElement('div');
  gv.className = 'history-body';
  const name = document.createElement('div');
  name.className = 'agent-name';
  name.textContent = a.name;
  const bottom = setupBottomLine(a);
  gv.appendChild(name); gv.appendChild(bottom);
  const warningLine = setupWarningLine(a);
  if (warningLine) gv.appendChild(warningLine);
  r.appendChild(nk); r.appendChild(gv);
  r.appendChild(permissionIcon(a.permission));
  const warning = setupAlert(a);
  if (warning) r.appendChild(warning);
  // On a two-per-row card a badge eats into the NAME. The badge of a running agent STAYS (that is
  // live information and the thing being looked for); the run count moved to the tooltip - a past
  // number is not what someone is after while looking at a card.
  if (running) r.appendChild(badge('Running', true));
  r.style.cursor = 'pointer';
  /* THE TOOLTIP IS SHORT: on hover, the account, the model and the full name are enough. The
     description, the folder and the run count are already in the form and in the detail view. */
  r.title = cardHint(a);
  r.onclick = () => agentForm(a);
  if (a.nameConflict) {
    // Locked: shown and openable, but there is no remove button; the form allows only a rename.
    r.classList.add('locked');
    gv.appendChild(lockedLine());
    return r;
  }

  // REMOVE FROM PROJECT. It sits in the same place as the x on a project row but does NOT do the same
  // thing: removing a project does not touch the disk, while this deletes the file. The confirmation
  // text states the difference.
  const removeBtn = document.createElement('span');
  removeBtn.className = 'remove';
  removeBtn.textContent = '×';
  removeBtn.title = "Remove agent from project (deletes its definition file)";
  removeBtn.onclick = (o) => { o.stopPropagation(); removeAgent(a); };
  r.appendChild(removeBtn);
  return r;
}

/* THE PROJECTS A "DELETE EVERYWHERE" WILL TOUCH, listed one way for agents and skills alike. The
   skill's question listed full paths while the agent's listed folder names (first real-use trial,
   23 September); the folder name is what the project list shows. */
function removalList(projects) {
  return "It will be removed from " + countOf(projects.length, "project", "projects") + ":\n"
    + projects.map((x) => '  ' + folderName(x)).join('\n');
}

/** Removes the agent from the project. Unlike removing a project it DELETES THE FILE; the confirmation says so plainly. */
async function removeAgent(a) {
  if (runningAgents.has(a.name)) {
    writeStatus('"' + a.name + "\" is running.", "Wait for the run to finish before removing this agent.");
    return;
  }
  /* REMOVING FROM A PROJECT IS NOT DELETING - an agent not being used does not mean it is
     dead. This confirmation text used to say the definition file would be permanently deleted, which
     is now misleading: what is deleted is only the file in this project, while the agent itself
     stands and stays in the list. */
  const warning = 'Remove "' + a.name + "\" from this project?\n\n"
    + (a.filePath || "(path unavailable)") + '\n\n'
    + "This deletes only this project's copy of the definition.\n\n"
    + "The agent itself stays: it keeps its account and model, it still appears in the list "
    + "below, and you can add it back at any time. Other projects are untouched.";
  if (!await confirm(warning)) return;
  const r = await settle(window.panel.removeAgent(project, a.filePath));
  if (r && r.error) {
    /* NOTHING CHANGED, and this cannot be buried in a tooltip. When the file cannot be
       deleted the membership no longer drops either; that is exactly what the user needs to know,
       otherwise they assume the removal was left half done. */
    writeStatus("Could not remove agent.", r.error);
    await infoWindow(r.error);
    return;
  }
  await refreshDefinitions();
  refreshExternalAgent();
  writeStatus('"' + a.name + "\" removed from this project; the agent is still available.",
    "A running orchestrator may still have the previous agent list in context.");
}

/* *
 * THE ONE SENTENCE FOR THE RESULT OF A DELETION.
 *
 * It used to say "deleted from N project(s)" unconditionally; but the central record was also being
 * deleted unconditionally, and an undeletable file brought the agent back on the next scan. So the
 * sentence was not merely early, it was WRONG. If the work did not finish it is not called finished,
 * and the way to retry is stated.
 *
 * A pure function: it does not touch the DOM, so it can be tested. */
function deletionResult(r, name) {
  if (!r || r.error) return { succeeded: false, text: (r && r.error) || "Could not delete agent." };
  const short = (x) => String(x).split(/[\\/]/).filter(Boolean).pop();
  const removedPaths = Array.isArray(r.removedPaths) ? r.removedPaths : [];
  const pending = Array.isArray(r.pending) ? r.pending : [];
  if (!pending.length) {
    return { succeeded: true,
      text: '"' + name + '" deleted from ' + countOf(removedPaths.length, 'project', 'projects') + '.',
      bottom: "A running orchestrator may still have the previous agent list in context." };
  }
  const reason = (project) => {
    const h = (r.errors || []).find((x) => x && x.project === project);
    return (h && h.error) || 'Unknown error';
  };
  const lines = [];
  if (removedPaths.length) lines.push("Deleted in " + countOf(removedPaths.length, "project", "projects") + ".");
  lines.push("Still there in " + countOf(pending.length, "project", "projects") + ":");
  for (const project of pending) {
    lines.push("  " + short(project));
    lines.push("    " + reason(project));
  }
  lines.push('"' + name + '" stays in Benchook until those files are gone, so it cannot '
    + 'come back as a different agent.');
  lines.push("Press Delete agent again to retry. Benchook also finishes the delete by "
    + "itself the next time it can open that project.");
  return { succeeded: false, partial: true, text: '"' + name + '" was not fully deleted.',
    bottom: lines.join('\n') };
}

/* *
 * THE SENTENCE FOR A DELETION THAT FINISHED OR IS PENDING IN THE BACKGROUND.
 *
 * A gap found by a cold review: a deletion can complete without the user clicking anywhere (a watcher
 * event, or reselecting the project). The same care shown on the button path had not been applied
 * here -- so the panel deleted a file from disk and wrote nothing on screen. A blocking dialog would
 * be WRONG here: the user is doing something else at that moment. The status line writes it without
 * interrupting the work.
 *
 * A pure function: it does not touch the DOM, so it can be tested. */
function watchDeletionResult(publish) {
  if (!publish) return null;
  const completed = Array.isArray(publish.deletionCompleted) ? publish.deletionCompleted : [];
  const pending = Array.isArray(publish.deletionPending) ? publish.deletionPending : [];
  if (!completed.length && !pending.length) return null;
  const name = (list) => list.map((x) => '"' + x + '"').join(', ');
  if (completed.length) {
    return { text: name(completed) + " deleted: Benchook finished the delete in this project.",
      bottom: "The file could not be removed when you pressed Delete; it was removed just now." };
  }
  const reason = (publish.errors || []).filter((h) => h && pending.includes(h.name))
    .map((h) => '  ' + (h.project || '') + ' ' + (h.error || '')).join('\n');
  return { text: name(pending) + " is still waiting to be deleted here.",
    bottom: (reason || "Benchook could not remove the file yet.")
      + "\nIt stays in Benchook until the file is gone, and finishes by itself when it can." };
}

/* *
 * DELETE THE AGENT EVERYWHERE - from every project and from the panel. A separate action with its own
 * confirmation text so it is not confused with removing it from a project.
 *
 * HOW MANY PROJECTS IT AFFECTS IS WRITTEN FIRST, then it deletes. Nobody should press this button
 * without seeing which projects will be affected; safety contract requires it. */
async function agentNoneTag(a) {
  if (runningAgents.has(a.name)) {
    writeStatus('"' + a.name + "\" is running.", "Wait for the run to finish before deleting it.");
    return;
  }
  const all = await window.panel.agentRegistry().catch(() => []);
  const record = (all || []).find((x) => String(x.name).toLowerCase() === String(a.name).toLowerCase());
  const recordProjects = (record && record.projects) || [];
  const question = "Delete the agent \"" + a.name + "\" everywhere?\n\n"
    + (recordProjects.length
      ? removalList(recordProjects)
      : "It is not in any project right now.")
    + "\n\nThis also removes it from the panel. To keep the agent and only take it out of "
    + "this project, use Remove from project instead.";
  if (!await confirm(question)) return;
  const r = await settle(window.panel.deleteAgent(a.name));
  await refreshDefinitions();
  refreshExternalAgent();
  const s = deletionResult(r, a.name);
  writeStatus(s.text, s.bottom || '');
  // A half-finished deletion does not stay in a tooltip: the user must not leave this screen without
  // seeing which file is left and what to do about it.
  if (s.partial || !s.succeeded) await infoWindow(s.text + '\n\n' + (s.bottom || ''));
}

/**
 * The bottom line of an agent card: THE ACCOUNT and THE MODEL, nothing else.
 *
 * These are general agents with tasks of their own, and which project they are in does not matter -
 * any of them can be added to any project. Under an agent, only the name of its account and the model
 * it uses should appear.
 * That is why the project name and the panel-agent / Claude-Code-agent label came off the card; both
 * live in the tooltip, where space is not a problem.
 *
 * The account name is SHORTENED - to fit two columns, and because the first few letters are enough.
 * So that shortening does not destroy distinctness, the first word is taken: "Claude (default)"
 * becomes "Claude". A long single-word name is cut to its first 10 letters.
 */
/**
 * The name of the model AS SHOWN ON SCREEN. The `gpt` prefix on every GPT model is dropped so that
 * only the version reads on the card.
 *
 * DISPLAY ONLY. The name written to the file, passed to the terminal and given to `--model` stays the
 * real one (`gpt-5.6-luna`); the only thing changed here is the on-screen label. If the two are
 * confused the panel sends a model name that does not exist.
 */
/**
 * Makes a model identity readable ON SCREEN: `claude-sonnet-5` -> `Sonnet 5`.
 *
 * The provider name is dropped because it already appears in three other places (the pane icon, the
 * account row, the terminal title); version numbers are joined with a dot (`haiku-4-5` -> `Haiku 4.5`)
 * and the trailing date stamp is removed (`...-20251001`), because both are names of the same model.
 *
 * ONLY THE ON-SCREEN TEXT CHANGES. The value that goes into the file, to the CLI and into the record
 * is the RAW identity; if the two are confused the panel calls a model that does not exist.
 */
function modelName(raw) {
  const m = String(raw || '').trim();
  if (!m || m === 'default') return m;
  const parts = m.replace(/^(?:claude|gpt)[-_ ]/i, '')
    .split(/[-_]/)
    .filter((x) => !/^\d{8}$/.test(x));           // the trailing date stamp: the same model
  const output = [];
  for (const p of parts) {
    const previousCount = output.length && /^[\d.]+$/.test(output[output.length - 1]);
    if (previousCount && /^\d{1,2}$/.test(p)) { output[output.length - 1] += '.' + p; continue; }
    output.push(/^[a-zçğıöşü]/.test(p) ? p.charAt(0).toLocaleUpperCase("en-US") + p.slice(1) : p);
  }
  return output.join(' ');
}

function accountRecord(id) {
  return id ? registry.find((x) => x.id === id) || null : null;
}

/** The text of a model option. A family name an older agent was saved with (`opus`, `sonnet`,...) is shown
    as the version it stands for now, when the account's catalog says so (`latest` from
    `window.panel.claudeLatest`); the lists themselves offer only named versions. */
function modelOptionText(raw, latest) {
  if (raw === 'default') return "Default";
  const k = String(raw || '').toLowerCase();
  const now = latest && /^(fable|opus|sonnet|haiku)$/.test(k) ? latest[k] : null;
  return now || modelName(raw);
}

/**
 * The SHORT FORM of an account - its name next to the icon, with the model beside it.
 *
 * The provider name is already visible in the icon, so it is dropped from the name: "Claude (work)"
 * becomes "work". If nothing is left, nothing is written - the icon alone is enough. When there are
 * several accounts on the same provider, what tells them apart is exactly that remaining piece.
 * It is not cut here: it used to be cut to four letters, and the card's width now does the shortening.
 */
function shortAccount(id) {
  const h = accountRecord(id);
  const raw = String((h && h.name) || id || '').trim();
  const remaining = raw.replace(/^(claude|codex|openai|anthropic)\b[\s\-_()]*/i, '').trim();
  return remaining.replace(/[()]/g, '').trim();
}

/** The provider icon: a burst of rays for Claude, a hexagonal node for Codex. Raw SVG, no external file. */
function providerIcon(provider) {
  const ns = 'http://www.w3.org/2000/svg';
  const sv = document.createElementNS(ns, 'svg');
  sv.setAttribute('viewBox', '0 0 16 16');
  sv.setAttribute('class', 'agent-icon' + (provider === 'codex' ? ' codex' : ' claude'));
  if (provider === 'codex') {
    const y = document.createElementNS(ns, 'path');
    y.setAttribute('d', 'M8 1.6 13.5 4.8v6.4L8 14.4 2.5 11.2V4.8Z');
    y.setAttribute('fill', 'none');
    y.setAttribute('stroke', 'currentColor');
    y.setAttribute('stroke-width', '1.4');
    y.setAttribute('stroke-linejoin', 'round');
    sv.appendChild(y);
  } else {
    // An eight-pointed star: a plain drawing that echoes the Claude mark.
    for (let i = 0; i < 8; i++) {
      const c = document.createElementNS(ns, 'rect');
      c.setAttribute('x', '7.35'); c.setAttribute('y', '1.6');
      c.setAttribute('width', '1.3'); c.setAttribute('height', '5.2');
      c.setAttribute('rx', '0.65');
      c.setAttribute('fill', 'currentColor');
      c.setAttribute('transform', 'rotate(' + (i * 45) + ' 8 8)');
      sv.appendChild(c);
    }
  }
  return sv;
}

/* *
 * The bottom line of a card: THE PROVIDER ICON, the short account name and the model. No box.
 *
 * The box was removed so the card simply carries the icon of whichever provider the agent runs on.
 * The provider is NOT INVENTED: first the own `provider` line of the agent, and failing that the kind
 * recorded for the account in the registry. With neither, no icon is drawn - not showing the unknown
 * as known is safety contract of the panel. */
/* THE REASON MUST BE VISIBLE, NOT IN A TOOLTIP.
 *
 * And the reason alone is not enough: a user once wrote the provider login name into the `account`
 * line of an agent file, and the panel said it was not in the registry and bound the agent to the
 * orchestrator. That is the right behaviour, but because the user could not see which names the
 * registry held, they took it for a defect. WRITING the known accounts is not a guess: they are read
 * from the registry. */
/** The account id written in the file but missing from the registry; null otherwise. The form box
 *  keeps it selected so that an untouched record does not lose its binding. */
function unregisteredFileAccount(a) {
  const c = a && a.resolution;
  if (!c || !c.asOrchestrator || !c.fileAccount || c.fileAccount === 'orchestrator') return null;
  return registry.some((h) => h.id === c.fileAccount || h.name === c.fileAccount) ? null : c.fileAccount;
}

function resolutionNote(a) {
  const c = a && a.resolution;
  if (!c || !c.reason) return null;
  /* THE ACCOUNT LIST IS NOT WRITTEN HERE. The warning was found long and confusing; something short
     along the lines of "Linked account is not registered" is enough.

     Short history: this line was a dead branch looking for a Turkish text; it was repaired and then
     began appending every account in the registry to the warning. Seeing the result on screen, the
     user found it noisy - and rightly: which accounts can be chosen is already written in the ACCOUNT
     BOX right next to it, and repeating it in the warning says the same thing twice.
     The warning reports only the EVENT; the options are the business of the box. */
  return c.reason;
}

/** An agent's account and model as the screen writes them - the account's name, the model's panel name. Never the
 *  raw id or model string (K8/K16); search used the raw ones until 27 September. */
function agentNames(a) {
  const c = a && a.resolution;
  const hk = c && !c.asOrchestrator ? accountRecord(c.account) : null;
  const account = c ? (c.asOrchestrator ? "Same as orchestrator" : ((hk && hk.name) || c.account)) : (a.account || "Not specified");
  const raw = c ? (c.asOrchestrator ? null : c.model) : a.model;
  const model = (c && c.asOrchestrator) ? "Same as orchestrator"
    : raw ? (raw === 'default' ? "Default" : modelName(raw)) : "Not specified";
  return { account, model };
}

/** The tooltip of a sidebar card: the full name, the account name and the model - that is all. */
function cardHint(a) {
  const { account, model } = agentNames(a);
  return a.name + "\nAccount: " + account + "\nModel: " + model
    + "\nPermission: " + PERMISSION_LABEL[a.permission || 'default'];
}

/* THE LEVEL ON THE CARD, as a small mark in the card's left margin under the status dot: an eye for read
   only, a pencil for editing, a prompt for full access (amber). In the bottom line it took the room the
   model name needs; the margin was empty. The word is in its tooltip and in the card's. */
function permissionIcon(level) {
  const known = PERMISSION_LABEL[level] ? level : 'default';
  const ns = 'http://www.w3.org/2000/svg';
  const sv = document.createElementNS(ns, 'svg');
  sv.setAttribute('viewBox', '0 0 16 16');
  sv.setAttribute('class', 'perm-icon perm-' + known);
  const t = document.createElementNS(ns, 'title'); t.textContent = "Permission: " + PERMISSION_LABEL[known]; sv.appendChild(t);
  const path = (d) => { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.4'); p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round'); sv.appendChild(p); };
  if (known === 'default') { path('M8 1.8 13.2 4v3.6c0 3.2-2.2 5.6-5.2 6.6-3-1-5.2-3.4-5.2-6.6V4z'); path('M8 5.6v2.8'); path('M8 10.6v.1'); }
  else if (known === 'full') { path('M2.5 4.5 6 8l-3.5 3.5'); path('M8 11.5h5.5'); }
  else if (known === 'edit' ) { path('M10.5 2.5l3 3-7.5 7.5H3v-3z'); }
  else if (known === 'custom') { path('M3 5h10M3 8h10M3 11h6'); }
  else { path('M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z'); path('M8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z'); }
  return sv;
}

function bottomPart(className, text) {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  return s;
}

function setupBottomLine(a) {
  const bottom = document.createElement('div');
  bottom.className = 'bottom';
  const h = accountRecord(a.account);
  /* The provider CAN BE KNOWN from three places, none of them a guess: the own `provider` line of the
     definition, the kind recorded for the account in the registry, or the `.claude/agents/` folder -
     files there are in the own sub-agent format of Claude Code and run in that harness
     (`worker === false`). With none of the three, no icon is drawn. */
  /* AN AGENT BOUND TO THE ORCHESTRATOR: no icon is drawn and none can be - which provider will run it
     is only settled at call time. Nor is it called a missing account and model; that is no longer an
     omission but a valid setting. */
  if (a.resolution && a.resolution.asOrchestrator) {
    bottom.appendChild(bottomPart('bottom-text', "Same as orchestrator"));
  // The reason (an unregistered account) is no longer here but inside `setupWarningLine`: see the note there.
    bottom.title = "Uses the orchestrator's account and model."
      + (a.resolution.reason ? "\nReason: " + a.resolution.reason : '')
      + (a.resolution.fileAccount ? "\nAccount in definition: " + a.resolution.fileAccount : '')
      + (a.resolution.fileModel ? "\nModel in definition: " + a.resolution.fileModel : '');
    return bottom;
  }
  const provider = a.provider || (h && h.provider) || (a.worker === false ? 'claude' : null);
  if (provider) bottom.appendChild(providerIcon(provider));
  // 'default' is an internal marker shown on screen as "Default"; modelName deliberately leaves it alone.
  /* Render account and model separately. Under limited width, truncate the account label before the model label. */
  const accountText = shortAccount(a.account);
  const modelText = a.model === 'default' ? 'Default' : modelName(a.model);
  if (accountText) bottom.appendChild(bottomPart('bottom-account', accountText));
  if (accountText && modelText) bottom.appendChild(bottomPart('bottom-sep', ' · '));
  if (modelText) bottom.appendChild(bottomPart('bottom-model', modelText));
  if (!accountText && !modelText && !provider) bottom.appendChild(bottomPart('bottom-text', "Account and model not specified"));
  /* THE TOOLTIP SHOWS THE NAME OF THE ACCOUNT, NOT ITS INTERNAL ID: nobody knows those ids by heart,
     and the part before the @ is what should be written. The name in the registry is already the part
     of the e-mail before the @. For an unregistered account the internal id remains, but it is said. */
  const accountName = a.account ? (h ? h.name : a.account + " (not registered)") : "Not specified";
  bottom.title = "Account: " + accountName + "\nModel: "
    + (a.model ? (a.model === 'default' ? 'Default' : modelName(a.model)) : "Not specified");
  return bottom;
}

/* Keep card warnings concise and place the full explanation in the tooltip. Select the label from the warning source rather than truncating its sentence. */
function setupWarningLine(a) {
  const parts = [];
  const reason = resolutionNote(a);
  if (reason) parts.push({ label: "No account", sentence: reason });
  if (a && a.signInWarning) parts.push({ label: "Signed out", sentence: a.signInWarning });
  if (mcpWarning && a && a.resolution && !a.resolution.asOrchestrator) {
    parts.push({ label: "Unreachable", sentence: mcpWarning });
  }
  if (!parts.length) return null;
  const u = document.createElement('div');
  u.className = 'agent-warning';
  u.textContent = parts.map((x) => x.label).join(' · ');
  u.title = parts.map((x) => x.sentence).join('\n');
  return u;
}

/* Display the configured agent connection state. Share status text with panel/mcp-status.js so the UI and generated catalog agree. */
let mcpWarning = null;

/* ---------------- DEPENDENCY WARNING ----------------
 *
 * The panel has to say that these agents are risky and carry dependencies of their own: a small amber
 * warning mark in the top-left corner of an agent card, with a warning on hover and the long
 * explanation in the detail view.
 *
 * The mark lights ONLY for a STRONG missing dependency - a file that is executed or applied and is
 * not in this project. A missing read-only document weakens an agent without stopping it, so it does
 * not light the mark; it is written in the detail view. Without that distinction every card would
 * carry a mark and the mark would say nothing: measured - FIVE of the six agents in this project
 * carry a soft missing dependency and none carries a strong one.
 */
function dependencySummary(a) {
  const b = a && a.dependency;
  if (!b) return null;
  const place = b.placeAmbiguous || [];
  if (!(b.all || []).length && !place.length) return null;
  return b;
}

/**
 * The warning mark in the top-left corner of a card. TWO LEVELS: red for the badly broken, amber for
 * what is a problem but can still run.
 *
 * RED:   a file the agent opens and applies is missing -- this agent will not work.
 * AMBER: a file the agent refers to is missing -- it works, without that information.
 * With nothing missing, no mark is drawn.
 *
 * With a single level it produced a defect: the detail view flagged a missing file while the card
 * showed nothing, so the screen looked as if it were contradicting itself.
 */
function setupAlert(a) {
  const b = dependencySummary(a);
  if (!b) return null;
  const strong = b.missingStrong.length;
  const soft = b.missingSoft.length;
  if (!strong && !soft) return null;
  const u = document.createElement('span');
  u.className = 'agent-alert ' + (strong ? 'red' : 'yellow');
  u.textContent = '!';
  u.title = strong
    ? "A required file appears to be missing from this project:\n"
      + b.missingStrong.map((x) => '  ' + x).join('\n')
      + "\nImporting an agent copies its definition only."
    : "A referenced file is missing from this project:\n"
      + b.missingSoft.map((x) => '  ' + x).join('\n');
  return u;
}

/** The explanation in the detail view. Short: one sentence, one list, one note. */
function dependencyBlock(a) {
  const b = dependencySummary(a);
  if (!b) return null;
  const container = document.createElement('div');
  container.className = 'link-box'
    + (b.missingStrong.length ? ' strong' : (b.missingSoft.length ? ' soft' : ''));

  const press = document.createElement('div');
  press.className = 'link-title';
  press.textContent = b.missingStrong.length ? "! Required files may be missing"
    : (b.missingSoft.length ? "! Missing referenced files" : "Referenced files");
  container.appendChild(press);

  const signedIn = document.createElement('div');
  signedIn.className = 'link-text';
  signedIn.textContent = b.missingStrong.length
    ? "A file this agent appears to require is missing. "
      + "Importing an agent copies its definition only."
    : (b.missingSoft.length
      ? "A referenced file is missing. The agent may need it to complete its task."
      : "All detected files are present.");
  container.appendChild(signedIn);

  const list = document.createElement('ul');
  list.className = 'link-list';
  for (const x of b.all) {
    const li = document.createElement('li');
    li.className = (x.exists ? 'present' : 'absent') + (x.strong ? ' strong' : '');
    li.textContent = (x.exists ? '✓ ' : '✗ ') + x.filePath;
    li.title = (x.strong ? "Appears to be required by the instructions." : "Referenced in the instructions.")
      + (x.exists ? " Present in this project." : " Missing from this project.");
    list.appendChild(li);
  }
  container.appendChild(list);

  if ((b.placeAmbiguous || []).length) {
    /* The name appears, the folder does not. It cannot be called missing, because where to look is unknown. */
    const by = document.createElement('div');
    by.className = 'link-note';
    by.textContent = "Referenced without a path: " + b.placeAmbiguous.join(', ');
    by.title = "The definition mentions this file without a folder path. "
      + "Its location could not be checked.";
    container.appendChild(by);
  }

  const note = document.createElement('div');
  note.className = 'link-note';
  note.textContent = "Detected from the instructions; may be incomplete.";
  note.title = "Benchook checks file paths mentioned in the agent definition. "
    + "This is a dependency hint, not a guarantee that the agent will succeed or fail.";
  container.appendChild(note);
  return container;
}

/** An agent from another project: dimmed, without a frame, and clicking asks to copy it into this project. */
function externalLine(a) {
  const r = document.createElement('div');
  r.className = 'agent-card external';
  const nk = document.createElement('span');
  nk.className = 'status-dot';
  nk.style.background = '#33322f';
  const gv = document.createElement('div');
  gv.className = 'history-body';
  const name = document.createElement('div');
  name.className = 'agent-name';
  name.textContent = a.name;
  const bottom = setupBottomLine(a);
  gv.appendChild(name); gv.appendChild(bottom);
  const warningLine = setupWarningLine(a);
  if (warningLine) gv.appendChild(warningLine);
  r.appendChild(nk); r.appendChild(gv);
  r.appendChild(permissionIcon(a.permission));
  const warning = setupAlert(a);
  if (warning) r.appendChild(warning);
  /* AN ACTIVE AND AN INACTIVE AGENT OPEN THE SAME DIALOG - meeting the same dialog, with only the
     button differing (Add to project when inactive, Remove from project when active), is the sensible
     shape. An inactive agent used to go through a review page in between; that page dated from a time
     when an inactive agent COULD NOT BE EDITED, and buttons had been piled onto it since. */
  /* THE SOURCE IS NOW THE REGISTRY. This row shows not the FILE of another project but the
     AGENT ITSELF. Saving adds it to this project and updates the agent at the same time; there is no
     such thing as copying any more, because there is no such thing as a copy. */
  const shortProject = (x) => String(x).split(/[\\/]/).filter(Boolean).pop();
  const where = (a.projects || []).length
    ? "Active in: " + a.projects.map(shortProject).join(', ')
    : "Not in any project yet. It is not gone, it is idle.";
  r.title = cardHint(a) + '\n' + where;
  r.style.cursor = 'pointer';
  if (a.nameConflict) { r.classList.add('locked'); gv.appendChild(lockedLine()); }
  r.onclick = () => {
    /* THE INTENT IS CLEAR HERE: this row shows a PERSON in the registry who is not in this project.
       Saving adds it to this project -- it does not create a new agent. */
    agentForm({ name: a.name, description: a.description, body: a.task || '', model: a.model,
      account: a.account, provider: a.provider, resolution: a.resolution, projects: a.projects,
      tools: a.tools || null, permission: a.permission, nameConflict: !!a.nameConflict,
      conflictProjects: [...(a.projects || []), ...Object.values(a.nameConflicts || {}).map((x) => x.project)] },
    { intent: 'addToProject' });
  };
  return r;
}

/** The locked mark on a card: a warning line under the name. A badge would take the name's
    place in the two-column card. */
function lockedLine() {
  const w = document.createElement('div');
  w.className = 'agent-warning';
  w.textContent = 'Same name';
  w.title = 'Locked: another project has a different agent with this name. Open it to rename it.';
  return w;
}

function badge(text, opened) {
  const rz = document.createElement('span');
  rz.className = 'badge' + (opened ? ' expanded' : '');
  rz.textContent = text;
  return rz;
}

let externalAgents = [];
async function refreshExternalAgent() {
  renderNameConflicts();   // locks are not tied to one project: the warning follows every refresh
  const note = g('externalAgentNote');
  if (!note) return;
  if (!project) { externalAgents = []; note.textContent = ''; renderAgentList(); return; }

  /* THE SOURCE IS NOW THE REGISTRY. This list used to scan the folders of other projects, so
     an agent used in no project appeared nowhere at all. An agent has to remain editable and addable
     from the panel even when it is used in no project. */
  // Only the newest call for the current project writes the list; an older reply is dropped.
  const proj = project, request = refreshExternalAgent.request = (refreshExternalAgent.request || 0) + 1;
  try {
    const all = await window.panel.agentRegistry();
    if (request !== refreshExternalAgent.request || project !== proj) return;
    const here = new Set(definedAgents.filter((x) => !x.undefinedDef).map((x) => x.name.toLowerCase()));
    /* AN AGENT BEING DELETED DOES NOT APPEAR IN THIS LIST. This is the add-to-project list;
       presenting a half-finished deletion as an addable agent would invite the user to cancel the
       deletion without realising it. The record is not lost: its card stands in the project whose file
       still exists, and the deletion is retried from there. */
    externalAgents = (all || []).filter((x) => !here.has(String(x.name).toLowerCase())
      && !x.deletionPending);
  }
  catch { externalAgents = []; note.textContent = "Could not read the agent registry"; renderAgentList(); return; }
  note.textContent = '';
  note.title = '';
  renderAgentList();
}


/* *
 * Sets up what is missing so that an agent assigned to this project is also CALLABLE in it.
 *
 * This has to happen automatically when an agent is added, so that it appears in the files straight
 * away. What is automatic is not having to hunt for a separate Set up button
 * every time. THE APPROVAL IS NOT REMOVED: every file that would be written is shown in one dialog
 * and approved once. That is how safety contract is kept.
 *
 * If there is nothing to set up, nothing is asked - opening an empty dialog on every agent addition
 * would turn the approval into a habit that is clicked through unread. */
const pendingSetups = new Map();
function completeSetup(manual = false) {
  const targetProject = project;
  if (!targetProject) { if (manual) writeStatus("Open a project folder first (Overview → Open project).", ''); return Promise.resolve(); }
  if (pendingSetups.has(targetProject)) return pendingSetups.get(targetProject);
  const task = askSetup(targetProject, manual).finally(() => pendingSetups.delete(targetProject));
  pendingSetups.set(targetProject, task);
  return task;
}
async function askSetup(targetProject, manual) {
  const preferenceKey = 'benchook.setup-deferred:' + targetProject.replace(/\\/g, '/').toLowerCase();
  let deferred = false;
  try { deferred = localStorage.getItem(preferenceKey) === 'yes'; } catch {}
  if (!manual && deferred) {
    writeStatus("Agent saved. Project setup is deferred.", "Use Complete setup in the Agents tab when you are ready.");
    return;
  }
  const p = await settle(window.panel.setupPlan(targetProject));
  if (!p || p.error) { if (p && p.error) writeStatus("Could not prepare setup.", p.error); return; }
  if (!Array.isArray(p.steps) || !p.steps.length) {
    try { localStorage.removeItem(preferenceKey); } catch {}
    if (manual) writeStatus("Project setup is up to date.");
    return;
  }

  const describe = { create: "Create", update: "Update", repair: "Repair" };
  const question = [
    "To make agents available to the orchestrator,",
    "the following project files need to be updated:",
    '',
    ...p.steps.map((a) => '· ' + a.file + '  (' + describe[a.kind] + ')'
      + (a.note ? '\n    ' + a.note : '')),
    '',
    "These settings reference the Benchook installation.",
    "Existing project hooks will be preserved.",
    '',
    "Apply these changes?",
  ].join('\n');
  if (!await confirm(question)) {
    try { localStorage.setItem(preferenceKey, 'yes'); } catch {}
    writeStatus("Setup cancelled.",
      "The agent definition is saved. Use Complete setup in the Agents tab when you are ready; the orchestrator may not discover it until then.");
    return;
  }
  const s = await settle(window.panel.applySetup(p.steps));
  if (!s || s.error) { writeStatus("Setup could not be completed.", (s && s.error) || "Benchook did not answer."); return; }
  try { localStorage.removeItem(preferenceKey); } catch {}

  /* SAYING IT IS REGISTERED WOULD BE WRONG HERE. Measured: Codex does not run the hooks of a project
     until each hook has been marked TRUSTED individually, and it does so silently. The user saw this
     with their own eyes in the dialog that appeared in a second Codex session.
     Writing the files opens the Claude side and does NOT open the Codex side; the panel cannot do
     that, because the trust stamp is kept in the own settings file of Codex and the approval belongs
     to the user. Not showing the unknown as known is safety contract. */
  writeStatus(((s.written && s.written.length) || 0) + " files updated.",
    "Project settings are saved. When opening Codex, "
    + "review the project hooks if prompted. Select \"Trust all and "
    + "continue\" only after reviewing them. Changed hooks may "
    + "require another review.");
}

function refreshLeft() {
  const warning = g('ctxWarning');
  const b = enabled, s = b && b.context;
  const account = b && registry.find((h) => h.id === b.accountId);
  g('ctxAccount').textContent = account ? account.name : '—';

  if (!b || !s || s.error) {
    g('ctxModel').textContent = '—'; g('ctxUsed').textContent = '—';
    g('ctxPercent').textContent = '—'; setupRing(null);
    warning.style.display = (s && s.error) ? 'block' : 'none';
    if (s && s.error) warning.textContent = s.error;
    return;
  }

  /* NO PROVIDER NEXT TO THE MODEL: only the model reads there. The account name is right beside it
     and the provider icon is in the pane title above, so the "claude" inside "claude-sonnet-5" was a
     third repetition. */
  g('ctxModel').textContent = s.model ? modelName(s.model) : 'Unknown';
  g('ctxModel').title = s.model || '';
  g('ctxUsed').textContent = format(s.used);

  /* WITH NO TOKENS SPENT THE PERCENTAGE IS ZERO - even when the limit is unknown. While no message
     has been written the context window showed a question mark, where 0% reads perfectly well. And
     this is not a guess: 0 divided by any number is 0. The panel is not showing something it does not
     know here, it is showing something it does.
     If tokens HAVE been spent while the limit is unknown, no percentage is written: that really is unknown. */
  const emptySession = s.percent === null && s.used === 0 && !(s.missing && s.missing.length);
  if (emptySession) {
    g('ctxPercent').textContent = '0%';
    setupRing(0);
    warning.style.display = 'none';
  } else if (s.percent === null) {
    g('ctxPercent').textContent = '?';
    setupRing(null);
    warning.style.display = 'block';
    warning.textContent = (s.missing && s.missing.length)
      ? "Token usage is unavailable in this session log."
      : "'" + modelName(s.model || '?') + "' has no known context limit. Percentage unavailable.";
  } else {
    const y = s.percent;
    g('ctxPercent').textContent = Math.round(y) + '%';
    setupRing(y);
    warning.style.display = 'none';
  }
}
/* Agent records come from the session subagents directory. Display recorded output and tool activity; do not infer unrecorded reasoning. */
let openAgent = null;           // the file name of the agent whose detail view is open
let openAgentSource = 'pane';  // which list that record was opened from: 'pane' | 'project'
const cards = new Map();     // agent name -> the card nodes and how many steps were drawn
let lastList = [];             // the per-second counter works from this

/* Keep input, cached-input, and output token values distinct. Token counts do not provide a reliable conversion to an account quota percentage. */
function tokenLine(t) {
  if (!t || !t.present) return "Token usage unavailable";
  return short(t.output) + '\u2191 \u00b7 ' + short(t.input) + '\u2193 \u00b7 ' + countOf(t.calls, "call", "calls");
}

/** A count with its noun in agreement: "1 run", "2 runs". */
function countOf(n, one, many) {
  return n + ' ' + (n === 1 ? one : many);
}

/* ELAPSED TIME -- for a running agent, from the start until NOW; for a finished one, the difference
   between the first and last record. Without that distinction the counter froze and a running agent
   looked dead on screen. */
function elapsedSeconds(a) {
  if (!a.startedAt) return null;
  const b = Date.parse(a.startedAt);
  // The counter advances only for an agent that is REALLY running. 'unknown' (a run from another
  // session, or an end marker that could not be read) also shows the first-to-last difference in the
  // record; otherwise a run from yesterday would look as if it had been running for hours.
  if (a.status !== 'running') {
    return a.updatedAt ? Math.round((Date.parse(a.updatedAt) - b) / 1000) : null;
  }
  return Math.round((Date.now() - b) / 1000);
}
function writeDuration(sn) {
  if (sn === null) return '\u2014';
  return sn < 60 ? sn + " s" : Math.floor(sn / 60) + ' min ' + (sn % 60) + " s";
}

/* WHICH WORKER BELONGS TO WHICH PANE.
 *
 * EVERY worker record in the project used to be added to the list of EVERY pane: a worker started
 * from terminal A also showed live on the card of B, and the running count went up in every pane.
 * The record had no parent field either.
 *
 * The record now carries the panel identity of the terminal that started the run (`BENCHOOK_SESSION`,
 * per pane) and a live card lands only on its own pane. A RECORD WITH NO PARENT IS NOT GUESSED AT --
 * binding it by name or time proximity is the thing the card forbids. Those appear not on a live card
 * but in the project history; the history stays whole. */
/* Two binding paths: a Claude worker carries `parent` (the BENCHOOK_SESSION of the pane); a Codex
   worker cannot, so the main process writes `parentThread` (the Codex session id of the pane) through
   rollout matching. An empty identity matches nothing. */
function paneWorkers(workers, paneId, sessionIdFromFile = null) {
  return (workers || []).filter((a) => a && (
    (paneId && a.parent && a.parent === paneId)
    || (sessionIdFromFile && !a.parent && a.parentThread && a.parentThread === sessionIdFromFile)));
}

/* Newest first by when the run started: native runs and worker runs come from two lists, and joined
   unsorted an older run could stand as a card's "latest". */
const runTime = (a) => Date.parse(a.startedAt || '') || a.createdAt || 0;
const newestFirst = (list) => list.sort((a, b) => runTime(b) - runTime(a));

/* A WORKER (MCP) RECORD IN THE SHAPE OF A RUN. One place: the pane cards and the project history each
   had their own copy of this conversion. `extra` carries what only one of them adds. */
function workerRun(a, extra = {}) {
  return {
    ...a,
    file: 'worker:' + a.id,
    ...extra,
    step: a.status === 'running' ? 0 : 1,
    tools: {}, targets: [],
    tokens: a.tokens ? {
      present: true,
      output: a.tokens.output || 0,
      input: (a.tokens.fresh || 0) + (a.tokens.cacheRead || 0) + (a.tokens.cacheWritten || 0),
      calls: 1,
    } : null,
    flow: a.result ? [{ tip: 'text', text: a.result }] : [],
  };
}
/** Is this run a worker (MCP) run? Its step count is unknown and is never written. */
const isWorkerRun = (a) => !!a && typeof a.file === 'string' && a.file.startsWith('worker:');

/* WHICH AGENTS AND ACCOUNTS ARE RUNNING, from whatever lists were just read. It used to be updated only
   while the history or a detail view was open, so the sidebar "Running" mark was usually missing and the
   remove/delete guard could say "is running" long after a run ended. */
function setRunning(lists) {
  const newAgent = new Set(), newAccount = new Set();
  for (const a of lists.flat()) {
    if (!a || a.status !== 'running') continue;
    if (a.name) newAgent.add(a.name);
    if (a.account) newAccount.add(a.account);
  }
  const changed = newAgent.size !== runningAgents.size || newAccount.size !== runningAccounts.size
    || [...newAgent].some((x) => !runningAgents.has(x))
    || [...newAccount].some((x) => !runningAccounts.has(x));
  runningAgents = newAgent;
  runningAccounts = newAccount;
  if (changed) { renderAgentList(); renderRegistry(); }
}

/* A QUESTION NOBODY CAN SEE IS A RUN THAT WAITS FOR GOOD. Permission questions were drawn only on the
   cards of the tab on screen; a run asking from another tab or another open project stalled with no sign.
   Such tabs and project rows get a "?" mark, and the status line says where. Other projects are read every
   fifth round (about 6 s) to keep the cost low. */
const asking = (a) => a && a.status === 'running' && Array.isArray(a.questions) && a.questions.length;
async function markWaitingQuestions(workers) {
  const tabs = new Set();
  for (const sy of pages) {
    if (sy === activePage) continue;
    for (const b of (sy.panes || [])) {
      if (paneWorkers(workers, b.connection, b.provider === 'codex' ? b.sessionId : null).some(asking)) tabs.add(sy.id);
    }
  }
  let others = waitingProjects;
  if (waitingRound++ % 5 === 0) {
    others = new Set();
    for (const other of projectFields.keys()) {
      if (other === project) continue;
      const answer = await window.panel.projectWorkers(other).catch(() => null);
      if (((answer && answer.list) || []).some(asking)) others.add(other);
    }
  }
  const same = (x, y) => x.size === y.size && [...x].every((v) => y.has(v));
  const changed = !same(tabs, waitingTabs) || !same(others, waitingProjects);
  const appeared = [...tabs].some((x) => !waitingTabs.has(x)) || [...others].some((x) => !waitingProjects.has(x));
  waitingTabs = tabs; waitingProjects = others;
  if (!changed) return;
  renderPageStrip(); renderProjectList();
  if (appeared) {
    const where = [...[...tabs].map((id) => (pages.find((x) => x.id === id) || {}).name), ...[...others].map(folderName)].filter(Boolean);
    writeStatus("An agent is waiting for your permission: " + where.join(', ') + ".", "Open that tab or project to answer on its run card.");
  }
}

// One round at a time: a slow read (a large session file) used to let rounds pile up every 1.2 s.
let agentRefreshing = false;
async function refreshAgent() {
  if (agentRefreshing) return;
  agentRefreshing = true;
  try { await refreshAgentRound(); } finally { agentRefreshing = false; }
}
async function refreshAgentRound() {
  /* ONE ROUND BELONGS TO ONE PROJECT. The pane list is copied (a tab switch rewrites `panes` in place)
     and a reply that arrives after a project switch is dropped instead of being drawn into the new one.
     A failed read of one pane no longer stops the round for the others. */
  const proj = project;
  const list = panes.slice();
  let workerAnswer;
  try { workerAnswer = proj ? await window.panel.projectWorkers(proj) : { list: [] }; }
  catch { workerAnswer = { list: [] }; }
  if (project !== proj) return;
  const workers = ((workerAnswer && workerAnswer.list) || []).map((a) => workerRun(a));
  for (const b of list) {
    if (!b.id) { b.agents = null; b.agentBadge.innerHTML = ''; continue; }
    let c;
    try { c = await window.panel.readAgents(b.id); }
    catch (e) { c = { none: 'error', error: (e && e.message) || String(e) }; }
    if (project !== proj) return;
    c = c || { none: 'error' };
    // Only the workers THIS pane started land on a live card ; the rest are in the project history.
    c.list = newestFirst([...(c.list || []), ...paneWorkers(workers, b.connection, b.provider === 'codex' ? b.sessionId : null)]);
    b.agents = c;
    const running = (c && c.list) ? c.list.filter((a) => a.status === 'running').length : 0;
    // If nothing changed, do not touch the DOM: otherwise the blinking dot restarts its animation every round.
    const badge = running ? '<span class="dot"></span> ' + countOf(running, 'agent', 'agents') : '';
    if (b.agentBadge.innerHTML !== badge) b.agentBadge.innerHTML = badge;
    b.agentBadge.style.color = 'var(--yellow)';
  }
  setRunning([workers, ...panes.map((b) => (b.agents && b.agents.list) || [])]);
  await markWaitingQuestions(workers);
  const c = enabled && enabled.agents;
  lastList = (c && c.list) || [];
  writeSummary(enabled, c);
  renderGrid(enabled, c);
  if (historyOpen) { await refreshProjectRuns(); renderHistory(lastList); }
  else if (openAgent) { await refreshProjectRuns(); renderDetail(openAgent); }
}

/* THE SENTENCE IN THE TOP STRIP - pure and testable.
 *
 * the list said finished while the end was only ESTIMATED, and the strip wrote "All
 * completed"; the "Completed (probable)" distinction from the detail and history views had not
 * reached here. The count of runs that probably finished is now in the sentence.
 *
 * with only an MCP worker having run -- and the native main journal not there yet -- the card
 * showed a result while the strip said "No agent activity yet". The cause: `c.none === 'record'` was
 * consulted before the list even when the list was full. The rule: if the list is full the list is
 * described; no-record is said only when there really is no run at all. */
function summarySentence(list) {
  const k = list.filter((a) => a.status === 'running').length;
  const h = list.filter((a) => a.status === 'error').length;
  const t = list.filter((a) => a.status === 'done' && a.endSource === 'estimated').length;
  const unknown = list.filter((a) => !['running', 'error', 'done', 'cancelled'].includes(a.status)).length;
  return countOf(list.length, "agent run", "agent runs") + " · "
    + (k ? k + " running" : h ? h + " failed"
      : unknown ? unknown + " with unknown status"
      : t ? "All completed (" + t + " probable)" : "All completed");
}

function writeSummary(b, c) {
  // Instead of a terse technical sentence, WHAT HAPPENED is written and the reason goes in the
  // tooltip: a line like "no session record was created" means nothing to the person reading it.
  let m;
  let ip = "Agents invoked by this tab's orchestrator in the current session.";
  const list = (c && Array.isArray(c.list)) ? c.list : [];
  if (!b) {
    m = "No active orchestrator";
    ip = "Start an orchestrator from the sidebar to see its agent activity.";
  } else if (list.length) {
    m = summarySentence(list);
  } else if (!c || c.none === 'record') {
    m = "No agent activity yet";
    ip = "Agent runs will appear here when the orchestrator invokes them.";
  } else if (c.none === 'support') {
    m = "Native agent activity unavailable";
    ip = c.error || '';
  } else if (c.none === 'error') {
    m = "Unavailable";
    ip = c.error || '';
  } else {
    m = "No agent activity yet";
  }
  /* The "calls" section in the left column was removed, but the TEXT remains: when the terminal is
     collapsed the strip shows it. The strip used to read it from the DOM of that section; once the
     section was gone, reading from there would crash. The text is kept here now. */
  agentSummaryText = m;
  for (const el of [g('agentSummary'), sg('flowIdentity')]) {
    if (!el) continue;
    if (el.textContent !== m) el.textContent = m;
    el.title = ip;
  }
}

/* THE AGENT GRID -- it has to be obvious when agents are NOT working, and when they are, the work
   they do should stream on screen the way it does in a terminal; being dynamic really matters.
   Every agent has ITS OWN card; a card is built once and then only NEW steps are appended -- it is
   not redrawn (redrawing threw the scroll position back to the top).
   What streams are the steps the agent writes to disk. The THINKING of an agent does not stream: it
   is not written to disk. */
/* ONE CARD PER AGENT -- the same agents should use one card, showing the work of whichever run is
   active, and after it finishes the last thing it did can stay.
   So a card belongs to a ROLE (record-checker, challenger,...), not to a call. Calling the same role
   again does not open a new card: the same card moves to the new job and its body is cleared.
   The history is not lost -- every run stays in the Agent history window. */
function groupBy(list) {
  const m = new Map();          // the list already arrives newest first
  for (const a of list) {
    if (!m.has(a.name)) m.set(a.name, { name: a.name, runs: [] });
    m.get(a.name).runs.push(a);
  }
  const groups = [...m.values()];
  // Running roles on top; after that, ordered by the most recent to run.
  groups.sort((x, y) => {
    const kx = x.runs.some((k) => k.status === 'running') ? 1 : 0;
    const ky = y.runs.some((k) => k.status === 'running') ? 1 : 0;
    return ky - kx;
  });
  return groups;
}

/** The run shown on the card: the running one if there is one, otherwise the most recent. */
function enabledRun(gr) {
  /* A run that waits for an answer comes first: with two runs of one agent, only the first running run
     was drawn and the other's question was never shown, so that run waited for good. */
  return gr.runs.find((k) => k.status === 'running' && Array.isArray(k.questions) && k.questions.length)
    || gr.runs.find((k) => k.status === 'running') || gr.runs[0];
}

function renderGrid(b, c) {
  const trace = sg('grid');
  const list = (b && c && c.list) ? c.list : [];
  const groups = groupBy(list);

  // With no agents the grid closes completely: the orchestrator takes the full height.
  gridVisible(groups.length > 0);

  if (!groups.length) {
    for (const [d, k] of cards) { k.container.remove(); cards.delete(d); }
    return;
  }

  const valid = new Set(groups.map((x) => x.name));
  for (const [d, k] of cards) if (!valid.has(d)) { k.container.remove(); cards.delete(d); }

  groups.forEach((gr, i) => {
    let k = cards.get(gr.name);
    if (!k) { k = createCard(gr); cards.set(gr.name, k); }
    if (trace.children[i] !== k.container) trace.insertBefore(k.container, trace.children[i] || null);
    refreshCard(k, gr);
  });
}

function createCard(gr) {
  const container = document.createElement('div');
  container.className = 'card';
  container.innerHTML =
    '<div class="card-top"><span class="dot"></span><span class="card-name"></span>' +
    '<span class="card-model"></span><span class="card-account"></span><span class="card-count"></span>' +
    "<span class=\"card-close\">Details</span></div>" +
    '<div class="card-task"></div>' +
    '<div class="card-ask" hidden></div>' +
    '<div class="body"></div>' +
    '<div class="card-footer"><span class="card-status"></span><span class="card-metric"></span>' +
    '<span class="card-duration"></span></div>';
  container.querySelector('.card-name').textContent = gr.name;
  container.querySelector('.card-name').title = gr.name;
  const d = {
    container,
    body: container.querySelector('.body'),
    point: container.querySelector('.dot'),
    model: container.querySelector('.card-model'),
    account: container.querySelector('.card-account'),
    num: container.querySelector('.card-count'),
    task: container.querySelector('.card-task'),
    ask: container.querySelector('.card-ask'),
    status: container.querySelector('.card-status'),
    measure: container.querySelector('.card-metric'),
    duration: container.querySelector('.card-duration'),
    shown: null,
    rendered: 0,
  };
  container.querySelector('.card-close').onclick = () => {
    if (d.shown) { historyOpen = false; openAgent = d.shown; renderDetail(d.shown, 'pane'); }
  };
  sg('grid').appendChild(container);
  return d;
}

function refreshCard(k, gr) {
  const a = enabledRun(gr);
  const running = a.status === 'running';
  k.container.classList.toggle('running', running);
  k.container.classList.toggle('finished', !running);
  k.point.style.display = running ? '' : 'none';
  setupText(k.model, runModelText(a));
  k.model.title = runModelDetail(a);
  /* WHICH ACCOUNT IT RAN ON - writing the account there is useful, and the identity was already in
     the record, it simply never reached the screen.
     If the record carries no account, that run happened on the own account of the orchestrator; it is
     not invented. */
  const hk = a.account ? accountRecord(a.account) : null;
  const accountText = a.account ? ((hk && hk.name) || a.account) : "Same as orchestrator";
  setupText(k.account, accountText);
  k.account.title = a.account
    ? ("This run used the account " + accountText + (hk ? '' : " (no longer registered)"))
    : "This run used the orchestrator's own account.";
  setupText(k.num, countOf(gr.runs.length, "run", "runs"));
  setupText(k.task, a.task || "(No task description)");
  k.task.title = a.task || '';
  // An estimated end says "probable" on the card too ; an unknown state never becomes "Completed".
  setupText(k.status, running ? 'Running' : runStatusWord(a.status, a.endSource));
  k.container.classList.toggle('invalid', a.status === 'error');
  // For a worker run the step count is unknown and is not written; the area under the card follows the same rule.
  const workerCard = isWorkerRun(a);
  setupText(k.measure, (workerCard ? '' : a.step + " steps · ") + tokenLine(a.tokens));
  setupText(k.duration, writeDuration(elapsedSeconds(a)));

  renderQuestion(k, a);

  // If the same role moved to a NEW job the card body is cleared; the old run stays in the history.
  if (k.shown !== a.file) {
    k.body.textContent = '';
    k.rendered = 0;
    k.shown = a.file;
  }

  const events = a.flow || [];
  // Paginated provider history can update an existing item without adding a row.
  // A count alone would keep the old text forever. Preserve scroll while rebuilding
  // only when the already-rendered prefix actually changed.
  const previousScroll = k.body.scrollTop;
  const previousInFooter = k.body.scrollHeight - previousScroll - k.body.clientHeight < 30;
  const signatures = events.map(o => JSON.stringify([o.tip, o.tool, o.target, o.text]));
  if (events.length < k.rendered || (k.eventSignatures || []).slice(0, k.rendered)
    .some((signature, i) => signature !== signatures[i])) { k.body.textContent = ''; k.rendered = 0; }
  k.eventSignatures = signatures;
  if (events.length === k.rendered) return;

  const inFooter = previousInFooter;
  for (let i = k.rendered; i < events.length; i++) {
    const o = events[i];
    const d = document.createElement('div');
    if (o.tip === 'tool') {
      d.className = 'event';
      const b = document.createElement('b'); b.textContent = o.tool;
      d.appendChild(b);
      d.appendChild(document.createTextNode('  ' + (o.target || '')));
    } else {
      d.className = 'event text';
      d.textContent = o.text;
    }
    k.body.appendChild(d);
  }
  k.rendered = events.length;
  if (inFooter) k.body.scrollTop = k.body.scrollHeight;
  else k.body.scrollTop = previousScroll;
}

/* A PERMISSION PROMPT ON THE LIVE RUN CARD . What the agent wants to do, in the words of its
   provider's own prompt, with the command or file; Allow or Deny answers it and the waiting agent continues. One
   question at a time, the oldest first; a count says when more wait. Nothing is answered without a click. */
function renderQuestion(k, a) {
  const questions = (a.status === 'running' && Array.isArray(a.questions)) ? a.questions : [];
  const q = questions[0];
  const key = q ? q.id + ':' + questions.length : '';
  if (k.askKey === key) return;
  k.askKey = key;
  k.ask.textContent = '';
  k.ask.hidden = !q;
  k.container.classList.toggle('asking', !!q);
  if (!q) return;
  const head = document.createElement('div'); head.className = 'ask-title';
  head.textContent = "Permission required · " + q.title + (questions.length > 1 ? " (" + (questions.length - 1) + " more waiting)" : '');
  const detail = document.createElement('code'); detail.className = 'ask-detail';
  detail.textContent = q.detail || '';
  detail.title = q.detail || '';
  const actions = document.createElement('div'); actions.className = 'ask-actions';
  const note = document.createElement('span'); note.className = 'ask-note';
  const runId = String(a.file || '').replace(/^worker:/, '');
  for (const [label, decision] of [["Allow", 'allow'], ["Deny", 'deny']]) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.className = 'ask-' + decision;
    b.onclick = async () => {
      for (const x of actions.querySelectorAll('button')) x.disabled = true;
      const r = await settle(window.panel.answerWorker(project, runId, q.id, decision));
      if (r && r.error) { note.textContent = r.error; for (const x of actions.querySelectorAll('button')) x.disabled = false; return; }
      k.askKey = null;
      refreshAgent();
    };
    actions.appendChild(b);
  }
  actions.appendChild(note);
  k.ask.append(head, detail, actions);
}

/* AGENT HISTORY -- one row per run, grouped by role. Because cards belong to a role, older runs drop
   off the screen; they live here so they are not lost. */
let historyOpen = false;
let historySignature = '';
let projectRuns = [];        // the runs across EVERY session of the project

/* If an agent was run in a project it is worth seeing there regardless of where it came from. The
   history window now shows the whole project; the cards on the main screen stayed tied to the pane,
   because that is the live screen. */
async function refreshProjectRuns() {
  if (!project) { projectRuns = []; return; }
  const proj = project;
  let c, i;
  try {
    [c, i] = await Promise.all([
      window.panel.projectAgentRuns(proj, enabled && enabled.id),
      window.panel.projectWorkers(proj),
    ]);
  } catch { return; }   // the previous list stays until the next round
  // A reply for a project the user has left is not written into the current one.
  if (project !== proj) return;
  const workers = ((i && i.list) || []).map((a) => workerRun(a, { session: "Worker" }));
  projectRuns = newestFirst([...((c && c.list) || []), ...workers]);
  setRunning([projectRuns]);
}

/* THE STATE OF A RUN COMES FROM ONE SENTENCE.
 *
 * Finished can come from two different pieces of evidence and they are not the same thing: the
 * completion notification in the main session record is CERTAIN; the fallback marker used when that
 * shape is absent altogether ("the last record carries only text") is an ESTIMATE and can be wrong --
 * an intermediate text in the middle of a run fits that shape too. Showing the two with the same word
 * would present an unmeasured assumption as a measured one, which the card forbids. */
/**
 * THE MODEL TEXT OF A RUN. In a real run three cards wrote it three ways: the requested alias, the
 * internal default marker of the panel, and the raw identity. The rule: if the model that REALLY RAN
 * is known, that one (`observedModels`, read from the output or the rollout on a worker run),
 * otherwise the requested one; both go through the spelling the panel uses everywhere (`modelName`);
 * the default marker appears on screen as "Default"; with none of them, "Model unavailable".
 * The raw identity goes into the tooltip; it is not lost.
 */
/* A CARD NAMES ONE MODEL: THE OWN MODEL OF THE AGENT. Two different models appearing on an agent card
   was needless confusion. A provider may also have used a helper model during a run (an observed list
   carried two names); that information is not invented, but the question a card answers is which model
   this agent ran on. The order: the requested model (as resolved in the record), then the first
   observed model, then the model in the definition. Every observed name stays in the tooltip and in
   the detail view (runModelDetail). */
function runModelText(a) {
  const running = Array.isArray(a && a.observedModels) ? [...new Set(a.observedModels.filter(Boolean))] : [];
  const requested = a && a.requestedModel && !['orchestrator', 'default'].includes(a.requestedModel) ? a.requestedModel : null;
  const raw = requested || running[0] || (a && a.model) || '';
  if (!raw) return "Model unavailable";
  return raw === 'default' ? "Default" : modelName(raw);
}
/** Every model name appearing in the record (requested plus observed), for the tooltip and the detail view. */
function runModelDetail(a) {
  const all = [...new Set([a && a.requestedModel, ...((a && a.observedModels) || []), a && a.model].filter(Boolean))];
  return all.map((m) => m === 'default' ? "Default" : m === 'orchestrator' ? "Same as orchestrator" : modelName(m)).join(', ');
}

function runStatusWord(status, endSource) {
  if (status === 'done') return endSource === 'estimated' ? "Completed (probable)" : "Completed";
  if (status === 'error') return "Failed";
  if (status === 'cancelled') return "Cancelled";
  if (status === 'running') return "Running";
  return "Unknown";
}

function renderHistory(list) {
  const k = g('detail');
  const signature = list.map((a) => a.file + a.status + a.step).join(',')
            + '|' + definedAgents.map((a) => a.name + a.times).join(',')
            + '|' + projectRuns.map((a) => a.file + a.status + a.step).join(',');
  if (historySignature === signature) return;
  historySignature = signature;
  detailInstalled = null;   // the detail skeleton was torn down and will be rebuilt

  k.textContent = '';
  const close = document.createElement('button');
  close.id = 'closeButton'; close.textContent = 'Close';
  close.onclick = closeDetail;
  k.appendChild(close);
  const b = document.createElement('h3'); b.textContent = "Agent history";
  k.appendChild(b);

  definitionList(k);

  // If the project-wide list could be read it is shown; if not, it falls back to the list of the pane
  // and THE HEADING changes too -- so that showing less is never passed off as showing everything.
  const hasProject = projectRuns.length > 0;
  const runs = hasProject ? projectRuns : list;

  const t0 = document.createElement('div');
  t0.className = 'history-title';
  t0.textContent = hasProject ? "All runs in this project" : "Runs in this session";
  k.appendChild(t0);
  /* THE DESCRIPTION LINE MOVED INTO THE TOOLTIP: the agent activity window had too much text and
     looked cluttered. The information is not lost, it sits in the tooltip of the heading; it is not a
     sentence that has to be read every time the window opens. */
  if (hasProject) {
    t0.title = "This view includes all recorded runs. The main view shows the current session. "
      + "Runs from other sessions may show an unknown status "
      + "when their completion record is unavailable.";
  }

  if (!runs.length) {
    const y = document.createElement('div');
    y.className = 'hint';
    y.textContent = hasProject ? "No agent runs recorded in this project."
                             : "No agent runs recorded in this session.";
    k.appendChild(y);
    g('overlay').style.display = 'block';
    return;
  }

  const thisPane = new Set(list.map((a) => a.file));

  for (const gr of groupBy(runs)) {
    const b2 = document.createElement('div');
    b2.className = 'history-title';
    b2.textContent = gr.name + '  \u00b7  ' + countOf(gr.runs.length, "run", "runs");
    k.appendChild(b2);
    for (const a of gr.runs) {
      const r = document.createElement('div');
      r.className = 'history-row';
      const s1 = document.createElement('span'); s1.className = 'history-name';
      const statusText = runStatusWord(a.status, a.endSource);
      s1.textContent = statusText + ' \u00b7 ' + writeDuration(elapsedSeconds(a));
      if (a.status === 'unknown') s1.style.color = 'var(--muted)';
      const s2 = document.createElement('span'); s2.className = 'history-task';
      s2.textContent = a.task || "(No task description)"; s2.title = a.task || '';
      const s3 = document.createElement('span'); s3.className = 'shadow';
      // Which session it ran in is written on the row: the list no longer belongs to a single pane.
      const where = a.session
        ? '  \u00b7  ' + (thisPane.has(a.file) ? "This pane" : a.session.slice(0, 8)) : '';
      /* THE ROW WAS SHORTENED: the token breakdown (four numbers) stood on every row and made the list
         unreadable. The numbers were not lost, they moved into the tooltip of the row. */
      // For a worker run the step count is unknown and is not written.
      const worker = isWorkerRun(a);
      s3.textContent = (worker ? '' : a.step + " steps") + where.replace(/^  ·  /, worker ? '' : '  ·  ');
      s3.title = tokenLine(a.tokens);
      r.appendChild(s1); r.appendChild(s2); r.appendChild(s3);
      r.onclick = () => { historyOpen = false; openAgent = a.file; renderDetail(a.file, 'project'); };
      r.title = thisPane.has(a.file) ? "View details" : "View recorded details from another session";
      k.appendChild(r);
    }
  }
  g('overlay').style.display = 'block';
}

/* GRID VISIBILITY -- with no agents the orchestrator takes the full height: a very narrow area for
   the orchestrator does not feel comfortable to work in. */
function applyShare() {
  const top = sg('topRight'), bottom = sg('flowContainer');
  if (!shareRatio || !top || !bottom) return;   // the page may not be built yet
  top.style.flex = shareRatio.top + ' 1 0';
  bottom.style.flex = shareRatio.bottom + ' 1 0';
}

let terminalOnly = false;      // hidden by hand?
function gridVisible(hasAgent) {
  const show = (hasAgent || terminalHidden) && !terminalOnly;
  const container = sg('flowContainer'), ay = sg('separatorY'), strip = sg('strip'), top = sg('topRight');

  // IT MUST BE POSSIBLE TO REOPEN the agent area while it is hidden. In the first version the Hide
  // button was INSIDE the area being hidden; once hidden there was no way to bring it back.
  // There are two ways out now: the layout buttons in the left column and this strip.
  const containerD = show ? '' : 'none';
  const changed = container.style.display !== containerD;
  if (changed) container.style.display = containerD;
  ay.style.display = (show && !terminalHidden) ? '' : 'none';
  top.style.display = terminalHidden ? 'none' : '';

  // The strip appears ONLY when it was hidden by hand. With no agents the grid is closed anyway, and
  // showing the strip there would be a lie about something hidden being there.
  const showStrip = terminalOnly && !terminalHidden;
  strip.style.display = showStrip ? 'flex' : 'none';
  if (showStrip) setupText(sg('stripSummary'), agentSummaryText || '');

  const d = sg('fold');
  if (d) setupText(d, "Hide");
  // The strip takes space too; the refit runs AFTER every visibility change.
  if (changed) requestAnimationFrame(measureAll);
}

/* LAYOUT -- dragging a window to the edge of the screen on Windows rearranges it, and the same kind
   of use is wanted here. Four ready compositions are chosen with a button or by dragging the title to
   an edge; the top, bottom, left or right position of the terminal is saved. */
function selectLayout(name) {
  if (name === 'stacked' || name === 'sideBySide') { layout = name; layoutReversed = false; terminalOnly = false; terminalHidden = false; }
  else if (name === 'terminalOnly') { terminalOnly = true; terminalHidden = false; }
  else if (name === 'agentsOnly') { terminalOnly = false; terminalHidden = true; }
  applyLayout();
  gridVisible(cards.size > 0);
  saveLayout();
}

function applyLayout() {
  if (!activePage) return;   // the page may not be built yet
  // 'sideBySide' - the English rename had turned this one comparison into 'inline', a layout that does not exist, so
  // side by side never applied (reported by the user, 26 September 2026).
  activePage.root.classList.toggle('side-by-side', layout === 'sideBySide');
  activePage.root.classList.toggle('reverse', layoutReversed);
  // The strip's arrow points to where the agents open from the edge the strip stands on.
  const arrow = activePage.root.querySelector('[data-role="strip"] .strip-arrow');
  if (arrow) arrow.textContent = layout === 'sideBySide' ? (layoutReversed ? '▶' : '◀') : (layoutReversed ? '▼' : '▲');
  for (const d of document.querySelectorAll('button[data-place]')) {
    const selected = d.dataset.place === (terminalHidden ? 'agentsOnly' : terminalOnly ? 'terminalOnly' : layout);
    // Marked with a class rather than a border colour: the segment buttons in the top bar have no
    // border, so a colour would be invisible.
    d.classList.toggle('selected', selected);
  }
  measureAll();
}

/* Dragging the title to an edge: all four layouts use the same saved-layout mechanism. */
function dragDropSetup(root) {
  const targets = root.querySelector('[data-role="layoutTargets"]');
  const cleanup = () => {
    targets.classList.remove('expanded');
    for (const h of targets.querySelectorAll('.hover')) h.classList.remove('hover');
  };
  const launch = (e) => {
    if (!panes.length || e.target.closest('.x,.layer')) return;
    cleanup();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'layout');
    targets.classList.add('expanded');
  };
  document.addEventListener('dragend', cleanup);
  root.addEventListener('dragstart', (e) => {
    if (e.target.closest('.title,.flow-drag')) launch(e);
  });
  const draggables = new MutationObserver(() => {
    for (const x of root.querySelectorAll('.title,.flow-drag')) x.draggable = true;
  });
  draggables.observe(root, { childList: true, subtree: true });
  // Released when the tab closes: the document-level listener kept every closed tab's nodes alive.
  root.releaseDragDrop = () => { document.removeEventListener('dragend', cleanup); draggables.disconnect(); };
  for (const x of root.querySelectorAll('.title,.flow-drag')) x.draggable = true;
  for (const h of targets.querySelectorAll('[data-drop]')) {
    h.ondragover = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; h.classList.add('hover'); };
    h.ondragleave = () => h.classList.remove('hover');
    h.ondrop = (e) => {
      e.preventDefault();
      const n = h.dataset.drop;
      layout = (n === 'left' || n === 'right') ? 'sideBySide' : 'stacked';
      layoutReversed = n === 'right' || n === 'bottom';
      terminalOnly = false; terminalHidden = false;
      cleanup();
      applyLayout(); gridVisible(cards.size > 0); saveLayout();
    };
  }
}
/* The per-second pulse: only the counters of running cards. NO file is read and no token is spent --
   only the number on screen advances, without which a card looks dead. */
function refreshDuration() {
  for (const a of lastList) {
    if (a.status !== 'running') continue;
    /* Cards are kept per agent NAME (one card per role) and show one run at a time. The lookup used the
       run's file, never matched, and the per-second counter never moved. */
    const k = cards.get(a.name);
    if (k && k.shown === a.file) setupText(k.duration, writeDuration(elapsedSeconds(a)));
  }
}

/* THE DETAIL VIEW. Caught by eye: the view was rebuilt with innerHTML every 3 seconds, so scrolling
   down threw the scroll position back to the top on the next round and a long result was impossible
   to read. The fix is where the drawing HAPPENS: the skeleton is built ONCE per agent and afterwards
   only the text of a changed area changes in place. For a finished agent no area changes at all, so
   the DOM is never touched - the scroll position does not move. */
let detailInstalled = null;   // the file name of the agent whose skeleton is built

function setupText(el, created) { if (el && el.textContent !== created) el.textContent = created; }

/* Resolve details from the list where the row was opened. Project history can contain a newer copy than the active pane list. */
function selectDetailRecord(file, source, paneList, projectList) {
  const find = (list) => (list || []).find((x) => x && x.file === file) || null;
  const order = source === 'project' ? [projectList, paneList] : [paneList, projectList];
  return find(order[0]) || find(order[1]);
}

function renderDetail(file, source = null) {
  if (source) openAgentSource = source;
  const c = enabled && enabled.agents;
  const a = selectDetailRecord(file, openAgentSource, c && c.list, projectRuns);
  if (!a) { closeDetail(); return; }
  const k = g('detail');

  if (detailInstalled !== file) {
    k.innerHTML =
      "<button id=\"closeButton\">Close</button>" +
      '<h3></h3><div class="meta"></div><div class="meta token"></div>' +
      // THE HEADING SAYS WHAT IT IS. A user looking for this text could not find it although it sat
      // under a "Task" heading: the heading did not say the text was THE MESSAGE THE ORCHESTRATOR
      // SENT. The own rule of the panel: write what it is, not what it is called.
      "<h4>Message the orchestrator sent</h4><div class=\"meta-2\"></div>" +
      "<h4>Resources accessed</h4><div id=\"targets\"></div>" +
      "<h4>Result</h4><pre id=\"resultText\"></pre>" +
      "<h4 id=\"historyTitle\" hidden>Earlier runs of this agent</h4><div id=\"agentHistory\"></div>";
    k.querySelector('h3').textContent = a.name;
    k.querySelector('.meta-2').textContent = a.task || '—';
    g('closeButton').onclick = closeDetail;
    k.scrollTop = 0;
    detailInstalled = file;
  }

  /* NO STEP OR TOOL COUNT IS WRITTEN FOR A WORKER RUN: rather than write something wrong when we
     genuinely cannot know it, we write nothing. Seen in a real run: the `--print` output does not
     report tool calls, and the screen said "No tool calls" while the agent had read a file.
     An unknown number IS NOT SHOWN; it is written only for a native run that has a record file. */
  const workerShown = isWorkerRun(a);
  const tools = Object.entries(a.tools).sort((x, y) => y[1] - x[1])
                        .map(([name, n]) => name + ' ×' + n).join('  ·  ') || "No tool calls";
  setupText(k.querySelector('.meta'),
    [runModelText(a), runStatusWord(a.status, a.endSource),
     a.seconds === null ? '' : a.seconds + " s",
     workerShown ? '' : a.step + " steps", workerShown ? '' : tools].filter(Boolean).join('  ·  '));
  setupText(k.querySelector('.token'), tokenLine(a.tokens));

  const h = g('targets');
  // The target list is hidden for a worker run for the same reason: even a dash would mean none.
  h.hidden = workerShown;
  h.previousElementSibling.hidden = workerShown;
  const signature = a.targets.map((x) => x.tool + '|' + x.target).join(String.fromCharCode(10));
  if (h.dataset.signature !== signature) {
    h.dataset.signature = signature;
    h.textContent = a.targets.length ? '' : '—';
    for (const x of a.targets) {
      const d = document.createElement('div');
      d.className = 'target';
      const b1 = document.createElement('b'); b1.textContent = x.tool;
      d.appendChild(b1); d.appendChild(document.createTextNode('  ' + x.target));
      h.appendChild(d);
    }
  }

  setupText(g('resultText'), a.result
    || (a.status === 'done' ? "(No text result)" : "(Waiting for a result)"));
  renderAgentHistory(a);
  g('overlay').style.display = 'block';
}

/**
 * THE EARLIER RUNS OF THIS AGENT - being able to see the past work of the agent you have open is
 * useful, while the project-wide history window stays as it is. Here ONLY the runs of the open agent
 * are listed.
 *
 * The source is `projectRuns`: the runs across every session of the project, not only this session.
 * The open run itself drops off the list - it is already shown in full above.
 */
function renderAgentHistory(a) {
  const box = g('agentHistory');
  const title = g('historyTitle');
  if (!box || !title) return;
  const earlier = projectRuns
    .filter((x) => x.name === a.name && x.file !== a.file)
    .sort((x, y) => String(y.startedAt || '').localeCompare(String(x.startedAt || '')));
  const signature = earlier.map((x) => x.file + x.status).join('|');
  if (box.dataset.signature === signature) return;
  box.dataset.signature = signature;
  box.textContent = '';
  title.hidden = earlier.length === 0;
  if (!earlier.length) return;
  for (const x of earlier) {
    const d = document.createElement('div');
    d.className = 'target';
    d.style.cursor = 'pointer';
    const b1 = document.createElement('b');
    b1.textContent = runStatusWord(x.status, x.endSource);
    d.appendChild(b1);
    /* IF THE TIME IS UNKNOWN IT IS NOT WRITTEN. Older records may have no start time; rather than
       invent an empty date, only the task text is shown. */
    const parts = [];
    if (x.startedAt) parts.push(dateAndTime(new Date(x.startedAt)));
    if (x.model || (x.observedModels || []).length) parts.push(runModelText(x));
    parts.push(x.task || "(No task description)");
    d.appendChild(document.createTextNode('  ' + parts.join('  ·  ')));
    d.title = "Open this run";
    d.onclick = () => { openAgent = x.file; detailInstalled = null; renderDetail(x.file, 'project'); };
    box.appendChild(d);
  }
}

function closeDetail() {
  openAgent = null; detailInstalled = null; historyOpen = false; historySignature = ''; formOpen = false;
  skillOpen = null;
  g('overlay').style.display = 'none';
}
/* Escape and a click outside close the dialog the same way its Close button does. On the sign-in screen
   that means cancelling the sign-in: a dismissed screen used to leave a sign-in running with no screen. */
/* TYPED TEXT IS NOT THROWN AWAY BY A STRAY KEY. Escape or a click beside a form used to close it and
   lose what was typed. The first edit marks the form that is on screen; dismissing that same form asks
   first. A form drawn later (its first element is new) starts clean. */
let detailDirtyFor = null;
g('detail').addEventListener('input', () => { detailDirtyFor = g('detail').firstElementChild; });
async function dismissDetail() {
  if (detailDirtyFor && detailDirtyFor === g('detail').firstElementChild && detailDirtyFor.isConnected
      && !await confirm("Discard your unsaved changes?")) return;
  detailDirtyFor = null;
  if (signInPending && signInPending.status && signInPending.status.isConnected) {
    const id = signInPending.id;
    signInPending = null;
    window.panel.cancelSignIn(id).catch(() => null);
  }
  closeDetail();
}
g('overlay').addEventListener('mousedown', (e) => { if (e.target.id === 'overlay') dismissDetail(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && g('overlay').style.display === 'block') {
    e.preventDefault(); e.stopPropagation(); dismissDetail();
  }
});

/* THE NOTICE FROM THE WATCHER. The panel now sees a change made from outside without waiting for it:
   when an orchestrator changes the account or model of an agent, when an agent is added or deleted,
   when a skill folder changes -- and when an account is deleted from the registry, because that too
   changes how agents resolve.
   POLLING WAS NOT REMOVED: `fs.watch` is not reliable in every environment (a network drive, the
   write-and-replace pattern of some editors). If an event is missed the panel shows things LATE, not
   WRONG. */
/* THE PAGE DOES NOT DIE WITHOUT THE BRIDGE. `preload.js` and `panel.js` load together, but if the
   panel stayed open from an older build (or if the bridge is renamed one day) an error thrown here
   would kill EVERYTHING AFTER THIS LINE -- including the polling timers. The panel would then look as
   if it never updated, with the reason written nowhere on screen. */
if (typeof window.panel.onChange === 'function') {
  window.panel.onChange(({ label, publish }) => {
    if (label === 'skill') { refreshSkills().then(checkSkillConflict); return; }
    refreshDefinitions();
    checkFormConflict();
    /* A DELETION FINISHING IN THE BACKGROUND DOES NOT STAY SILENT. This callback was
       receiving the publish result and not using it, while the panel may just have removed a file
       from disk. */
    const s = watchDeletionResult(publish);
    if (s) writeStatus(s.text, s.bottom);
  });
} else {
  console.warn("Live file watching is unavailable. Lists refresh by polling; restart Benchook to reconnect.");
}

refreshDefinitions();
setInterval(refreshDefinitions, 10000);   // defined agents: reads the folder (the fallback for the watcher)
setInterval(refreshContext, 3000);   // context: reads a file
/* `refreshAccount` and `refreshQuota` were removed together with the fixed "Claude / Codex" rows they
   fed. Those rows read the DEFAULT installations of the machine rather than the registry; the e-mail
   and the quota are already shown per account on the account rows (`drawRegistry` plus
   `refreshRegistryStatus`). */
setInterval(refreshAgent, 1200);     // agent cards: reads files; measured cost about 0.5 ms
setInterval(refreshDuration, 1000);     // counters: read nothing

/* ---------------- layout ---------------- */
/* The layout has TWO layers: the window and the known projects are global, the rest belongs to a
   PROJECT - the last state of each project has to be kept per project. */
let projectChanging = false;

function layoutData() {
  if (!project) return { projects: projects, theme };
  if (activePage) sumPageStatus(activePage);
  const digest = (sy) => {
    const b = (sy.panes || [])[0];
    return {
      id: sy.id, name: sy.name,
      orchestrator: b ? { provider: b.provider, sessionId: b.sessionId || null, label: b.label,
        accountId: b.accountId || null, model: b.model || null, connection: b.connection || null } : (sy.savedSession || null),
      split: sy.shareRatio, terminalOnly: !!sy.terminalOnly, layout: sy.layout || 'stacked',
      terminalHidden: !!sy.terminalHidden, layoutReversed: !!sy.layoutReversed,
    };
  };
  const allProjectStatus = {};
  for (const [filePath, field] of projectFields) {
    if (filePath === FIELDLESS || filePath === project) continue;
    if (!field.pages.length) continue;
    allProjectStatus[filePath] = {
      pages: field.pages.map(digest),
      activePage: field.activePage?.id || null,
      sidebarTab: field.sidebarTab || 'agents',
    };
  }
  return {
    project: project,
    projects: projects,
    theme,
    handoverFile,
    textSize,
    allProjectStatus,
    projectState: {
      sidebarTab: sidebarTab,
      pages: pages.map(digest),
      activePage: activePage ? activePage.id : null,
    },
  };
}

function saveLayout() {
  // The empty state of terminals closing during a switch must not overwrite the project snapshot just taken.
  if (projectChanging) return;
  /* A FAILED SAVE IS SAID. Errors (a full disk, a locked file) used to be dropped, and tabs and sessions
     were silently not restored. One status line per distinct error, until a save succeeds again. */
  window.panel.writeLayoutAndWait(layoutData()).then((r) => {
    if (r && r.error) {
      if (layoutSaveError !== r.error) writeStatus("Could not save the layout. Tabs and sessions may not be restored.", r.error);
      layoutSaveError = r.error;
    } else layoutSaveError = null;
  }).catch(() => null);
}
let layoutSaveError = null;

async function waitLayoutSaveAnd() {
  const r = await window.panel.writeLayoutAndWait(layoutData());
  if (r && r.error) throw new Error("Could not save layout: " + r.error);
}


/* SWITCHING PROJECT. The open terminal is closed (waiting until the process really dies), the record
   of the new project is loaded, and its orchestrator, if any, reopens where it left off. */
async function changeProject(filePath) {
  return changeWorkspace(() => changeProjectOwned(filePath));
}
async function changeProjectOwned(filePath) {
  mark("Switch project");
  try { await projectChangeInner(filePath); }
  catch (e) { showError("Could not switch project", e); }
}

/* The cost of a switch is measured: how many terminals were KILLED, how many were rebuilt with
   `--resume`, and how long it took. The complaint that it looks like everything is being built from
   scratch is not a visual flicker; these numbers make it plain. The acceptance criterion: killed = 0.

   THE MEASURED TIME splits in three, because a single setup figure was misleading: `start(b)` inside
   `createPane` returns WITHOUT being awaited, and main.js writes the command 400 ms later. So when
   the DOM has finished being built there is still nothing on screen. That is why the first-output
   figure exists: from the beginning of the switch until EVERY rebuilt terminal has produced its first
   output. If a fix removes the teardown, no terminal is rebuilt and this number becomes 0; if it does
   not, it stays large. It draws both directions. */

/** Will `buildPagesInner` really build a terminal? The two places must use THE SAME judgement; written
    separately, the number lies. */
function orchInstallable(orch) {
  return !!(orch && orch.provider && orch.accountId && orch.model);
}

/** Counts, from the record, the orchestrators that will really be built - the same judgement as `canBuildOrchestrator`. */
function orchestratorsToSetup(dr) {
  const record = (dr && Array.isArray(dr.pages) && dr.pages.length)
    ? dr.pages : [{ orchestrator: dr && dr.orchestrator }];
  const orchestrators = record.map((k) => k && k.orchestrator).filter(orchInstallable);
  return { requested: orchestrators.length, resumed: orchestrators.filter((o) => o.sessionId).length };
}

/** The panes that have produced NO OUTPUT AT ALL since the switch - that is, the ones that were
    rebuilt. Once a fix removes the teardown, the surviving terminal already has its first output, and
    counting it as new would make the duration negative. If this list is empty the switch built nothing. */
function reInstalled() {
  const created = [];
  for (const sy of pages) {
    for (const b of (sy === activePage ? panes : sy.panes || [])) {
      if (b && b.firstOutput == null) created.push(b);
    }
  }
  return created;
}

/* The measurement record DOES NOT HOLD UP the switch: it is written once the new terminals produce
   their first output. It waits at most 15 seconds; what does not arrive is not invented, it is counted
   as a missing first output. */
function writeSwitchMetric(base, additions, t0) {
  const limit = performance.now() + 15000;
  const look = () => {
    const incoming = additions.filter((b) => b.firstOutput != null);
    if (incoming.length < additions.length && performance.now() < limit) { setTimeout(look, 50); return; }
    const mostLast = incoming.length ? Math.max(...incoming.map((b) => b.firstOutput)) : t0;
    window.panel.recordSwitchMetric(Object.assign({}, base, {
      msFirstOutput: Math.round(mostLast - t0),
      firstOutputMissing: additions.length - incoming.length,
    }));
  };
  look();
}

/* ---------------- project fields ----------------
   Every PROJECT lives in its own field inside `#right`. Leaving a project does not tear that field
   down, it hides it: the pages, the panes and the RUNNING TERMINALS stay in place and the work
   continues in the background. Coming back is a matter of flipping `hidden` - the same thing a page
   switch (`goToPage`) already does.

   `pages` / `activePage` / `pageCounter` always belong to the ACTIVE project; they are written into
   the record of a field when it is put to sleep and read back when it wakes. That is why the dozens
   of places using those three did not have to change.
   The table itself and its empty-project key are declared with the other top-level state near
   the start of this file. */

function projectField(filePath) {
  const key = filePath || FIELDLESS;
  let field = projectFields.get(key);
  if (field) return field;
  const root = document.createElement('div');
  root.className = 'project-area';
  g('rightPane').appendChild(root);
  field = { root, pages: [], activePage: null, pageCounter: 0 };
  projectFields.set(key, field);
  return field;
}

/** Hides the field of the active project and writes its state into that field. Nothing is closed. */
function sleepField() {
  const key = project || FIELDLESS;
  const field = projectFields.get(key);
  if (!field) return;
  if (activePage) sumPageStatus(activePage);
  field.pages = pages;
  field.activePage = activePage;
  field.pageCounter = pageCounter;
  field.sidebarTab = sidebarTab;
  // An empty field opened before a project was selected is not worth keeping; but if something is running in it,
  // it is left alone.
  const running = pages.some((sy) => (sy.panes || []).some((b) => b && b.id));
  if (key === FIELDLESS && !running) {
    field.root.remove();
    projectFields.delete(key);
    return;
  }
  field.root.hidden = true;
}

/** Brings the field back if this project was entered before. Returns `false` if it was never built. */
async function wakeField() {
  const field = projectFields.get(project || FIELDLESS);
  if (!field || !field.pages.length) return false;
  pages = field.pages;
  pageCounter = field.pageCounter;
  field.root.hidden = false;
  const target = field.activePage || pages[0];
  // `goToPage` returns early when the active page is the same; because the field changed it has to be reset.
  activePage = null;
  await goToPage(target.id, true);   // applies the layout and measures what could not be measured while hidden
  return true;
}

/** The terminal ids that are really alive at that moment - the measurement works from this. */
function liveTerminals() {
  return new Set(idMap.keys());
}

/* THE SAME FOLDER IS NEVER LISTED TWICE - seen in a real window: one project had become two rows,
   one with forward slashes and one with backslashes (a test rig mixed the separators; a user can
   reach the same state through drag-and-drop or an older layout file). A path enters the list and the
   layout in one form: backslashes on Windows, no trailing separator; the comparison is
   case-insensitive. The displayed name does not change. */
function projectPathNormalize(filePath) {
  let y = String(filePath || '').trim();
  if (!y) return y;
  if (navigator.platform.startsWith('Win')) y = y.replace(/\//g, '\\').replace(/\\+/g, '\\');
  return y.length > 3 ? y.replace(/[\\/]+$/, '') : y;
}
const sameProject = (a, b) => projectPathNormalize(a).toLowerCase() === projectPathNormalize(b).toLowerCase();

async function projectChangeInner(filePath) {
  filePath = projectPathNormalize(filePath);
  if (!filePath || (project && sameProject(filePath, project))) return;
  const source = project;
  const previousLive = liveTerminals();
  // The last full state of the old project is not moved until it has been written to disk.
  await waitLayoutSaveAnd();
  projectChanging = true;
  const t0 = performance.now();
  let tTeardown = t0;
  let targetStatus = null;
  try {
  // THE OLD PROJECT IS NOT KILLED, IT IS HIDDEN. Its field, its pages and its running terminals stay
  // in memory and the work continues in the background: switching windows must not stop the work
  // being done in the one you left.
  sleepField();
  tTeardown = performance.now();
  project = filePath;
  if (!projects.some((x) => sameProject(x, filePath))) projects.push(filePath);
  const registered = await window.panel.readLayout();
  const dr = (registered && registered.projectState && registered.projectState[filePath]) || null;
  targetStatus = dr;
  if (dr && dr.sidebarTab) selectTab(dr.sidebarTab);
  showProject();
  renderProjectList();
  refreshDefinitions();
  refreshRegistry();
  // If this project was entered before, its field is ALREADY built and running: it is only woken.
  if (!(await wakeField())) await setupPages(dr);
  } finally {
    projectChanging = false;
    const orch = orchestratorsToSetup(targetStatus);
    // The number is not written by hand to claim there was no teardown: what is counted is terminals
    // that were alive before the switch and are not afterwards. If some path still kills them, this
    // number will not come out zero.
    const closed = [...previousLive].filter((id) => !idMap.has(id)).length;
    writeSwitchMetric({
      time: new Date().toISOString(), source: source || '(none)', target: filePath,
      closed, requested: orch.requested, resumed: orch.resumed,
      msTeardown: Math.round(tTeardown - t0), msSetup: Math.round(performance.now() - tTeardown),
    }, reInstalled(), t0);
  }
  saveLayout();
}

/* The project list: quick switching. The panel DISCOVERS no projects; only the ones you opened are here. */
function renderProjectList() {
  const container = g('projectList');
  if (!container) return;
  container.textContent = '';
  for (const filePath of projects) {
    const name = folderName(filePath);
    const r = document.createElement('div');
    r.className = 'project-row' + (filePath === project ? ' selected' : '');
    const nk = document.createElement('span');
    nk.className = 'status-dot';
    nk.style.background = waitingProjects.has(filePath) ? 'var(--yellow)' : filePath === project ? 'var(--accent)' : '#33322f';
    const t = document.createElement('span');
    t.className = 'padded';
    // Two projects with the same folder name (C:\a\app, D:\b\app) are told apart by their parent folder.
    const twin = projects.some((x) => x !== filePath && folderName(x) === name);
    t.textContent = (twin ? name + ' — ' + folderName(String(filePath).replace(/[\\/][^\\/]+[\\/]*$/, '')) : name)
      + (waitingProjects.has(filePath) ? ' ?' : '');
    r.appendChild(nk); r.appendChild(t);
    r.title = filePath + "\n\nClick to open.";
    if (filePath !== project) r.onclick = () => changeProject(filePath);

    // REMOVE FROM THE LIST. Picking the wrong folder used to be unfixable: the path could not be
    // changed and there was no way to remove a project. THE FOLDER IS NOT TOUCHED.
    const remove = document.createElement('span');
    remove.className = 'remove';
    remove.textContent = '×';
    remove.title = "Remove from the project list (preserves files)";
    remove.onclick = (o) => { o.stopPropagation(); forgetProject(filePath); };
    r.appendChild(remove);
    container.appendChild(r);
  }
}

/** Removes the project from the memory of the panel. The folder on disk and the agent definitions STAY IN PLACE. */
async function forgetProject(filePath) {
  return changeWorkspace(() => forgetProjectOwned(filePath));
}
async function forgetProjectOwned(filePath) {
  const isOpen = filePath === project;
  const running = isOpen
    ? allLivePanes(filePath).length
    : ((projectFields.get(filePath) || { pages: [] }).pages || [])
        .reduce((n, sy) => n + (sy.panes || []).filter((b) => b && b.id).length, 0);
  const warning = folderName(filePath) + " — remove from the project list?\n\n"
    + filePath + "\n\nThe project folder and agent definitions are preserved. Only the saved path and "
    + "layout are removed from Benchook."
    + (running ? "\n\nRunning terminals that will be closed: " + running + "." : '');
  if (!await confirm(warning)) return;

  /* THE DURABLE SAVE FIRST, THEN THE CLOSE - a code review found this path: the terminals and the
     field used to be closed BEFORE the result of the save. If the save failed, the screen said
     "Could not remove" while the workspace was already gone and the project was still in the list.
     Now, if the save fails nothing changes: the terminals stay open and the field stays in place. */
  const r = await window.panel.forgetProject(filePath);
  if (r && r.error) { writeStatus("Could not remove project from the list.", r.error); return; }
  projects = (r && r.projects) || projects.filter((x) => x !== filePath);

  // Close the field and the running terminals: the window of a forgotten project must not linger behind.
  const field = projectFields.get(filePath);
  if (field) {
    /* For the OPEN project the live pages are the global `pages`; `field.pages` is filled only when
       the project is left. Closing only `field.pages` left the open project's terminals running
       with no window, although the warning had counted them. */
    const fieldPages = (field.pages && field.pages.length) ? field.pages : (isOpen ? pages : []);
    for (const sy of [...fieldPages]) {
      for (const b of (sy === activePage ? [...panes] : [...(sy.panes || [])])) {
        if (b.id) window.panel.closeTerminal(b.id);
        closePane(b, true);
      }
    }
    field.root.remove();
    projectFields.delete(filePath);
  }

  if (isOpen) {
    // The open project was removed: it switches to the first one remaining, or returns to the
    // no-project-selected state if none is left. The panel NEVER selects a folder on its own.
    project = null;
    const target = projects[0] || null;
    if (target) { await changeProjectOwned(target); }
    else {
      pages = []; activePage = null;
      await setupPages(null);
      showProject(); renderProjectList(); refreshDefinitions();
      writeEmptyGive();
    }
  } else {
    renderProjectList();
    refreshExternalAgent();
  }
  saveLayout();
}

/** The panes of a project that are alive at that moment (for the active project the live array is used). */
function allLivePanes(filePath) {
  const field = projectFields.get(filePath);
  if (!field) return [];
  const list = [];
  for (const sy of (field.pages.length ? field.pages : pages)) {
    for (const b of (sy === activePage ? panes : sy.panes || [])) {
      if (b && b.id) list.push(b);
    }
  }
  return list;
}

/* Ask which terminal to change when a saved layout contains multiple terminals. */
function askOrchestrator(candidates) {
  const empty = sg('space'); if (empty) empty.remove();
  const k = document.createElement('div');
  k.className = 'picker'; k.dataset.role = 'picker-close';
  const b1 = document.createElement('h3'); b1.textContent = "Which session should this tab restore?";
  const p1 = document.createElement('p');
  p1.textContent = "Saved terminals: " + candidates.length + ". Select one for this tab.";
  p1.title = "Each tab supports one orchestrator. "
    + "Other conversation logs will be preserved. "
    + "Use + to restore another session in a new tab.";
  k.appendChild(b1); k.appendChild(p1);
  for (const a of candidates) {
    const d = document.createElement('button');
    d.textContent = (a.label || a.provider) + (a.sessionId ? " · Resumed session" : " · New session");
    d.onclick = () => {
      k.remove();
      selectOldOrchestrator(a);
    };
    k.appendChild(d);
  }
  const y = document.createElement('button');
  y.textContent = "Start a new session instead";
  y.onclick = () => {
    k.remove();
    writeEmptyGive("Start an orchestrator from the sidebar.");
  };
  k.appendChild(y);
  sg('topRight').appendChild(k);
}

function selectOldOrchestrator(orch) {
  activePage.savedSession = orch;
  writeEmptyGive();
  const select = g('orchestratorAccount');
  const known = orch.accountId && registry.some((h) => h.id === orch.accountId && h.provider === orch.provider);
  select.value = known ? orch.accountId : '';
  // Setting .value from code fires no event: the dropdown and the model list are told explicitly.
  select.dispatchEvent(new Event('change'));
  refreshButtons();
}

/* ---------------- choosing the orchestrator ---------------- */
g('orchestratorAccount').onchange = () => { refreshOrchModel(); refreshMcpStatus(); };
// The two boxes of the orchestrator use the own dropdown of the panel; the real select stays in the
// DOM and is only invisible on screen.
setupDropdownList(g('orchestratorAccount'));
setupDropdownList(g('orchestratorModel'));
g('orchestratorSwitch').onclick = async () => {
  if (workspaceBlocked()) return;
  const b = panes[0];
  if (!b) return;
  orchChangeMode = !orchChangeMode;
  renderAccountMenu();   // the list as it is now; on cancel this puts the running account back
  if (orchChangeMode) {
    g('orchestratorAccount').value = b.accountId || '';
    g('orchestratorAccount').dispatchEvent(new Event('change'));
    await refreshOrchModel();
    if ([...g('orchestratorModel').options].some((o) => o.value === b.model)) g('orchestratorModel').value = b.model;
    writeStatus("Select an account and model.",
      "Review the session transfer before applying this change.");
  }
  refreshButtons();
  await refreshMcpStatus();
};

g('orchestratorStart').onclick = () => changeWorkspace(async () => {
  const h = registry.find((x) => x.id === g('orchestratorAccount').value);
  const model = g('orchestratorModel').value;
  const reason = !registry.length ? "Add an account first: Accounts → Add account."
    : !g('orchestratorAccount').value ? "Select an account first."
    : !h ? "The selected account is unavailable. Refresh the account list and try again."
    : !accountSignIn(h) ? h.name + " is signed out. Sign in from Accounts."
    : !model ? "Select a model first."
    : null;
  if (reason) { writeStatus(reason, ''); return; }
  if (orchChangeMode) {
    const oldPane = panes[0];
    if (!oldPane) return;
    const sameProgram = oldPane.provider === h.provider;
    const sameAccount = oldPane.accountId === h.id;
    /* Changing providers starts a new conversation without transferring chat history or context. Display the handoff note freshness so the user can supply project context explicitly. */
    let description = sameProgram
      ? "The terminal will close and resume with the selected account and model. When switching accounts, the session log is copied to the destination profile."
      : "Switching providers starts a new, empty conversation.\n\n"
        + "Nothing from this session carries over: not the conversation, not the decisions, "
        + "not the work in progress. This terminal closes and its log stays where it is.\n\n"
        + "Carrying context across providers is your project's responsibility. The panel does "
        + "not write a handoff note for you.";

    // How current the handover note is IS SAID, not enforced. The panel does not block the switch and
    // does not touch the file; it shows the two timestamps and the decision is the user's.
    if (!sameProgram) {
      const d = await window.panel.handoverStatus(project, oldPane.provider, oldPane.sessionId, oldPane.accountId);
      if (d && d.lines) description += "\n\nHANDOFF NOTES:\n" + d.lines.join('\n');
    }
    if (!await confirm(description + "\n\nContinue?")) return;
    if (sameProgram && !sameAccount) {
      if (!oldPane.sessionId) {
        writeStatus("Session ID is not available yet.",
          "Send a message in the terminal first. Account transfer requires a saved session.");
        return;
      }
      const oldInfo = { provider: oldPane.provider, sessionId: oldPane.sessionId, label: oldPane.label,
        accountId: oldPane.accountId, model: oldPane.model, connection: oldPane.connection };
      // The process is closed first; no risk is left of copying a live file and missing its last lines.
      const stopped = await window.panel.closeTerminalAndWait(oldPane.id);
      if (!stopped?.done) { writeStatus('Could not switch account.', stopped?.error || 'Terminal shutdown failed.'); return; }
      closePane(oldPane, true);
      const copy = await window.panel.copySession(oldPane.provider, project, oldPane.sessionId,
        oldPane.accountId, h.id);
      if (!copy || copy.error) {
        await createPaneAndWait(oldInfo.provider, oldInfo.sessionId, oldInfo.label,
          oldInfo.accountId, oldInfo.model, oldInfo.connection);
        writeStatus("Account switch cancelled. The original session was reopened.",
          (copy && copy.error) || "Could not copy session log");
        return;
      }
      orchChangeMode = false;
      await createPaneAndWait(h.provider, oldInfo.sessionId, h.name + ' · ' + model, h.id, model, oldInfo.connection);
      return;
    }
    const resumeId = sameProgram ? oldPane.sessionId : null;
    const resumeConnection = sameProgram ? oldPane.connection : null;
    // The same session is reopened immediately with --resume. It waits for the old process to REALLY
    // close, otherwise two processes touch the same record file for a moment and the last lines can be
    // lost. This wait existed from the start on the account-change path but not on the model-change
    // path; found by reading the code and closed.
    if (oldPane.id) {
      const stopped = await window.panel.closeTerminalAndWait(oldPane.id);
      if (!stopped?.done) { writeStatus('Could not switch session.', stopped?.error || 'Terminal shutdown failed.'); return; }
    }
    closePane(oldPane, true);
    orchChangeMode = false;
    await createPaneAndWait(h.provider, resumeId, h.name + ' · ' + model, h.id, model, resumeConnection);
    return;
  }
  const saved = activePage && activePage.savedSession;
  if (saved && h.provider !== saved.provider
      && !await confirm("This tab has a saved " + saved.provider + " session. Starting with " + h.provider
        + " begins a new conversation, and the saved session is no longer offered here.\n\nContinue?")) return;
  const old = saved && h.provider === saved.provider ? saved : null;
  await createPaneAndWait(h.provider, old && old.sessionId || null,
    h.name + ' · ' + model, h.id, model);
});

/* DEFINED AGENTS -- which agents are in use in the project and which are not has to be visible.
   The definitions come from Claude Code's own `.claude/agents/` folder and from the
   single new source `.benchook/agents/`, while the usage comes from the session records. An agent may
   be defined and never called; or called while having no definition in this project (the built-ins:
   general-purpose, Explore,...). The two are shown separately. */
/* WATCHING FOR OUTSIDE CHANGES.
   The targets are set up per project and are not rebuilt while the project does not change (rebuilding
   on every refresh would mean opening and closing an operating-system watcher once a second).
   `watchedKey` is declared with the other top-level state near the start of this file. */
/* EVERY OPEN PROJECT IS WATCHED. Only the selected project used to be reported, and a real
   edit made in a background project never reached the panel. An open project is one opened in this
   session whose field (and running terminals, if any) are alive; forgetting a project deletes its
   field, so its watcher drops off at the next setup. */
function openProjects() {
  const list = [project];
  for (const filePath of projectFields.keys()) {
    if (filePath && filePath !== FIELDLESS && filePath !== project) list.push(filePath);
  }
  return list.filter(Boolean);
}
async function setupWatching() {
  const projects = openProjects();
  // The key covers both the selection and the open set: while the set does not change nothing is
  // rebuilt, or we would open and close an operating-system watcher on every refresh.
  const key = JSON.stringify([project, projects]);
  if (watchedKey === key) return;
  watchedKey = key;
  try { await window.panel.setupWatcher(project, projects); }
  catch { /* if the watching cannot be set up, polling continues */ }
}

async function refreshDefinitions() {
  setupWatching();
  if (!project) { definedAgents = []; setupText(g('agentDefinition'), ''); renderAgentList(); refreshExternalAgent(); return; }
  /* A reply for a project the user has already left is dropped: it used to fill the new project's list
     with the old project's agents until the next 10-second poll. A failed read keeps the list and says so. */
  const proj = project, request = refreshDefinitions.request = (refreshDefinitions.request || 0) + 1;
  let list;
  try { list = await window.panel.listAgents(proj); }
  catch (e) {
    if (request === refreshDefinitions.request && project === proj) setupText(g('agentDefinition'), "Could not read the agents of this project: " + errorText(e));
    return;
  }
  if (request !== refreshDefinitions.request || project !== proj) return;
  definedAgents = Array.isArray(list) ? list : [];
  const own = definedAgents.filter((a) => !a.undefinedDef);
  setupText(g('agentDefinition'), agentSummary(own));
  renderAgentList();
  refreshExternalAgent();
}

/* THE HEADING STATES THE COUNT ONLY. It used to add "· 8 never used"; in the room beside the two
   buttons that was cut to "8 age...", and whether an agent was used is on its card and in its form. */
function agentSummary(own) {
  return own.length ? countOf(own.length, "agent", "agents") : "No agents in this project";
}

/* ONE WAY TO WRITE A MOMENT, in the panel's language and not the computer's: the run list used the
   computer's language and showed "23.09.2026 18:59:12" beside "09/23, 06:59 PM" here. */
function dateAndTime(d) {
  return d.toLocaleString("en-US", { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function writeUsage(a) {
  if (!a.times) return "Never used";
  const g2 = a.last ? new Date(a.last) : null;
  return countOf(a.times, "run", "runs") + (g2 ? " · Last run " + dateAndTime(g2) : '');
}

/** Draws the list of defined agents into a container. Unused ones are not dimmed, they are stated PLAINLY. */
function definitionList(container) {
  const own = definedAgents.filter((a) => !a.undefinedDef);
  const builtin = definedAgents.filter((a) => a.undefinedDef && a.builtin);
  const ambiguous = definedAgents.filter((a) => a.undefinedDef && !a.builtin);

  // The description is NOT a row but the tooltip of the heading: the list stays short and whoever
  // wants the detail hovers over it.
  const showWithTitle = (title, list, description) => {
    if (!list.length) return;
    const t = document.createElement('div');
    t.className = 'history-title'; t.textContent = title;
    if (description) t.title = description;
    container.appendChild(t);
    for (const a of list) {
      const r = document.createElement('div');
      r.className = 'history-row'; r.style.cursor = a.undefinedDef ? 'default' : 'pointer';
      const s1 = document.createElement('span'); s1.className = 'history-name'; s1.textContent = a.name;
      const s2 = document.createElement('span'); s2.className = 'history-task';
      s2.textContent = a.description || "(No definition in this project)"; s2.title = a.description || '';
      const s3 = document.createElement('span'); s3.className = 'shadow';
      // Panel agents show their assigned account and model together.
      const c = a.resolution;
      /* The account BY NAME and the model in the spelling of the panel - whatever the panel writes is
         what should appear; a raw identity was seen on screen in a real run. */
      const accountRaw = c ? (c.asOrchestrator ? null : c.account) : a.account;
      const accountEntry = accountRaw ? accountRecord(accountRaw) : null;
      const accountText = (c && c.asOrchestrator) ? "Same as orchestrator" : ((accountEntry && accountEntry.name) || accountRaw);
      const modelRaw = c ? (c.asOrchestrator ? null : c.model) : a.model;
      const modelText = modelRaw ? (modelRaw === 'default' ? "Default" : modelName(modelRaw)) : null;
      const note = resolutionNote(a);
      // The reason is IN THE ROW ITSELF, NOT IN A TOOLTIP: a warning that needs hovering is a warning
      // nobody sees.
      s3.textContent = writeUsage(a) + (modelText ? '  \u00b7  ' + modelText : '')
                     + (accountText ? '  \u00b7  ' + accountText : '')
                     + (note ? '  \u00b7  ' + note : '');
      if (note) s3.title = note;
      if (!a.times || note) s3.style.color = 'var(--yellow)';
      r.appendChild(s1); r.appendChild(s2); r.appendChild(s3);
      if (!a.undefinedDef) { r.title = "Click to edit"; r.onclick = () => agentForm(a); }
      container.appendChild(r);
    }
  };

  showWithTitle("Project agents", own);
  showWithTitle("Built-in agents", builtin,
    "Built-in Claude Code agents with no project definition.");
  showWithTitle("Unknown origin", ambiguous,
    "The agent definition may have been removed or loaded externally. "
    + "Its origin is not available in the log.");
}

/* CREATING AN AGENT -- the central promise of the panel. The definition is written once into the
   `.benchook/agents/` folder; if the calling orchestrator is on the same account and provider it runs
   locally, otherwise it takes the MCP path. The panel SENDS nothing to the orchestrator. */
let formOpen = false;
let editingAgent = null;

/* THE ACCOUNT REGISTRY -- which account and which model each agent runs on is chosen here, and any
   number of accounts can be added.
   The registry lives in the data folder of the panel; every account carries its own identity folder,
   and accounts ARE NOT SWAPPED -- all of them stay signed in at once (measured: the header of
   panel/accounts.js). */
let registry = [];

let registryStatus = new Map();
let registryRequest = 0;
let registryWaiting = false;
function accountSignIn(h) {
  const status=registryStatus.get(h.id);
  return typeof status?.signedIn === 'boolean' ? status.signedIn : h.signedIn;
}


/** The e-mail a row is signed in as: the live reading first, then the one stored at sign-in. */
function accountEmail(h) {
  return String(((registryStatus.get(h.id) || {}).email) || h.email || '').trim().toLowerCase();
}

/** An earlier row of the same provider signed in as the same e-mail, or null. Rows made before the
    sign-in check refused duplicates can still exist; they are marked instead of looking like two accounts. */
function duplicateOf(h) {
  const e = accountEmail(h);
  if (!e || !accountSignIn(h)) return null;
  const i = registry.findIndex((x) => x.id === h.id);
  return registry.slice(0, i).find((x) => x.provider === h.provider && accountSignIn(x) && accountEmail(x) === e) || null;
}

/** How an account reads in a menu. Two rows must never read the same: a duplicate says so, and two
    rows that only share a name get their profile folder added. */
function accountOptionText(h) {
  let text = h.name + ' — ' + h.provider + (accountSignIn(h) ? '' : " (Signed out)");
  if (duplicateOf(h)) text += " (duplicate)";
  else if (registry.some((x) => x.id !== h.id && x.provider === h.provider && x.name === h.name)) {
    // Two addresses with the same name before the @ (john@a, john@b): the address tells them apart.
    text += ' (' + (accountEmail(h) || String(h.folderPath || '').split(/[\\/]/).filter(Boolean).pop()) + ')';
  }
  return text;
}

async function refreshRegistry(force = true) {
  if (!force && registryWaiting) return;
  const request = ++registryRequest;
  registryWaiting = true;
  let list;
  try { list = await window.panel.listAccounts(); }
  catch { if (request === registryRequest) registryWaiting = false; return; }
  if (request !== registryRequest) return;
  registry = list;
  registryStatus = new Map([...registryStatus].filter(([id]) => list.some(h => h.id === id)));
  // The identity and the quota are read separately: the list draws immediately and the numbers fill in as they arrive.
  window.panel.accountStatus().then((d) => {
    if (request !== registryRequest) return;
    registryStatus = new Map(d.map((x) => [x.id, x]));
    renderRegistry();
  }).catch(() => { /* Retain the previous observation when polling fails. */ })
    .finally(() => { if (request === registryRequest) registryWaiting = false; });
  renderRegistry();
}

function renderRegistry() {
  const container = g('accountStore');
  if (!container) return;
  /* THE FULL LABEL ON AN EMPTY PANEL, A PLUS ONCE THERE IS AN ACCOUNT: on a first run it says what to
     do; afterwards it takes no space. */
  const extra = g('accountAdd');
  if (extra) {
    extra.textContent = registry.length ? '+' : "Add account";
    extra.title = "Add a Claude or Codex account";
    extra.classList.toggle('plus', registry.length > 0);
  }
  container.textContent = '';
  for (const h of registry) {
    const d = registryStatus.get(h.id);
    // A row sharing the same folder IS NOT A SEPARATE ACCOUNT; this is stated plainly.
    const same = registry.filter((x) => x.provider === h.provider && x.folderPath === h.folderPath).length > 1;

    const r = document.createElement('div');
    r.className = 'account-row';

    const av = document.createElement('div');
    av.className = 'avatar ' + (h.provider === 'codex' ? 'codex' : 'claude');
    av.appendChild(providerIcon(h.provider));
    av.title = (h.provider === 'codex' ? 'Codex' : 'Claude') + " account";
    r.appendChild(av);

    const gv = document.createElement('div');
    gv.className = 'history-body';

    const localName = (e) => (e ? String(e).split('@')[0] : null);
    const label = (record, data) => {
      const local = localName(data && data.email);
      if (!local) return record.name;
      const conflicting = registry.some((x) => x.id !== record.id
        && x.provider === record.provider
        && localName((registryStatus.get(x.id) || {}).email) === local);
      // A duplicate row is marked DUPLICATE; "name · name" would only repeat itself.
      if (!conflicting) return local;
      return record.name !== local ? local + ' · ' + record.name : String(data.email);
    };

    const name = document.createElement('div');
    name.className = 'name';
    const b = document.createElement('b');
    b.textContent = label(h, d);
    b.title = (d && d.email) ? d.email : h.name;
    const iy = document.createElement('i');

    let warning = null;
    // The state in one word, chosen to agree both with the name of the action (Sign in) and with the
    // session wording used elsewhere.
    const twinOf = duplicateOf(h);
    if (!accountSignIn(h)) warning = "SIGNED OUT";
    else if (twinOf) {
      warning = "DUPLICATE";
      b.title = "Same " + (h.provider === 'codex' ? 'Codex' : 'Claude') + " account as \"" + twinOf.name
        + "\" (" + accountEmail(h) + "). Both rows use one quota. Remove one of them.";
    }
    else if (same) warning = "SHARED PROFILE";
    else if (d && !d.email && d.signedIn) warning = "Identity unavailable";
    else if (d && d.signedIn === null && d.error) { warning = "Status unavailable"; b.title = d.error; }
    else if (!d) warning = "Loading…";

    const percent = (d && d.short !== null && d.short !== undefined) ? d.short : null;
    // The provider can return a fraction (28.99999999999996 was seen): a whole number on screen.
    iy.textContent = warning || (percent === null ? '—' : Math.round(percent) + '%');
    if (!warning && d?.quotaWarning && percent !== null) iy.textContent = 'Last known: ' + Math.round(percent) + '%';
    if (warning) iy.style.color = 'var(--yellow)';
    else if (d && (d.long >= 90 || d.short >= 90)) iy.style.color = 'var(--red)';
    name.appendChild(b); name.appendChild(iy);
    gv.appendChild(name);

    if (d && d.quotaWarning) {
      const ku = document.createElement('div');
      ku.className = 'card-usage';
      ku.style.color = 'var(--yellow)';
      ku.textContent = 'Usage limit reached';
      ku.title = d.quotaWarning + ' Provider reported this at ' + d.quotaWarningTime;
      gv.appendChild(ku);
    }
    // If the quota could not be read THE REASON is written: leaving it blank reads as "there is room".
    if (percent === null && d && d.signedIn && d.quotaError) {
      const kh = document.createElement('div');
      kh.className = 'card-usage';
      kh.style.color = 'var(--yellow)';
      kh.textContent = "Usage limits unavailable";
      kh.title = d.quotaError;
      gv.appendChild(kh);
    }

    // The bar is drawn ONLY when there is a number. With no number, an empty bar would
    // suggest there is room left.
    if (percent !== null) {
      const cb = document.createElement('div');
      cb.className = 'checkbox';
      const filled = document.createElement('i');
      filled.style.width = Math.max(0, Math.min(100, percent)) + '%';
      filled.style.background = (d.long >= 90 || d.short >= 90) ? 'var(--red)'
                            : (percent >= 60 ? 'var(--yellow)' : 'var(--green)');
      cb.appendChild(filled);
      gv.appendChild(cb);
      const ip = ["Five-hour usage: " + d.short];
      if (d.long !== null && d.long !== undefined) ip.push("Weekly usage: " + d.long);
      if (writeReset(d.shortReset)) ip.push("Five-hour reset: " + writeReset(d.shortReset));
      if (writeReset(d.longReset)) ip.push("Weekly reset: " + writeReset(d.longReset));
      ip.push(h.provider === 'codex' && d.stale
        ? "Live Codex limits are unavailable. Showing the last recorded usage."
        : "Usage limits refresh from the provider, including when this account is idle.");
      if (d.stale) ip.push("LAST KNOWN VALUE" + (d.wasRead ? ' · ' + hourShort(d.wasRead) : ''));
      cb.title = ip.join('  ·  ');

      /* TWO LINES BECAME ONE. The accounts section took up too much of the screen without any of its
         information being expendable.
         Measured: each signed-in account row was 64 pixels and the whole registry 174 pixels (a fifth
         of the window). Most of that was two SEPARATE text lines.
         No number left the screen; they simply sit side by side. The colours stayed separate: if the
         weekly figure is stale or unknown, only that part turns amber and the reset time does not. */
      const ks = writeReset(d.shortReset);
      const known = d.long !== null && d.long !== undefined;
      const label = h.provider === 'codex' && d.stale
        ? (d.wasRead ? "Last run " + hourShort(d.wasRead) : "From last run")
        : (d.stale ? "Last known" + (d.wasRead ? ' ' + hourShort(d.wasRead) : '') : "Live");
      const us = writeReset(d.longReset);

      const line = document.createElement('div');
      line.className = 'card-usage quota-row';

      /* Distinguish a known reset time, a usage window that has not started, and unavailable information. A reported zero with no reset time can be a valid unused window. */
      const unused = d.short === 0 && !d.shortReset && !d.quotaError && !d.quotaWarning;
      const yen = document.createElement('span');
      yen.textContent = ks || (unused ? "Five-hour window inactive" : "Reset time unavailable");
      yen.title = ks
        ? "The usage bar shows this five-hour window. This is its reset time."
        : (unused
          ? "No active five-hour window was reported. "
            + "A reset time will appear when the provider reports one."
          : "The five-hour reset time is unavailable for this account.");
      if (!ks && !unused) yen.style.color = 'var(--yellow)';
      line.appendChild(yen);

      const hf = document.createElement('span');
      hf.textContent = known ? 'Weekly ' + Math.round(d.long) + '%' : "Weekly limit unavailable";
      if (!known || d.stale) hf.style.color = 'var(--yellow)';
      hf.title = (known
        ? (h.provider === 'codex' && d.stale
            ? "Weekly usage comes from this account's last Codex session. "
              + "It may be out of date."
            : "Weekly usage refreshes from the provider at most once per minute. "
              + "It updates even while the account is idle.")
        : "Weekly usage is unavailable for this account.")
        + '\nSource: ' + label
        + (us ? "\nWeekly reset: " + us : '');
      line.appendChild(hf);

      gv.appendChild(line);
    }

    // THE AGENTS USING THIS ACCOUNT: which accounts are in use as an agent account is worth seeing in
    // the accounts section. It comes from the `account` field of the agent definition; no guessing.
    /* THE COMMA-SEPARATED LIST OF AGENT NAMES WAS REMOVED: writing how many agents run on each
       account is unnecessary here. The agent list already sits on the Agents tab and repeating it
       took space. WHAT IS RUNNING RIGHT NOW stayed -- that is live and bears directly on the quota. */
    if (runningAccounts.has(h.id)) {
      const ku = document.createElement('div');
      ku.className = 'card-usage';
      const b2 = document.createElement('b');
      b2.textContent = "Running";
      ku.appendChild(b2);
      ku.title = "An agent is running on this account";
      gv.appendChild(ku);
    }

    r.appendChild(gv);

    // An account with no login can be fixed here: the panel opens the login screen in ITS OWN
    // terminal. The user types no path and pastes no command.
    /* ONE DECISION POINT.
       Two separate actions were tried first (sign out and remove), then both were explained in text
       with long descriptions. Both got confused; if the person who commissioned it could not tell the
       two apart, future users never would, and the second attempt read as more confusing still.
       The root cause was PRESENTING THE TWO SEPARATELY: the user wants to be done with an account, and
       which half of it is an internal distinction of the panel. There is one button now; whether the
       session is closed too is an option in that dialog. */
    if (!accountSignIn(h)) {
      const gd = document.createElement('span');
      gd.className = 'add';
      gd.textContent = '→';
      gd.title = "Sign in to this account in your browser.";
      gd.onclick = () => signInScreen(h);
      r.appendChild(gd);
    }

    /* AN ICON, NOT A WORD: a Remove label is unnecessary in the accounts section; an x or power icon
       saves space. What it does is written as a full sentence in the tooltip. */
    const x = document.createElement('span');
    x.className = 'remove';
    x.textContent = '×';
    x.title = accountSignIn(h)
      ? "Remove this account from Benchook, with an option to sign out."
      : "Remove this account from Benchook.";
    x.onclick = async () => {
      /* SHOW FIRST, THEN ASK: removing an account has to warn that the agents using it will fall back
         to the model of the orchestrator. It did not. The agents in the registry (across every
         project) are counted; the binding is not deleted, so when the account is added back the
         agents return to it. */
      const all = await window.panel.agentRegistry().catch(() => []);
      const linked = (all || []).filter((a) => a.account === h.id || a.account === h.name).map((a) => a.name);
      const question = h.name + " — remove from Benchook?"
        + (linked.length
          ? "\n\n" + countOf(linked.length, "agent uses", "agents use") + " this account:\n" + linked.map((n) => '  ' + n).join('\n')
            + "\n\nThey will run as Same as orchestrator until this account is added back; their link to it is kept."
          : "\n\nNo agent uses this account.");
      let signOutAlso = false;

      if (accountSignIn(h)) {
        /* The box is NOT TICKED BY DEFAULT: signing out is the side that is hard to undo (it needs a
           new login in the browser), and an account such as `claude-default` may be the everyday
           terminal session of the user. The panel does not choose the hard-to-undo option for them. */
        const c = await confirmWithOptions(question, "Also sign out of this account", false);
        if (!c.confirm) return;
        signOutAlso = c.selection;
      } else if (!await confirm(question)) { return; }

      if (signOutAlso) {
        x.textContent = '…';
        const c2 = await settle(window.panel.signOut(h.id));
        x.textContent = '×';
        /* IF THE SIGN-OUT FAILS THE ACCOUNT IS NOT REMOVED. Removed, it would vanish from the list
           while its session stayed open, leaving the user no screen to close it from -- exactly the
           silent loss this exists to prevent. */
        if (c2 && c2.error) {
          writeStatus('"' + h.name + "\" could not be signed out. The account was not removed.",
            (c2.error || '') + (c2.output ? '\n' + c2.output : ''));
          return;
        }
      }

      const r2 = await settle(window.panel.removeAccount(h.id));
      if (r2 && r2.error) { writeStatus("Could not remove account.", r2.error); return; }
      await refreshRegistry();
      await refreshDefinitions();
      writeStatus('"' + h.name + "\" removed from Benchook.", signOutAlso
        ? "Signed out. Adding this profile again will require sign-in."
        : !accountSignIn(h) ? "It was not signed in."
        : "This profile remains signed in: "
          + (h.folderPath || "(default provider profile)"));
    };
    r.appendChild(x);
    container.appendChild(r);
  }

  renderAccountMenu();
  // Every other screen that names an account follows the same refresh, so none keeps an old list or name.
  if (g('formAccount')) fillFormAccounts(g('formAccount'));
  syncAccountNames();
  refreshMcpStatus();
}

/* THE ACCOUNT BOX OF THE AGENT FORM: signed-in accounts plus the agent's current one (even signed
   out, so the box never slides to another account by itself). It is refilled on every registry
   refresh, so an account added or signed in while the form is open appears without reopening it.
   Names are set as text, never as HTML: an account name comes from an e-mail address. */
function fillFormAccounts(select) {
  const current = select.dataset.current || null;
  const keep = select.value;
  const wanted = [['', "Select account…", true], ['orchestrator', "Same as orchestrator", false],
    ...registry.filter((x) => accountSignIn(x) || x.id === current).map((h) => [h.id, accountOptionText(h), false])];
  // Rebuilt only when the list really changed: this runs on every 5-second refresh, and rebuilding an
  // open list would close it under the user's pointer.
  const same = select.options.length === wanted.length
    && wanted.every(([v, t], i) => select.options[i].value === v && select.options[i].textContent === t);
  if (same) return;
  select.textContent = '';
  for (const [value, text, disabled] of wanted) {
    const o = document.createElement('option');
    o.value = value; o.textContent = text; o.disabled = !!disabled;
    select.appendChild(o);
  }
  if ([...select.options].some((o) => o.value === keep && !o.disabled)) select.value = keep;
  else {
    select.value = '';
    // The chosen account is gone (removed while the form was open): the form re-reads its own state.
    if (keep) select.dispatchEvent(new Event('change'));
  }
}

/* AN ACCOUNT NAME CAN CHANGE AFTER A PANE OPENED: the first sign-in names the account from its
   e-mail. Pane titles were written once from the name at start, and agent cards were drawn before
   the rename, so both kept the old name. Titles keep their model part; only the account part follows. */
let shownAccountNames = '';
function syncAccountNames() {
  for (const sy of (typeof pages !== 'undefined' ? pages : [])) {
    const list = sy === activePage ? panes : (sy.panes || []);
    for (const b of list) {
      const h = b && b.accountId ? registry.find((x) => x.id === b.accountId) : null;
      if (!h || !b.label || !b.label.includes(' · ')) continue;
      const label = h.name + b.label.slice(b.label.indexOf(' · '));
      if (label === b.label) continue;
      b.label = label;
      if (b.name) b.name.textContent = paneLabel(b.label, b.resumeDid);
    }
  }
  const names = registry.map((h) => h.id + '=' + h.name).join('\n');
  if (names !== shownAccountNames) {
    const first = !shownAccountNames;
    shownAccountNames = names;
    if (!first && typeof renderAgentList === 'function') renderAgentList();
  }
}

/* THE ORCHESTRATOR ACCOUNT MENU is rebuilt on EVERY registry refresh, open orchestrator or not.
   It used to be rebuilt only while no orchestrator was open, so an account added during a session
   was missing from "Switch account or model" until an empty panel happened to trigger a refresh.
   What must not slide is the SELECTION, not the list: the running account stays selected, and in
   switch mode the user's own pick is kept. */
function renderAccountMenu() {
  const select = g('orchestratorAccount');
  if (!select) return;
  const running = panes[0]?.accountId || null;
  const before = select.value;   // read before any rebuild, which resets the value
  const keep = panes.length && !orchChangeMode ? running : before;
  const options = [{ value: '', text: "Select account…" }];
  for (const h of registry) {
    options.push({ value: h.id, text: accountOptionText(h) });
  }
  // A running orchestrator whose account was removed keeps a visible row instead of a blank box.
  if (running && !registry.some((h) => h.id === running)) {
    options.push({ value: running, text: (panes[0].label || running) + " (removed from Benchook)" });
  }
  const same = select.options.length === options.length
    && options.every((x, i) => select.options[i].value === x.value && select.options[i].textContent === x.text);
  if (!same) {
    select.textContent = '';
    for (const x of options) {
      const o = document.createElement('option');
      o.value = x.value; o.textContent = x.text;
      select.appendChild(o);
    }
  }
  select.value = options.some((x) => x.value === keep) ? keep : '';
  // A value set from code fires no event: the dropdown's button and the model list are told explicitly.
  if (select.value !== before) select.dispatchEvent(new Event('change'));
}

/* ---------------- OUR OWN DROPDOWN ----------------
 *
 * The account pickers under the orchestrator looked boxy when opened; they should look like the
 * search list elsewhere in the program.
 *
 * WHY CSS WAS NOT ENOUGH: when a `<select>` opens, the operating system draws the list. The CSS of the
 * page cannot reach that window - an `option` can only be given a colour, not corners, shadow or
 * spacing. The first attempt fixed the CLOSED state of the box while the open list stayed as it was.
 *
 * HOW: the `<select>` STAYS in the DOM and is still the single real source - every call site reading
 * `.value`, `.options` or `.onchange` works as it did. It is invisible on screen; in its place the
 * panel draws a button and a list styled like `#searchResult`. On a selection the value of the real
 * `select` changes and a `change` event is dispatched, so the logic does not change at all.
 *
 * THE OPTIONS CHANGE FROM OUTSIDE (when an account is added, when a model list arrives). A
 * `MutationObserver` watches for that; when code clears and refills the select, the button refreshes
 * on its own. No separate also-update-this call is needed, so there is no place to forget.
 *
 * KEYBOARD: Enter, space or down opens, Escape closes, the arrow keys move, Enter selects. Focus stays
 * on the button, so the tab order is not disturbed.
 */
function setupDropdownList(select) {
  if (!select || select.dataset.pickerReady === '1') return;
  select.dataset.pickerReady = '1';

  const container = document.createElement('div');
  container.className = 'picker-close';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'picker-button';
  const textEl = document.createElement('span');
  textEl.className = 'picker-text';
  const ok = document.createElement('span');
  ok.className = 'picker-arrow';
  ok.textContent = '⌄';
  button.appendChild(textEl); button.appendChild(ok);
  container.appendChild(button);

  /* THE OWN SPACING OF THE SELECT MOVES TO THE WRAPPER. Measured from a screenshot: the two boxes were
     stuck together. The reason: the `margin-top` that spaced the model box sat in the inline style of
     the select itself, and since the select is no longer visible that spacing was not visible either.
     The value is read and moved to the wrapper -- the number is NOT invented here, the own value of
     the element is used. */
  const space = window.getComputedStyle(select);
  container.style.marginTop = space.marginTop;
  container.style.marginBottom = space.marginBottom;

  select.parentNode.insertBefore(container, select);
  container.appendChild(select);
  select.classList.add('hidden-select');
  select.style.margin = '0';

  let list = null;
  const close = () => {
    if (!list) return;
    list.remove(); list = null;
    button.classList.remove('expanded');
    document.removeEventListener('mousedown', clickExternal, true);
    window.removeEventListener('resize', close);
  };
  const clickExternal = (o) => { if (!container.contains(o.target)) close(); };

  const refresh = () => {
    const o = select.options[select.selectedIndex];
    textEl.textContent = o ? o.textContent : '';
    button.disabled = select.disabled;
    // While an orchestrator is open the boxes are HIDDEN (`refreshButtons`); the wrapper must hide too,
    // otherwise the real select would be hidden while its button stayed on screen.
    container.hidden = select.hidden;
    if (select.hidden) close();
    button.title = select.title || (o ? o.textContent : '');
    if (list) { close(); open(); }
  };

  const open = () => {
    if (select.disabled || !select.options.length) return;
    list = document.createElement('div');
    list.className = 'picker-list';
    [...select.options].forEach((o, i) => {
      const r = document.createElement('div');
      r.className = 'picker-row' + (i === select.selectedIndex ? ' selected' : '');
      r.textContent = o.textContent;
      r.title = o.textContent;
      r.onmousedown = (e) => {
        e.preventDefault();
        if (select.selectedIndex !== i) {
          select.selectedIndex = i;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        close(); refresh(); button.focus();
      };
      list.appendChild(r);
    });
    container.appendChild(list);
    button.classList.add('expanded');
    const s = list.querySelector('.selected');
    if (s) s.scrollIntoView({ block: 'nearest' });
    document.addEventListener('mousedown', clickExternal, true);
    window.addEventListener('resize', close);
  };

  button.onclick = () => { if (list) close(); else open(); };
  button.onkeydown = (o) => {
    if (o.key === 'Escape') { close(); return; }
    if (o.key === 'Enter' || o.key === ' ' || o.key === 'ArrowDown' || o.key === 'ArrowUp') {
      o.preventDefault();
      if (!list) { open(); return; }
      if (o.key === 'Enter') { close(); return; }
      // Arrow key: move the selection of the real select, dispatch the event, redraw the list.
      const direction = o.key === 'ArrowDown' ? 1 : -1;
      const created = Math.max(0, Math.min(select.options.length - 1, select.selectedIndex + direction));
      if (created !== select.selectedIndex) {
        select.selectedIndex = created;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      refresh();
    }
  };

  // When the options or the selected value change from outside, the button refreshes by itself.
  new MutationObserver(refresh).observe(select, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['disabled', 'title', 'value', 'hidden'],
  });
  select.addEventListener('change', refresh);
  refresh();
}

let orchModelRequest = 0;
async function refreshOrchModel() {
  const request = ++orchModelRequest;
  const h = registry.find((x) => x.id === g('orchestratorAccount').value);
  const select = g('orchestratorModel'); select.textContent = '';
  const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; select.appendChild(o); };
  if (!h) { add('', "Select model…"); return; }
  // A model list that cannot be read leaves "Default" to choose instead of an empty box.
  if (h.provider === 'codex') {
    const m = await settle(window.panel.codexModels(h.folderPath));
    if (request !== orchModelRequest || g('orchestratorAccount').value !== h.id) return;
    add('default', "Default" + (m && m.defaults ? ' (' + modelName(m.defaults) + ')' : ''));
    for (const x of (m && Array.isArray(m.seen) ? m.seen : [])) add(x.name, modelName(x.label || x.name));
  } else {
    const [models, latest] = await Promise.all([settle(window.panel.claudeModels(h.folderPath)),
      settle(window.panel.claudeLatest(h.folderPath))]);
    if (request !== orchModelRequest || g('orchestratorAccount').value !== h.id) return;
    const list = Array.isArray(models) && models.length ? models : ['default'];
    for (const m of list) add(m, modelOptionText(m, latest));
  }
}

let mcpRefreshRequest = 0;
async function refreshMcpStatus() {
  const request = ++mcpRefreshRequest;
  const requestedProject = project, requestedPage = activePage;
  const id = orchChangeMode ? g('orchestratorAccount').value
    : (panes[0]?.accountId || g('orchestratorAccount').value);
  const field = g('mcpStatus');
  g('mcpSetup').dataset.accountId = id || '';
  if (!project || !id) {
    writeMcp("MCP: " + mcpStatusLabel('inactive'), '', 'inactive');
    g('mcpSetup').disabled = true;
    /* WITH NOTHING SELECTED NO WARNING IS WRITTEN: saying not installed would present the unknown as
       known. safety contract of the panel. */
    setupReachabilityWarning(null);
    return;
  }
  let d;
  try { d = await window.panel.mcpStatus(requestedProject, id); }
  catch (error) { d = { status: 'unknown', error: error.message }; }
  const currentId = orchChangeMode ? g('orchestratorAccount').value
    : (panes[0]?.accountId || g('orchestratorAccount').value);
  if (request !== mcpRefreshRequest || project !== requestedProject
      || activePage !== requestedPage || currentId !== id) return;
  /* IF THE SELECTED ACCOUNT IS NOT IN THE REGISTRY IT IS INACTIVE, NOT MISSING. After an account is
     removed the old id can stay in the selection box; the button lit amber while there was nothing
     to install. Amber means you can install it; here it cannot be, because which account it is is unknown. */
  if (d.error && /select.*account/i.test(d.error)) {
    writeMcp("MCP: " + mcpStatusLabel('inactive'), d.error, 'inactive');
    g('mcpSetup').disabled = true;
    setupReachabilityWarning(null);
    return;
  }
  /* A DISABLED DEFINITION IS NOT "NOT INSTALLED". All four states are written separately;
     the detail stays in the sentence from `mcp-status.js` and is not written a second time here. */
  writeMcp("MCP: " + mcpStatusLabel(d.status), d.note || d.error || '', d.status);
  g('mcpSetup').disabled = !!d.installed && !d.needsRerun;
  setupReachabilityWarning(d.warning || null);
  writeDeclinedBar(d.status === 'closed' && d.provider === 'claude');
}

/* A DECLINED CONNECTION IS SAID ABOVE THE CLAUDE TERMINAL, AND ONLY THEN . After
   "continue without" Claude never asks again in that project, and its /mcp list does not show the
   declined server; the only sign was the colour of a top-bar button. The bar appears on the Claude
   terminals of this project while the decline stands, and goes when it is lifted. */
function writeDeclinedBar(declined) {
  for (const b of panes) {
    if (!b || !b.container) continue;
    const existing = b.container.querySelector('.mcp-declined');
    if (!(declined && b.provider === 'claude' && b.id)) { if (existing) { existing.remove(); try { b.fit.fit(); } catch { /* hidden pane */ } } continue; }
    if (existing) continue;
    const bar = document.createElement('div');
    bar.className = 'mcp-declined';
    const text = document.createElement('span');
    text.textContent = "Agents on other accounts can't be called from this terminal: Benchook's connection was declined in this project.";
    const button = document.createElement('button');
    button.textContent = "Ask again";
    button.title = "Removes the decline and restarts this terminal on the same conversation, so Claude asks again.";
    button.onclick = () => askAgainMcp(b);
    bar.appendChild(text); bar.appendChild(button);
    b.container.insertBefore(bar, b.container.querySelector('.screen'));
    try { b.fit.fit(); } catch { /* hidden pane */ }
  }
}

/** Lifts the decline (with approval) and resumes the terminal, so Claude asks on start. */
async function askAgainMcp(b) {
  return changeWorkspace(() => askAgainMcpOwned(b));
}
async function askAgainMcpOwned(b) {
  if (!await confirm("Ask Claude again about Benchook's connection?\n\n"
    + "Benchook removes its entry from the declined list in .claude\\settings.local.json of this project "
    + "and restarts this terminal on the same conversation. When Claude asks, choose to use the connection.")) return;
  const r = await window.panel.askAgainMcp(project);
  if (!r || r.error) { writeStatus("Could not ask again.", (r && r.error) || ''); return; }
  const info = { provider: b.provider, sessionId: b.sessionId, label: b.label, accountId: b.accountId,
    model: b.model, connection: b.connection };
  if (b.id) {
    const stopped = await window.panel.closeTerminalAndWait(b.id);
    if (!stopped?.done) { writeStatus("Could not restart the terminal.", stopped?.error || ''); return; }
  }
  closePane(b, true);
  await createPaneAndWait(info.provider, info.sessionId, info.label, info.accountId, info.model,
    info.sessionId ? info.connection : null);
  refreshMcpStatus();
}

/** If the connection warning CHANGED the agent list is redrawn; if it is the same, nothing is drawn.
 *  This is so the warning appears on the card of the relevant AGENT, not on a single top-bar button. */
function setupReachabilityWarning(text) {
  if (mcpWarning === text) return;
  mcpWarning = text;
  if (typeof renderAgentList === 'function') renderAgentList();
}

/** The single on-screen word for the state. The vocabulary lives in `panel/mcp-status.js`; because
 *  the page cannot `require` it, the values arrive with the `mcp:status` answer. */
function mcpStatusLabel(status) {
  if (status === 'installed') return "Ready";
  if (status === 'closed') return "Disabled";
  if (status === 'otherProject') return "Fixed to another project";
  if (status === 'inactive') return "Select a project and account";
  return "Not configured";
}

/* Derive button color from the connection state rather than localized display text. */
function mcpStatusColor(status) {
  if (status === 'installed') return 'ready';
  if (status === 'inactive' || status === 'unknown') return 'inactive';
  return 'missing';
}

/* Text from the back end is not printed on screen RAW: the state is one word, the detail is in the
 * tooltip.
 *
 * MCP moved from the bottom of the left column to the TOP BAR and was reduced to one button: too many
 * words were shown there, and a button that glows amber when not installed and green when installed
 * reads better. The text of the button is fixed; THE COLOUR says the state and the detail is in the tooltip. */
function writeMcp(short, long, status) {
  const field = g('mcpStatus');
  if (field) {
    field.textContent = short;                       // hidden; for screen readers and tests
  }
  const button = g('mcpSetup');
  if (!button) return;
  const m = String(short);
  button.classList.remove('ready', 'missing', 'inactive');
  button.classList.add(mcpStatusColor(status));
  // The short state is written at the START of the tooltip: the text backs up what the colour says.
  button.title = m + (long ? '\n' + long : '\n'
    + "Connects the orchestrator to agents on other accounts or providers.");
}

/* THE SETUP HAS ITS OWN COUNTER. It used to share the status poll's counter, and the poll runs on every
   account refresh: a poll that fired while setup ran made the click handler drop its own result, so
   "Could not connect MCP" or "configured" was never written. */
let mcpSetupRequest = 0;
g('mcpSetup').onclick = async () => {
  const requestedProject = project, requestedPage = activePage;
  const request = ++mcpSetupRequest;
  const id = orchChangeMode ? g('orchestratorAccount').value
    : (panes[0]?.accountId || g('orchestratorAccount').value);
  // No silent exit: why it could not be installed is written.
  /* SILENT FAILURE REMOVED. The MCP connection showed amber but clicking it did not connect. The
     reason was on screen: when setup failed, the state was written only into the TOOLTIP of the
     button. The user clicked, nothing changed, and why it did not change was visible nowhere.
     Every path now lands on the status line of the panel. */
  if (!project) {
    writeMcp("MCP: " + mcpStatusLabel('inactive'), '', 'inactive');
    writeStatus("Could not connect MCP.", "Select a project from the sidebar first.");
    return;
  }
  if (!id) {
    writeMcp("MCP: " + mcpStatusLabel('inactive'), '', 'inactive');
    writeStatus("Could not connect MCP.",
      "Select an orchestrator account. Use Add account if the list is empty.");
    return;
  }
  let d;
  try { d = await window.panel.setupMcp(requestedProject, id); }
  catch (error) { d = { error: error.message }; }
  const currentId = orchChangeMode ? g('orchestratorAccount').value
    : (panes[0]?.accountId || g('orchestratorAccount').value);
  if (request !== mcpSetupRequest || project !== requestedProject
      || activePage !== requestedPage || currentId !== id) return;
  writeMcp("MCP: " + (d.error ? "Setup failed" : mcpStatusLabel(d.status)), d.error || d.note || '',
    d.error ? 'none' : d.status);
  g('mcpSetup').disabled = !!d.installed && !d.needsRerun;
  if (d.error) writeStatus("Could not connect MCP.", d.error);
  else if (!d.installed) writeStatus("MCP setup needs attention.", d.note || 'Check the connection settings.');
  /* SAYING "INSTALLED, YOU ARE READY" WOULD BE WRONG. Measured: the setup was written after an open
     Codex session had started and that session never saw the tool -- the user did the setup and the
     orchestrator still could not call it. What is on disk and what an open session sees are separate;
     the panel only knows the disk, so it says what is needed. */
  /* THE REAL ACTION IS ON THE VISIBLE LINE: "open a new terminal" used to be only in the tooltip,
     and the fact that an open session will not see the new connection must be readable without
     hovering. With no orchestrator open the sentence is not needed. */
  else writeStatus(panes.some((b) => b.id && (b.provider === 'claude' || b.provider === 'codex'))
      ? "MCP configured. Open a new terminal to use it."
      : "MCP connection configured.",
    [d.note, d.openRe].filter(Boolean).join(' '));
  await refreshMcpStatus();
};

/* ADDING AN ACCOUNT -- the user types no path and pastes no command.
   Signing in from the system is healthier than writing code for it, and no user will know which
   file to edit. The panel chooses the folder ITSELF and opens the login screen ITSELF; the user only
   signs in to their account in the window that opens.

   The panel does not do the login itself: no password or token passes through it, and the flow is the
   own login flow of Claude Code or Codex. The panel only says which folder to open it in. */
function accountForm() {
  historyOpen = false; openAgent = null; formOpen = true;
  const k = g('detail');
  k.textContent = '';
  const close = document.createElement('button');
  close.id = 'closeButton'; close.textContent = 'Close'; close.onclick = closeDetail;
  k.appendChild(close);
  const b = document.createElement('h3'); b.textContent = "Add account";
  k.appendChild(b);

  const descriptor = document.createElement('div');
  descriptor.className = 'meta';
  descriptor.textContent = "Sign in through the provider's browser flow. "
    + "Other account profiles are preserved.";
  descriptor.title = "Choose a provider and select Add and sign in. Benchook creates a separate "
    + "profile folder and opens sign-in. Other profiles stay signed in. "
    + "The account is labelled with your email name after sign-in; there is nothing to type.";
  k.appendChild(descriptor);

  /* After sign-in, show the account identity and warn if it matches another registered account. */

  const form = document.createElement('div');
  form.style.marginTop = '12px';
  /* THE ACCOUNT IS NOT ASKED FOR A NAME. The on-screen label comes from the part of the e-mail before
     the @ after login. A hand-typed name was both an unnecessary question and interfered with agent
     matching; both are gone. */
  const provider = document.createElement('div');
  provider.className = 'field';
  provider.innerHTML = "<label>Provider</label><select id=\"accountProvider\">"
    + '<option value="claude">Claude</option><option value="codex">Codex</option></select>';
  form.appendChild(provider);

  /* THE FOLDER IS NO LONGER SHOWN: showing which file a login will be saved to is unnecessary
     information, and the own rule of the panel already says no user will know which file to edit -
     yet the form still showed it. The path WAS NOT LOST, it was hidden: the panel still derives it,
     saves it and writes it out when needed (when removing the account, when signing out). For someone
     who wants to choose the folder themselves there is a one-line disclosure; a first-run user never
     sees it. */
  const kl = document.createElement('div');
  kl.className = 'field';
  kl.innerHTML = '<input id="accountFolder" hidden />'
    + '<div class="hint"><span id="accountOpen" style="cursor:pointer;text-decoration:underline">'
    + "Choose a profile folder</span></div>";
  form.appendChild(kl);
  k.appendChild(form);

  const output = document.createElement('div');
  const dg = document.createElement('div');
  dg.className = 'buttons';

  // The folder suggestion is produced per provider; there is no name input, uniqueness is enough.
  const refreshSuggestion = async () => {
    if (g('accountFolder').dataset.manual === '1') return;
    const suggested = await settle(window.panel.suggestAccountFolder(g('accountProvider').value, ''));
    // The form may have closed while the suggestion was read; a failed read leaves the field as it is.
    if (typeof suggested === 'string' && g('accountFolder')) g('accountFolder').value = suggested;
  };
  setTimeout(() => {
    g('accountProvider').onchange = refreshSuggestion;
    // Makes the disclosure area VISIBLE: while hidden it cannot be typed into or focused.
    g('accountOpen').onclick = () => {
      const box = g('accountFolder');
      box.hidden = false;
      box.readOnly = false;
      box.dataset.manual = '1';
      box.style.opacity = '1';
      g('accountOpen').textContent = "Account profile will be saved in:";
      box.focus();
    };
    refreshSuggestion();
  }, 0);

  const add = document.createElement('button');
  add.textContent = "Add and sign in";
  // One click, one account: a second click while this runs used to create a second profile.
  add.onclick = async () => {
    if (add.disabled) return;
    add.disabled = true;
    try { await addAndSignIn(); } finally { add.disabled = false; }
  };
  const addAndSignIn = async () => {
    output.textContent = '';
    /* THE CLI IS CHECKED BEFORE THE ACCOUNT IS ADDED. Otherwise a missing or broken install surfaced
       only after the account row existed, as a sign-in that failed with a sentence that did not say
       what to fix. Nothing is added; after fixing the install the same button works again. */
    const problem = await window.panel.cliProblem(g('accountProvider').value).catch(() => null);
    if (problem) {
      const w = setupWarning(problem.message);
      w.style.whiteSpace = 'pre-wrap'; w.style.userSelect = 'text';
      output.appendChild(w);
      return;
    }
    const previousIds = new Set(registry.map((h) => h.id));
    const r = (await settle(window.panel.addAccount({
      provider: g('accountProvider').value, folder: g('accountFolder').value.trim() || null,
    }))) || { error: "Benchook did not answer." };
    if (r.error) {
      output.appendChild(setupWarning(r.error));
      if (r.suggestion) { g('accountFolder').value = r.suggestion; }
      return;
    }
    await refreshRegistry();
    /* THE NEW ACCOUNT IS FOUND BY ID, NOT BY NAME. The name may now be empty and the temporary label
       the panel sets can be the same on several accounts; searching by name would open the login
       screen of the wrong account. */
    const created = registry.find((h) => !previousIds.has(h.id));
    if (!created) { output.appendChild(setupWarning("The added account could not be found")); return; }
    await signInScreen(created);
  };
  dg.appendChild(add);
  k.appendChild(dg);
  k.appendChild(output);
  g('overlay').style.display = 'block';
}

/* Provider-owned sign-in. Claude owns its console input; the panel only shows progress. */
async function signInScreen(h) {
  formOpen = true; historyOpen = false; openAgent = null;
  const k = g('detail');
  k.textContent = '';

  const closeD = document.createElement('button');
  closeD.id = 'closeButton'; closeD.textContent = 'Close';
  closeD.onclick = async () => {
    const result = await settle(window.panel.cancelSignIn(h.id));
    if (result?.error) { status.textContent=result.error; return; }
    signInPending=null; closeDetail();
  };
  k.appendChild(closeD);

  const b = document.createElement('h3');
  b.textContent = h.name + " — Sign in";
  k.appendChild(b);

  const status = document.createElement('div');
  status.className = 'frame';
  status.style.marginTop = '10px';
  status.textContent = h.provider === 'claude' ? 'Opening Claude Code sign-in…' : 'Opening browser…';
  k.appendChild(status);

  const link = document.createElement('div');
  link.className = 'path';
  link.style.marginTop = '8px';
  k.appendChild(link);

  // Said BEFORE the browser opens: which account signs in is decided there, not by Benchook.
  const which = document.createElement('div');
  which.className = 'hint';
  which.style.marginTop = '8px';
  which.textContent = "The browser signs in with the " + (h.provider === 'claude' ? 'claude.ai' : 'ChatGPT')
    + " account that is open there. To add a different account, sign out there first or open the sign-in link"
    + (h.provider === 'claude' ? " (shown in the Claude Code window)" : "") + " in a private window.";
  k.appendChild(which);

  const where = document.createElement('div');
  where.className = 'path';
  where.style.marginTop = '10px';
  where.textContent = "Profile folder: " + h.folderPath;
  k.appendChild(where);

  g('overlay').style.display = 'block';

  signInPending = { id: h.id, status, link };
  const r = await settle(window.panel.startSignIn(h.id));
  if (r && r.error && /already in progress/i.test(r.error)) {
    // The earlier sign-in of this row is still running: this screen follows it instead of losing its result.
    status.textContent = 'A sign-in for this account is already running. Finish it in the browser, or press Close to cancel it.';
    return;
  }
  if (r && r.error) {
    // An install problem carries the command that fixes it on its own line; keep the lines and let it be copied.
    status.textContent = r.error; status.style.whiteSpace = 'pre-wrap'; status.style.userSelect = 'text';
    signInPending = null; return;
  }
  status.textContent = h.provider === 'claude'
    ? 'Complete sign-in in the Claude Code window and your browser. If asked for a code, enter it in Claude Code. This dialog closes when sign-in finishes.'
    : 'Complete sign-in in your browser. This dialog closes automatically.';
}

/* Login notices from the main process. One listener; it writes to the screen of whichever account it is for. */
let signInPending = null;
window.panel.onSignIn(async (v) => {
  if (!signInPending || signInPending.id !== v.id) return;
  const { status, link } = signInPending;
  /* THE SCREEN MAY HAVE BEEN REPLACED (another form opened over it). Then the result goes to the status
     line and nothing on screen is closed: a success used to close whatever form was open. */
  if (v.status !== 'ongoing' && !status.isConnected) {
    signInPending = null;
    await refreshRegistry();
    writeStatus(v.status === 'done' ? "Sign-in finished." : v.status === 'twin'
      ? "Not added: this account is already in Benchook (" + (v.twin || '') + ")." : "Sign-in incomplete: " + (v.reason || ''), v.output || '');
    return;
  }
  if (v.status === 'ongoing') {
    if (v.url) {
      link.textContent = '';
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = "Open sign-in link";
      a.title = v.url;
      a.style.color = 'var(--accent)';
      a.onclick = (o) => { o.preventDefault(); window.panel.openLink(v.url); };
      link.appendChild(a);
    }
    return;
  }
  if (v.status === 'twin') {
    // The dialog stays open: the user needs to read what happened and what to do instead.
    signInPending = null;
    const site = v.provider === 'codex' ? 'ChatGPT' : 'claude.ai';
    status.style.whiteSpace = 'pre-wrap';
    status.textContent = "This browser signed in as " + (v.email || 'an account') + ", which is already added as \""
      + v.twin + "\". Benchook did not add it twice"
      + (v.undone ? (v.removed ? " and removed this new row." : "; this row stays signed out.")
        : ".\nThe second sign-in could not be undone automatically: remove this row from Accounts.")
      + "\n\nTo add a different account: sign out of " + site + " in your browser, or open the sign-in link"
      + " in a private window, then sign in again.";
    await refreshRegistry();
    return;
  }
  if (v.status === 'done') {
    signInPending = null;
    /* WHO SIGNED IN IS SAID - from a real attempt. A different account had signed into the folder
       opened for another one and the panel never noticed: it said signed in and moved on without
       writing which account had signed in.

       The cause is not in the panel but in the browser: the account already signed in on claude.ai is
       silently authorised on the consent screen. The panel cannot manage the browser; what it can do
       is SAY WHAT HAPPENED and warn that the same account now sits on two rows. With the same account
       on two rows, the panel says it ran on the second account while the work comes out of the quota
       of the first. */
    await refreshRegistry();
    // The model list of a just-signed-in account can differ from the one read while it was signed out.
    if (g('orchestratorAccount').value === v.id) refreshOrchModel();
    // Checked again AFTER the refresh: a form the user opened while it ran is not closed under them.
    if (status.isConnected) closeDetail();
    const record = registry.find((x) => x.id === v.id) || {};
    if (v.twin) {
      writeStatus("Warning: \"" + v.twin + "\" matches an existing account (" + (v.email || '?') + ').',
        "The browser authorized an account that is already registered. These profiles "
        + "share the same account and usage limits. "
        + "\n\nTo use another account, sign out in your browser "
        + "or open the authorization link in a private window, then sign in again.");
    } else if (v.email) {
      writeStatus('"' + (v.email) + "\" signed in.",
        v.newName ? "Account name taken from email: " + v.newName : '');
    } else {
      writeStatus('"' + (record.name || v.id) + "\" signed in.",
        "Signed-in account identity could not be read.");
    }
    return;
  }
  signInPending = null;
  status.style.whiteSpace = 'pre-wrap';
  status.textContent = "Sign-in incomplete: " + (v.reason || "Reason unavailable") + '.'
    + (v.removed ? "\nThe new account was not added." : '');
  // What the provider printed is shown, not hidden in a tooltip; it is usually the real reason.
  if (v.output && String(v.output).trim()) {
    const out = document.createElement('pre');
    out.className = 'path'; out.style.whiteSpace = 'pre-wrap'; out.style.userSelect = 'text'; out.style.maxHeight = '140px';
    out.style.overflow = 'auto'; out.textContent = String(v.output).trim().slice(-800);
    status.after(out);
  }
  const again = document.createElement('button');
  again.textContent = "Try again";
  again.style.marginTop = '10px';
  const row = v.removed ? null : registry.find((x) => x.id === v.id);
  again.onclick = () => (row ? signInScreen(row) : accountForm());
  status.parentNode && status.parentNode.appendChild(again);
  refreshRegistry();
});

function setupWarning(text) {
  const u = document.createElement('div');
  u.className = 'warning-2'; u.textContent = text;
  return u;
}


function setupField(id, label, hint, line, value, long) {
  const d = document.createElement('div');
  d.className = 'field';
  const l = document.createElement('label'); l.textContent = label;
  const el = line > 1 ? document.createElement('textarea') : document.createElement('input');
  if (line > 1) el.rows = line;
  el.id = id;
  if (value) el.value = value;
  d.appendChild(l); d.appendChild(el);
  if (hint) {
    const i = document.createElement('div'); i.className = 'hint'; i.textContent = hint;
    if (long) { i.title = long; l.title = long; }
    d.appendChild(i);
  }
  return d;
}

/* ---------------- if the file under an open form changes ----------------
 *
 * Warn and let the user choose, and have the warning say what changed - down to something like
 * "this agent's model changed".
 *
 * THE DEFECT: while the form was open, if an orchestrator changed the account in the same file,
 * Save SILENTLY overwrote that change. safety contract of the panel is strained here -- a loss the
 * user did not approve. The panel no longer picks either direction by itself: it offers two options.
 *
 * `formStartupContent` is the file as it was when the form opened. The comparison is by CONTENT, not
 * by mtime: two writes in the same second can carry the same mtime. */
let formStartupContent = null;
let conflictAccepted = false;

/* After a successful save, advance the conflict baseline to the saved content and path. Reset any prior keep-edits acceptance; subsequent external changes are compared against the new baseline. */
function recordAfterBase(filePath, d) {
  const readable = d && !d.none && typeof d.content === 'string';
  return { filePath, base: readable ? d.content : null };
}

async function refreshFormBase(filePath, name) {
  let d = null;
  try { d = await window.panel.agentFileState(filePath, null); } catch { d = null; }
  const t = recordAfterBase(filePath, d);
  formStartupContent = t.base;
  conflictAccepted = false;
  if (editingAgent) editingAgent.filePath = t.filePath;
  // Buttons retain this object's reference. Advance its identity too after rename.
  if (name) {
    formOldName = name;
    if (editingAgent) editingAgent.name = name;
  }
  const old = g('conflictStrip');
  if (old) old.remove();
}

async function checkFormConflict() {
  if (!formOpen || !editingAgent || !editingAgent.filePath || conflictAccepted) return;
  let d;
  try { d = await window.panel.agentFileState(editingAgent.filePath, formStartupContent); }
  catch { return; }
  if (!d || !d.changed) return;
  renderConflictStrip(d);
}

function renderConflictStrip(d) {
  const k = g('detail');
  if (!k) return;
  const old = g('conflictStrip');
  if (old) old.remove();

  const s = document.createElement('div');
  s.id = 'conflictStrip';
  s.className = 'warning-2';
  s.style.borderLeft = '3px solid var(--yellow)';
  s.style.padding = '8px';
  s.style.margin = '8px 0';

  const b = document.createElement('div');
  b.textContent = d.none
    ? "This agent's file was deleted outside Benchook."
    : "This file changed while you were editing — " + (d.digest || "Details unavailable");
  s.appendChild(b);

  const dg = document.createElement('div');
  dg.className = 'buttons';
  dg.style.marginTop = '6px';

  const mine = document.createElement('button');
  mine.textContent = "Keep my edits";
  mine.title = "Saving will overwrite the external changes. "
    + "Choose this only if you want to replace them.";
  mine.onclick = () => { conflictAccepted = true; s.remove(); };
  dg.appendChild(mine);

  if (!d.none) {
    const external = document.createElement('button');
    external.textContent = "Reload from disk";
    external.title = "Discard your unsaved edits and load the current file.";
    external.onclick = async () => {
      await refreshDefinitions();
      const created = definedAgents.find((x) => x.filePath === editingAgent.filePath)
                || definedAgents.find((x) => x.name === editingAgent.name);
      if (created) await agentForm(created); else closeDetail();
    };
    dg.appendChild(external);
  }

  s.appendChild(dg);
  // The strip sits right under the heading: the user should see it before carrying on with the form.
  const place = g('formPlace');
  if (place && place.parentNode) place.parentNode.insertBefore(s, place.nextSibling);
  else k.appendChild(s);
}

/* Agent definitions are shared records; editing one updates its member projects. */
/* THE INTENT OF THE FORM. There are three different jobs and the main process CANNOT ASK
   which one: only the page knows which list the card was opened from. It used to be carried nowhere,
   and adding an existing agent to this project was mistaken for creating a second agent of the same
   name and refused. */
let formIntent = 'new';
/* THE IDENTITY IS THE NAME AT THE MOMENT THE FORM OPENED. The name box in the form can
   change; what changes is the NAME, not the person. Because this was not carried, renaming created
   a second agent. */
let formOldName = null;

/** The intent, by where the card came from. The page knows, the main process does not. */
function selectIntent(editing) {
  if (!editing || !editing.name) return 'new';
  if (definedAgents.some((x) => !x.undefinedDef && x.name === editing.name)) return 'edit';
  /* IN THE REGISTRY BUT NOT IN THIS PROJECT: add. Not in the registry either: NEW -- a card that was
     called in the past but has no definition ("undefined") goes through here, and it really is a new agent. */
  if (externalAgents.some((x) => x.name === editing.name)) return 'addToProject';
  return 'new';
}

/* *
 * WHAT THE PREVIEW PROMISES MUST BE WHAT THE BUTTON DOES.
 * A pure function: it does not touch the DOM, so it can be tested. */
/* WHAT WILL HAPPEN BEFORE SAVING - separately for the two operations that change where a file lives
 *. Pure: no DOM. Paths are compared at the level of folder and file name only; separator
 * direction and letter case (Windows) are normalised. */
function noticeSentence({ oldPath, filePath, oldName, newName, projects }) {
  if (!oldPath || !filePath) return null;
  const flatten = (p) => String(p).replace(/[\\/]+/g, '/').toLowerCase();
  const folder = (p) => flatten(p).replace(/\/[^/]*$/, '');
  if (flatten(oldPath) === flatten(filePath)) return null;
  const nameChanged = !!(oldName && newName && oldName !== newName);
  const moving = folder(oldPath) !== folder(filePath);
  const short = (p) => String(p).split(/[\\/]/).filter(Boolean).pop();
  const lines = [];
  if (nameChanged) {
    const list = (projects || []).map((p) => '  ' + short(p));
    lines.push('Saving renames "' + oldName + '" to "' + newName + '"'
      + (list.length ? " in " + countOf(list.length, "project", "projects") + ":" : ".")
      + (list.length ? '\n' + list.join('\n') : ''));
    lines.push("The old files named " + oldName + ".md are deleted after the new ones are written. "
      + "It stays the same agent; its history is kept.");
  }
  if (moving) {
    lines.push("Saving moves this agent to the managed folder. The old definition will be deleted: " + oldPath);
    if (/\/\.claude\/agents$/.test(folder(oldPath))) {
      lines.push("It is in Claude Code's own folder, where it always runs on the orchestrator's account. "
        + "After the move it runs on the account and model chosen here, in every project that uses it.");
    }
  }
  return lines.length ? lines.join('\n') : null;
}

function intentWord(intent, name, projectCount) {
  if (intent === 'addToProject') {
    return '"' + name + '" will be added to this project. It stays the same agent'
      + (projectCount > 0 ? ', and it is still active in ' + countOf(projectCount, 'other project', 'other projects') + '.' : '.');
  }
  if (intent === 'edit') {
    return projectCount > 0
      ? "Saving updates this agent in this project and in " + countOf(projectCount, "other project", "other projects") + "."
      : "Saving updates this agent.";
  }
  return "This creates a new agent. Agent names are shared across every project.";
}

/** The projects, other than the file being EDITED, in which the agent of this name sits.
 *  Nothing invented: it reads two lists - the definitions of this project and those of other projects
 *  (`otherAgents`, scanned from the project list the panel knows). A copy in a project the panel does
 *  not know about does not show up here, which is why the text never claims that is all of them. */
function usedProjects(name, filePath) {
  const set = new Set();
  const same = (x) => filePath && x && String(x) === String(filePath);
  for (const x of externalAgents) {
    if (x.name === name && !same(x.filePath) && x.project) set.add(x.project);
  }
  for (const x of definedAgents) {
    if (x.name === name && !x.undefinedDef && !same(x.filePath) && project) set.add(project);
  }
  return [...set];
}

async function agentForm(editing = null, option = null) {
  /* ONE FORM AT A TIME. The form waits on several reads before it builds its fields; two quick clicks (or
     the reopen after a save racing a click) used to build two forms into the same panel with the same
     element ids, and Save could read the other agent's fields. A form that is no longer the newest stops
     at its next wait. */
  const generation = agentForm.generation = (agentForm.generation || 0) + 1;
  const superseded = () => generation !== agentForm.generation;
  formIntent = (option && option.intent) || selectIntent(editing);
  formOldName = (editing && editing.name) || null;
  editingAgent = editing;
  conflictAccepted = false;
  formStartupContent = null;
  if (editing && editing.filePath) {
    try {
      const d = await window.panel.agentFileState(editing.filePath, null);
      formStartupContent = (d && d.content) || null;
    } catch { /* if it cannot be read no conflict check is made; the write path still requires approval */ }
    if (superseded()) return;
  }
  historyOpen = false; openAgent = null; detailInstalled = null; formOpen = true;
  const k = g('detail');
  k.textContent = '';

  const close = document.createElement('button');
  close.id = 'closeButton'; close.textContent = 'Close'; close.onclick = closeDetail;
  k.appendChild(close);
  const b = document.createElement('h3'); b.textContent = editing ? "Edit agent" : "Create agent";
  k.appendChild(b);

  /* WHICH OTHER PROJECTS IT IS ACTIVE IN IS STATED: if it is used elsewhere, the user has to be told
     so before changing it.

     THE MEANING CHANGED WITH. The sentence here used to say the files in those projects were
     SEPARATE copies that this change would not touch. The opposite is now true: there is one agent and
     the change goes to all of them. The same list now reports SCOPE rather than a warning -- so the
     user sees what they are changing. */
  if (editing) {
    const projectList = usedProjects(editing.name, editing.filePath);
    if (projectList.length) {
      const u = document.createElement('div');
      u.className = 'warning-2';
      /* THE TEXT WAS REVERSED. It used to say those copies would not change; now there is one agent
         and the change reaches all of them. Had the old sentence stayed, the panel would have said the
         exact opposite and the user would have changed projects they believed untouched. */
      u.textContent = "This agent is also active in: " + projectList.join(', ')
        + ". Saving updates it in all of them.";
      k.appendChild(u);
    }
  }

  if (!project) {
    const u = document.createElement('div');
    u.className = 'warning-2'; u.textContent = "Open a project folder first (Overview → Open project). The agent will be saved there.";
    k.appendChild(u); g('overlay').style.display = 'block'; return;
  }

  const descriptor = document.createElement('div');
  descriptor.className = 'meta';
  descriptor.id = 'formPlace';
  k.appendChild(descriptor);

  /* Show the dependency explanation for an agent of this project too. */
  if (editing) {
    const link = dependencyBlock(editing);
    if (link) k.appendChild(link);
  }

  // The full agent list is NO LONGER repeated here: it lives on the Agents tab of the sidebar and is
  // edited by clicking there. The form shows a single agent.
  await refreshDefinitions();
  if (superseded()) return;

  const form = document.createElement('div');
  form.style.marginTop = '12px';
  form.appendChild(setupField('formName', "Name", "Lowercase letters, numbers, and hyphens.", 1, editing && editing.name, "The orchestrator uses this name to invoke the agent."));
  form.appendChild(setupField('formWhen', "When to use", "Describe when the orchestrator should delegate to this agent.", 3, editing && editing.description, "Used by the orchestrator to select an agent."));
  form.appendChild(setupField('formTask', "Instructions", '', 8, editing && editing.body));
  /* THE PROJECT-SPECIFIC FIELD WAS REMOVED - such a request can be written to the orchestrator
     when the agent is given its task.

     THIS WAS MISSED ON THE FIRST PASS and the record check caught it: the storage layer had started
     dropping this section while the FORM still asked for it. Anything the user typed would have been
     lost with the panel saying nothing -- a silent loss, exactly what safety contract is about. The
     step producing the defect was the field itself, so the field went; the stripping layer stays for
     older files. */

  // Every agent carries one explicit account and model; both can be changed later from this form.
  await refreshRegistry();
  if (superseded()) return;
  const pair = document.createElement('div');
  pair.className = 'pair';

  const hd = document.createElement('div');
  hd.className = 'field';
  /* "Same as orchestrator" sits at the TOP of the list and is not selected by default: the user
     chooses it knowingly. An agent whose account is missing or deleted does not wait aside as not
     ready, it binds to the orchestrator; this box makes that state something the user can also choose
     BY HAND. */
  /* AN UNSELECTABLE PLACEHOLDER, AND SIGNED-IN ACCOUNTS ONLY. Choosing the placeholder must not be
     possible, and only signed-in accounts belong in the list. The placeholder is `disabled`, so the
     form cannot be saved with an empty account.

     THE ONE EXCEPTION: the CURRENT account of the agent stays in the list even when signed out.
     Otherwise the box would silently slide to another account and the user would change the account
     of the agent without realising it -- within the scope of safety contract. That row says it is
     signed out. */
  const currentAccount = (editingAgent && editingAgent.resolution && !editingAgent.resolution.asOrchestrator)
    ? editingAgent.resolution.account : null;
  /* AN ACCOUNT IN THE FILE THAT IS NOT REGISTERED IN THE PANEL (deleted, or from another computer) is
     not offered as an option: "Same as orchestrator" comes selected (which is the real setting of
     the agent anyway) and the old binding is mentioned only in the tooltip sentence. Saving binds
     the file to the orchestrator too. */
  const unregisteredAccount = unregisteredFileAccount(editingAgent);
  hd.innerHTML = "<label>Account</label><select id=\"formAccount\"></select>"
    + "<div class=\"hint\" id=\"formAccountHint\" title=\"Agents on the same account and provider use native subagents; "
    + "other accounts use the MCP worker bridge.\">Runs on this account.</div>";
  hd.querySelector('select').dataset.current = currentAccount || '';
  fillFormAccounts(hd.querySelector('select'));
  pair.appendChild(hd);

  const md = document.createElement('div');
  md.className = 'field';
  md.innerHTML = '<label>Model</label><select id="formModel">'
    + '</select>'
    + '<select id="formModelCodex" style="display:none"></select>'
    + "<div class=\"hint\" id=\"formModelHint\">Claude models.</div>";
  pair.appendChild(md);
  form.appendChild(pair);

  /* WHAT THIS AGENT MAY DO - the user's choice . Before this box an agent file said
     `tools: Read, Grep, Glob, Bash` while the run passed no permission at all: a Claude agent could only
     read, a Codex agent not even that (measured). Each level is now a fixed list that the run enforces;
     a new agent edits project files, an old one is read-only, a hand-written list stays "custom". */
  const permissionField = document.createElement('div');
  permissionField.className = 'field';
  permissionField.innerHTML = '<label>Permission</label><select id="formPermission"></select>'
    + '<div class="hint" id="formPermissionHint"></div>';
  form.appendChild(permissionField);
  {
    const select = permissionField.querySelector('select');
    for (const level of PERMISSION_LEVELS) {
      const o = document.createElement('option'); o.value = level; o.textContent = PERMISSION_LABEL[level]; select.appendChild(o);
    }
    const current = editing ? (editing.permission || 'default') : 'default';
    if (current === 'custom') {
      const o = document.createElement('option'); o.value = 'custom';
      o.textContent = "Custom: " + (editing.tools || ''); select.appendChild(o);
    }
    select.value = current;
    select.onchange = () => writePermissionHint();
  }
  k.appendChild(form);

  /* Keep the destination preview in sync with the name; use a placeholder only for an empty name. */
  const writeSavePlace = () => {
    // A locked agent is renamed where its file already is; that line is written by lockAgentForm.
    if (editing && editing.nameConflict) return;
    g('formPlace').textContent = "Save to: " + project + '\\.benchook\\agents\\'
      + (g('formName').value.trim() || '<name>') + '.md';
  };
  g('formName').addEventListener('input', writeSavePlace);

  // When the account changes the model field changes too: the model names of Codex are not those of Claude.
  /* Only the newest account choice fills the model box: a slow Codex list that arrived after the user had
     already picked a Claude account used to write Codex models into the wrong box. A list that cannot be
     read leaves "Default" instead of an empty box, and the form still gets its buttons. */
  let modelRequest = 0;
  const accountChanged = async () => {
    const request = ++modelRequest;
    const current = () => request === modelRequest && !superseded() && !!g('formAccount');
    const id = g('formAccount').value;
    const h = registry.find((x) => x.id === id) || null;

    /* NO MODEL IS CHOSEN FOR AN AGENT BOUND TO THE ORCHESTRATOR, because there is nothing to choose:
       which model is valid depends on which provider runs it, and the panel does not know that until
       call time. The box is locked with one option; an empty box would look forgotten. */
    if (id === 'orchestrator') {
      g('formModelCodex').style.display = 'none';
      const select = g('formModel');
      select.style.display = '';
      select.textContent = '';
      const o = document.createElement('option');
      o.value = 'orchestrator'; o.textContent = "Same as orchestrator";
      select.appendChild(o);
      select.value = 'orchestrator';
      g('formModelHint').textContent = "The model is inherited from the orchestrator.";
      g('formAccountHint').textContent = unregisteredAccount
        ? "The account this agent was linked to (" + unregisteredAccount + ") is no longer registered in Benchook, "
          + "so the agent runs as Same as orchestrator until it is added back. Saving keeps that link."
        : "Uses the orchestrator's account and model.";
      writeSavePlace();
      return;
    }
    g('formAccountHint').textContent = (id && !h)
      ? "This account is not registered in Benchook. Until it is added back, the agent runs as Same as orchestrator."
      : "Runs on this account.";

    const codexMi = !!h && h.provider === 'codex';
    let claudeNow = null;   // which version each Claude family name stands for on this account
    g('formModel').style.display = codexMi ? 'none' : '';
    g('formModelCodex').style.display = codexMi ? '' : 'none';
    if (codexMi) {
      // The list is not invented: the default of that account plus the names REALLY used in the past,
      // with how many records each appears in. If it is not listed, type-it-yourself is available.
      const m = await settle(window.panel.codexModels(h.folderPath));
      if (!current()) return;
      const select = g('formModelCodex');
      select.textContent = '';
      const addOption = (value, text) => {
        const o = document.createElement('option');
        o.value = value; o.textContent = text;
        select.appendChild(o);
      };
      addOption('default', "Default" + (m && m.defaults ? ' (' + modelName(m.defaults) + ')' : ''));
      for (const x of (m && Array.isArray(m.seen) ? m.seen : [])) {
        addOption(x.name, modelName(x.label || x.name));
      }
    } else {
      /* THE MODEL BOX IS FILLED EVEN WITH NO ACCOUNT SELECTED. There used to be an `else if (h)` here:
         with an empty account no branch ran and the model box stayed EMPTY -- opening the form, the
         user saw both boxes empty and could read the reason nowhere. */
      const [answer, latest] = await Promise.all([settle(window.panel.claudeModels(h ? h.folderPath : null)),
        settle(window.panel.claudeLatest(h ? h.folderPath : null))]);
      if (!current()) return;
      claudeNow = latest;
      const models = Array.isArray(answer) && answer.length ? answer : ['default'];
      const select = g('formModel'); select.textContent = '';
      for (const model of models) {
        const o = document.createElement('option'); o.value = model;
        o.textContent = modelOptionText(model, latest); select.appendChild(o);
      }
    }

    g('formModelHint').textContent = codexMi
      ? "Models available in this account's Codex catalog."
      : (h ? "Claude models — Account: " + h.name + "." : "Select an account first.");
    writeSavePlace();
    /* THE SAVED MODEL BELONGS TO ITS PROVIDER. Moving a Claude agent to a Codex account used to carry
       "opus" into the Codex box and save it. It is kept only while the provider stays the same. */
    const savedAccount = editing && editing.resolution && !editing.resolution.asOrchestrator
      ? registry.find((x) => x.id === editing.resolution.account) : null;
    const savedProvider = savedAccount ? savedAccount.provider : (editing && editing.provider) || null;
    if (editing && editing.model && (!h || !savedProvider || h.provider === savedProvider)) {
      const select = codexMi ? g('formModelCodex') : g('formModel');
      /* A MODEL THE LIST NO LONGER CARRIES IS KEPT, NOT SWAPPED. The list now follows the provider's
         catalog; an agent saved with a model that has since left it would otherwise open on the first
         option, and saving would change its model without anyone choosing that. */
      if (!editing.model || editing.model === 'orchestrator') { /* nothing saved to keep */ }
      else if (![...select.options].some((o) => o.value === editing.model)) {
        const o = document.createElement('option'); o.value = editing.model;
        o.textContent = modelOptionText(editing.model, claudeNow);
        select.appendChild(o);
      }
      if ([...select.options].some((o) => o.value === editing.model)) select.value = editing.model;
    }
  };
  formAccountTouched = false;
  g('formAccount').onchange = async () => { formAccountTouched = true; await accountChanged(); writePermissionHint(); };
  /* THE PRESELECTED VALUE IS WHAT WILL REALLY RUN - not the raw text in the file. When the file named
     an account that is not in the registry, `select.value` given a non-matching value became '' and
     the box looked EMPTY. Separating what the user sees from where the agent will really run was the
     form-side copy of the defect fixed at the same time. */
  /* THE BOX SHOWS THE REGISTRY FORM. Whether the file holds the account label or its id makes no
     difference: we know which account it is, and it should appear exactly as the panel writes it.
     So the raw text of the file is not put into the box; whichever account the resolution found is
     selected and shown as everywhere else. If it resolves to no account the selection is Same as
     orchestrator -- the real setting of the agent -- and the reason is written on the amber line below. */
  const c0 = editing && editing.resolution;
  if (c0) g('formAccount').value = c0.asOrchestrator ? 'orchestrator' : c0.account;
  await accountChanged();
  if (superseded()) return;
  writePermissionHint();

  /* The model follows the same rule: it appears as the panel writes models. If the name in the file is
     not in the ready list (like a model never used on that account yet) the box would stay empty; it is
     added as an option, but in the own model spelling of the panel -- with no extra note. */
  if (editing && editing.model && (!c0 || !c0.asOrchestrator)) {
    const selectModel = (g('formModelCodex').style.display !== 'none') ? g('formModelCodex') : g('formModel');
    if (![...selectModel.options].some((o) => o.value === editing.model)) {
      const o = document.createElement('option');
      o.value = editing.model;
      o.textContent = modelName(editing.model);
      selectModel.insertBefore(o, selectModel.firstChild);
    }
    selectModel.value = editing.model;
  }
  formStart = { account: g('formAccount').value, model: currentFormModel() };
  /* AN AGENT IN CLAUDE CODE'S OWN FOLDER (.claude/agents) is run by Claude Code itself on the
     orchestrator's account; the boxes above did not apply to it. That is said here, and changing the
     account or model moves it into Benchook's folder when it is saved (with its own confirmation). */
  if (editing && inClaudeFolder(editing.filePath)) {
    const u = document.createElement('div');
    u.className = 'warning-2';
    u.style.marginTop = '6px';
    u.textContent = "This agent is in Claude Code's own folder (.claude/agents), so it runs on the orchestrator's "
      + "account and model. If you change its account or model, saving moves it into Benchook's folder so the "
      + "choice applies; you will be asked first.";
    form.appendChild(u);
  }

  /* THE BOXES SHOW WHAT THE FILE SAYS: no where-it-will-really-run addition is needed, and whatever
     model the file names is what the panel shows, without extra sentences.
     The one exception is a warning when SOMETHING HAPPENED: if the account was not found in the
     registry the agent binds to the orchestrator, and that has to be visible. */
  const formNote = resolutionNote(editing);
  if (formNote) {
    const u = document.createElement('div');
    u.className = 'warning-2';
    u.style.marginTop = '6px';
    u.textContent = formNote;
    form.appendChild(u);
  }
  /* A NAME THE FORM CANNOT SAVE IS SAID WHEN THE FORM OPENS. Imported agents may carry names such as
     code_reviewer; saving requires lowercase letters, numbers and hyphens, and used to fail only at Save. */
  if (editing && editing.name && !/^[a-z0-9][a-z0-9-]*$/.test(editing.name)) {
    const suggestion = String(editing.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
    const u = document.createElement('div');
    u.className = 'warning-2';
    u.style.marginTop = '6px';
    u.textContent = "To save changes, rename this agent using lowercase letters, numbers and hyphens (for example \""
      + suggestion + "\"). Until then it keeps running under its current name.";
    form.appendChild(u);
  }

  const output = document.createElement('div');
  output.id = 'formOutput';
  k.appendChild(output);

  const dg = document.createElement('div');
  dg.className = 'buttons';
  const preview = document.createElement('button');
  /* THE PREVIEW WAS REMOVED: when changing the properties of an agent a Save agent settings button is
     enough. The changes are already made in the form above, and showing the raw text of the file a
     second time adds no information. When something needs attention (the file will move, the source
     of another project will be written) that is when the flow stops and asks for approval. */
  preview.textContent = formIntent === 'addToProject' ? "Save and add to this project" : "Save agent settings";
  if (formIntent === 'addToProject') {
    const description = document.createElement('div');
    description.className = 'warning-2';
    description.textContent = 'Saving adds this existing agent to this project. Any changes to its settings apply everywhere it is used.';
    k.appendChild(description);
  }
  preview.onclick = async () => {
    preview.disabled = true;
    try { await previewAgent(); }
    finally { preview.disabled = false; }
  };
  dg.appendChild(preview);

  /* THE SAME DIALOG, A DIFFERENT ACTION BUTTON.
     For an inactive agent: add to this project. For an active agent: remove from the project.
     Copy-and-change did not survive as a separate button; the behaviour moved here: changing the
     fields and adding to this project is exactly that. The source file is never opened on this path
     -- the copy is produced from the state of the form. */
  if (editing && editing.filePath) {
    const removeBtn = document.createElement('button');
    removeBtn.textContent = "Remove from project";
    removeBtn.title = "Deletes this project's copy only. The agent itself stays and can be added back.";
    removeBtn.onclick = async () => { closeDetail(); await removeAgent(editing); };
    dg.appendChild(removeBtn);
  }

  /* DELETING THE AGENT EVERYWHERE IS A SEPARATE ACTION. It cannot be the same button as
     removing from a project: one deletes the file of this project, the other removes the agent from
     every project. How many projects it affects is written in the CONFIRMATION TEXT, before the click. */
  if (editing && editing.name) {
    const noneTag = document.createElement('button');
    noneTag.textContent = "Delete agent";
    noneTag.title = "Removes the agent from every project and from the panel.";
    noneTag.onclick = async () => { closeDetail(); await agentNoneTag(editing); };
    dg.appendChild(noneTag);
  }

  k.insertBefore(dg, output);
  if (editing && editing.nameConflict) lockAgentForm(k, form, dg, output, editing);

  g('overlay').style.display = 'block';
}

/* SAME NAME, DIFFERENT AGENTS: LOCKED. The form still shows everything,
   but only the name can be changed, and saving renames this project's copy and nothing else. The
   main process refuses any other change to a locked agent as well; this is where the user sees why. */
function lockAgentForm(k, form, dg, output, editing) {
  const u = document.createElement('div');
  u.className = 'warning-2';
  u.id = 'formLockNote';
  u.textContent = 'Another project has a different agent named "' + editing.name + '". Benchook cannot '
    + 'tell them apart, so both are locked and cannot be edited, deleted, added or removed. Give this '
    + "one a new name to unlock it; only this project's copy is renamed, and nothing else in it changes.";
  k.insertBefore(u, k.querySelector('h3') ? k.querySelector('h3').nextSibling : k.firstChild);
  for (const el of form.querySelectorAll('input, textarea, select, button')) {
    if (el.id === 'formName') continue;
    el.disabled = true;
    // Visibly locked, not just refusing input: a field that looks editable invites the mistake.
    el.style.opacity = '.45';
    el.style.cursor = 'not-allowed';
  }
  const place = g('formPlace');
  if (place) place.textContent = editing.filePath
    ? 'File: ' + editing.filePath + ' (a rename keeps it in this folder)' : '';
  dg.textContent = '';
  if (!editing.filePath) {
    // Listed here but not held by this project: there is no copy here to rename.
    g('formName').disabled = true;
    const where = document.createElement('div');
    where.className = 'warning-2';
    where.textContent = 'This project has no copy of it. Open it in a project that has one to rename it: '
      + [...new Set(editing.conflictProjects || [])].map(folderName).join(', ') + '.';
    dg.appendChild(where);
    return;
  }
  const rename = document.createElement('button');
  rename.id = 'formRename';
  rename.textContent = 'Rename this copy';
  rename.onclick = async () => {
    const newName = g('formName').value.trim();
    output.textContent = '';
    const note = document.createElement('div');
    note.className = 'warning-2';
    if (!newName || newName === editing.name) {
      note.textContent = 'Type a new name first.';
      output.appendChild(note);
      return;
    }
    rename.disabled = true;
    let y;
    try { y = await window.panel.renameAgentCopy(project, editing.name, newName, editing.filePath); }
    catch (e) { y = { error: errorText(e) }; }
    rename.disabled = false;
    if (!y || !y.renamed || y.error) {
      note.textContent = 'Not renamed: ' + ((y && y.error) || 'unknown error');
      output.appendChild(note);
      return;
    }
    closeDetail();
    await refreshDefinitions();
    writeStatus('Renamed to "' + y.name + '".', "Only this project's copy was renamed.");
  };
  dg.appendChild(rename);
}

/* THE WARNING AT THE TOP OF THE PAGE: every locked name and the projects holding a definition of it.
   Built from text nodes: names and paths come from files on disk. */
async function renderNameConflicts() {
  const bar = g('nameConflictBar');
  if (!bar) return;
  let list = [];
  try { list = await window.panel.agentConflicts(); } catch { list = []; }
  bar.textContent = '';
  bar.hidden = !list.length;
  if (!list.length) return;
  const title = document.createElement('b');
  title.textContent = 'Agents with the same name. ';
  bar.appendChild(title);
  bar.appendChild(document.createTextNode('Benchook cannot tell these apart, so they are locked until one of each is renamed: '));
  list.forEach((c, i) => {
    if (i) bar.appendChild(document.createTextNode(' · '));
    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = c.name;
    bar.appendChild(n);
    bar.appendChild(document.createTextNode(' (' + c.projects.map((p) => folderName(p)).join(', ') + ')'));
  });
  bar.appendChild(document.createTextNode('. Open the agent in one of those projects and give it a new name.'));
}

/** @param {{copy?:boolean}} [option] with `copy`, the target becomes THIS project and the source file is
 *  left untouched. The add-to-this-project button of the old source mode used this. */
/* *
 * THE ONE SENTENCE FOR THE RESULT OF A SAVE.
 *
 * Only the `error` field on top used to be checked: even when a project could not be written, a
 * green "Saved" appeared on screen. Because an agent is the same person in every project, that meant
 * "updated everywhere" and it was WRONG. A partial success no longer counts as a success, and the
 * target left uncovered is named.
 *
 * A pure function: it does not touch the DOM, so it can be tested. */
function writeResult(y, defaultPath) {
  if (!y || y.error) return { succeeded: false, text: (y && y.error) || 'Save failed' };
  const missing = Array.isArray(y.publishErrors) ? y.publishErrors : [];
  const filePath = y.filePath || defaultPath;
  if (!missing.length) return { succeeded: true, text: "Saved: " + filePath };
  /* THE SENTENCE WAS FIXED DURING A REVIEW BY THE USER. The earlier form took the reason raw from the
     `error` field, and the screen showed a raw Node error naming a temporary file.
     The reason now arrives already translated into the language of the user by `agent-sync`; the
     project path sits on its own line so a long path does not break the sentence. */
  const lines = ["Saved in this project, but "
    + missing.length + " other project" + (missing.length > 1 ? 's' : '') + " could not be updated:"];
  for (const e of missing) {
    lines.push("  " + (e.project || e.filePath || '(unknown project)'));
    lines.push("    " + (e.error || 'Unknown error'));
    /* After a replace with an unknown outcome the evidence file remains; if we do not say where it is,
       the user cannot find it. This is the only temporary file that MUST be shown. */
    if (e.preservedTemp) lines.push("    A recovery copy was kept: " + e.preservedTemp);
  }
  lines.push("Those projects still have their previous version.");
  lines.push("Benchook will update them the next time it can write there.");
  return { succeeded: false, partial: true, text: lines.join('\n') };
}

/* THE TWO SIDE EFFECTS OF A RENAME. Both are at file level and neither may stay silent: an
   old-named definition that could not be deleted in some project, and a definition that moved to
   another folder. These are not ERRORS (the save may have succeeded), but the user needs to know them. */
function nameChangeNotes(y) {
  const lines = [];
  const remaining = (y && y.oldNameRemaining) || [];
  const carried = (y && y.moved) || [];
  if (remaining.length) {
    lines.push("The old name is still there in " + countOf(remaining.length, "project", "projects") + ":");
    for (const e of remaining) {
      lines.push("  " + (e.project || e.filePath));
      lines.push("    " + (e.error || 'Unknown error'));
    }
    lines.push("Save the agent again to finish the rename.");
  }
  for (const t of carried) {
    lines.push("Moved: " + t.from);
    lines.push("    to " + t.to);
  }
  return lines;
}

/* THE PERMISSION LEVELS AS WRITTEN ON SCREEN, and what each one means for the agent's provider. On
   Windows only Claude's commands escape the project folder: Codex keeps them inside its sandbox, Claude
   has no sandbox there (Claude Code documents its sandbox for macOS, Linux and WSL2 only). */
/* 25 September 2026: the default level comes first - normal use, the account's own permission settings, and what
   they would ask is asked on the live run card. The other three are optional locks. The words follow the terms the
   providers themselves use (approval, read-only). */
const PERMISSION_LEVELS = ['default', 'read', 'edit', 'full'];
const PERMISSION_LABEL = { default: "Ask for approval", read: "Read-only", edit: "Edit files, no commands",
  full: "Auto-approve edits and commands", custom: "Custom" };
function permissionHint(level, provider) {
  if (level === 'default') {
    return "Works as it does in your terminal: uses this account's permission settings, and whatever it would ask "
      + "you there appears on the live run card to allow or deny.";
  }
  if (level === 'read') return "Reads and searches files. Changes nothing, asks nothing.";
  if (level === 'custom') return "A tool list written by hand in the agent file; it is kept as it is.";
  if (level === 'edit') {
    return provider === 'codex'
      ? "Reads and writes files inside the project folder; Codex's own commands stay in its sandbox, with no network."
      : "Reads, creates and edits files in the project folder. Runs no commands.";
  }
  if (provider === 'codex') return "Also runs commands and may use the network; Codex still writes only inside the project folder.";
  if (provider === 'claude') return "Also runs commands (tests, npm, git). On Windows, Claude's commands are not limited to the project folder.";
  return "Also runs commands. On Claude they are not limited to the project folder on Windows; Codex keeps them in its sandbox.";
}
function writePermissionHint() {
  const select = g('formPermission'), hint = g('formPermissionHint');
  if (!select || !hint) return;
  const id = g('formAccount') ? g('formAccount').value : '';
  const h = registry.find((x) => x.id === id) || null;
  hint.textContent = permissionHint(select.value, h ? h.provider : null);
  hint.style.color = (select.value === 'full' && (!h || h.provider !== 'codex')) ? 'var(--yellow)' : '';
}

/* Set when the user changes the account box of the open agent form. */
let formAccountTouched = false;
let formStart = { account: null, model: null };   // the form's account and model when it opened
const inClaudeFolder = (p) => /[\\/]\.claude[\\/]agents[\\/][^\\/]+$/i.test(String(p || ''));
function currentFormModel() {
  const codex = g('formModelCodex') && g('formModelCodex').style.display !== 'none';
  return codex ? g('formModelCodex').value : (g('formModel') ? g('formModel').value : null);
}
/** True when an agent in .claude/agents gets a new account or model: it has to move to apply. */
function formNeedsMove() {
  return !!(editingAgent && inClaudeFolder(editingAgent.filePath) && g('formAccount')
    && (g('formAccount').value !== formStart.account || currentFormModel() !== formStart.model));
}
async function previewAgent(option) {
  let accountId = g('formAccount') ? g('formAccount').value : '';
  /* A REMOVED ACCOUNT'S LINK IS KEPT. Removing an account promises that agents keep their link to it
     until it is added back; any later save (a description edit) used to write "Same as orchestrator"
     because that is what the box shows. Unless the user changed the box, the file's link is sent. */
  const keptLink = accountId === 'orchestrator' && !formAccountTouched ? unregisteredFileAccount(editingAgent) : null;
  if (keptLink) accountId = keptLink;
  const h = registry.find((x) => x.id === accountId) || null;
  const field = {
    name: g('formName').value, description: g('formWhen').value, task: g('formTask').value,

    account: accountId || null,
    provider: h ? h.provider : (keptLink ? (editingAgent.provider || null) : null),
    /* THE TOOL RESTRICTION IS NOT LOST ON ITS WAY THROUGH THE FORM. The form never shows this
       field; when it did not send it, the write layer put in the default list and an agent given only
       `Read` widened just because its description was edited. Not showing is one thing, deleting another. */
    tools: (editingAgent && editingAgent.tools) || null,
    // The chosen level decides the tool line; "custom" keeps the hand-written list above.
    permission: g('formPermission') ? g('formPermission').value : null,
    model: keptLink ? (editingAgent.model || 'default')
      : (h && h.provider === 'codex') ? g('formModelCodex').value : g('formModel').value,
    oldPath: editingAgent && editingAgent.filePath,
    moveToPanel: formNeedsMove(),
  };
  /* THE SAVE GOES WHERE THE PREVIEW WAS MADE. The project is taken once here: the user approves a
     preview built for this project, and a project switch before "Save" must not send it elsewhere. */
  const previewProject = project;
  const r = (await settle(window.panel.previewAgent(previewProject, field))) || { error: "Benchook could not prepare the preview." };
  const c = g('formOutput');
  c.textContent = '';
  if (r.error) {
    const u = document.createElement('div');
    u.className = 'warning-2'; u.textContent = r.error;
    c.appendChild(u); return;
  }


  // A MOVE IS NEVER MADE WITHOUT SAYING SO. If an agent living outside the own folder of the panel (for
  // example an agent of Claude Code under `.claude/agents/`) is edited and saved, the old file IS
  // DELETED. This screen used to say nothing about it; one of the safety constraints is changing no file
  // without approval.
  /* A RENAME IS NOT A MOVE. The same condition (`oldPath !== path`) is true for two different
     operations and the sentence described only one: renaming an agent that was already managed also
     said "moves this agent to the managed folder". The sentence now states the real operation and the
     projects affected. */
  // The affected projects are read FROM THE REGISTRY: the list row does not carry membership, the registry does.
  let memberProjects = r.projects || (editingAgent && editingAgent.projects) || null;
  if (!memberProjects && formOldName) {
    try {
      const record = (await window.panel.agentRegistry() || []).find((x) => x && x.name === formOldName);
      memberProjects = (record && record.projects) || null;
    } catch { memberProjects = null; }
  }
  const notice = noticeSentence({ oldPath: r.oldPath, filePath: r.filePath, oldName: formOldName, newName: r.name,
    projects: memberProjects || [] });
  if (notice) {
    const u = document.createElement('div');
    u.className = 'warning-2';
    u.style.whiteSpace = 'pre-wrap';
    u.textContent = notice;
    c.appendChild(u);
  }

  /* THE AN-AGENT-OF-THIS-NAME-EXISTS WARNING WAS REMOVED: editing your own agent is the normal case,
     not a warning. If the name REALLY belongs to someone else the write is refused in the main process
     (`agentRegistry.nameSuitable`) and the reason appears below. */

  /* WHAT WILL HAPPEN IS WRITTEN BEFORE SAVING. This line did not exist and the will-be-added
     promise sat only in the tooltip of the card, while the operation itself was refused. */
  const intentNote = document.createElement('div');
  intentNote.className = 'warning-2';
  intentNote.textContent = intentWord(formIntent, r.name,
    (r.projects || (editingAgent && editingAgent.projects) || []).length);
  c.appendChild(intentNote);

  const note = document.createElement('div');
  note.className = 'warning-2';
  // Catalog updates reach an open session through its enabled prompt hook.
  note.textContent = "The orchestrator receives catalog changes on your next message when the catalog hook is enabled.";
  note.title = "The catalog hook reports changes only when the agent list changes. "
    + "If needed, setup is offered after saving the agent.";
  c.appendChild(note);

  const dg = document.createElement('div');
  dg.className = 'buttons';

  /* SITUATIONS THAT NEED ATTENTION. Apart from these, a write happens in ONE CLICK: the user already
     made the change in the form and pressed Save agent settings, and a second approval step adds no
     information. Two exceptions remain, both about where a file lives and both within the fourth
     never: a move in which the old definition WILL BE DELETED, and a write to the source of another
     project. */
  const noticeNeeded = !!(r.oldPath && r.oldPath !== r.filePath);

  const writeD = document.createElement('button');
  writeD.textContent = noticeNeeded ? "Save anyway" : "Save agent settings";
  writeD.onclick = async () => {
    /* A LAST CHECK BEFORE WRITING. The watcher can miss an event (a network drive, the
       write-and-replace pattern of some editors); then the strip is never drawn and the user would
       overwrite the change of the orchestrator without knowing. This check happens at the moment of
       the write itself, so it waits for no event. */
    if (editingAgent && editingAgent.filePath && formStartupContent && !conflictAccepted) {
      const d = await settle(window.panel.agentFileState(editingAgent.filePath, formStartupContent));
      if (d && d.changed) {
        renderConflictStrip(d);
        const u = document.createElement('div');
        u.className = 'warning-2';
        u.textContent = "Not saved: the file changed outside Benchook. Resolve the conflict above.";
        c.appendChild(u);
        return;
      }
    }
    const y = (await settle(window.panel.writeAgent({ project: previewProject, name: r.name, content: r.content,
      intent: formIntent, oldName: formOldName, oldPath: r.oldPath, moveToPanel: formNeedsMove() })))
      || { error: "Benchook did not answer; the agent may not have been saved." };
    const result = writeResult(y, r.filePath);
    const notes = nameChangeNotes(y);
    const s = document.createElement('div');
    s.className = 'warning-2';
    s.style.whiteSpace = 'pre-wrap';   // so the target list reads line by line
    s.textContent = [result.text, ...notes].join('\n');
    /* NO GREEN ON A PARTIAL SUCCESS. The file was written, but while the agent is not the same in every
       project the work is not done; refreshing the list is still right, because the writable places changed. */
    // A rename whose old name was not cleaned up is not done either.
    if (result.succeeded && !((y && y.oldNameRemaining) || []).length) s.style.color = 'var(--green)';
    let resultField = c;
    const formProviderChanged = formIntent !== 'edit' || formOldName !== r.name;
    if (!y.error) {
      await refreshFormBase(r.filePath, r.name);
      await refreshDefinitions();
      await refreshExternalAgent();
      // Creating, adding and renaming change which actions the form offers.
      // Rebuild from the persisted definition, never keep the old action closures.
      if (formProviderChanged && result.succeeded && !((y && y.oldNameRemaining) || []).length) {
        const current = definedAgents.find(a => !a.undefinedDef && a.name === r.name);
        if (current) {
          await agentForm(current, { intent: 'edit' });
          resultField = g('formOutput');
        }
      }
    }
    resultField.appendChild(s);
    if (!y.error) await completeSetup();
  };
  if (noticeNeeded) dg.appendChild(writeD);

  const copyButton = document.createElement('button');
  copyButton.textContent = "Copy invocation instructions";
  copyButton.onclick = () => {
    window.panel.writeClipboard(invocationText(r, g('formWhen').value, g('formTask').value));
    copyButton.textContent = "Copied to clipboard";
  };
  dg.appendChild(copyButton);
  c.appendChild(dg);

  /* ONE CLICK. With nothing that needs attention the save happens at once; the button stays so it is
     clear where the result line came from and saving again is at hand. With a warning, it WAITS: no
     file is moved before the user has read what will happen. */
  if (!noticeNeeded) await writeD.onclick();
}

/* ================= SKILLS =================
 *
 * A Skills window next to the Agents window, holding every skill the panel can see, from which
 * skills can be added, removed and changed across projects.
 *
 * TWO DIFFERENCES FROM AN AGENT:
 *   1. A skill has no account and no model - the card is simpler.
 *   2. Every skill is written to BOTH SIDES at once. The reason was measured: there is no shared
 *      folder at project level. The card shows which sides exist as badges; a missing or diverged
 *      one is not hidden.
 */
let skills = [];
let externalSkills = [];          // in the registry but not in this project, plus those on the machine
let builtinSkills = { codex: [], claudeNote: '' };   // the own skills of the provider, read only
let skillRegistryRecords = [];

/** A skill of this project: green-framed, edited when clicked. */
function skillLine(x) {
  const r = document.createElement('div');
  r.className = 'agent-card own';
  const nk = document.createElement('span');
  nk.className = 'status-dot';
  nk.style.color = 'var(--green)';

  const gv = document.createElement('div');
  gv.className = 'history-body';
  const name = document.createElement('div');
  name.className = 'agent-name';
  name.textContent = x.name;
  /* ONLY THE NAME ON THE CARD: anything under the name on a skill frame was clutter, and the name is
     enough. The description is not lost; it sits in the tooltip of the card and in the detail view. */
  gv.appendChild(name);

  r.appendChild(nk); r.appendChild(gv);

  /* A MISSING or DIVERGED skill does not stay silent - the same as the warning mark on an agent card.
     Red: one side does not exist at all, so that orchestrator cannot see the skill.
     Amber: both sides exist but their contents differ, so the same name behaves two ways. */
  if (x.missingSide.length || x.divergent) {
    const u = document.createElement('span');
    u.className = 'agent-alert ' + (x.missingSide.length ? 'red' : 'yellow');
    u.textContent = '!';
    u.title = x.missingSide.length
      ? (x.missingSide.includes('codex') ? 'Codex' : 'Claude')
        + " copy is missing. The skill is unavailable to that provider."
      : "The Claude and Codex copies differ. "
        + "Click to review and sync them.";
    r.appendChild(u);
  }

  const remove = document.createElement('span');
  remove.className = 'remove';
  remove.textContent = '✕';
  remove.title = "Remove skill from this project";
  remove.onclick = (o) => { o.stopPropagation(); removeSkill(x); };
  r.appendChild(remove);

  r.title = (x.description || "No usage description") + "\n\nClick to edit.";
  r.style.cursor = 'pointer';
  r.onclick = () => skillDetail(x);
  return r;
}

/** A skill from another project: dimmed; clicking reads its content and lets it be added. */
function externalSkillLine(x) {
  const r = document.createElement('div');
  r.className = 'agent-card external';
  const nk = document.createElement('span');
  nk.className = 'status-dot';
  nk.style.background = '#33322f';
  const gv = document.createElement('div');
  gv.className = 'history-body';
  const name = document.createElement('div');
  name.className = 'agent-name';
  name.textContent = x.name;
  gv.appendChild(name);   // only the name on the card; the description is in the tooltip
  r.appendChild(nk); r.appendChild(gv);
  r.title = (x.description ? x.description + '\n\n' : '')
    /* MEASURED: `~/.agents/skills` on the machine is loaded in every project under Codex and in no
       panel terminal under Claude. The two are stated separately; saying not loaded is right for
       Claude and would be wrong for Codex. */
    + (x.source === 'machine'
      ? "On this machine: " + x.project + "\nCodex loads it in every project; Claude only after it is added to the project."
      : "In: " + x.project)
    + "\n\nNot in this project. Click to review and add.";
  r.style.cursor = 'pointer';
  r.onclick = () => inspectExternalSkill(x);
  return r;
}

/* A BUILT-IN SKILL - the own file of the provider; it can be read and CANNOT BE CHANGED built-ins are shown below, visible but untouchable. The old User-level skills section is gone:
   skills on the machine were NOT LOADED into panel terminals (measured); they are now added from
   the not-in-this-project list. */
function builtinSkillLine(x) {
  const r = document.createElement('div');
  r.className = 'agent-card external';
  r.style.opacity = '0.7';
  const nk = document.createElement('span');
  nk.className = 'status-dot';
  nk.style.background = '#2a2a28';
  const gv = document.createElement('div');
  gv.className = 'history-body';
  const name = document.createElement('div');
  name.className = 'agent-name';
  name.textContent = x.name;
  gv.appendChild(name);
  r.appendChild(nk); r.appendChild(gv);
  r.title = (x.description ? x.description + '\n\n' : '') + "Built-in " + (x.provider === 'codex' ? 'Codex' : '')
    + " skill: " + x.filePath + "\n\nRead-only. Benchook does not change provider files.";
  r.style.cursor = 'pointer';
  r.onclick = () => inspectExternalSkill({ ...x, project: x.filePath, projectName: "Built-in", builtin: true });
  return r;
}

function renderSkillList() {
  const container = g('skillList');
  if (!container) return;
  container.textContent = '';
  if (!project) {
    const b = document.createElement('div');
    b.className = 'path';
    b.textContent = "Open a project folder first (Overview → Open project).";
    container.appendChild(b);
    return;
  }
  /* A SKILL IS NEVER DRAWN TWICE: skills that are already active should not appear a second time
     below as inactive; as with agents, an active one glows and an inactive one stays dimmed.
     A skill active in this project sits ONLY in the bright list above; the same name is not repeated
     in the dimmed lists below. It is filtered by name, because the name is what the orchestrator sees:
     two skills of the same name cannot be active at once. */
  const enabledNames = new Set(skills.map((x) => x.folderName));
  const externalRemaining = externalSkills.filter((x) => !enabledNames.has(x.folderName));

  if (skills.length) {
    writeTitle(container, "This project", "Loaded by orchestrators in this project. Click to edit; edits reach every project the skill is in.");
    container.appendChild(setupGrid(skills.map(skillLine)));
  }
  if (externalRemaining.length) {
    writeTitle(container, "Not in this project", "Known to Benchook (other projects) or found on this machine. "
      + "Not loaded here until added. Click to review and add.");
    container.appendChild(setupGrid(externalRemaining.map(externalSkillLine)));
  }
  if (!skills.length && !externalRemaining.length) {
    const b = document.createElement('div');
    b.className = 'path';
    b.textContent = "No skills found.";
    container.appendChild(b);
  }
  /* BUILT-INS AT THE VERY BOTTOM, UNTOUCHABLE. Those of Codex are read from disk; those of
     Claude are not on disk, so neither their count nor their names are INVENTED: only that they exist is said. */
  if (builtinSkills.codex.length || builtinSkills.claudeNote) {
    writeTitle(container, "Built-in (read-only)", "Shipped by the provider. Benchook shows them but cannot change them.");
    if (builtinSkills.codex.length) container.appendChild(setupGrid(builtinSkills.codex.map(builtinSkillLine)));
    if (builtinSkills.claudeNote) {
      const n = document.createElement('div');
      n.className = 'side-note';
      n.textContent = builtinSkills.claudeNote;
      container.appendChild(n);
    }
  }
}

async function refreshSkills() {
  if (!project) { skills = []; externalSkills = []; skillRegistryRecords = []; renderSkillList(); return; }
  /* ONE PROJECT PER REFRESH. After a project switch an older refresh used to write the previous project's
     skills over the new ones, and the conflict check then compared against the wrong list. */
  const proj = project, request = refreshSkills.request = (refreshSkills.request || 0) + 1;
  const stale = () => request !== refreshSkills.request || project !== proj;
  try {
    const t = await window.panel.completeSkills(proj);
    if (stale()) return;
    if (t && t.errors && t.errors.length) {
      writeStatus("Some skill copies could not be synchronized.",
        t.errors.map((x) => x.name + ': ' + x.error).join('\n'));
    }
  } catch (e) {
    writeStatus("Could not synchronize skill copies.", errorText(e));
  }
  let listed;
  try { listed = await window.panel.listSkills(proj); } catch { listed = []; }
  if (stale()) return;
  skills = listed;
  /* ONE REGISTRY - not-in-this-project comes from the registry (members of other projects) and
     from the own folders of the machine. The ones on the machine are not loaded into panel terminals
     (measured); here they stand only as addable candidates. */
  try {
    const d = await window.panel.skillRegistry(proj);
    if (stale()) return;
    skillRegistryRecords = (d && d.records) || [];
    const local = new Set(skills.map((x) => x.folderName));
    const registered = new Set(skillRegistryRecords.map((x) => x.folderName));
    externalSkills = [
      ...skillRegistryRecords.filter((x) => !local.has(x.folderName)).map((x) => ({
        ...x, source: 'registry',
        project: (x.projects || []).length ? x.projects.map((q) => q.split(/[\\/]/).filter(Boolean).pop()).join(', ') : "no project yet",
      })),
      ...((d && d.machine) || []).filter((x) => !registered.has(x.folderName) && !local.has(x.folderName))
        .map((x) => ({ ...x, source: 'machine', project: x.filePath })),
    ].sort((a, b) => a.name.localeCompare(b.name, "en-US"));
  } catch { externalSkills = []; skillRegistryRecords = []; }
  try { builtinSkills = await window.panel.builtinSkills(); }
  catch { builtinSkills = { codex: [], claudeNote: '' }; }
  if (stale()) return;
  const missing = skills.filter((x) => x.missingSide.length || x.divergent).length;
  setupText(g('skillSummary'), skills.length
    ? skills.length + (skills.length === 1 ? " skill" : " skills")
      + (missing ? '  \u00b7  ' + missing + " need attention" : '')
    : "No skills in this project");
  /* WHY THE COUNT DOES NOT MATCH: an orchestrator counted twenty skills while the panel showed four.
     The difference is the built-in skills the provider brings along. The panel cannot install, edit
     or delete them; showing them as regular ones would make them look editable.

     NO COUNT IS WRITTEN, because the panel DOES NOT KNOW that number: built-in skills do not sit in a
     folder, they come from inside the provider. Writing a fixed number would break safety contract of
     the panel and would silently go wrong when the provider version changes. */
  setupText(g('skillNote'), '');   // built-ins now sit below the list, read only
  renderSkillList();
}

/* IF THE FILE CHANGES FROM OUTSIDE WHILE THE SKILL FORM IS OPEN.
 * Measured: with the form open, SKILL.md was changed on disk and Save silently overwrote the outside
 * change. The rule of the agent form applies unchanged: the baseline is the content at the
 * moment the form opened; when a change is seen a strip appears and the user chooses; without a choice
 * the save is refused. The panel picks no direction. */

function checkSkillConflict() {
  if (!skillOpen || skillOpen.accepted || !g('skillText')) return;
  const y = skills.find((b) => b.folderName === skillOpen.folderName);
  if (!y) { renderSkillStrip({ none: true }); return; }
  if ((y.content || '') !== skillOpen.base) renderSkillStrip({ none: false, created: y });
}

function renderSkillStrip(d) {
  const k = g('detail');
  if (!k) return;
  const old = g('skillStrip');
  if (old) old.remove();
  const s = document.createElement('div');
  s.id = 'skillStrip';
  s.className = 'warning-2';
  s.style.borderLeft = '3px solid var(--yellow)';
  s.style.padding = '8px';
  s.style.margin = '8px 0';
  const b = document.createElement('div');
  b.textContent = d.none
    ? "This skill's files were deleted outside Benchook."
    : "This skill's file changed while you were editing.";
  s.appendChild(b);
  const dg = document.createElement('div');
  dg.className = 'buttons';
  dg.style.marginTop = '6px';
  const mine = document.createElement('button');
  mine.textContent = "Keep my edits";
  mine.title = "Saving will overwrite the external changes. Choose this only if you want to replace them.";
  mine.onclick = () => { if (skillOpen) skillOpen.accepted = true; s.remove(); };
  dg.appendChild(mine);
  if (!d.none) {
    const external = document.createElement('button');
    external.textContent = "Reload from disk";
    external.title = "Discard your unsaved edits and load the current file.";
    external.onclick = () => skillDetail(d.created);
    dg.appendChild(external);
  }
  s.appendChild(dg);
  const text = g('skillText');
  if (text && text.parentNode) text.parentNode.insertBefore(s, text);
  else k.appendChild(s);
}

/** The skill detail: its raw text is edited and written to both sides at once. */
function skillDetail(x) {
  const skillProject = project;
  skillOpen = { folderName: x.folderName, base: x.content || '', accepted: false };
  historyOpen = false; openAgent = null; detailInstalled = null; formOpen = true;
  const k = g('detail');
  k.textContent = '';

  const close = document.createElement('button');
  close.id = 'closeButton'; close.textContent = 'Close'; close.onclick = closeDetail;
  k.appendChild(close);

  const b = document.createElement('h3');
  b.textContent = x.name;
  k.appendChild(b);

  const descriptor = document.createElement('div');
  descriptor.className = 'meta';
  descriptor.textContent = "Loading…";
  descriptor.title = "Saving updates both copies, including any missing copy.";
  k.appendChild(descriptor);
  window.panel.skillPaths(project, x.folderName).then((paths) => {
    descriptor.textContent = (paths || []).join('   ·   ');
  }).catch(() => { descriptor.textContent = Object.values(x.paths).join('   ·   '); });

  if (x.missingSide.length || x.divergent) {
    const u = document.createElement('div');
    u.className = 'warning-2';
    u.textContent = x.missingSide.length
      ? "One copy is missing. Saving creates it."
      : "The copies differ. Choose the source for supporting files, then edit the instructions below.";
    k.appendChild(u);
  }

  const title = document.createElement('div');
  title.className = 'history-title';
  title.style.marginTop = '12px';
  title.textContent = "Complete skill";
  k.appendChild(title);

  const field = document.createElement('textarea');
  field.id = 'skillText';
  field.className = 'source-text';
  field.value = x.content || '';
  field.spellcheck = false;
  field.readOnly = true;
  k.appendChild(field);

  let sourceSelection = null;
  if (x.divergent) {
    const label = document.createElement('label');
    label.textContent = "Supporting files source ";
    sourceSelection = document.createElement('select');
    sourceSelection.id = 'skillSourceSide';
    for (const [value, text] of [['', "Select source"], ['claude', "Claude copy"], ['codex', "Codex copy"]]) {
      const option = document.createElement('option'); option.value = value; option.textContent = text;
      sourceSelection.appendChild(option);
    }
    label.appendChild(sourceSelection); k.appendChild(label);
  }

  const dg = document.createElement('div');
  dg.className = 'buttons';
  const normalizeRecord = document.createElement('button');
  normalizeRecord.textContent = "Edit";
  normalizeRecord.onclick = () => {
    field.readOnly = false;
    normalizeRecord.hidden = true;
    save.hidden = false;
    field.focus();
  };
  dg.appendChild(normalizeRecord);
  const save = document.createElement('button');
  save.textContent = "Save";
  save.hidden = true;
  save.title = "Updates both provider copies.";
  save.onclick = async () => {
    const text = field.value;
    if (!text.trim()) { writeStatus("Skill instructions cannot be empty.", ''); return; }
    if (sourceSelection && !sourceSelection.value) { writeStatus("Choose which supporting files to keep.", ''); return; }
    const sourceSide = sourceSelection?.value || undefined;
    /* A fresh check at save time: the watcher may have missed an event (the pattern). */
    if (skillOpen && !skillOpen.accepted) {
      let fresh = null;
      try { fresh = (await window.panel.listSkills(skillProject)).find((b) => b.folderName === x.folderName); } catch { fresh = null; }
      if (!fresh || (fresh.content || '') !== skillOpen.base) {
        renderSkillStrip(fresh ? { none: false, created: fresh } : { none: true });
        writeStatus("Not saved: the file changed outside Benchook. Resolve the conflict above.", '');
        return;
      }
    }
    const paths = await window.panel.skillSavePaths(skillProject, x.folderName);
    if (!await confirm([x.name + " — save this skill and its supporting files?",
      sourceSide ? "Supporting files will come from " + sourceSide + "." : '', '', ...paths].join('\n'))) return;
    const r = await window.panel.writeSkill(skillProject, x.folderName, text, sourceSide);
    if (r && r.error) { writeStatus("Could not save.", r.error); return; }
    /* CHANGING IT IN ONE PLACE CHANGES IT EVERYWHERE. How many projects it was written to is
       said; a project that could not be written is not hidden. */
    const n = (r.projects || []).length;
    const missing = (r.errors || []);
    writeStatus('"' + x.name + '" saved' + (n > 1 ? " in " + n + " projects." : ".")
      + (missing.length ? " " + countOf(missing.length, "project", "projects") + " could not be written." : ''),
      [r.warning || '', ...(r.written || []), ...missing.map((h) => (h.project || '') + ': ' + h.error)].filter(Boolean).join('\n'));
    closeDetail();
    refreshSkills();
  };
  dg.appendChild(save);

  const cancel = document.createElement('button');
  cancel.textContent = "Cancel";
  cancel.onclick = closeDetail;
  dg.appendChild(cancel);

  /* DELETE EVERYWHERE - the same as Delete agent: first it writes which projects it will go from. */
  const record = skillRegistryRecords.find((b) => b.folderName === x.folderName);
  const everyFromPlace = document.createElement('button');
  everyFromPlace.textContent = "Delete everywhere";
  everyFromPlace.title = "Removes this skill from every project it is in and from Benchook.";
  everyFromPlace.onclick = async () => {
    const projects = (record && record.projects) || [skillProject];
    const question = [x.name + " — delete this skill everywhere?", '',
      removalList(projects), '', "This also removes it from Benchook. To keep it elsewhere, use the ✕ on the card instead (remove from this project only)."].join('\n');
    if (!await confirm(question)) return;
    const r = await window.panel.deleteSkill(x.folderName);
    if (r && r.error) { writeStatus("Could not delete.", r.error); return; }
    writeStatus('"' + x.name + '"' + (r.deleted ? " deleted from " + countOf(projects.length, "project", "projects") + "." : " was not fully deleted."),
      [...(r.removedPaths || []), ...(r.errors || []).map((h) => (h.project || '') + ': ' + h.error)].join('\n'));
    closeDetail();
    refreshSkills();
  };
  dg.appendChild(everyFromPlace);
  k.appendChild(dg);
  g('overlay').style.display = 'block';
}

/* safety contract: which folders will go is written BEFORE deleting. */
async function removeSkill(x) {
  // The folders listed in the question are the ones removed, even if the project changes meanwhile.
  const proj = project;
  const paths = await window.panel.skillPaths(proj, x.folderName);
  const question = [x.name + " — remove this skill from the project?", '',
    "These folders will be permanently deleted:", ...paths, '',
    "Copies in other projects are preserved."].join('\n');
  if (!await confirm(question)) return;
  const r = await settle(window.panel.removeSkill(proj, x.folderName));
  if (r && r.error) { writeStatus("Could not remove item.", r.error); return; }
  writeStatus('"' + x.name + "\" removed from this project.", (r.removedPaths || []).join('\n'));
  refreshSkills();
}

/** A skill from another project: READ IT FIRST, then ask - the same rule as for agents. */
function inspectExternalSkill(x) {
  historyOpen = false; openAgent = null; detailInstalled = null; formOpen = true;
  const k = g('detail');
  k.textContent = '';

  const close = document.createElement('button');
  close.id = 'closeButton'; close.textContent = 'Close'; close.onclick = closeDetail;
  k.appendChild(close);

  const b = document.createElement('h3');
  b.textContent = x.name;
  k.appendChild(b);

  const origin = document.createElement('div');
  origin.className = 'meta';
  origin.textContent = "Source: " + (x.project || '?');
  k.appendChild(origin);

  const whenTitle = document.createElement('div');
  whenTitle.className = 'history-title';
  whenTitle.style.marginTop = '12px';
  whenTitle.textContent = "When to use";
  k.appendChild(whenTitle);

  const description = document.createElement('div');
  description.className = 'frame' + (x.description ? '' : ' empty');
  description.textContent = x.description || "Not specified.";
  k.appendChild(description);

  const gb = document.createElement('div');
  gb.className = 'history-title';
  gb.style.marginTop = '12px';
  gb.textContent = "Complete skill";
  k.appendChild(gb);

  const text = document.createElement('pre');
  text.textContent = x.content || "(Unavailable)";
  k.appendChild(text);

  const dg = document.createElement('div');
  dg.className = 'buttons';
  if (x.builtin) {
    const n = document.createElement('div');
    n.className = 'warning-2';
    n.textContent = "Built-in skill. Benchook shows it but does not change the provider's files.";
    k.appendChild(n);
  } else {
    const add = document.createElement('button');
    add.textContent = "Add to this project";
    add.title = x.source === 'machine'
      ? "Copies this skill into Benchook and into this project (both providers), so Claude loads it too. The original folder is left as it is."
      : "Writes this skill into this project for both providers. It stays the same skill everywhere.";
    add.onclick = () => { closeDetail(); takeExternalSkill(x); };
    dg.appendChild(add);
    /* A SKILL OUTSIDE THIS PROJECT CAN STILL BE DELETED. Removed from its last project, a skill stayed in
       Benchook as "no project yet" with no way to delete it: "Delete everywhere" lived only in the
       in-project view. Machine skills (~/.agents/skills) are not Benchook's to delete. */
    const record = x.source === 'machine' ? null : skillRegistryRecords.find((r) => r.folderName === x.folderName);
    if (record) {
      const remove = document.createElement('button');
      remove.textContent = "Delete everywhere";
      remove.onclick = async () => {
        const where = record.projects || [];
        const question = [x.name + " — delete this skill everywhere?", '',
          where.length ? removalList(where) : "It is in no project.", '', "This also removes it from Benchook."].join('\n');
        if (!await confirm(question)) return;
        const r = await window.panel.deleteSkill(x.folderName);
        if (r && r.error) { writeStatus("Could not delete.", r.error); return; }
        writeStatus('"' + x.name + '"' + (r.deleted ? " deleted." : " was not fully deleted."),
          [...(r.removedPaths || []), ...(r.errors || []).map((h) => (h.project || '') + ': ' + h.error)].join('\n'));
        closeDetail();
        refreshSkills();
      };
      dg.appendChild(remove);
    }
  }
  const cancel = document.createElement('button');
  cancel.textContent = x.builtin ? "Close" : "Cancel";
  cancel.onclick = closeDetail;
  dg.appendChild(cancel);
  k.appendChild(dg);
  g('overlay').style.display = 'block';
}

/* ADDING GOES THROUGH TWO DOORS - a skill in the registry is added with a membership (the same
   person); one sitting on the machine is first taken into the registry (the source folder is not
   touched) and then added. On both paths the paths to be written are shown FIRST (safety contract). */
async function takeExternalSkill(x) {
  // The files listed in the question are the ones written, even if the project changes meanwhile.
  const proj = project;
  const paths = await window.panel.skillPaths(proj, x.folderName);
  const machine = x.source === 'machine';
  const question = [x.name + " — add this skill to the project?", '',
    machine ? "Source folder (left unchanged): " + x.filePath : "Already in: " + (x.project || "no project yet"),
    '', "Files to create:", ...paths].join('\n');
  if (!await confirm(question)) return;
  const r = await settle(machine
    ? window.panel.importSkill(proj, x.filePath, x.folderName)
    : window.panel.addSkillToProject(proj, x.folderName));
  if (r && r.error) { writeStatus("Could not add skill.", r.error); return; }
  writeStatus('"' + x.name + "\" added to this project.", (r.written || []).join('\n'));
  refreshSkills();
}

/** A new skill: name, when to use it, and a body. Written to both sides at once. */
function skillForm() {
  historyOpen = false; openAgent = null; detailInstalled = null; formOpen = true;
  const k = g('detail');
  k.textContent = '';

  const close = document.createElement('button');
  close.id = 'closeButton'; close.textContent = 'Close'; close.onclick = closeDetail;
  k.appendChild(close);
  const b = document.createElement('h3');
  b.textContent = "New skill";
  k.appendChild(b);

  if (!project) {
    const u = document.createElement('div');
    u.className = 'warning-2'; u.textContent = "Open a project folder first (Overview → Open project).";
    k.appendChild(u); g('overlay').style.display = 'block'; return;
  }

  const descriptor = document.createElement('div');
  descriptor.className = 'meta';
  descriptor.id = 'skillFormPlace';
  descriptor.textContent = "Creates a skill for both Claude and Codex.";
  k.appendChild(descriptor);

  const form = document.createElement('div');
  form.style.marginTop = '12px';
  form.appendChild(setupField('skillFormName', "Name", "Lowercase letters, numbers, and hyphens.", 1, null,
    "Used as the folder name and skill identifier."));
  form.appendChild(setupField('skillFormWhen', "When to use",
    "Helps the orchestrator select this skill.", 3, null,
    "Saved in the SKILL.md description field."));
  form.appendChild(setupField('skillFormBody', "Instructions", '', 10, null,
    "Instructions the orchestrator follows when using this skill."));
  k.appendChild(form);

  const output = document.createElement('div');
  k.appendChild(output);

  const dg = document.createElement('div');
  dg.className = 'buttons';
  const write = document.createElement('button');
  write.textContent = "Create";
  write.onclick = async () => {
    output.textContent = '';
    const name = (g('skillFormName').value || '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      output.appendChild(setupWarning("Use lowercase letters, numbers, and hyphens for the name.")); return;
    }
    const description = (g('skillFormWhen').value || '').trim().replace(/\s+/g, ' ');
    if (!description) {
      output.appendChild(setupWarning("Add a usage description so the orchestrator can select this skill."));
      return;
    }
    const body = (g('skillFormBody').value || '').trim();
    if (!body) { output.appendChild(setupWarning("Instructions cannot be empty.")); return; }
    if (skills.some((x) => x.folderName === name)) {
      output.appendChild(setupWarning('"' + name + "\" already exists in this project.")); return;
    }
    /* A SKILL NAME IS ONE NAME ACROSS PROJECTS. A new skill named like one in another project used to be
       saved into that project too, overwriting it, while the question listed only this project's files. */
    const proj = project;   // the question lists this project's files; the write goes to the same place
    const known = await window.panel.skillRegistry(proj).catch(() => null);
    if (known && (known.records || []).some((x) => x.folderName === name)) {
      output.appendChild(setupWarning('"' + name + "\" is already a skill in another project. Choose another name, "
        + "or add the existing skill to this project from Skills.")); return;
    }
    // Quoted and escaped: a description with ": " or a leading "#" would otherwise break the header.
    const content = ['---', 'name: ' + name, 'description: ' + JSON.stringify(description), '---', '',
      body, ''].join('\n');
    const paths = await window.panel.skillPaths(proj, name);
    if (!await confirm(['"' + name + "\" — create this skill?", '',
      "Files to create:", ...paths].join('\n'))) return;
    const r = await settle(window.panel.writeSkill(proj, name, content));
    if (r && r.error) { output.appendChild(setupWarning(r.error)); return; }
    writeStatus('"' + name + "\" created.", (r.written || []).join('\n'));
    closeDetail();
    refreshSkills();
  };
  dg.appendChild(write);
  const cancel = document.createElement('button');
  cancel.textContent = "Cancel";
  cancel.onclick = closeDetail;
  dg.appendChild(cancel);
  k.appendChild(dg);
  g('overlay').style.display = 'block';
}

/* ---------------- TOOLTIP BALLOON ----------------
 *
 * The window that appears on hover should have a frame that matches the program.
 *
 * The `title` balloon of the operating system cannot be styled: its colour, frame and font belong to
 * Windows. That is why the panel draws its own balloon.
 *
 * HOW: on hovering over something that carries a `title`, the text is moved to `data-hint` and the
 * `title` is emptied -- that is the only way to silence the native balloon. It is put back when the
 * pointer leaves, so the attribute is never permanently lost; screen tests can go on reading `title`.
 *
 * It does not touch the safety constraints of the panel: it writes nothing and sends nothing. */
{
  const tooltip = document.createElement('div');
  tooltip.id = 'tooltip';
  tooltip.hidden = true;
  document.body.appendChild(tooltip);

  let opened = null;      // the element whose text was borrowed
  let borrowed = [];       // elements whose title was taken temporarily: the element and its ancestors with a title
  let time = null;

  /* TWO BALLOONS. Measured with real mouse events: while the balloon is open the card and the status
     line are REDRAWN every second and the redraw writes the `title` back; Windows saw it and opened
     its own balloon as well. Borrowing is not enough: the moment the title of a borrowed element fills
     again it is taken again (MutationObserver), and the balloon text stays current. The chain of
     ancestors is under the same guard. Everything is given back when the pointer leaves. */
  const scout = new MutationObserver((records) => {
    for (const k of records) {
      const el = k.target;
      const created = el.getAttribute && (el.getAttribute('title') || '').trim();
      if (!created || !borrowed.includes(el)) continue;
      el.dataset.hint = created;
      el.title = '';
      if (el === opened) tooltip.textContent = created;
    }
  });
  const hide = () => {
    if (time) { clearTimeout(time); time = null; }
    scout.disconnect();
    for (const el of borrowed) {
      if (el.dataset.hint !== undefined) { el.title = el.dataset.hint; delete el.dataset.hint; }
    }
    borrowed = [];
    opened = null;
    tooltip.hidden = true;
  };

  /* The balloon is placed BELOW the pointer; if it would overflow the screen it is pulled back in. */
  const insert = (x, y) => {
    tooltip.hidden = false;
    const b = tooltip.getBoundingClientRect();
    const space = 14;
    let left = x + space;
    let top = y + space;
    if (left + b.width > window.innerWidth - 8) left = Math.max(8, x - b.width - space);
    if (top + b.height > window.innerHeight - 8) top = Math.max(8, y - b.height - space);
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  };

  document.addEventListener('mouseover', (o) => {
    const el = o.target && o.target.closest ? o.target.closest('[title]') : null;
    if (!el || el === opened) return;
    const text = (el.getAttribute('title') || '').trim();
    if (!text) return;
    hide();
    opened = el;
    for (let p = el; p && p.getAttribute; p = p.parentElement) {
      if (!p.hasAttribute('title')) continue;
      p.dataset.hint = p.getAttribute('title');
      p.title = '';
      borrowed.push(p);
      scout.observe(p, { attributes: true, attributeFilter: ['title'] });
    }
    tooltip.textContent = text;
    // A short delay: the balloon must not jump around while the pointer is passing OVER something.
    time = setTimeout(() => insert(o.clientX, o.clientY), 260);
  });

  document.addEventListener('mousemove', (o) => {
    if (opened && !tooltip.hidden) insert(o.clientX, o.clientY);
  });

  document.addEventListener('mouseout', (o) => {
    if (!opened) return;
    const visited = o.relatedTarget;
    if (visited && opened.contains && opened.contains(visited)) return;
    hide();
  });

  // A click, a scroll or a window change closes the balloon, so it is never left hanging on screen.
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
}

/* Text for the user to PASTE into the orchestrator. The panel does not send it -- safety contract. */
function invocationText(agent, description, task) {
  const name = agent.name;
  const enabledAccount = panes[0]?.accountId || null;
  const enabled = enabledAccount ? ("Active orchestrator account in Benchook: `" + enabledAccount + '`.')
    : "The active orchestrator account is unknown. Identify it before choosing a route.";
  return [
      "A new agent is available in this project: `" + name + '` (.benchook/agents/' + name + '.md).',
      "Agent configuration: provider `" + (agent.provider || "See definition") + '`, account `' + agent.account + '`.',
      enabled,
      "Use a native subagent only when both provider and account match your own. When the account",
      "or provider differs, use the `run_agent` tool on the `worker` MCP server",
      "with this agent name (agent: \"" + name + '").',
      '',
      "When to use: " + String(description).replace(/\s+/g, ' ').trim(),
      '',
      "Instructions: " + String(task).replace(/\s+/g, ' ').trim().slice(0, 400),
      '',
      "Choose the matching execution route, invoke this agent, and report its result.",
  ].join('\n');
}

g('agentCreate').onclick = () => agentForm();
g('projectSetupComplete').onclick = () => completeSetup(true);
const skillSetupButton = g('skillCreate');
if (skillSetupButton) skillSetupButton.onclick = () => skillForm();
g('accountAdd').onclick = accountForm;
refreshRegistry();
setInterval(() => refreshRegistry(false), 5000); // Coalesce slow polling; explicit changes may supersede it.
g('historyOpen').onclick = async () => {
  historyOpen = true; openAgent = null; formOpen = false; historySignature = '';
  await refreshDefinitions();
  await refreshProjectRuns();
  renderHistory(lastList);
};
/* Collapse or expand the agent area - bound per page. */
function setupFolding(root) {
  root.querySelector('[data-role="fold"]').onclick =
    () => { terminalOnly = true; gridVisible(cards.size > 0); saveLayout(); };
  root.querySelector('[data-role="strip"]').onclick =
    () => { terminalOnly = false; gridVisible(cards.size > 0); saveLayout(); };
}
for (const d of document.querySelectorAll('button[data-place]')) {
  d.onclick = () => selectLayout(d.dataset.place);
}
for (const b of document.querySelectorAll('#sidebarTabs button')) {
  b.onclick = () => {
    selectTab(b.dataset.tab);
    // Pressing the tab refreshes the list WITHOUT WAITING; waiting ten seconds for the timer and
    // looking at the old list felt as if the button did not work.
    if (b.dataset.tab === 'agents') refreshDefinitions();
    saveLayout();
  };
}
g('projectPick').onclick = async () => {
  const p = await window.panel.pickProject();
  if (!p) return;
  // If the selected project is already open, `changeProject` returns quietly and nothing happens on
  // screen; the user would think the button does not work. The reason is written.
  if (p === project) { writeStatus("This project is already open.", p); return; }
  // The list row and the folder picker must use THE SAME switch path. This button used to write only
  // the `project` variable; because the projectState record of the target was not read, the pages and
  // the assigned orchestrator looked as if built from scratch.
  await changeProject(p);
};
g('settingsOpen').onclick = openSettings;
g('settingsClose').onclick = closeSettings;
g('handoverFile').onchange = saveHandoverFile;
g('settingsOverlay').onclick = (e) => { if (e.target === g('settingsOverlay')) closeSettings(); };
document.addEventListener('keydown', (e) => {
  if (g('settingsOverlay').hidden) return;
  if (e.key === 'Escape') { closeSettings(); return; }
  if (e.key !== 'Tab') return;
  const focusable = [...g('settingsBox').querySelectorAll('button:not([disabled]), input:not([disabled])')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/* ---------------- startup ---------------- */
(async () => {
  /* An unreadable layout used to stop the startup here with no tabs and no message. The panel now opens
     with defaults and says why; the file itself is not overwritten (saving reads it first and fails). */
  let registered = await settle(window.panel.readLayout());
  if (registered && registered.error) {
    showError("Could not read the saved layout", registered.error);
    registered = null;
  }
  applyTheme(registered && registered.theme);
  handoverFile = (registered && typeof registered.handoverFile === 'string') ? registered.handoverFile : '';
  if (registered && Number.isFinite(registered.textSize)) textSize = Math.min(24, Math.max(9, registered.textSize));
  project = (registered && registered.project) || null;
  if (registered && Array.isArray(registered.projects)) {
    // Duplicates from an older layout file collapse into one row (the first form seen is kept).
    projects = [];
    for (const y of registered.projects) if (y && !projects.some((x) => sameProject(x, y))) projects.push(y);
  }
  const dr = (registered && registered.projectState && project && registered.projectState[project]) || null;
  if (dr && dr.sidebarTab) selectTab(dr.sidebarTab);
  showProject();
  renderProjectList();
  // The agent list used to be drawn once at startup BEFORE the project was known; with Agents as the
  // saved tab the screen opened on an empty list and waited ten seconds for the timer.
  refreshDefinitions();
  await setupPages(dr);
  if (!project) writeEmptyGive();
})();


/* ---------------- sayfalar ---------------- */

function sumPageStatus(sy) {
  if (!sy) return;
  sy.panes = panes.slice();
  sy.cards = new Map(cards);
  sy.enabled = enabled;
  sy.layout = layout;
  sy.layoutReversed = layoutReversed;
  sy.terminalOnly = terminalOnly;
  sy.terminalHidden = terminalHidden;
  sy.shareRatio = shareRatio;
  sy.projectRuns = projectRuns;
}

function applyPageStatus(sy) {
  panes.length = 0;
  for (const b of (sy.panes || [])) panes.push(b);
  cards.clear();
  for (const [k, v] of (sy.cards || new Map())) cards.set(k, v);
  enabled = sy.enabled || null;
  layout = sy.layout || 'stacked';
  layoutReversed = !!sy.layoutReversed;
  terminalOnly = !!sy.terminalOnly;
  terminalHidden = !!sy.terminalHidden;
  shareRatio = sy.shareRatio || shareRatio;
  projectRuns = sy.projectRuns || [];
}

function createPage(status) {
  const pattern = g('pageTemplate');
  const root = pattern.content.firstElementChild.cloneNode(true);
  projectField(project).root.appendChild(root);
  pageCounter++;
  const sy = {
    id: (status && status.id) || 'page-' + Date.now().toString(36) + '-' + pageCounter,
    name: (status && status.name) || 'Panel ' + pageCounter,
    root,
    panes: [], cards: new Map(), enabled: null,
    layout: (status && status.layout) || 'stacked',
    layoutReversed: !!(status && status.layoutReversed),
    terminalOnly: !!(status && status.terminalOnly),
    terminalHidden: !!(status && status.terminalHidden),
    shareRatio: (status && status.split) || null,
    projectRuns: [],
    orchestrator: (status && status.orchestrator) || null,
  };
  // The own divider, drag-and-drop targets and collapse buttons of this page are bound.
  setupSeparatorY(root);
  dragDropSetup(root);
  setupFolding(root);
  root.hidden = true;
  pages.push(sy);
  return sy;
}

async function goToPage(id, first = false) {
  if (!first && workspaceBlocked()) return;
  const target = pages.find((x) => x.id === id);
  if (!target || (activePage === target && !first)) return;
  if (activePage) { sumPageStatus(activePage); activePage.root.hidden = true; }
  activePage = target;
  target.root.hidden = false;
  measureStep("Switch tab: restore state", () => applyPageStatus(target));
  // A tab whose terminal closed or failed while it was in the background says what it holds now.
  if (!panes.length && !(sg('topRight') && sg('topRight').querySelector('.picker'))) writeEmptyGive();
  measureStep("Switch tab: apply layout", () => applyLayout());
  gridVisible(cards.size > 0);
  applyShare();
  measureStep("Switch tab: resize terminals", () => measureAll());   // what could not be measured while hidden
  // The one-orchestrator-per-page rule is PER PAGE, but the disabled state of the buttons did not
  // travel with the page: with an orchestrator running on Panel 1, switching to Panel 2 left the
  // buttons disabled and no orchestrator could be started on that page.
  // The change mode does not belong to a page either; it drops on a page switch, otherwise a button
  // saying apply change would linger on the new page.
  orchChangeMode = false;
  renderAccountMenu();
  refreshButtons();
  // The account and model boxes and the worker connection line belong to the PAGE as well: without a
  // refresh, the model and connection state of the previous page stayed on top of the new one.
  measureStep("Switch tab: refresh model", () => refreshOrchModel());
  measureStep("Switch tab: refresh MCP status", () => refreshMcpStatus());
  measureStep("Switch tab: refresh sidebar", () => refreshLeft());
  measureStep("Switch tab: render tabs", () => renderPageStrip());
  /* On a new page it must be clear where TYPING WILL GO. On the close-page path, when the last pane
     closed focus stayed nowhere; that was exactly the scenario the user described - opening an
     orchestrator and then closing that panel. A page switch should have handed focus over too, and
     did not. */
  if (panes.length) {
    const targetPane = enabled && panes.includes(enabled) ? enabled : panes[0];
    makeEnabled(targetPane);
  }
  saveLayout();
}

/* TABS: RENAMING AND REORDERING - panels can be renamed, and their positions on that row changed
   (moving A to the left or right of B).

   RENAMING ALREADY EXISTED, but by double click and WRITTEN NOWHERE; a feature the user does not know
   about does not exist for them. It is now stated in the tooltip.

   REORDERING is by dragging. A dragged tab moves to the FAR side of the neighbour whose half it
   passes -- exactly where the pointer is released, with no nearest-gap guessing. The dropped
   position is saved to the layout, so the panel reopens in the same order.

   NO CLASH WITH CLICKING: when a drag starts a mark is set, and `click` does not switch pages when it
   sees that mark. Otherwise every drag would also be a tab switch. */
let dragTab = null;

function renderPageStrip() {
  const container = g('pageTabs');
  if (!container) return;
  container.textContent = '';
  for (const sy of pages) {
    const r = document.createElement('div');
    r.className = 'result-row' + (sy === activePage ? ' selected' : '');
    r.draggable = true;
    r.dataset.pageId = sy.id;
    const nk = document.createElement('span');
    nk.className = 'status-dot';
    // Green only while a process runs: an exited terminal still on screen is not running.
    const running = (sy === activePage ? panes : sy.panes || []).some((b) => b && b.id);
    nk.style.background = running ? 'var(--green)' : '#33322f';
    const t = document.createElement('span');
    t.className = 'result-name';
    const waiting = waitingTabs.has(sy.id);
    t.textContent = sy.name + (waiting ? ' ?' : '');
    if (waiting) nk.style.background = 'var(--yellow)';
    r.appendChild(nk); r.appendChild(t);
    r.title = sy.name + String.fromCharCode(10)
      + (waiting ? "An agent on this tab is waiting for your permission." + String.fromCharCode(10) : '')
      + "Double-click to rename · Drag to reorder";
    r.onclick = () => { if (r.dataset.dragging === '1') return; goToPage(sy.id); };
    const changeName = async () => {
      const name = await askText("Tab name:", sy.name);
      if (name && name.trim()) { sy.name = name.trim(); renderPageStrip(); saveLayout(); }
    };
    r.ondblclick = changeName;

    r.ondragstart = (o) => {
      dragTab = sy.id;
      r.dataset.dragging = '1';
      r.classList.add('dragging');
      // Some environments never start a drag that carries no data; the content itself is not used.
      try { o.dataTransfer.setData('text/plain', sy.id); } catch { /* not important */ }
      o.dataTransfer.effectAllowed = 'move';
    };
    r.ondragend = () => {
      dragTab = null;
      delete r.dataset.dragging;
      r.classList.remove('dragging');
      for (const x of container.children) x.classList.remove('drop-left', 'drop-right');
    };
    r.ondragover = (o) => {
      if (dragTab === null || dragTab === sy.id) return;
      o.preventDefault();
      o.dataTransfer.dropEffect = 'move';
      const k = r.getBoundingClientRect();
      const left = (o.clientX - k.left) < k.width / 2;
      r.classList.toggle('drop-left', left);
      r.classList.toggle('drop-right', !left);
    };
    r.ondragleave = () => r.classList.remove('drop-left', 'drop-right');
    r.ondrop = (o) => {
      o.preventDefault();
      const source = dragTab;
      r.classList.remove('drop-left', 'drop-right');
      if (source === null || source === sy.id) return;
      const k = r.getBoundingClientRect();
      const left = (o.clientX - k.left) < k.width / 2;
      const i = pages.findIndex((x) => x.id === source);
      if (i < 0) return;
      const [carried] = pages.splice(i, 1);
      // The position of the target is found again AFTER the removal: if the source was to its left the index has shifted.
      const h = pages.findIndex((x) => x.id === sy.id);
      pages.splice(left ? h : h + 1, 0, carried);
      dragTab = null;
      renderPageStrip();
      saveLayout();
    };

    if (pages.length > 1) {
      const x = document.createElement('span');
      x.className = 'close';
      x.textContent = '✕';
      x.title = "Close tab";
      x.onclick = (e) => { e.stopPropagation(); closePage(sy.id); };
      r.appendChild(x);
    }
    container.appendChild(r);
  }
}

async function closePage(id) {
  return changeWorkspace(() => closePageOwned(id));
}
async function closePageOwned(id) {
  mark("Close tab");
  if (pages.length < 2) return;
  const sy = pages.find((x) => x.id === id);
  if (!sy) return;
  const openPane = (sy === activePage ? panes : sy.panes || []);
  if (openPane.length && !await confirm(sy.name + " — close this tab and its terminal?")) return;
  // One loop for the active and a background tab: `closePane` already tells the two apart. The list is
  // taken again after the question, in case the active tab changed while it was open.
  for (const b of [...(sy === activePage ? panes : sy.panes || [])]) {
    if (b.id) {
      const stopped = await settle(window.panel.closeTerminalAndWait(b.id));
      if (!stopped?.done) { writeStatus('Could not close tab.', stopped?.error || 'Terminal shutdown failed.'); return; }
    }
    closePane(b, true);
  }
  if (sy.root.releaseDragDrop) sy.root.releaseDragDrop();
  measureStep("Close tab: remove DOM", () => sy.root.remove());
  pages = pages.filter((x) => x !== sy);
  if (sy === activePage) {
    activePage = null;
    await measureStepAsync("Close tab: activate next tab", () => goToPage(pages[0].id, true));
  }
  else { renderPageStrip(); saveLayout(); }
}

/* Builds the pages of a project. With no record a single page opens - the same as the old behaviour. */
async function setupPages(dr) {
  try { await pagesSetupInner(dr); }
  catch (e) { showError("Could not restore tabs", e); }
}

async function pagesSetupInner(dr) {
  // Deleting only what is in the array is not enough: once the array and the DOM drift apart an orphaned
  // body remains and an extra terminal appears on screen. The container is emptied completely.
  // ONLY THE FIELD OF THIS PROJECT is emptied; if `#right` were deleted wholesale, the running
  // terminals of the background projects would go too.
  const container = projectField(project).root;
  while (container.firstChild) container.removeChild(container.firstChild);
  pages = [];
  activePage = null;
  pageCounter = 0;
  const record = (dr && Array.isArray(dr.pages) && dr.pages.length)
    ? dr.pages
    : [{ name: 'Panel 1', orchestrator: dr && dr.orchestrator, layout: dr && dr.layout,
         layoutReversed: dr && dr.layoutReversed, terminalOnly: dr && dr.terminalOnly,
         terminalHidden: dr && dr.terminalHidden, split: dr && dr.split }];
  for (const k of record) createPage(k);
  // "+" continues after the highest restored "Panel N", so closing Panel 1 and restarting cannot give two "Panel 3".
  pageCounter = Math.max(pageCounter, ...pages.map((sy) => Number((/^Panel (\d+)$/.exec(sy.name) || [])[1]) || 0));
  // The orchestrator of each page opens while its own page is active (createPane writes to the active page).
  // That is how the terminals of background pages start running as well.
  for (const sy of pages) {
    await goToPage(sy.id, true);
    const orch = sy.orchestrator;
    if (orchInstallable(orch)) {
      createPane(orch.provider, orch.sessionId || null, orch.label || orch.provider, orch.accountId, orch.model, orch.connection || null);
    } else if (orch && orch.provider) {
      selectOldOrchestrator(orch);
    } else {
      writeEmptyGive();
    }
  }
  const requested = (dr && dr.activePage && pages.find((x) => x.id === dr.activePage))
    ? dr.activePage : pages[0].id;
  await goToPage(requested, true);
  renderPageStrip();
}

g('pageAdd').onclick = async () => {
  if (workspaceBlocked()) return;
  const sy = createPage(null);
  await goToPage(sy.id);
  renderPageStrip();
  writeEmptyGive("Start an orchestrator from the sidebar.");
};

/* ═══════════════════════ SEARCH ═══════════════════════════════════════════════
 * Search really searches, with no Ctrl+K needed: you click the box and type what you are looking for.
 * So there is no shortcut: click the box, type, pick a result.
 *
 * WHAT IT SEARCHES: the agents of this project, the account registry, the known projects, the open
 * pages and the own commands of the panel. All of it is data ALREADY ON SCREEN - search invents no
 * new source, it only opens a quick path.
 *
 * WHAT IT DOES NOT DO: it calls no model, reads no file and makes no network request. A chosen result
 * calls exactly the action that can be done by hand in the panel.
 */
const searchTrLower = (m) => String(m || '').toLocaleLowerCase('en-US');

function searchCommands() {
  return [
    { name: "Layout: stacked", hint: "Terminal above", make: () => selectLayout('stacked') },
    { name: "Layout: side by side", hint: "Terminal on the left", make: () => selectLayout('sideBySide') },
    { name: "Layout: terminal only", hint: '', make: () => selectLayout('terminalOnly') },
    { name: "Layout: agents only", hint: '', make: () => selectLayout('agentsOnly') },
    { name: "New tab", hint: "This project", make: () => g('pageAdd')?.click() },
    { name: "Agent activity", hint: "History", make: () => g('historyOpen')?.click() },
    { name: "Skills", hint: "Sidebar", make: () => selectTab('skills') },
    { name: "Agents", hint: "Sidebar", make: () => selectTab('agents') },
    { name: "Overview", hint: "Sidebar", make: () => selectTab('status') },
    { name: "Open project…", hint: '', make: () => g('projectPick')?.click() },
    { name: "Set up MCP connection", hint: '', make: () => { const b = g('mcpSetup'); if (b && !b.disabled) b.click(); } },
  ];
}

/** Show the agent in the left column and highlight it briefly - it SHOWS what it found, it does not pass over it silently. */
function searchAgentShow(name) {
  selectTab('agents');
  const target = [...document.querySelectorAll('#sidebar .agent-card')]
    .find((e) => searchTrLower(e.querySelector('.agent-name')?.textContent) === searchTrLower(name));
  if (!target) return;
  target.scrollIntoView({ block: 'center' });
  target.classList.add('search-highlight');
  setTimeout(() => target.classList.remove('search-highlight'), 1600);
  target.click();
}

/** Puts the account into the orchestrator picker; otherwise it only switches to the Status tab. */
function searchAccountSelect(id) {
  selectTab('status');
  const select = g('orchestratorAccount');
  if (select && [...select.options].some((o) => o.value === id)) {
    select.value = id;
    select.dispatchEvent(new Event('change'));
  }
}

function searchResults(query) {
  const s = searchTrLower(query).trim();
  if (!s) return [];
  const warn = (m) => searchTrLower(m).includes(s);
  const output = [];

  // Search is not limited to the active project. The definitions of other projects shown on the
  // Agents tab are searched too; if a local agent of the same name exists only one result is shown.
  const wantedAgents = [];
  const seenAgents = new Set();
  for (const a of [...definedAgents.filter((x) => !x.undefinedDef), ...externalAgents]) {
    const key = searchTrLower(a.name);
    if (seenAgents.has(key)) continue;
    seenAgents.add(key);
    wantedAgents.push(a);
  }
  for (const a of wantedAgents) {
    const shown = agentNames(a);
    if (!warn(a.name) && !warn(a.model) && !warn(a.account) && !warn(shown.account) && !warn(shown.model)) continue;
    output.push({ group: "Agents", rz: '◆', name: a.name,
      hint: [a.projectName, shown.account, shown.model].filter(Boolean).join(' · '),
      make: () => searchAgentShow(a.name) });
  }
  for (const h of registry) {
    if (!warn(h.name) && !warn(h.provider)) continue;
    output.push({ group: "Accounts", rz: h.provider === 'codex' ? 'X' : 'C', name: h.name,
      hint: accountSignIn(h) ? h.provider : h.provider + " · Signed out",
      make: () => searchAccountSelect(h.id) });
  }
  for (const y of projects) {
    if (!warn(y)) continue;
    output.push({ group: "Projects", rz: '▣', name: y.split(/[\\/]/).pop() || y, hint: y,
      make: () => changeProject(y) });
  }
  for (const sy of pages) {
    if (!warn(sy.name)) continue;
    output.push({ group: 'Tabs', rz: '▤', name: sy.name,
      hint: sy === activePage ? "Open" : '', make: () => goToPage(sy.id) });
  }
  for (const k of searchCommands()) {
    if (!warn(k.name)) continue;
    output.push({ group: 'Commands', rz: '›', name: k.name, hint: k.hint, make: k.make });
  }
  return output.slice(0, 40);
}

let searchSelected = -1;
let searchList = [];

function searchRender(query) {
  const box = g('searchResults');
  if (!box) return;
  searchList = searchResults(query);
  searchSelected = searchList.length ? 0 : -1;
  if (!query.trim()) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  if (!searchList.length) {
    box.innerHTML = "<div class=\"empty\">No results found.</div>";
    return;
  }
  let html = '', previousGroup = '';
  searchList.forEach((r, i) => {
    if (r.group !== previousGroup) { html += '<div class="group">' + r.group + '</div>'; previousGroup = r.group; }
    html += '<div class="result' + (i === 0 ? ' selected' : '') + '" data-i="' + i + '">'
      + '<span class="badge-mini">' + r.rz + '</span><span class="name"></span>'
      + '<span class="hint"></span></div>';
  });
  box.innerHTML = html;
  // The text is written separately: agent and project names are data of the user and are never printed as HTML.
  [...box.querySelectorAll('.result')].forEach((e) => {
    const r = searchList[Number(e.dataset.i)];
    e.querySelector('.name').textContent = r.name;
    e.querySelector('.hint').textContent = r.hint || '';
    e.onmousedown = (o) => { o.preventDefault(); searchSelect(Number(e.dataset.i)); };
  });
}

function searchHighlight(i) {
  const box = g('searchResults');
  if (!box) return;
  searchSelected = i;
  [...box.querySelectorAll('.result')].forEach((e, k) => {
    e.classList.toggle('selected', k === i);
    if (k === i) e.scrollIntoView({ block: 'nearest' });
  });
}

function searchSelect(i) {
  const r = searchList[i];
  if (!r) return;
  searchClose();
  // An action can be async (opening a page): its rejection is reported too, not only a thrown error.
  try { Promise.resolve(r.make()).catch((e) => writeStatus("Action failed.", errorText(e))); }
  catch (e) { writeStatus("Action failed.", errorText(e)); }
}

function searchClose() {
  const field = g('searchInput'), box = g('searchResults'), clearButton = g('searchClear');
  if (field) field.value = '';
  if (box) { box.hidden = true; box.innerHTML = ''; }
  if (clearButton) clearButton.hidden = true;
  searchList = []; searchSelected = -1;
}

(function setupSearch() {
  const field = g('searchInput');
  if (!field) return;
  field.addEventListener('input', () => {
    g('searchClear').hidden = !field.value;
    searchRender(field.value);
  });
  field.addEventListener('keydown', (o) => {
    if (o.key === 'ArrowDown') { o.preventDefault(); searchHighlight(Math.min(searchSelected + 1, searchList.length - 1)); }
    else if (o.key === 'ArrowUp') { o.preventDefault(); searchHighlight(Math.max(searchSelected - 1, 0)); }
    else if (o.key === 'Enter') { o.preventDefault(); searchSelect(searchSelected); }
    else if (o.key === 'Escape') { o.preventDefault(); searchClose(); field.blur(); }
  });
  // The list closes when focus leaves the box; a click on a result is caught on `mousedown`, so it
  // runs before the close.
  field.addEventListener('blur', () => setTimeout(searchClose, 120));
  g('searchClear').onclick = () => { searchClose(); field.focus(); };
})();
