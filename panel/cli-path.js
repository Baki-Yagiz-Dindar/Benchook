// Resolves npm wrappers such as `codex.cmd` / `claude.cmd` on Windows to their REAL target.
//
// WHY IT EXISTS. Since the Node 20 security fix for.bat/.cmd argument injection
// (CVE-2024-27980), Node refuses to START a `.cmd` or `.bat` file unless `shell: true` is
// passed. Without this module the panel could not launch a CLI installed through npm at all,
// and reported the failure as "codex not found" - which was the wrong sentence, because codex
// was installed.
//
// THE ANSWER IS NOT `shell: true`: opening a shell brings back quoting and escaping problems
// and reopens exactly the door that security fix closed. Instead the real target inside the
// wrapper is read and started directly. This is the one place that does it.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** Looks for the wrapper on PATH and in the own folder of npm. */
function findShim(name) {
  // Bounded: this runs on the main process, and a stuck lookup must not freeze the window.
  const found = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const fromPath = String(found.stdout || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean);
  if (fromPath && fs.existsSync(fromPath)) return fromPath;
  // The npm path a PowerShell profile adds may be absent from the PATH of a Node child process.
  const npmShim = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', name) : null;
  return (npmShim && fs.existsSync(npmShim)) ? npmShim : null;
}

/**
 * Reads the wrapper text. npm produces two shapes and both have been seen:
 *   - `"%_prog%"  "%dp0%\...\bin\xxx.js" %*`   -> node plus a script
 *   - `"%dp0%\...\xxx.exe" %*`                 -> a direct executable
 * @returns {{command:string, leadingArgs:string[]}|null}
 */
function resolveShim(shim) {
  const t = shimTargets(shim);
  if (!t) return null;
  if (t.js) {
    const filePath = t.js;
    if (fs.existsSync(filePath)) {
      // The Windows GUI exe of Electron may produce no stdout under a PTY. Use a console-capable
      // Node for the npm CLI; if none is found, return an error rather than open a silent terminal.
      const node = process.versions.electron ? findShim('node.exe') : process.execPath;
      return node ? { command: node, leadingArgs: [filePath] } : null;
    }
  }
  if (t.exe && isProgram(t.exe)) return { command: t.exe, leadingArgs: [] };
  return null;
}

/** What an npm launcher names: a script that Node runs, or a program (never Node itself), with
 *  `%dp0%`/`%~dp0%` resolved against the launcher's folder. Shared by `resolveShim` (start it) and
 *  `cliProblem` (say why it cannot start), so the two can never read a launcher differently.
 *  @returns {{js:string|null, exe:string|null}|null} null when the launcher cannot be read */
function shimTargets(shim) {
  let text;
  try { text = fs.readFileSync(shim, 'utf8'); } catch { return null; }
  const dp0 = path.dirname(shim);
  const open = (s) => path.normalize(s.replace(/%~?dp0%/ig, dp0 + path.sep));
  const js = text.match(/"([^"]*\.js)"/i);
  const exe = text.match(/"([^"]*\.exe)"/i);
  const exePath = exe ? open(exe[1]) : null;
  return { js: js ? open(js[1]) : null, exe: exePath && !/[\\/]node\.exe$/i.test(exePath) ? exePath : null };
}

/** A Windows program starts with "MZ". The npm package of Claude Code ships a small text placeholder
    named claude.exe that its install step replaces; when that step was skipped the placeholder is
    still there, and starting it fails with an error that names nothing useful. */
function isProgram(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(2);
    return fs.readSync(fd, head, 0, 2, 0) === 2 && head.toString('latin1') === 'MZ';
  } catch { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

/* WHERE THE OFFICIAL INSTALLERS PUT THE PROGRAM. They add these folders to the user's PATH, but a
   Benchook that was already open keeps the PATH it started with, so a CLI installed a minute ago was
   "not found". These folders are checked after PATH, never before it. */
function installFolders(name) {
  const env = process.env;
  const at = (base, ...rest) => (base ? path.join(base, ...rest) : null);
  return [
    name === 'claude' ? at(env.USERPROFILE, '.local', 'bin') : null,                       // claude.ai/install.ps1
    name === 'codex' ? at(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin') : null,  // chatgpt.com/codex/install.ps1
    at(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),                                  // winget, per user
    at(env.ProgramFiles, 'WinGet', 'Links'),                                               // winget, machine wide
  ].filter(Boolean);
}

function knownInstall(name) {
  for (const dir of installFolders(name)) {
    const file = path.join(dir, name + '.exe');
    if (isProgram(file)) return file;
  }
  return null;
}

/**
 * Makes a CLI runnable WITHOUT opening a `shell`.
 * @param name  the command name, such as 'codex' or 'claude'
 * @returns {{command:string, leadingArgs:string[]}|null}  null means the CLI was not found
 */
/* A FOUND CLI IS REMEMBERED FOR A FEW SECONDS. The account rows ask for it every 5 s per account, and
   every answer cost up to three `where.exe` runs on the main process. Only a found program is kept,
   only while its file still exists and the search path is unchanged: a CLI installed a moment ago is
   still found at once, and one that disappears is looked up again. */
const found = new Map();
function cliInvocation(name) {
  const custom = process.env[name.toUpperCase() + '_CLI_EXE'];
  if (custom && fs.existsSync(custom)) return { command: custom, leadingArgs: [] };
  if (process.platform !== 'win32') return { command: name, leadingArgs: [] };
  const key = name + '\0' + (process.env.PATH || '') + '\0' + (process.env.APPDATA || '') + '\0' + (process.env.LOCALAPPDATA || '');
  const old = found.get(name);
  if (old && old.key === key && Date.now() - old.at < 10000 && fs.existsSync(old.c.command)
    && old.c.leadingArgs.every((x) => fs.existsSync(x))) return { command: old.c.command, leadingArgs: [...old.c.leadingArgs] };
  const c = lookUp(name);
  if (c) found.set(name, { key, at: Date.now(), c }); else found.delete(name);
  return c;
}
function lookUp(name) {
  const exe = findShim(name + '.exe');
  if (exe) return { command: exe, leadingArgs: [] };
  const shim = findShim(name + '.cmd');
  const resolved = shim ? resolveShim(shim) : null;
  if (resolved) return resolved;
  const known = knownInstall(name);
  return known ? { command: known, leadingArgs: [] } : null;
}

const INSTALL = {
  claude: { label: 'Claude Code', install: 'irm https://claude.ai/install.ps1 | iex',
    npm: 'npm install -g @anthropic-ai/claude-code@latest' },
  /* Codex's own Windows installer (learn.chatgpt.com/docs/codex/cli, "standalone installer for Windows";
     the script installs to %LOCALAPPDATA%\Programs\OpenAI\Codex\bin, checked 6 October 2026). It needs no
     Node.js: on a clean machine the npm command failed with "npm is not recognized" (user's friend). */
  codex: { label: 'Codex CLI', install: 'irm https://chatgpt.com/codex/install.ps1 | iex',
    npm: 'npm install -g @openai/codex@latest' },
};

/* NODE.JS, said once and the same way everywhere. Benchook's agent connection (the MCP worker) runs on
   Node.js, and every npm command needs it; a clean machine has neither. */
const NODE_INSTALL = 'winget install --id OpenJS.NodeJS.LTS --exact --source winget';
function nodeMissing() { return !cliInvocation('node'); }
function nodeNeeded(what) {
  return what + ' needs Node.js 22.12 or newer, which was not found.\nRun in PowerShell: ' + NODE_INSTALL
    + '\nThen open a new PowerShell window, and restart Benchook.';
}

/* WHY THE CLI CANNOT START, in words the user can act on. Called only after `cliInvocation` returned
   null. "Not installed" and "installed but broken" need different fixes; the old single sentence
   ("was not found in PATH or the npm installation folder") was shown for a launcher whose program
   file was missing, so it sent the user looking for a PATH problem that did not exist. Benchook
   repairs nothing itself: it names the file it looked at and the official command that fixes it. */
function cliProblem(name) {
  const k = INSTALL[name] || { label: name, install: null, npm: null };
  const custom = process.env[name.toUpperCase() + '_CLI_EXE'];
  if (custom && !fs.existsSync(custom)) {
    return { kind: 'broken', file: custom,
      message: name.toUpperCase() + '_CLI_EXE points to a file that does not exist: ' + custom };
  }
  const restart = '\nAfter installing or repairing it, try again; if it is still not found, restart Benchook.';
  // An npm command on a machine without Node.js cannot work: Node.js comes first.
  const run = (command) => (/^npm /.test(command) && nodeMissing()
    ? '\nThis command uses npm, which comes with Node.js; Node.js was not found. First run: ' + NODE_INSTALL
      + '\nThen, in a new PowerShell window, run: ' + command
    : '\nRun in PowerShell: ' + command);
  const backupOf = (file) => {
    try {
      const base = path.basename(file).toLowerCase() + '.old.';
      return fs.readdirSync(path.dirname(file)).filter((f) => f.toLowerCase().startsWith(base)).sort().pop() || null;
    } catch { return null; }
  };
  const missingTarget = (file, fix) => {
    const backup = backupOf(file);
    return { kind: 'broken', file, message: k.label + ' is installed, but its program file is missing: ' + file + '.'
      + (backup ? ' A backup left by an unfinished update is next to it (' + backup + ').' : '')
      + (fix ? run(fix) : '') + restart };
  };
  const shim = process.platform === 'win32' ? findShim(name + '.cmd') : null;
  if (shim) {
    const t = shimTargets(shim) || { js: null, exe: null };   // an unreadable launcher is reported below
    if (t.js) {
      const file = t.js;
      if (!fs.existsSync(file)) return missingTarget(file, k.npm);
      return { kind: 'broken', file, message: k.label + ' is installed through npm, but Node.js (node.exe) was not found'
        + ' on PATH, and Benchook needs it to start ' + name + '.\nRun in PowerShell: ' + NODE_INSTALL + restart };
    }
    if (t.exe) {
      const file = t.exe;
      if (!fs.existsSync(file)) return missingTarget(file, k.npm);
      if (!isProgram(file)) {
        return { kind: 'broken', file, message: k.label + ' is installed through npm, but its setup step did not finish: '
          + file + ' is a placeholder, not a program. This happens when npm skips optional dependencies or install'
          + ' scripts. Reinstall without --omit=optional or --ignore-scripts; if npm says install scripts'
          + ' are not yet allowed, approve them first (npm approve-scripts ' + (name === 'claude'
            ? '@anthropic-ai/claude-code' : '@openai/codex') + ').' + run(k.npm) + restart };
      }
    }
    return { kind: 'broken', file: shim, message: 'Benchook could not read the ' + name + ' launcher at ' + shim
      + '.' + run(k.npm || k.install) + restart };
  }
  for (const dir of installFolders(name)) {
    const file = path.join(dir, name + '.exe');
    if (fs.existsSync(file) && !isProgram(file)) {
      return { kind: 'broken', file, message: k.label + ' at ' + file + ' is not a valid program.'
        + run(k.install || k.npm) + restart };
    }
    if (!fs.existsSync(file) && backupOf(file)) return missingTarget(file, k.install);
  }
  return { kind: 'missing', message: k.label + ' is not installed, or Benchook cannot find it (checked PATH, the npm'
    + ' folder and the default install folders).' + (k.install ? run(k.install) : '') + restart };
}

/** The one sentence every caller shows when `cliInvocation` returned null. */
function cliMissing(name) { return cliProblem(name).message; }

/** The environment to start a resolved CLI with. When the CLI is a script run by a Node program
    (`leadingArgs`), that program is told to behave as Node even if it is Electron's own executable. */
function invocationEnv(c, env = process.env) {
  return { ...env, ...(c && c.leadingArgs && c.leadingArgs.length ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
}

/** Runs the resolved CLI with the given arguments. Returns an error if no wrapper was found. */
function runCli(name, args, options = {}) {
  const c = cliInvocation(name);
  if (!c) return { error: cliMissing(name) };
  const timeout = options.timeout || 60000;   // a CLI waiting on a prompt must not freeze the panel
  const r = spawnSync(c.command, [...c.leadingArgs, ...args],
    { encoding: 'utf8', windowsHide: true, ...options, timeout,
      env: invocationEnv(c, options.env || process.env) });
  if (r.error && r.error.code === 'ETIMEDOUT') return { error: name + ' did not finish within ' + Math.round(timeout / 1000) + ' seconds.' };
  if (r.error) return { error: name + " could not start: " + r.error.message };
  return { code: r.status, output: r.stdout || '', errorOutput: r.stderr || '' };
}

module.exports = { cliInvocation, cliProblem, cliMissing, runCli, invocationEnv, resolveShim, installFolders,
  nodeMissing, nodeNeeded, NODE_INSTALL };
