// Benchook - the main process.
//
// What it does: opens the window, spawns real PTYs, reads context-window usage from the session
// records, and writes the layout to disk.
//
// What it does NOT do: it never calls a model, never sends a command on behalf of the user, and
// never changes a file without approval (the safety constraints).

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const pty = require('@lydell/node-pty');
const product = require('./product');          // every name derived from the product name, in one place
const context = require('./sessions');
const quotaClaude = require('./quota-claude');
const quotaCodex = require('./quota-codex');
const writeAgent = require('./agent-writer');
const agentResolution = require('./agent-resolution');
const agentRegistry = require('./agent-registry');   // the ONE record of an agent
const agentSync = require('./agent-sync');       // writes that record into every project
const agents = require('./agent-runs');
const skills = require('./skills');
const skillRegistry = require('./skill-registry');   // a skill is a person too
const skillSync = require('./skill-sync');
const signInFlow = require('./login-flow');
const cliPath = require('./cli-path');
const account = require('./account-identity');
const accounts = require('./accounts');
const workerRecords = require('./worker-records');
const mcpStatus = require('./mcp-status');
const runSummary = require('./run-summary');
const projectSetup = require('./project-setup');
const handoverStatus = require('./handover-status');
const { normalizeLayout, layoutValid } = require('./layout-shape');
const persistentJson = require('./persistent-json');
const folderOperation = require('./folder-transaction');
const logCleanup = require('./log-cleanup');
const claudeContext = require('./claude-context');
const boundedLog = require('./bounded-log');
const traceStorage = require('./trace-storage');
const firstSetup = require('./onboarding');
const watcher = require('./watcher');
const security = require('./security');
const { stopTerminal } = require('./terminal-stop');

// Register all privileged handlers through the same trusted main-frame boundary.
const ipc = {
  handle(channel, handler) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!security.trustedSender(event, window, path.join(__dirname, 'index.html')))
        throw new Error('Untrusted IPC sender.');
      return handler(event, ...args);
    });
  },
  on(channel, handler) {
    ipcMain.on(channel, (event, ...args) => {
      if (security.trustedSender(event, window, path.join(__dirname, 'index.html')))
        handler(event, ...args);
    });
  },
};

const terminals = new Map();          // id -> pty process
const sessions   = new Map();          // id -> { provider, project, old, file, sessionId,... }
let nextId = 1;
let window = null;
const singleSample = app.requestSingleInstanceLock();
if (!singleSample) app.quit();
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });

/* CRASH RECORDING. The main process once died silently while a tab was being closed
   (Windows event 1000, ntdll 0xc0000374); there was not a single line in the own journal of the
   panel, and 121 concurrent closes against a temporary profile could not reproduce it. So that a
   stack trace exists next time: the own collector of Electron writes the minidump to a LOCAL folder
   and uploads it nowhere. Child process deaths (GPU, renderer, utility) also land in the stall
   journal - the death of the main process can only be seen as a dump, because nobody is left to
   write to the journal. */
const crashFolder = path.join(app.getPath('userData'), 'crash-dumps');
try {
  app.setPath('crashDumps', crashFolder);
  require('electron').crashReporter.start({ uploadToServer: false, compress: false,
    productName: product.NAME, companyName: product.NAME });
} catch { /* the recorder could not be set up; the panel still opens */ }
/* ONE DIAGNOSTICS JOURNAL. Crashes, stalls and focus events go to the same bounded file in the panel's
   data folder (not the project); writing it never blocks the panel. */
function writeStall(record) {
  try { boundedLog.add(path.join(app.getPath('userData'), 'stalls.jsonl'), { at: new Date().toISOString(), ...record }); }
  catch { /* the journal could not be kept; it does not stop the panel working */ }
}
function writeCrash(record) { writeStall({ side: 'crash', ...record }); }
app.on('child-process-gone', (_e, d) => writeCrash({ duration: 0,
  task: 'Child process gone: ' + d.type + (d.name ? ' ' + d.name : '') + ' — ' + d.reason + ' (exit ' + d.exitCode + ')' }));
app.on('render-process-gone', (_e, _w, d) => writeCrash({ duration: 0,
  task: 'Renderer gone: ' + d.reason + ' (exit ' + d.exitCode + ')' }));

const layoutFile = () => path.join(app.getPath('userData'), 'layout.json');
const switchMetricFile = () => path.join(app.getPath('userData'), 'switch-metrics.jsonl');

/* Clear inherited provider session variables through the shared accounts.cleanInherited policy. */
const cleanEnv = () => accounts.cleanInherited(process.env);

// --- Window ------------------------------------------------------------------
/* The layout file: the window and the known projects are GLOBAL, the rest belongs to a project
   (`projectState[<project path>]`). Its shape and the repair applied while reading it live in
   panel/layout-shape.js and are covered by tests. */
function readLayout() {
  const data = persistentJson.read(layoutFile(), layoutValid);
  return data ? normalizeLayout(data) : null;
}

function writeLayoutAtomic(data) {
  persistentJson.write(layoutFile(), data, layoutValid);
}

function setupWindow() {
  const registered = readLayout();
  window = new BrowserWindow({
    width: registered?.window?.width || 1400,
    height: registered?.window?.height || 880,
    x: registered?.window?.x,
    y: registered?.window?.y,
    title: product.NAME,
    icon: path.join(__dirname, 'benchook.ico'),
    show: process.env.BENCHOOK_TEST !== '1' || process.env.BENCHOOK_TEST_SHOW === '1',
    backgroundColor: '#09080b',   // so no light colour flashes while the theme is loading
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      /* SPELL CHECKING OFF. The Chromium checker runs against the language of the operating system
         and was underlining English agent instructions in red. The text in these forms is not natural
         language but instructions and code, and the language of the product is English. The decision
         of the user: no underlining at all. */
      spellcheck: false,
      /* Electron THROTTLES its timers and paint loop in an unfocused window (default: on). In this
         panel that slows down the terminal itself: PTY data keeps flowing in the main process while
         the page handles it late - what the user sees is letters appearing on screen with a delay
         that clears up on alt-tab. A terminal has to stay alive in the background; that is something
         the panel has already promised. */
      backgroundThrottling: false,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.loadFile(path.join(__dirname, 'index.html'), {
    query: { theme: typeof registered?.theme === 'string' ? registered.theme : 'pink' },
  });
  if (registered?.window?.maximized) window.maximize();

  window.on('close', (event) => {
    // Save the window geometry; the panes are saved separately by the page.
    try {
      const existing = readLayout() || {};
      // Save identities formed after the last timer round, or in the background, as well.
      for (const o of sessions.values()) {
        const status = o.contextFile && claudeContext.read(o.contextFile, o.project);
        if (status) o.sessionId = status.sessionId;
        context.sessionFile(o);
        if (!o.sessionId || !o.connection) continue;
        for (const status of Object.values(existing.projectState || {})) {
          for (const sy of (status.pages || [])) {
            if (sy.orchestrator?.connection === o.connection) sy.orchestrator.sessionId = o.sessionId;
          }
        }
      }
      const s = window.getNormalBounds();
      existing.window = { width: s.width, height: s.height, x: s.x, y: s.y, maximized: window.isMaximized() };
      fs.mkdirSync(path.dirname(layoutFile()), { recursive: true });
      writeLayoutAtomic(existing);
    } catch (e) {
      /* THE USER DECIDES, THE WINDOW IS NOT HELD HOSTAGE. A save that keeps failing (a full disk, a locked
         file) used to block closing for good: the only way out was Task Manager. */
      const choice = dialog.showMessageBoxSync(window, { type: 'error', title: "Could not save layout",
        message: "Benchook could not save your tabs and session details.",
        detail: e.message + "\n\nIf you close without saving, the tabs and sessions since the last save are not restored next time.",
        buttons: ["Keep window open", "Close without saving"], defaultId: 0, cancelId: 0, noLink: true });
      if (choice !== 1) event.preventDefault();
    }
  });

  window.on('closed', () => {
    for (const p of terminals.values()) { try { p.kill(); } catch { /* already dead */ } }
    terminals.clear();
    window = null;
  });
}

app.whenReady().then(() => {
  if (!singleSample) return;
  try {
    folderOperation.setup(path.join(app.getPath('userData'), 'folder-transactions'));
    readLayout();
  } catch (e) {
    dialog.showErrorBox("Could not recover saved data", e.message + "\nBenchook closed without replacing the saved data.");
    app.quit(); return;
  }
  // The account registry lives in the own data folder of the panel, not in the repository (personal paths).
  process.env.BENCHOOK_DATA_DIR = app.getPath('userData');
  accounts.setup(path.join(app.getPath('userData'), 'accounts.json'));
  agentRegistry.setup(path.join(app.getPath('userData'), 'agents.json'));
  skillRegistry.setup(path.join(app.getPath('userData'), 'skills.json'),
    path.join(app.getPath('userData'), 'skill-copies'));
  // The state before the settings file of a provider is touched is copied into the own folder of the panel.
  firstSetup.setup(path.join(app.getPath('userData'), 'first-run-backups'));
  const cleanTraces = () => {
    const live = [...sessions.entries()].filter(([id]) => terminals.has(id)).map(([, o]) => o);
    logCleanup.cleanup(path.join(app.getPath('userData'), 'session-traces'), live.map((o) => o.traceFile).filter(Boolean));
    // The read position of a closed Codex terminal's log is not kept for the rest of the session.
    require('./session-trace').keepOnly(live.map((o) => o.traceFile).filter(Boolean));
    logCleanup.cleanupContext(path.join(app.getPath('userData'), 'claude-context'), live.map((o) => o.contextFile).filter(Boolean));
  };
  cleanTraces();
  const cleanup = setInterval(cleanTraces, 3600000); cleanup.unref();
  setupWindow();

  ipc.handle('terminal:open', async (_o, { command, provider, sessionId, column, line, workingDirectory, accountId, orchestrator, model, connection: inherited }) => {
    const selected = accountId ? accounts.find(accountId) : null;
    if (orchestrator) {
      if (!accountId || !model) throw new Error("Select an account and model for the orchestrator.");
      if (!selected) throw new Error("The account of this session is no longer in Benchook. Add it again, or choose another account of the same provider.");
      if (selected.provider !== provider) throw new Error("The selected account does not match this provider.");
      if (!accounts.hasSignIn(selected)) throw new Error("The selected account is signed out.");
    }
    const shell = process.env.COMSPEC || 'powershell.exe';
    const id = nextId++;
    /* A handed-over connection identity is taken only when the same conversation continues and it is
       not in use by a live pane; otherwise a new one is generated. */
    const inheritable = typeof inherited === 'string' && /^[0-9a-f-]{36}$/i.test(inherited) && !!sessionId
      && ![...sessions.values()].some((o) => o && o.connection === inherited);
    const connection = inheritable ? inherited : randomUUID();
    // It can be opened with the environment of an ACCOUNT: the login terminal uses this, so the login
    // is written into the own identity folder of that account and no other account is touched.
    // The identity folder is created HERE TOO. There are older accounts that were added to the
    // registry without their folder being created; on those Codex says "CODEX_HOME... does not exist"
    // and never starts. Measured: a second Codex account could not be signed into.
    if (accountId) { try { accounts.prepareFolder(accounts.find(accountId)); } catch { /* the environment is still built */ } }
    const accountEnv = accountId ? accounts.env(accounts.find(accountId)) : null;
    if (accountEnv && (!accountEnv.TERM || accountEnv.TERM === 'dumb')) accountEnv.TERM = 'xterm-256color';
    let toRun = shell, args = [], traceFile = null, contextFile = null;
    let resumeWarning = null;   // the reason told to the page if the saved session was not found
    /* WHETHER IT REALLY RESUMED IS TOLD TO THE PAGE SEPARATELY. The page used to infer the
       "(resumed)" label from the presence of an identity; but a clean Claude start also generates an
       identity for `--session-id`, so a terminal opened from scratch said "(resumed)". The label is
       now produced only when the CLI was really told to resume. */
    let resumeDid = false;
    if (orchestrator) {
      const cli = cliPath.cliInvocation(provider);
      if (!cli) throw new Error(cliPath.cliMissing(provider));
      toRun = cli.command;
      args = [...cli.leadingArgs];
      if (provider === 'claude') {
        /* `--resume` IS NOT SAID FOR A SESSION WHOSE EXISTENCE WAS NOT VERIFIED - seen in a real run
           of the user: the terminal did not open at all and the process ended with exit code 1.
           The cause: the saved session identity sits IN THE LAYOUT but that record is not in the
           profile of the SELECTED ACCOUNT. It happens when an account is removed and re-added, when a
           page opened under another account is restored, or when the record is deleted. The panel was
           handing the identity to the CLI without verifying it, and the CLI rightly died.

           `findSessionFile` already did this check; it simply was never called on the start path. With
           no record a CLEAN session is opened and the reason is written for the user - the panel does
           not silently attach to another conversation, and it does not delete the record either. */
        if (sessionId) {
          const record = context.findSessionFile('claude', workingDirectory, sessionId,
            accounts.folderPath(selected));
          if (record) { args.push('--resume', sessionId); resumeDid = true; }
          else {
            resumeWarning = "Saved session (" + String(sessionId).slice(0, 8) + '…) '
              + (selected ? selected.name : "this") + " profile does not contain this session. "
              + "A new session was started. The original conversation is preserved and may belong to another account.";
            sessionId = randomUUID();
            args.push('--session-id', sessionId);
          }
        } else { sessionId = randomUUID(); args.push('--session-id', sessionId); }
        const node = cliPath.cliInvocation('node');
        if (node) {
          const target = path.join(app.getPath('userData'), 'claude-context', connection + '.json');
          const setting = claudeContext.setting(accounts.folderPath(selected), workingDirectory, target, node.command);
          if (setting) { args.push('--settings', JSON.stringify(setting)); contextFile = target; }
        }
      } else {
        /* THE SAME CHECK AS CLAUDE. A Codex session that is not in the selected account's folder (the
           account was re-added, or the tab was restored under another account) made Codex exit with an
           error and no explanation. Then a new session starts and the reason is said. */
        if (sessionId && !context.findSessionFile('codex', workingDirectory, sessionId, accounts.folderPath(selected))) {
          resumeWarning = "Saved session (" + String(sessionId).slice(0, 8) + '…) '
            + (selected ? selected.name : "this") + " profile does not contain this session. "
            + "A new session was started. The original conversation is preserved and may belong to another account.";
          sessionId = null;
        }
        if (sessionId) { args.push('resume', sessionId); resumeDid = true; }
        {
          const logDir = path.join(app.getPath('userData'), 'session-traces', randomUUID());
          fs.mkdirSync(logDir, { recursive: true });
          traceFile = path.join(logDir, 'codex-tui.log');
          args.push('-c', 'log_dir=' + JSON.stringify(logDir.replace(/\\/g, '/')));
          accountEnv.RUST_LOG = 'codex_core::codex=info,codex_core::session=info';
        }
        // The orchestrator runs from the account's own folder too: name the Windows sandbox, or Codex
        // rejects every command (`codex-windows.js`). The account's own choice, if any, is kept.
        args.push(...require('./codex-windows').sandboxArgs(selected ? accounts.folderPath(selected) : null));
      }
      if (model && model !== 'default') args.push('--model', model);
      /* THE MODEL IS WRITTEN INTO THE ENVIRONMENT TOO. The worker server, opened as a child
         of this terminal, can resolve the same-as-the-orchestrator choice only from here. What is
         carried is the choice of THIS terminal, not a global setting of the panel. */
      Object.assign(accountEnv, agentResolution.orchestratorEnv(model));
      if (cli.leadingArgs.length) accountEnv.ELECTRON_RUN_AS_NODE = '1';
    }
    // The pane will bind to ITS OWN session: take a snapshot of the folder before opening.
    // `kind` comes from outside, because the command may also be something like "claude --resume <id>".
    const accountFolder = selected ? accounts.folderPath(selected) : null;
    const newSession = provider ? { provider, project: workingDirectory,
      old: context.snapshot(provider, workingDirectory, accountFolder), file: null,
      sessionId: sessionId || null, accountFolder, traceFile, connection, contextFile,
      authId: null } : null;
    /* THE LOGIN IDENTITY OF THE TERMINAL. An observation belongs to whichever account the
       pane was opened with; the identity is read from the CLI (`auth status`) and `accounts:status`
       compares it with the current one. The old method (the stat stamp of.credentials.json) raised
       false alarms: the CLI recreates the file without the login changing. The read does not hold up
       the opening; until the result arrives the observation of the pane is not used (an unknown
       identity is not trusted, and does not count as changed either). */
    if (newSession && provider === 'claude' && accountFolder) {
      /* THE IDENTITY IS READ BEFORE THE OPENING - measured: a read delayed by 3 s wrote a login that
         had changed after the terminal opened into the pane, so the observation of the pane (the old
         login) was shown against the new account. A CLI process reads its login information as it
         starts; the identity is read at the same moment, before the process is spawned (~300 ms
         measured). Past 1500 ms the opening does not wait and the delayed read below takes over; on
         that path the window exists again and is accepted knowingly. */
      const onRead = await Promise.race([
        account.claude(accountFolder).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 1500)),
      ]);
      const onId = account.signInIdentity(onRead);
      if (onId) newSession.authId = onId;
      const readId = (remaining) => account.claude(accountFolder).then((k) => {
        const g = account.signInIdentity(k);
        if (g) newSession.authId = g;
        else if (remaining > 0) setTimeout(() => readId(remaining - 1), 5000);
      }).catch(() => { if (remaining > 0) setTimeout(() => readId(remaining - 1), 5000); });
      // The first read is 3 s later, so the measured window in which the CLI recreates the file (1-2 s
      // after startup) does not defeat the stat guard inside `account.claude`. The observation
      // arrives about 15 s later anyway.
      if (!onId) setTimeout(() => readId(2), 3000);
    }
    /* THIS PANE IS ITS OWN SESSION. The catalogue hook keeps what a session last heard per
       session; when the harness supplies no session identity of its own, this identity from the panel
       is used. Unique per pane and constant for the life of that pane. */
    const terminalEnv = accountEnv || cleanEnv();
    terminalEnv.BENCHOOK_SESSION = connection;
    const p = pty.spawn(toRun, args, {
      name: 'xterm-256color',
      cols: column || 80,
      rows: line || 24,
      cwd: workingDirectory || os.homedir(),
      env: terminalEnv,
    });
    if (newSession) sessions.set(id, newSession);
    terminals.set(id, p);
    p.onData((data) => { if (window && !window.isDestroyed()) window.webContents.send('terminal:data', { id, data }); });
    p.onExit(({ exitCode }) => {
      if (window && !window.isDestroyed()) window.webContents.send('terminal:exit', { id, exitCode });
      terminals.delete(id);
      // The session record goes with its process: a terminal that exited by itself is never "closed"
      // by the page, so its record used to stay among the live sessions for good.
      sessions.delete(id);
    });
    if (command && !orchestrator) setTimeout(() => { try { p.write(command + '\r'); } catch { /* closed */ } }, 400);
    // If the saved session was not found THE REASON goes back to the page; opening a clean session
    // silently would silently break the expectation of continuing where they left off.
    return { id, sessionId: sessionId || null, connection, resumeWarning, resumeDid };
  });

  ipc.on('terminal:write', (_o, { id, data }) => {
    const p = terminals.get(id);
    if (p) { try { p.write(data); } catch { /* closed */ } }
  });

  ipc.on('terminal:resize', (_o, { id, column, line }) => {
    const p = terminals.get(id);
    if (p && column > 0 && line > 0) { try { p.resize(column, line); } catch { /* closed */ } }
  });

  /* FOCUS ESCAPING WHILE A TERMINAL DIES.
   *
   * An A/B comparison by the user, single-variable and done by hand: opening a new pane, PUTTING AN
   * ORCHESTRATOR IN IT and then closing that pane reproduced the problem, while opening a pane with
   * NO ORCHESTRATOR and closing it did not. The only difference is a console process being killed.
   *
   * The journal says the same: focus does not wander INSIDE the page, THE WHOLE WINDOW loses focus
   * (about 975 ms). What takes the focus is not a part of the panel but an outside window - on
   * Windows, the console host of a process opened through conpty can come to the foreground briefly
   * while that process dies. During that interval keystrokes never reach the panel, and that is what
   * the user sees as typing going nowhere.
   *
   * The repair is kept NARROW, because forcing focus can annoy the user too:
   *   - it is armed only while a terminal IS BEING CLOSED, never on its own;
   *   - it is armed only if the window HAS FOCUS at that moment - if the user is already in another
   *     application it does not interfere;
   *   - it lasts only 1.5 seconds and takes focus back ONCE.
   * If the user deliberately switched to another window during exactly those 1.5 seconds, focus comes
   * back once; that is accepted knowingly, the alternative being a lost second of keystrokes on every
   * close.
   */
  let focusGuardEnd = 0;
  let focusLossMoment = 0;
  function setupFocusGuard() {
    if (!window || window.isDestroyed()) return;
    /* THE WINDOW-MUST-HAVE-FOCUS CONDITION WAS REMOVED, and the reason was measured: closing a pane
       first opens a confirmation dialog, during which the focus does not appear to be on the panel,
       and the guard was never armed - there was not a single restored line in the journal. The guard
       is armed only while the user closes a terminal; it never runs on its own. */
    focusGuardEnd = Date.now() + 2500;
    writeStall({ side: 'focus', duration: 0, task: "Terminal closing; focus guard enabled" });
  }
  /* Window focus is now written as an EVENT rather than a LABEL. A label used to be attached only
     next to long operations, so the question of how many seconds the window spent unfocused could not
     be read from the journal - and that interval is exactly when keystrokes are lost. */
  window.on('blur', () => {
    focusLossMoment = Date.now();
    writeStall({ side: 'window', duration: 0, task: "Window lost focus" });
    if (Date.now() > focusGuardEnd) return;
    focusGuardEnd = 0;                       // once only, so it cannot loop
    setTimeout(() => {
      if (!window || window.isDestroyed() || window.isFocused()) return;
      window.focus();
      writeStall({ side: 'focus', duration: 0, task: "Window focus restored after terminal close" });
    }, 60);
  });
  window.on('focus', () => {
    writeStall({ side: 'window', duration: focusLossMoment ? Date.now() - focusLossMoment : 0,
      task: "Focus restored; key events were unavailable while unfocused" });
    focusLossMoment = 0;
  });

  ipc.on('terminal:close', (_o, { id }) => {
    const p = terminals.get(id);
    if (p) { setupFocusGuard(); try { p.kill(); } catch { /* already dead */ } terminals.delete(id); }
    sessions.delete(id);
  });

  ipc.handle('terminal:closeAndWait', async (_o, { id }) => {
    const p = terminals.get(id);
    if (!p) { sessions.delete(id); return { done: true }; }
    setupFocusGuard();
    const result = await stopTerminal(p);
    if (result.done) { terminals.delete(id); sessions.delete(id); }
    return result;
  });

  // Every pane reads its own session. If the file is not bound yet, it looks for a new file that
  // appeared after the snapshot. If it finds none it PRODUCES NO percentage - it says not yet.
  ipc.handle('context:read', (_o, { id }) => {
    const o = sessions.get(id);
    if (!o) return { error: "No session in this pane" };
    if (o.contextFile) {
      const live = claudeContext.read(o.contextFile, o.project);
      if (live) { o.sessionId = live.sessionId; o.file = null; return live; }
    }
    if (!o.file || o.traceFile) {
      // A trace specific to the terminal, or a known resume identity; no session is guessed from the shared folder.
      o.file = context.sessionFile(o);
      if (!o.file) return { provider: o.provider, sessionId: o.sessionId,
        error: o.traceFile && !o.sessionId ? "Waiting for this terminal's session ID" : "Waiting for a session log" };
      o.sessionId = context.sessionIdFromFile(o.provider, o.file);
    }
    const s = context.read(o.provider, o.file);
    if (o.traceFile) s.warning = traceStorage.warning(o.traceFile);
    s.sessionId = o.sessionId;
    return s;
  });

  // The sub-agents called in a pane. Their source is a separate folder: <session>/subagents/.
  // Codex paginated history has explicit parent/child edges in its local databases.
  ipc.handle('agents:read', (_o, { id }) => {
    const o = sessions.get(id);
    if (!o) return { none: 'pane' };
    if (o.provider === 'codex') {
      if (!o.sessionId) context.sessionFile(o);
      return require('./codex-agents').list(o.accountFolder, o.sessionId);
    }
    if (!o.file) {
      o.file = context.sessionFile(o);
      if (!o.file) return { none: 'record' };
    }
    try { return { list: agents.list(o.file) }; }
    catch (e) { return { none: 'error', error: e.message }; }
  });

  // EVERY RUN IN THE PROJECT -- for the history window.
  // The cards on the main screen stay tied to the pane; this shows the whole project.
  // The session of the active pane is marked separately: the end marker can only be read there.
  function allClaudeRuns(project, enabledFile = null) {
    const registered = accounts.list();   // read once: each read parses the registry and checks every profile
    const roots = [...new Set(registered.filter((h) => h.provider === 'claude')
      .map((h) => context.claudeFolder(project, h.folderPath)))];
    const list = roots.flatMap((k) => agents.projectRuns(k, enabledFile));
    /* THE SUB-AGENTS OF CODEX BELONG IN THE PROJECT HISTORY TOO. Taken from the homes of the
       registered Codex accounts, only when `threads.cwd` is this project; nothing is bound by guesswork. */
    const codexAgents = require('./codex-agents');
    for (const h of registered.filter((x) => x.provider === 'codex')) {
      try { list.push(...codexAgents.projectRuns(accounts.folderPath(h), project).list); }
      catch { /* an unreadable home: that account is left out of the history, the others are not */ }
    }
    /* A CODEX SUB-AGENT TURNS A HYPHEN INTO AN UNDERSCORE - seen in a real run: the definition was
       named with a hyphen and the Codex record with an underscore. Only this exact transformation is
       reversed, and only when a definition file under that name EXISTS in this project; no other
       similarity is looked for. */
    for (const k of list) {
      if (!k || typeof k.file !== 'string' || !k.file.startsWith('codex:') || !String(k.name).includes('_')) continue;
      const dashed = String(k.name).replace(/_/g, '-');
      if (fs.existsSync(path.join(project, ...product.AGENT_FOLDER, dashed + '.md'))) k.name = dashed;
    }
    return runSummary.merge(list);   // pure logic: panel/run-summary.js
  }

  ipc.handle('agents:project', (_o, { project, id }) => {
    if (!project) return { none: 'project' };
    const o = id ? sessions.get(id) : null;
    const enabledFile = (o && o.provider === 'claude') ? o.file : null;
    try {
      return { list: allClaudeRuns(project, enabledFile) };
    } catch (e) { return { none: 'error', error: e.message }; }
  });

  /* THE WORKERS OF A CODEX PANE. Parentless records are matched exactly against the worker/run_agent
     calls in the rollout of the open Codex sessions; a matched record gets `parentThread` written and
     the page binds it to that pane. The rollout is cached by size plus mtime. */
  const rolloutCache = new Map();
  const codexMatch = require('./codex-mcp-matching');
  function codexPaneWorkers(list, project) {
    const orphan = list.filter((k) => k && !k.parent);
    if (!orphan.length) return;
    const target = path.resolve(project).toLowerCase();
    const sessionCalls = new Map();   // Codex session id -> the run_agent calls in its rollout
    for (const o of sessions.values()) {
      if (!o || o.provider !== 'codex' || !o.sessionId) continue;
      if (path.resolve(o.project || '').toLowerCase() !== target) continue;
      let file = null;
      try { file = context.findSessionFile('codex', null, o.sessionId, o.accountFolder); } catch { file = null; }
      if (!file) continue;
      try {
        const d = fs.statSync(file);
        const old = rolloutCache.get(file);
        if (old && old.size === d.size && old.change === d.mtimeMs) sessionCalls.set(o.sessionId, old.callList);
        else {
          const callList = codexMatch.mcpCalls(fs.readFileSync(file, 'utf8'));
          rolloutCache.set(file, { size: d.size, change: d.mtimeMs, callList });
          while (rolloutCache.size > 500) rolloutCache.delete(rolloutCache.keys().next().value);   // bounded for long runs
          sessionCalls.set(o.sessionId, callList);
        }
      } catch { continue; }
    }
    /* AMBIGUITY ACROSS SESSIONS DOES NOT BIND - if two open Codex sessions called the same agent with
       the same task at overlapping times, the record fits both; the first match used to win. The pure
       half `matchAcrossSessions` binds only a record that fits a single session. A record already
       bound through the process ancestry never reaches here. */
    for (const [id, session] of codexMatch.matchBySession(orphan, sessionCalls)) {
      const k = orphan.find((x) => x.id === id);
      if (k && !k.parentThread) k.parentThread = session;
    }
  }

  /* THE PARENT FROM THE PROCESS ANCESTRY. The worker server writes its own pid into the record
     (`serverPid`); because Codex passes no environment, `parent` is empty. Here the process tree is
     walked upwards: pid -> ppid ->... and if the pty process of a pane is reached, the record is
     bound to that pane. The tree snapshot is taken with a single PowerShell call and cached for 3 s;
     a resolved record is never asked about again. Windows only; on another platform it is skipped
     silently (no card appears, and it still shows in the history). */
  const processAncestry = require('./process-ancestry');
  let processTree = { time: 0, map: null, pending: null };
  const resolvedParents = new Map();   // record id -> connection
  const unresolvable = new Set();      // record ids that will not be looked up again
  const attemptedParents = new Set();  // record ids looked up at least once
  function takeProcessTree() {
    if (process.platform !== 'win32') return Promise.resolve(null);
    if (processTree.map && Date.now() - processTree.time < 3000) return Promise.resolve(processTree.map);
    if (processTree.pending) return processTree.pending;
    processTree.pending = new Promise((resolve) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'],
        { windowsHide: true });
      let out = '';
      let settled = false;
      /* A hung WMI/PowerShell call used to leave `pending` set for good: every later workers:project
         waited on it and the agent cards stopped refreshing for the rest of the session. */
      const done = (map) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        processTree = map ? { time: Date.now(), map, pending: null } : { ...processTree, pending: null };
        resolve(map);
      };
      const timer = setTimeout(() => { try { ps.kill(); } catch {} done(null); }, 15000);
      ps.stdout.on('data', (d) => { out += d; });
      ps.on('error', () => done(null));
      ps.on('close', () => done(processAncestry.resolveMap(out)));
    });
    return processTree.pending;
  }
  async function processFromTreeParent(list) {
    const opened = list.filter((k) => k && !k.parent && !k.parentThread && Number.isFinite(k.serverPid));
    for (const k of opened) { const c = resolvedParents.get(k.id); if (c) k.parent = c; }
    /* EVERY RECORD IS LOOKED UP ONCE; ONLY A RUNNING ONE IS ASKED AGAIN, AND NOT AFTER ITS SERVER IS GONE.
       A finished or lost run whose pane could not be found used to send a PowerShell process scan every
       few seconds for as long as Benchook stayed open. */
    const remaining = opened.filter((k) => !k.parent && !unresolvable.has(k.id)
      && (k.status === 'running' || !attemptedParents.has(k.id)));
    const settle = () => {
      for (const k of remaining) {
        if (k.parent) continue;
        attemptedParents.add(k.id);
        if (k.status !== 'running' || processAlive(k.serverPid) === false) unresolvable.add(k.id);
      }
      // Bounded for long runs, like the other caches here; an evicted id is at most looked up once more.
      for (const set of [unresolvable, attemptedParents]) {
        while (set.size > 5000) set.delete(set.values().next().value);
      }
    };
    if (!remaining.length) return;
    try { await resolveParents(remaining); } finally { settle(); }
  }
  async function resolveParents(remaining) {
    const panePids = new Map();   // pty pid -> baglanti
    for (const [id, p] of terminals) {
      const o = sessions.get(id);
      if (p && Number.isFinite(p.pid) && o && o.connection) panePids.set(p.pid, o.connection);
    }
    if (!panePids.size) return;
    const map = await takeProcessTree();
    if (!map) return;
    for (const k of remaining) {
      const connection = processAncestry.fromAncestryPane(k.serverPid, map, panePids);
      if (connection) {
        k.parent = connection; resolvedParents.set(k.id, connection);
        while (resolvedParents.size > 2000) resolvedParents.delete(resolvedParents.keys().next().value);
      }
    }
  }

  /* When the owning server disappears, mark a running record unknown and persist the transition. Process loss alone does not prove success or failure. A reused process ID may delay detection. */
  function processAlive(pid) {
    if (!Number.isFinite(pid)) return null;
    try { process.kill(pid, 0); return true; }
    catch (e) { return e && e.code === 'EPERM'; }
  }
  function markServerLost(list, project) {
    for (const k of list) {
      if (!k || k.status !== 'running' || !Number.isFinite(k.serverPid)) continue;
      if (processAlive(k.serverPid) !== false) continue;
      k.status = 'unknown';
      k.endSource = 'server-lost';
      k.updatedAt = new Date().toISOString();
      k.result = k.result || "The worker connection closed before the result arrived. Whether the task finished is unknown.";
      try { workerRecords.write(app.getPath('userData'), project, k); } catch { /* if it cannot be written the screen still says the right thing */ }
    }
  }

  ipc.handle('workers:project', async (_o, { project }) => {
    if (!project) return { list: [] };
    try {
      const list = workerRecords.list(app.getPath('userData'), project);
      markServerLost(list, project);
      try { await processFromTreeParent(list); } catch { /* if it cannot bind, no card appears and the list still returns */ }
      try { codexPaneWorkers(list, project); } catch { /* if nothing matches, no card appears and the list still returns */ }
      // A running agent's open permission prompts ride along; the live run card shows them .
      return { list: workerRecords.withQuestions(app.getPath('userData'), project, list) };
    } catch (e) { return { list: [], error: e.message }; }
  });

  /* THE USER'S ANSWER TO AN AGENT'S PERMISSION PROMPT, from the live run card. Only a question of a running run can be
     answered, only once, only allow or deny (`worker-records.answer`). */
  ipc.handle('workers:answer', (_o, { project, runId, questionId, decision } = {}) => {
    if (!project) return { error: 'No project.' };
    try { return workerRecords.answer(app.getPath('userData'), project, runId, questionId, decision); }
    catch (e) { return { error: e.message }; }
  });

  // IS THE HANDOVER NOTE CURRENT -- SHOWN to the user when the provider changes; the decision is theirs.
  // The panel does not touch the file, does not write the note, and does not block the switch: it only reads two timestamps.
  ipc.handle('handover:status', (_o, { project, provider, sessionId, accountId }) => {
    const time = (filePath) => { try { return fs.statSync(filePath).mtimeMs; } catch { return null; } };
    // The file comes from the saved setting, not from the page, and must stay inside the project.
    let handover = null;
    try {
      const noteFile = handoverStatus.notePath(project, (readLayout() || {}).handoverFile);
      handover = noteFile ? time(noteFile) : null;
    } catch { handover = null; }   // an unreadable layout no longer rejects the whole status

    let sessionHead = null;
    try {
      const h = accountId ? accounts.find(accountId) : null;
      const file = context.findSessionFile(provider, project, sessionId, h ? accounts.folderPath(h) : null);
      if (file) {
        // Only the first line is needed: read at most 1 MB instead of the whole session file.
        const first = context.readStart(file);
        if (first) { const t = first.timestamp; sessionHead = t ? Date.parse(t) : fs.statSync(file).birthtimeMs; }
      }
    } catch { sessionHead = null; }

    return handoverStatus.digest(handover, sessionHead, Date.now());
  });

  ipc.handle('session:copy', (_o, { provider, project, sessionId, sourceAccount, targetAccount }) => {
    const source = accounts.find(sourceAccount);
    const target = accounts.find(targetAccount);
    if (!source || !target || source.provider !== provider || target.provider !== provider) return { error: "Account providers do not match" };
    try {
      context.copySession(provider, project, sessionId, accounts.folderPath(source), accounts.folderPath(target));
      return { done: true };
    } catch (e) { return { error: e.message }; }
  });

  /* Three channels to the page were removed: the Claude quota, the account read and the Codex quota.
     All three read the machine's DEFAULT installation and fed fixed "Claude / Codex" rows at the
     bottom; those rows had nothing to do with the registry, so they stayed even after the user
     removed every account. The same information is read PER ACCOUNT in the account status channel
     and stays there. */

  // CREATING AN AGENT. preview writes nothing -- it only builds the file that would be written.
  // write is called only after the page has taken APPROVAL: safety contract.
  // Defined agents plus how many times each ran in this project. The two come from SEPARATE sources:
  // the definition from.claude/agents/, the usage from the session records. Neither confirms the
  // other -- both are returned so that "defined but never called" and "called but has no definition"
  // (built-in agents) stay visible separately.
  /* WATCH FOR CHANGES MADE FROM OUTSIDE - a change made to the account or model of any agent from any
     orchestrator has to be reflected in the panel.
     What changed: the agent list was already scanned every ten seconds (late, but there); the skill
     list was refreshed only when that tab was clicked. The watcher feeds both from events. Polling is
     not removed -- `fs.watch` is not reliable everywhere, and it stays behind so that a missed event
     shows up LATE rather than WRONG.
     The panel WRITES nothing from this event; it only tells the page which list changed. */
  /* A CHANGE MADE FROM OUTSIDE IS APPLIED TO THE AGENT ITSELF. If an orchestrator or an
     editor changed a definition, that means the agent changed; the panel takes the change into the
     registry and spreads it to the OTHER projects. Silently writing back over it would lose real work
     done outside.

     The watcher does not say which file changed, so the project is reconciled from scratch; because a
     file the panel wrote itself already matches the registry, no loop forms. */
  let watchedProject = null;
  /* EVERY OPEN PROJECT IS WATCHED. Only the selected project used to be watched; it was
     measured that a real edit sitting in a background project never reached the panel and was
     SILENTLY overwritten by the next save. The page reports which projects are open; the scope
     decision and its cap are written in `watcher.targets`. */
  let watchedProjects = [];
  const folderWatcher = watcher.setupWatcher((label, eventProject) => {
    let publish = null;
    const targetProject = eventProject || watchedProject;
    if (label === 'agent' && targetProject) {
      try { publish = agentSync.reconcile(targetProject); }
      catch (e) { publish = { changed: [], errors: [{ error: e.message }] }; }
    }
    /* A SKILL GOES THE SAME WAY. A skill changed from outside in one project is taken into
       the registry and spread to the other member projects, exactly as the panel does for agents. */
    if (label === 'skill' && targetProject) {
      try { publish = skillSync.reconcile(targetProject); }
      catch (e) { publish = { errors: [{ error: e.message }] }; }
    }
    if (window && !window.isDestroyed()) {
      window.webContents.send('watcher:changed', { label, project: targetProject || null, publish });
    }
  });
  ipc.handle('watcher:setup', (_o, { project, projects }) => {
    watchedProject = project || null;
    // The selected project is ALWAYS at the head of the list: what the cap drops is the project opened longest ago.
    watchedProjects = [watchedProject, ...(Array.isArray(projects) ? projects : [])]
      .filter((x, i, all) => x && all.indexOf(x) === i);
    /* SELECTING A PROJECT RECONCILES IT TOO. Reconciling on a watcher event alone is not
       enough: a definition created or changed WHILE THE PANEL WAS CLOSED produces no event and never
       entered the registry. This was caught in a real Electron check. Reconciling already leaves an
       unchanged file alone, so running it on every project selection is cheap. */
    if (watchedProjects.length) {
      try {
        /* SELECTING A PROJECT CAN ALSO COMPLETE A HALF-FINISHED DELETION , and deleting a
           file is irreversible. The result used to be dropped here entirely; now anything that
           happened about a deletion goes to the page and appears on the status line. */
        try { skillSync.reconcileAll(watchedProjects); } catch { /* unreadable project */ }
        const y = agentSync.reconcileAll(watchedProjects);
        const deletionAction = y && ((y.deletionCompleted || []).length || (y.deletionPending || []).length);
        if (deletionAction && window && !window.isDestroyed()) {
          window.webContents.send('watcher:changed', { label: 'agent', project: watchedProject, publish: y });
        }
      } catch { /* unreadable project */ }
    }
    folderWatcher.setup(watcher.targets(watchedProjects,
      path.join(app.getPath('userData'), 'accounts.json')));
    return true;
  });
  app.on('before-quit', () => folderWatcher.close());

  /* The current state of an agent file and its difference from the copy taken when editing started.
     If the file changes from outside while the form is open the panel does NOT SILENTLY OVERWRITE it:
     it warns and lets the user choose, and the warning says what changed. */
  ipc.handle('agent:fileState', (_o, { filePath, previousContent }) => {
    const now = watcher.fingerTrace(filePath);
    if (now === null) return { none: true, changed: previousContent != null };
    if (previousContent == null || now === previousContent) return { none: false, changed: false, content: now };
    const f = watcher.diffs(previousContent, now);
    return { none: false, changed: true, content: now, diffs: f, digest: watcher.diffSentence(f) };
  });

  ipc.handle('agent:list', (_o, { project }) => {
    const defined = writeAgent.existing(project);
    const usage = new Map();
    /* Usage is extra information: an unreadable session folder used to reject the whole handler, and
       the defined-agent list (which does not depend on usage) disappeared with it. */
    if (project) try {
      const count = (name, last) => {
        const old = usage.get(name);
        usage.set(name, { times: (old ? old.times : 0) + 1,
          last: !old || last > old.last ? last : old.last });
      };
      for (const run of allClaudeRuns(project)) {
        count(run.name, run.createdAt || Date.parse(run.updatedAt) || 0);
      }
      /* WORKER (MCP) RUNS COUNT AS USAGE TOO - seen in a real run: an agent that had run twice through
         run_agent still showed as "Never used" in the list, because only native records were counted. */
      for (const record of workerRecords.list(app.getPath('userData'), project)) {
        if (record && record.name) count(record.name, Date.parse(record.startedAt) || 0);
      }
    } catch { usage.clear(); }
    // The origin split lives in panel/run-summary.js so it can be tested without Electron.
    const listed = runSummary.separateOrigin(defined, usage);
    // A name held by two different agents is locked; the page shows it and allows only a rename.
    // The level is computed here, once, so the page never interprets a tool list itself.
    return listed.map((a) => ({ ...a, nameConflict: agentRegistry.hasConflict(agentRegistry.find(a.name)),
      permission: agentResolution.permissionOf(a.tools) }));
  });
  /* SAME-NAME LOCKS, for the warning at the top of the page: each locked name with every project
     that holds a definition under it. */
  ipc.handle('agent:conflicts', () => agentRegistry.list().filter((a) => agentRegistry.hasConflict(a))
    .map((a) => ({ name: a.name, projects: [...new Set([...(a.projects || []), ...agentRegistry.conflictProjects(a)])] })));
  // The only change a locked agent accepts: renaming the copy in this project.
  ipc.handle('agent:renameCopy', (_o, { project, oldName, newName, filePath }) =>
    agentSync.renameCopy(project, oldName, newName, filePath));
  // THE ACCOUNT REGISTRY -- which account each agent runs on is chosen from here.
  ipc.handle('accounts:list', () => accounts.list());

  // THE IDENTITY AND QUOTA OF EVERY ACCOUNT: whether the login held, which account it is, and how much
  // room is left. The panel did not say this, and the error page in the browser was misleading too
  // (the login had in fact held). Both are READS: not a model call, and they spend no tokens.
  /* EVERY ACCOUNT SHOWS ITS OWN QUOTA, HOWEVER MANY THERE ARE.
   *
   * Users can enter any number of accounts and the program has to show the quota of all of them
   * properly. The panel will be a product in other hands; the number of accounts is not ours to bound.
   *
   * THE ACCOUNTS ARE READ IN PARALLEL. The loop used to be SEQUENTIAL: no account started before the
   * previous one finished. A Codex quota starts a CLI process with a 12-second timeout; ten cold Codex
   * accounts meant two minutes in the worst case, and for all that time the numbers of the last
   * accounts stood EMPTY on screen. Unnoticeable with four accounts, very noticeable with twenty.
   *
   * AN ERROR ON ONE ACCOUNT DOES NOT BRING DOWN THE OTHERS: every row carries its own error. A single
   * `Promise.all` rejection would empty the whole list and the user would say the quota is not being
   * read at all. */
  ipc.handle('accounts:status', async () => {
    const accountStatus = async (h) => {
      if (!h.signedIn && h.provider === 'codex') { return { id: h.id, signedIn: false }; }
      if (h.provider === 'codex') {
        const k = account.codex(h.folderPath);
        // THE QUOTA OF EVERY SIGNED-IN ACCOUNT IS READ. The Codex quota comes not from the network but
        // from the own session record of THAT ACCOUNT (used_percent is written on every turn), so the
        // number is inevitably the LAST KNOWN one and comes back with the time it was read.
        // For an account that never ran, no number is INVENTED: the reason is written in quotaError.
        const live = await quotaCodex.read(h);
        const last = live.quota ? null : context.lastCodexSession(h.folderPath);
        const s = last ? context.read('codex', last.file) : null;
        const quota = live.quota || ((s && !s.error && s.quota) ? s.quota : null);
        return {
          id: h.id, signedIn: true, email: k.email || null, error: k.error || null,
          short: quota && quota.short ? quota.short.percent : null,
          long: quota && quota.long ? quota.long.percent : null,
          // THE TWO RESETS TRAVEL SEPARATELY. Only the weekly one used to be sent, and the interface
          // wrote a plain "reset"; when the five-hour quota would renew was never visible.
          shortReset: quota && quota.short ? quota.short.resetsAt : null,
          longReset: quota && quota.long ? quota.long.resetsAt : null,
          stale: !live.quota,
          quotaSourceTrusted: !!live.quota && !live.error,
          wasRead: live.wasRead || (last ? last.writing : null),
          quotaError: live.error || (quota ? null : ((s && s.error) || "No recorded usage limits for this account")),
        };
      }
      const identity = await account.claude(h.folderPath);
      const normal = p => path.resolve(p).toLowerCase();
      const candidates = [...sessions.values()].filter(o => o.provider === 'claude' && o.contextFile
        && o.accountFolder && normal(o.accountFolder) === normal(h.folderPath));
      // Trust the observation by login identity, not by a file stamp ; see account.loginIdentity).
      const trust = quotaClaude.terminalTrust(candidates, account.signInIdentity(identity));
      const observations = trust.trusted
        .map(o => claudeContext.read(o.contextFile,o.project)).filter(Boolean)
        .sort((a,b) => Date.parse(b.time)-Date.parse(a.time));
      /* THE LAST KNOWN QUOTA IS NOT LOST WHEN A PANE CLOSES. Moving the orchestrator to another
         account turned the row of the old account into "Usage limits unavailable", although a valid
         observation had existed minutes earlier: the observation was tied to the pane and went with it.
         Every trusted observation is now written to disk per account (together with the login
         identity) and read back for that same identity when no live pane exists; the row already says
         "Last known - <time>". If the identity changed the old observation is not used: it stays
         reported as changed. */
      const idNow = account.signInIdentity(identity);
      const lastQuotaFile = path.join(app.getPath('userData'), 'quota-last', h.id + '.json');
      let last = null;
      try { last = persistentJson.read(lastQuotaFile, (v) => v && typeof v === 'object' && v.observation && v.observation.time); }
      catch { last = null; }
      // An observation without numbers (a resumed session's first status line) keeps the last known ones.
      const chosen = quotaClaude.choose(observations, last, idNow);
      // Written only when it changed: an unchanged observation used to be rewritten (fsync'd) every 5 s.
      const unchanged = last && last.authId === idNow
        && JSON.stringify(last.observation) === JSON.stringify(chosen.observation);
      if (chosen.save && !unchanged) {
        try { persistentJson.write(lastQuotaFile, { authId: idNow, observation: chosen.observation, writtenAt: new Date().toISOString() }); }
        catch { /* if it cannot be written the live observation is still shown */ }
      }
      const quota = quotaClaude.read(identity.signedIn ? chosen.observation : null, Date.now(),
        { idChanged: !!identity.signedIn && trust.idChanged, idUnknown: trust.idUnknown });
      return {
        id: h.id, signedIn: typeof identity.signedIn === 'boolean' ? identity.signedIn : null,
        email: identity.email || null, source: identity.source || null, error: identity.error || null,
        short: quota.short ? quota.short.percent : null,
        long: quota.long ? quota.long.percent : null,
        shortReset: quota.short ? quota.short.resetsAt : null,
        longReset: quota.long ? quota.long.resetsAt : null,
        stale: !!quota.stale, wasRead: quota.wasRead || null,
        quotaSourceTrusted: !!quota.wasRead && !quota.error,
        quotaError: quota.error || null,
      };
    };

    const list = accounts.list();
    const results = await Promise.all(list.map(async (h) => {
      // An unexpected error on one account does not drop the row of another: each row returns with its own error.
      try { return require('./quota-warning').apply(app.getPath('userData'), h, await accountStatus(h)); }
      catch (e) { return { id: h.id, signedIn: !!h.signedIn, quotaError: e && e.message ? e.message : String(e) }; }
    }));
    return results;
  });
  // Asked before an account is added: a CLI that cannot start is named before any sign-in begins.
  ipc.handle('cli:problem', (_o, { provider }) => (['claude', 'codex'].includes(provider) && !cliPath.cliInvocation(provider)
    ? cliPath.cliProblem(provider) : null));
  ipc.handle('accounts:add', (_o, { account: h }) => {
    try { return { list: accounts.add(h) }; }
    catch (e) { return { error: e.message, suggestion: e.suggestion || null }; }
  });
  ipc.handle('accounts:remove', (_o, { id }) => {
    if (signIns.has(id) || signOuts.has(id)) return {error:'Finish the authentication operation before removing this account'};
    try { return { list: accounts.remove(id) }; } catch (e) { return { error: e.message }; }
  });

  /* SIGNING OUT OF AN ACCOUNT - the mirror image of signing in: the panel does not touch the token, it
     runs the OWN sign-out command of the program while pointing it at the folder of that account.
     The outcome is measured not by the exit code of the command but by the identity file really being
     gone (`login-flow.signOutResult`) -- the third rule of the panel. */
  /** Runs the provider's own sign-out command on one account folder and reads whether it is signed out
      now. Used by the sign-out button and by the undo of a duplicate sign-in. */
  async function runSignOut(h, k, c) {
    const r = await require('./subprocess').run({ command: c.command, arg: [...c.leadingArgs, ...k.args],
      env: accounts.env(h), durationMs: 15000, maxOutput: 65536 });
    const signedOut = h.provider === 'claude'
      ? (await account.claude(accounts.folderPath(h), { fresh: true })).signedIn === false
      : !accounts.hasSignIn(h);
    return { r, signedOut };
  }

  ipc.handle('accounts:signOut', async (_o, { id }) => {
    if (process.env.BENCHOOK_TEST === '1') {
      return { error: "Sign-out is disabled in test mode (BENCHOOK_TEST=1)" };
    }
    const h = accounts.find(id);
    if (!h) return { error: "Account not found" };
    if (!accounts.hasSignIn(h)) return { error: h.name + " is already signed out" };

    const k = signInFlow.signOutCommand(h.provider);
    const c = cliPath.cliInvocation(k.name);
    if (!c) return { error: cliPath.cliMissing(k.name) };

    if (signIns.has(id) || signOuts.has(id)) return {error:'An authentication operation is already in progress'};
    signOuts.add(id);
    try {
    const { r, signedOut } = await runSignOut(h, k, c);
    const s = h.provider === 'claude'
      ? (r.code === 0 && signedOut ? {status:'done'}
        : {status:'error',reason:'Claude Code sign-out could not be verified'})
      : signInFlow.signOutResult(r.code, !signedOut);
    // The observations of older terminals are NOT discarded here which login they belong to
    // is known through `authIdentity`; on a re-login to the same account the observation stays valid,
    // and for another account the filter removes it.
    if (s.status !== 'done') {
      return { error: s.reason, output: String(r.output || '').trim().slice(0, 400) };
    }
    return { done: true, folder: accounts.folderPath(h) };
    } finally { signOuts.delete(id); }
  });
  // THE PANEL OPENS THE LOGIN -- signing in from the system is healthier than doing it by writing
  // code, and other users have to be able to sign in from the system too without knowing which file
  // to edit.
  //
  // The panel opens the login SCREEN, it does not do the login ITSELF: it starts the program in its
  // own console window, handing it the folder of that account through an environment variable. No
  // password, token or browser flow passes through the panel; all of it is the own login flow of
  // Claude Code or Codex.
  // Claude owns a native sign-in console; Codex owns its browser callback.
  const signIns = new Map();   // id -> { child, output, cancel }
  const signOuts = new Set();
  let loginCleanup = false;
  app.on('before-quit', event => {
    if (loginCleanup || !signIns.size) return;
    event.preventDefault(); loginCleanup = true;
    Promise.all([...signIns.values()].map(g => {
      g.cancel = true;
      return require('./subprocess').stopTree(g.child);
    })).finally(() => app.quit());
  });

  /* AFTER A LOGIN, WHO SIGNED IN IS READ - measured in a real attempt by the user. One account was
     expected in a given folder and a different one turned up inside it. The cause is not in the panel:
     `claude auth login` opens THE BROWSER, and because the browser is already signed in as some
     account, the consent screen silently authorises that one. The folder name DOES NOT DETERMINE which
     account signs in; it only says where the result is written.

     The panel cannot manage the browser and should not. What it can do is SAY what happened: once the
     login ends, the e-mail is read from the identity itself, written to the label in the registry, and
     if the same e-mail exists on another account a warning comes back. That is exactly the subject of
     the ninth answer-key rule: with the same account on two rows, the panel says it ran on the second
     account while the work comes out of the quota of the first. */
  /* A throw in the finish used to leave the entry in `signIns` with `finishing` set: the account then
     answered "an authentication operation is already in progress" until the panel was restarted. */
  function endSignIn(id, code) {
    finishSignIn(id, code).catch((e) => {
      signIns.delete(id);
      notifySignIn(id, { status: 'error', reason: 'Sign-in could not be completed: ' + ((e && e.message) || String(e)) });
    });
  }
  async function finishSignIn(id, code) {
    const g = signIns.get(id);
    if (!g) return;
    if (g.finishing) return;
    g.finishing = true;
    clearTimeout(g.timer);
    const h = accounts.find(id);
    let verified = h?.provider === 'claude' && code === 0 && !g.cancel
      ? await account.claude(accounts.folderPath(h), { fresh: true }) : null;
    // The status read can fail once while Claude Code is still writing its fresh credentials.
    if (verified && verified.signedIn !== true && verified.error !== 'Not signed in to Claude Code') {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      verified = await account.claude(accounts.folderPath(h), { fresh: true });
    }
    signIns.delete(id);
    /* EVERY REASON SAYS WHAT HAPPENED. A timeout used to read "Sign-in cancelled" and a closed Claude
       Code window "could not be verified"; neither told the user what to do next. */
    const r = g.timedOut ? {status:'error',reason:'Sign-in timed out after 10 minutes'}
      : g.cancel ? {status:'error',reason:'Sign-in cancelled'}
      : h?.provider === 'claude' ? (code === 0 && verified?.signedIn === true ? {status:'done'}
        : code !== 0 ? {status:'error',reason:'The Claude Code sign-in window closed before sign-in finished'}
        : {status:'error',reason:'Claude Code sign-in could not be verified'})
      : signInFlow.result(code, h ? accounts.hasSignIn(h) : false);
    if (r.status !== 'done') {
      /* A ROW MADE BY "ADD ACCOUNT" THAT NEVER SIGNED IN IS NOT KEPT. Each abandoned add used to leave
         one more identical "Claude account - SIGNED OUT" row. Only a never-signed-in row (temp) whose
         profile holds no sign-in is removed; its folder is left on disk. */
      let removed = false;
      if (h && h.temp && !accounts.hasSignIn(h)) { try { accounts.remove(id); removed = true; } catch { /* stays */ } }
      notifySignIn(id, { status: 'error', reason: r.reason, output: g.output.slice(-1200), removed });
      return;
    }

    let email = null;
    try {
      const identity = h && h.provider === 'codex'
        ? account.codex(accounts.folderPath(h))
        : verified || await account.claude(accounts.folderPath(h));
      email = (identity && identity.email) || null;
    } catch { /* the identity could not be read: the label does not change and no warning is given */ }

    /* THE SAME ACCOUNT IS NOT ADDED TWICE. The browser authorises whichever account is already signed
       in there, so "add another account" could sign the SAME account into a second row: two rows that
       share one quota, two identical names in the orchestrator menu. A warning used to be written and
       the duplicate kept. Now the new profile is signed out again with the provider's own command
       (only this row's folder; the other row is not touched), its label and e-mail are not written,
       and a row created by this add is removed. The page says what happened and how to add a
       different account. */
    const twinFirst = email ? accounts.emailTwin(id, email) : null;
    if (twinFirst) {
      let undone = false;
      try {
        const k = signInFlow.signOutCommand(h.provider);
        const c = cliPath.cliInvocation(k.name);
        if (c) undone = (await runSignOut(h, k, c)).signedOut;
      } catch { undone = false; }
      let removed = false;
      if (undone && h.temp) { try { accounts.remove(id); removed = true; } catch { /* the row stays, signed out */ } }
      notifySignIn(id, { status: 'twin', email, twin: twinFirst.name, undone, removed, provider: h.provider });
      return;
    }

    // THE LABEL ALWAYS COMES FROM THE E-MAIL. The concept of an account name was removed entirely, so
    // there is no user-typed name left to preserve.
    // The e-mail is written into the registry as well: the twin check and later startups look at it.
    if (email) { try { accounts.writeEmail(id, email); } catch { /* the registry could not be written */ } }

    let newName = null;
    if (email) {
      newName = String(email).split('@')[0];
      try { accounts.updateName(id, newName); } catch { /* if the registry cannot be written the label stays */ }
    }

    const twin = email ? accounts.emailTwin(id, email) : null;
    notifySignIn(id, { status: 'done', email, newName, twin: twin ? twin.name : null });
  }

  function notifySignIn(id, data) {
    if (window && !window.isDestroyed()) {
      window.webContents.send('account:signIn', { id, ...data });
    }
  }

  ipc.handle('accounts:startSignIn', (_o, { id }) => {
    if (process.env.BENCHOOK_TEST === '1') {
      return { error: "Sign-in is disabled in test mode (BENCHOOK_TEST=1)" };
    }
    const h = accounts.find(id);
    if (!h) return { error: "Account not found" };
    if (signIns.has(id) || signOuts.has(id)) return { error: 'An authentication operation is already in progress for this account' };
    const hz = accounts.prepareFolder(h);
    if (hz.error) return { error: hz.error };

    const k = signInFlow.signInCommand(h.provider);
    const c = cliPath.cliInvocation(k.name);
    if (!c) return { error: cliPath.cliMissing(k.name) };

    let child;
    try {
      child = h.provider === 'claude' ? require('./native-login').start(c,k.args,accounts.env(h)) : spawn(c.command, [...c.leadingArgs, ...k.args], {
        env: accounts.env(h), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return { error: "Could not start sign-in: " + e.message };
    }

    // Old terminals keep their observations each carries the sign-in identity it was
    // opened with, and `accounts:status` compares that with the identity after this sign-in.
    const record = { child, output: '', cancel:false };
    signIns.set(id, record);
    record.timer = setTimeout(() => {
      record.cancel = true; record.timedOut = true;
      require('./subprocess').stopTree(child).then(error => {
        if (error) notifySignIn(id,{status:'error',reason:error});
      });
    }, 10 * 60_000);

    const read = (part) => {
      record.output = (record.output + String(part)).slice(-8192);
      const d = signInFlow.readOutput(record.output);
      notifySignIn(id, { status: 'ongoing', url: d.url, codeWants: d.codeWants });
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.on('error', (e) => {
      record.output += '\n' + e.message;
      endSignIn(id, -1);
    });
    child.on('exit', (code) => endSignIn(id, code === null ? -1 : code));

    return { started: true, folder: accounts.folderPath(h) };
  });

  ipc.handle('accounts:cancelSignIn', async (_o, { id }) => {
    const g = signIns.get(id);
    if (!g) return { cancel: false };
    g.cancel = true;
    const error = await require('./subprocess').stopTree(g.child);
    if (error) return {error};
    return { cancel: true };
  });

  /* SKILLS - a new or added skill is written to both sides. If an older skill was left on one side
     only, the existing copy completes the missing side when the Skills tab is opened. */
  ipc.handle('skill:list', (_o, { project }) => skills.existing(project));
  ipc.handle('skill:complete', (_o, { project }) =>
    process.env.BENCHOOK_TEST === '1' ? { skipped: true } : skills.completeMissing(project));

  /* ONE REGISTRY. The page takes what is not in this project from the registry (members of
     other projects) and from the own folders of the machine (`~/.agents/skills`, `~/.claude/skills`;
     it was measured that these are not loaded into panel terminals); built-ins are separate and read only. */
  ipc.handle('skill:registry', (_o, { project }) => {
    try { if (project) skillSync.reconcile(project); } catch { /* unreadable project */ }
    const records = skillRegistry.list().map((b) => {
      let content = null;
      try { content = fs.readFileSync(path.join(skillRegistry.copyPath(b.folderName), 'SKILL.md'), 'utf8'); } catch { /* no copy */ }
      return { ...b, content };
    });
    return { records, machine: skillSync.machineSkills() };
  });
  ipc.handle('skill:builtins', () => skillSync.builtins(
    accounts.list().filter((h) => h.provider === 'codex').map((h) => accounts.folderPath(h))));
  ipc.handle('skill:addToProject', (_o, { project, folderName }) => skillSync.addToProject(folderName, project));
  ipc.handle('skill:delete', (_o, { folderName }) => skillSync.deleteFully(folderName));
  ipc.handle('skill:import', (_o, { project, source, folderName }) => skillSync.takeExternal(source, project, folderName));

  // A save goes through the registry: this project plus the other members.
  ipc.handle('skill:write', (_o, { project, folderName, content, sourceSide }) =>
    skillSync.saveForm(project, folderName, content, sourceSide));

  // Removing from a project: the files go, membership drops, the registry record stands.
  ipc.handle('skill:remove', (_o, { project, folderName }) =>
    skillSync.removeFromProject(folderName, project));

  /* So the paths that would be written can be shown FIRST: safety contract requires full paths on the approval screen. */
  ipc.handle('skill:paths', (_o, { project, folderName }) =>
    Object.keys(skills.SIDES).map((t) => skills.skillPath(project, t, folderName)));
  ipc.handle('skill:savePaths', (_o, { project, folderName }) => skillSync.savePaths(project, folderName));

  ipc.handle('accounts:suggestFolder', (_o, { provider, name }) => accounts.suggestedFolder(provider, name));

  ipc.handle('accounts:codexModels', (_o, { folder }) =>
    writeAgent.codexModels(folder || accounts.defaultHome('codex')));


  // RUNNING A WORKER FROM THE PANEL -- the only path that spends tokens; it never runs by itself.

  ipc.handle('agent:preview', (_o, { project, field }) => writeAgent.preview(project, field));
  /* THE WRITE DIRECTION WAS REVERSED. The form now writes to THE REGISTRY rather than to a
     project file, and the registry spreads to every project the agent is active in. Only the file of
     the open project used to be written and the others went stale; that is where divergence came from.

     The `content` the page sends IS PRESERVED: so that the text shown in the preview and the text
     written are the same, the registry record is read from that text. The page contract did not change. */
  /* THE INTENT IS CARRIED EXPLICITLY. Creating a new person, editing an existing one and
     adding an existing one to this project are three different jobs; all three used to look at an
     `overwrite` flag, and the panel said "save and it will be added to this project" while the save
     refused with "that name already exists". The decision itself lives in `agent-sync.saveForm`: this
     is an IPC handler and cannot be tested, and the rule must sit where it can be. */
  ipc.handle('agent:write', (_o, { project, name, content, intent, oldName, oldPath, moveToPanel }) =>
    agentSync.saveForm({ project, name, content, intent, oldName, oldPath, moveToPanel: !!moveToPanel }));

  ipc.handle('accounts:claudeModels', (_o, { folder } = {}) => writeAgent.claudeModels(folder || null));
  ipc.handle('accounts:claudeLatest', (_o, { folder } = {}) => writeAgent.claudeLatest(folder || null));

  // AGENTS FROM OTHER PROJECTS: the left panel lists agents that are not in this project so one of
  // them can be picked and added to it.
  // The panel DISCOVERS no projects: it reads only the paths it was given (projects that were opened
  // plus a folder chosen by hand). It does not invent a project list that does not exist.
  // Remove an agent from a project: deletes the definition file. THE PAGE takes the approval and shows the full path.
  /* REMOVING FROM A PROJECT IS NOT DELETING - an agent not being used does not mean it is
     dead. This door deletes only the file of that project; the agent stays in the registry and in the
     other projects. Deleting the agent outright is a separate door. */
  ipc.handle('agent:remove', (_o, { project, filePath }) => {
    if (!project || !filePath) return { error: 'Invalid request' };
    const name = path.basename(String(filePath), '.md');
    return agentSync.removeFromProject(name, project);
  });

  /* DELETE THE AGENT EVERYWHERE - says FIRST how many projects it will affect, then deletes. */
  /* LOOK AT THE FOLDER FIRST, IMPORT AFTERWARDS - show first, then ask. The scan writes
     nothing; the import takes only what was selected. */
  ipc.handle('agent:scanFolder', (_o, { folder }) => agentSync.scanFolder(folder));
  ipc.handle('agent:importFolder', (_o, { folder, names }) => agentSync.takeFromFolder(folder, names));
  ipc.handle('agent:delete', (_o, { name }) => agentSync.deleteFully(name));
  /* THE WHOLE REGISTRY, WITH ITS RESOLUTION. `resolution` comes from ONE place here too
     (`agent-resolution`): a list once invented its own answer and the same agent showed two different
     accounts on two screens. To avoid repeating that mistake in a new list, the resolution is
     computed and attached here. */
  ipc.handle('agent:registry', () => agentRegistry.list().map((a) => ({
    ...a,
    nameConflict: agentRegistry.hasConflict(a),
    permission: agentResolution.permissionOf(a.tools),
    resolution: agentResolution.resolve(
      { account: a.account, provider: a.provider, model: a.model },
      (x) => accounts.findLoose(x)),
  })));

  /* What a project needs for an agent to be REALLY callable. `plan` writes nothing; the page shows the
     list and takes approval, and `apply` is called afterwards. The provider is read from the registry
     - the panel guesses the kind of no account. */
  const accountProvider = (id) => {
    const h = accounts.find(id);
    return h ? h.provider : null;
  };
  /* FIRST RUN: the terminal of an account signed in from the panel must not show the wizard again.
     The cosmetic mark is written silently and the TRUST decision is asked on the page - `panel/onboarding.js`. */
  ipc.handle('onboarding:plan', (_o, { project, accountId }) => {
    const h = accounts.find(accountId);
    if (!h || !project) return { error: "Select an account and project" };
    try { return firstSetup.plan(h, accounts.folderPath(h), project); }
    catch (e) { return { error: e.message }; }
  });
  ipc.handle('onboarding:apply', (_o, { project, accountId, selection }) => {
    const h = accounts.find(accountId);
    if (!h || !project) return { error: "Select an account and project" };
    try { return firstSetup.apply(h, accounts.folderPath(h), project, selection || {}); }
    catch (e) { return { error: e.message }; }
  });

  ipc.handle('setup:plan', (_o, { project }) => projectSetup.plan(project, accountProvider));
  ipc.handle('setup:apply', (_o, { steps }) => projectSetup.apply(steps));

  /* The `agent:writeSource` and `agent:otherProjects` doors USED TO BE HERE - removed with ; the
     page called neither (source mode and the other-project list ended with. */

  /* Use the native folder picker as a child of the application window and restore focus when it closes. Folder selection requires an operating-system path, not a browser upload selection. */
  async function pickFolder(title) {
    const r = await dialog.showOpenDialog(window, { title: title, properties: ['openDirectory'] });
    if (window && !window.isDestroyed()) window.focus();
    return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
  }

  // Lets a folder be chosen and returns ONLY the path: it does not change the open project.
  ipc.handle('folder:pick', () => pickFolder("Select folder"));

  /* THE CONNECTION STATE lives in `panel/mcp-status.js`, so the hook asks the same place.
     This information once existed only in the panel and not in the catalogue the orchestrator reads;
     while the tool was not defined in that session, the catalogue still said to call `run_agent`. */
  function mcpInfo(project, id) {
    const h = accounts.find(id);
    if (!h || !project) return { installed: false, error: "Select a project and account first." };
    const d = mcpStatus.accountFor(h, project, (x) => accounts.folderPath(x));
    /* THE SENTENCE SHOWN ON THE CARD COMES FROM THERE. The page cannot `require` it; writing that text
       a second time there would guarantee it drifts apart from the catalogue. */
    return { ...d, provider: h.provider, warning: mcpStatus.MESSAGE.reachability(d.status, h.name || h.id) };
  }

  ipc.handle('mcp:status', (_o, { project, id }) => mcpInfo(project, id));
  ipc.handle('mcp:askAgain', (_o, { project }) => {
    if (!project) return { error: "Select a project first." };
    try { return mcpStatus.askAgainClaude(project); }
    catch (e) { return { error: e && e.message ? e.message : String(e) }; }
  });
  ipc.handle('mcp:setup', (_o, { project, id }) => {
    const h = accounts.find(id);
    if (!h || !project) return { error: "Select a project and account first." };
    const tool = projectSetup.WORKER;
    /* THE CONNECTION RUNS ON NODE.JS. Without it the provider would register a server that can never
       start, and agents would fail later with no reason given (seen on a clean machine). */
    if (cliPath.nodeMissing()) return { error: cliPath.nodeNeeded("Benchook's agent connection (MCP)") };
    try {
      if (h.provider === 'claude') {
        /* Read and written the way the setup plan does it: a byte-order mark is accepted, a file that
           is not a settings object is refused, and the write replaces the file whole. */
        const file = path.join(project, '.mcp.json');
        const j = projectSetup.readJson(file) || {};
        persistentJson.atomicText(file, JSON.stringify(projectSetup.withOwnMcpServer(j, project), null, 2) + '\n');
      } else {
        const env = accounts.env(h);
        const setting = path.join(accounts.folderPath(h), 'config.toml');
        const previous = fs.existsSync(setting) ? fs.readFileSync(setting, 'utf8') : null;
        /* `codex.cmd` CANNOT be started directly. Measured: on Node 24 `spawnSync('codex.cmd',...)`
           returns EINVAL - since CVE-2024-27980 Node does not start a `.cmd` or `.bat` file without a
           `shell`. So this setup never worked on that Node version and the panel reported it as
           "codex not found" while codex was installed. `shell: true` is not the answer, it would
           reopen that security door - the real target inside the wrapper is resolved and started directly. */
        try {
          const version = cliPath.runCli('codex', ['--version'], { env });
          if (version.error || version.code !== 0) {
            throw new Error(version.error || version.errorOutput || "Could not read Codex version");
          }
          /* Every registration that runs the worker script is removed, whatever its name, so an
             older registration is replaced rather than joined by a second server. */
          const registered = mcpStatus.ownCodexSections(previous || '', tool);
          for (const name of new Set([...registered, product.MCP_SERVER_KEY])) {
            cliPath.runCli('codex', ['mcp', 'remove', name], { env });
          }
          /* THE SERVER IS TOLD WHICH ACCOUNT IT IS - the Codex side of.
             `BENCHOOK_PROJECT` IS STILL NOT PASSED (it locked an account to a single project), but
             `CODEX_HOME` is. Measured: Codex does not pass the CODEX_HOME of the orchestrator to its
             MCP child, so `run_agent` could not resolve the account of an agent set to same-as-the-
             orchestrator (`mcp-server.js` -> sessionAccount null -> NATIVE SUBAGENT REQUIRED) and the
             job was safely refused. The Claude side did not have this problem because
             CLAUDE_CONFIG_DIR is carried. CODEX_HOME is FIXED per account (config.toml lives in the
             folder of that account) and is not tied to a project; the server reads it only inside
             `sessionAccount`, and worker runs build the environment of their own account separately
             (cleanInherited resets CODEX_HOME). */
          const root = accounts.folderPath(h);
          const result = cliPath.runCli('codex',
            ['mcp', 'add', product.MCP_SERVER_KEY, '--env', 'CODEX_HOME=' + root, '--', 'node', tool], { env });
          if (result.error || result.code !== 0) {
            throw new Error(result.error || result.errorOutput || "Could not register the Codex MCP server");
          }
          /* THE MODEL AND PANE OF THE TERMINAL - /060. `codex mcp add` can only write a fixed
             `--env`; BENCHOOK_ORCHESTRATOR_MODEL and BENCHOOK_SESSION, which vary per terminal, are
             copied from the calling process through the `env_vars` field of Codex (measured). The line
             is appended to the file as text; the rest of the file is not touched. */
          const written = fs.readFileSync(setting, 'utf8');
          // And the wait limit : an agent waiting on the user must not lose its result after 5 minutes.
          const added = mcpStatus.addToolTimeout(mcpStatus.addEnvVars(written).text);
          added.changed = added.text !== written;
          if (added.changed) persistentJson.atomicText(setting, added.text);
        } catch (e) {
          // A failed restore must not hide the error that caused it.
          if (previous === null) { try { fs.unlinkSync(setting); } catch { /* it was never created */ } }
          else { try { persistentJson.atomicText(setting, previous); } catch { /* the original error is reported */ } }
          throw e;
        }
      }
      /* AN ALREADY OPEN SESSION DOES NOT PICK UP THIS RECORD AFTER A SETUP - measured.
         The sentence comes from here so the page can tell the user. */
      return { ...mcpInfo(project, id), openRe: mcpStatus.MESSAGE.openRe };
    } catch (e) { return { error: e.message }; }
  });

  /* Record main-process and renderer stalls separately above the configured threshold. Store diagnostics in application data, not the project, so blocked event loops can be distinguished. */
  ipc.on('stall:renderer', (_o, record) => writeStall({ side: 'page', ...record }));

  /* WHICH BUILD IS RUNNING. It became necessary once: an expected line was missing from the journal
     and "the fix did not work" could not be told apart from "the panel is open on old code". An open
     Electron window knows nothing about changes on disk. Without this line every round started with
     that question; the journal now answers it itself. */
  try {
    const signature = ['main.js', 'panel.js', 'preload.js'].map((d) => {
      const s = fs.statSync(path.join(__dirname, d));
      return d + ' ' + new Date(s.mtimeMs).toISOString().slice(11, 19);
    }).join(' · ');
    writeStall({ side: 'panel', duration: 0, task: "Opened — " + signature });
  } catch { /* the signature could not be read; the journal is still kept */ }

  ipc.handle('layout:read', () => readLayout());
  function writeLayout(data) {
    try {
      const existing = readLayout() || {};
      if (data?.allProjectStatus) {
        existing.projectState = { ...(existing.projectState || {}), ...data.allProjectStatus };
        delete data.allProjectStatus;
      }
      // Project state is not written OVER, it is written under that project, so the record of another
      // project is not deleted while one project is being saved.
      if (data && data.projectState && data.project) {
        existing.projectState = existing.projectState || {};
        existing.projectState[data.project] = data.projectState;
        delete data.projectState;
      }
      Object.assign(existing, data);
      fs.mkdirSync(path.dirname(layoutFile()), { recursive: true });
      writeLayoutAtomic(existing);
      return { done: true };
    } catch (e) { return { error: e.message }; }
  }
  ipc.handle('layout:writeAndWait', (_o, data) => writeLayout(data));

  // Forgets the project FROM THE LIST. IT DOES NOT TOUCH THE FOLDER: no file is deleted and no agent
  // definition is deleted. One of the safety constraints is changing a file without approval; the only thing
  // removed here is the path the panel remembered and the screen layout belonging to that project.
  ipc.handle('layout:forgetProject', (_o, { filePath }) => {
    try {
      const existing = readLayout() || {};
      existing.projects = (existing.projects || []).filter((x) => x !== filePath);
      if (existing.projectState) delete existing.projectState[filePath];
      if (existing.project === filePath) existing.project = existing.projects[0] || null;
      fs.mkdirSync(path.dirname(layoutFile()), { recursive: true });
      writeLayoutAtomic(existing);
      return { done: true, projects: existing.projects, project: existing.project };
    } catch (e) { return { error: e.message }; }
  });

  // The cost of a project switch is appended as a single line. NO model call, NO network: only the
  // duration and counts the page measured itself. The tool that reads it: tools/switch-metrics.js.
  ipc.on('metrics:switch', (_o, record) => {
    try {
      fs.mkdirSync(path.dirname(switchMetricFile()), { recursive: true });
      boundedLog.add(switchMetricFile(), record);
    } catch { /* the measurement could not be written; it does not stop the panel working */ }
  });

  // A project folder is NEVER selected on its own -- nothing is auto-selected until the user picks a folder.
  ipc.handle('project:pick', () => pickFolder("Select project folder"));

  ipc.on('link:open', (_o, { url }) => {
    const safe = security.externalUrl(url);
    if (safe) shell.openExternal(safe).catch(() => {});
  });

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) setupWindow(); });
});

app.on('window-all-closed', () => app.quit());
