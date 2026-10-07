'use strict';
const fs = require('node:fs');
const path = require('node:path');
const json = require('./persistent-json');
function parse(v) {
  const c = v?.context_window;
  if (!c || typeof v.session_id !== 'string') throw new Error("Session context is unavailable");
  const num = x => Number.isFinite(x) && x >= 0 ? x : null;
  const u = c.current_usage;
  const field = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
  const total = u && field.every(k => num(u[k]) !== null) ? field.reduce((s,k)=>s+u[k],0) : null;
  const used = num(total);
  return { provider: 'claude', sessionId: v.session_id, project: v.workspace?.project_dir || v.cwd,
    model: v.model?.id || null, limit: num(c.context_window_size) || null,
    percent: num(c.used_percentage), used, missing: [],
    source: "Claude status line", time: new Date().toISOString(),
    quota: require('./quota-claude').parse(v.rate_limits) };
}
function read(file, project) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    const normal = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
    if (!v.project || normal(v.project) !== normal(project) || typeof v.sessionId !== 'string') return null;
    return v;
  } catch { return null; }
}
/* IF THE USER HAS THEIR OWN STATUS LINE THE PANEL GOES BEHIND IT, NOT IN FRONT.
 *
 * The panel takes the context percentage from the status-line hook of Claude: it passes its own
 * command with `--settings`, and that command writes the JSON arriving on stdin to a file. Because
 * `--settings` comes from the command line it OVERRIDES the `statusLine` setting in the files of
 * the user; the panel used to see this and refuse to install at all, so the line of the user was
 * preserved but the panel could not read the percentage.
 *
 * Now: when the user has a command of their own, the command of the panel becomes a WRAPPER - it
 * writes the same JSON to the file, then runs the user command with THE SAME stdin and prints its
 * output verbatim. The screen shows the line of the user; the panel still gets the percentage.
 * Other fields such as `padding` are carried over unchanged.
 * The precedence matches that of Claude: project `settings.local.json`, then project
 * `settings.json`, then the account.
 * Even if the parsing of the panel throws, the user command still runs: their line is never broken
 * because of us. */
function userStatusLine(root, project) {
  for (const p of [path.join(project, '.claude/settings.local.json'), path.join(project, '.claude/settings.json'), path.join(root, 'settings.json')]) {
    if (!fs.existsSync(p)) continue;
    let s;
    try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }   // corrupt file: that layer is ignored
    if (s && s.statusLine) return { setting: s.statusLine, file: p };
  }
  return null;
}
const quote = s => "'" + s.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'";
function setting(root, project, target, node) {
  const parts = [node, __filename, target].map(quote);
  const k = userStatusLine(root, project);
  if (!k) return { statusLine: { type: 'command', command: parts.join(' ') } };
  // A setting with no command, in a shape we do not know: leave it alone and do not install either - no guessing.
  if (typeof k.setting.command !== 'string' || !k.setting.command.trim()) return null;
  const wrap = { ...k.setting, type: 'command', command: [...parts, '--after', quote(k.setting.command)].join(' ') };
  return { statusLine: wrap, userCommand: k.setting.command, sourceFile: k.file };
}
/* The command of the user is a shell line. On Windows, Claude Code runs the status line and the
   hooks through Git Bash. The order is: CLAUDE_CODE_GIT_BASH_PATH, then bash on PATH; if neither
   exists, the system shell (a fallback, not a guess). */
function runUserCommand(command, entry) {
  const { spawnSync } = require('node:child_process');
  // Bounded (generously), so a hung user command does not keep this wrapper and its children alive.
  const shared = { input: entry, encoding: 'utf8', windowsHide: true, env: process.env, timeout: 30000 };
  const gitBash = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (gitBash && fs.existsSync(gitBash)) return spawnSync(gitBash, ['-c', command], shared);
  const r = spawnSync('bash', ['-c', command], shared);
  // Any start failure of bash falls back to the system shell, as before; a command that ran out of time
  // is not started a second time.
  return r.error && r.error.code !== 'ETIMEDOUT' ? spawnSync(command, { ...shared, shell: true }) : r;
}
if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { input += d; if (input.length > 1024 * 1024) process.exit(1); });
  process.stdin.on('end', () => {
    const afterI = process.argv.indexOf('--after');
    const userCommand = afterI > 0 ? process.argv[afterI + 1] : null;
    let ownOutput = null;
    try {
      const v = parse(JSON.parse(input));
      json.atomic(process.argv[2], v);
      ownOutput = v.percent === null ? "Waiting for context usage" : "Context usage: " + v.percent;
    } catch { if (!userCommand) process.exitCode = 1; }
    if (!userCommand) { if (ownOutput) process.stdout.write(ownOutput); return; }
    // The line of the user: the same stdin, their output, their exit code. Ours never reaches the screen.
    const r = runUserCommand(userCommand, input);
    if (r.error) { process.stdout.write(ownOutput || ''); process.exitCode = 1; return; }
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exitCode = r.status == null ? 1 : r.status;
  });
}
module.exports = { parse, read, setting, userStatusLine };
