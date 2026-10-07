'use strict';

/* RESOLVING THE WINDOWS CLI WRAPPER.
 *
 * What it protects against: setting up the Codex MCP connection from the panel reported it could not be
 * installed and was missing. The cause was in the own code of the panel: `spawnSync('codex.cmd',...)`
 * returns EINVAL on Node 24, because since CVE-2024-27980 Node does not start a `.cmd` or `.bat` file
 * without a `shell`. The panel reported this as codex not found while codex was installed.
 *
 * These tests resolve the shim TEXT and do not depend on a real codex installation - they run on another
 * machine too. They test the wrong direction as well: `node.exe` must not be taken for the target, and a
 * missing file must not be accepted. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveShim } = require('../panel/cli-path');

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-filePath-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The shape npm really produces on Windows (taken byte for byte from codex.cmd).
const NPM_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start',
  'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (',
  '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  '
    + '"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n');

test('an npm wrapper resolves to node plus a script', (t) => {
  const dir = folder(t);
  const target = path.join(dir, 'node_modules', '@openai', 'codex', 'bin');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'codex.js'), '// codex');
  const shim = path.join(dir, 'codex.cmd');
  fs.writeFileSync(shim, NPM_SHIM);

  const c = resolveShim(shim);
  assert.equal(c.command, process.execPath, 'it must be started with node');
  assert.equal(c.leadingArgs.length, 1);
  assert.equal(path.resolve(c.leadingArgs[0]), path.join(target, 'codex.js'));
});

test('with no target script NO resolution is produced - it is not treated as present', (t) => {
  const dir = folder(t);
  fs.writeFileSync(path.join(dir, 'codex.cmd'), NPM_SHIM);   // codex.js was never written
  assert.equal(resolveShim(path.join(dir, 'codex.cmd')), null);
});

test('the node.exe inside the wrapper is not mistaken for the target', (t) => {
  const dir = folder(t);
  fs.writeFileSync(path.join(dir, 'node.exe'), 'fake');
  // A wrapper naming only node.exe with no real target: it must say there is no resolution.
  fs.writeFileSync(path.join(dir, 'fake.cmd'), '"%dp0%\\node.exe" %*');
  assert.equal(resolveShim(path.join(dir, 'fake.cmd')), null);
});

test('a wrapper that carries a direct .exe resolves too', (t) => {
  const dir = folder(t);
  fs.writeFileSync(path.join(dir, 'real.exe'), 'MZ fake program header');   // a text placeholder is refused
  fs.writeFileSync(path.join(dir, 'x.cmd'), '"%dp0%\\real.exe" %*');
  const c = resolveShim(path.join(dir, 'x.cmd'));
  assert.equal(path.resolve(c.command), path.join(dir, 'real.exe'));
  assert.deepEqual(c.leadingArgs, []);
});

/* The defect ITSELF. Without this test the claim that it works now would hang in the air: it shows that
   Node refuses the.cmd, i.e. that the fix really gets past an obstacle. If Node ever reverts that, this
   test breaks and this comment needs reading then - the break is information. */
test('Node does NOT start a .cmd file without a shell - this is the reason for the fix', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows only');
  const dir = folder(t);
  const cmd = path.join(dir, 'trial.cmd');
  fs.writeFileSync(cmd, '@echo merhaba\r\n');
  const r = spawnSync(cmd, [], { encoding: 'utf8', windowsHide: true });
  assert.ok(r.error, 'if a .cmd can be started directly, the rationale for this fix has changed');
  assert.equal(r.error.code, 'EINVAL');
});

test('a found CLI is remembered briefly, and looked up again once its file is gone', { skip: process.platform !== 'win32' }, (t) => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-cache-'));
  const saved = { PATH: process.env.PATH, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, ProgramFiles: process.env.ProgramFiles };
  t.after(() => { Object.assign(process.env, saved); fs.rmSync(dir, { recursive: true, force: true }); });
  const exe = path.join(dir, 'benchookcachetest.exe');
  fs.writeFileSync(exe, 'MZ fake');
  process.env.PATH = dir + ';' + path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  process.env.APPDATA = dir; process.env.LOCALAPPDATA = dir; process.env.USERPROFILE = dir; process.env.ProgramFiles = dir;
  // where.exe runs are counted: the module takes spawnSync when it loads, so it is loaded fresh here.
  const childProcess = require('node:child_process');
  const original = childProcess.spawnSync;
  let lookups = 0;
  childProcess.spawnSync = (cmd, ...rest) => { if (/where\.exe$/i.test(String(cmd))) lookups++; return original(cmd, ...rest); };
  delete require.cache[require.resolve('../panel/cli-path')];
  const cliPath = require('../panel/cli-path');
  childProcess.spawnSync = original;
  t.after(() => { delete require.cache[require.resolve('../panel/cli-path')]; });
  assert.equal(cliPath.cliInvocation('benchookcachetest').command.toLowerCase(), exe.toLowerCase());
  const afterFirst = lookups;
  assert.ok(afterFirst >= 1, 'the first answer searched PATH');
  assert.equal(cliPath.cliInvocation('benchookcachetest').command.toLowerCase(), exe.toLowerCase(), 'the second answer is the same');
  assert.equal(lookups, afterFirst, 'the second answer did not run where.exe again');
  fs.rmSync(exe);
  assert.equal(cliPath.cliInvocation('benchookcachetest'), null, 'a removed program is not reported from memory');
});
