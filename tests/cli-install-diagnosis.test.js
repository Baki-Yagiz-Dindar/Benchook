'use strict';

/* A MISSING CLI AND A BROKEN ONE ARE TOLD APART.
 *
 * What it protects against: a Claude Code npm launcher whose program file had been renamed aside by
 * an unfinished update (`claude.exe.old.<number>` left next to it) was reported as "claude was not
 * found in PATH or the npm installation folder". The launcher WAS on PATH; the sentence sent the
 * user looking for the wrong problem. A CLI installed by the official installer into a folder that
 * the already-open Benchook had not seen on its PATH was "not found" as well.
 *
 * Every case is built in a temporary folder; the real installs of this machine are not read. PATH is
 * narrowed to System32 so where.exe runs but finds nothing of ours. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../panel/cli-path');

const PROGRAM = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);
const CLAUDE_SHIM = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n'
  + '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
const CODEX_SHIM = '"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';

function machine(t) {
  if (process.platform !== 'win32') { t.skip('Windows install layouts'); return null; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-diagnosis-'));
  const saved = {};
  const env = {
    PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
    APPDATA: path.join(root, 'Roaming'), USERPROFILE: path.join(root, 'home'),
    LOCALAPPDATA: path.join(root, 'Local'), ProgramFiles: path.join(root, 'ProgramFiles'),
    CLAUDE_CLI_EXE: undefined, CODEX_CLI_EXE: undefined,
  };
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
  const npm = path.join(env.APPDATA, 'npm');
  return { env, put, npm, claudeBin: path.join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin') };
}

test('nothing installed: "not installed", with the official install command', (t) => {
  const m = machine(t); if (!m) return;
  assert.equal(cli.cliInvocation('claude'), null);
  const p = cli.cliProblem('claude');
  assert.equal(p.kind, 'missing');
  assert.match(p.message, /not installed/);
  assert.match(p.message, /irm https:\/\/claude\.ai\/install\.ps1 \| iex/);
});

test('npm launcher present but its program renamed aside by an update: broken, names the file and the backup', (t) => {
  const m = machine(t); if (!m) return;
  m.put(path.join(m.npm, 'claude.cmd'), CLAUDE_SHIM);
  m.put(path.join(m.claudeBin, 'claude.exe.old.1790982766030'), PROGRAM);
  assert.equal(cli.cliInvocation('claude'), null);
  const p = cli.cliProblem('claude');
  assert.equal(p.kind, 'broken');
  assert.equal(p.file, path.join(m.claudeBin, 'claude.exe'));
  assert.match(p.message, /claude\.exe\.old\.1790982766030/);
  assert.match(p.message, /npm install -g @anthropic-ai\/claude-code@latest/);
  assert.doesNotMatch(p.message, /not installed/);
});

test('npm placeholder left by a skipped install step is not taken for a program', (t) => {
  const m = machine(t); if (!m) return;
  m.put(path.join(m.npm, 'claude.cmd'), CLAUDE_SHIM);
  m.put(path.join(m.claudeBin, 'claude.exe'), '#!/bin/sh\necho "native binary not installed"\n');
  assert.equal(cli.cliInvocation('claude'), null, 'a text placeholder must not be started');
  const p = cli.cliProblem('claude');
  assert.equal(p.kind, 'broken');
  assert.match(p.message, /placeholder/);
});

test('a working npm launcher still resolves to its program', (t) => {
  const m = machine(t); if (!m) return;
  m.put(path.join(m.npm, 'claude.cmd'), CLAUDE_SHIM);
  const exe = m.put(path.join(m.claudeBin, 'claude.exe'), PROGRAM);
  assert.equal(path.resolve(cli.cliInvocation('claude').command), exe);
});

test('the native installer folder is found even when it is not on the PATH Benchook started with', (t) => {
  const m = machine(t); if (!m) return;
  const exe = m.put(path.join(m.env.USERPROFILE, '.local', 'bin', 'claude.exe'), PROGRAM);
  assert.equal(cli.cliInvocation('claude').command, exe);
});

test('a broken npm launcher does not hide a working native install', (t) => {
  const m = machine(t); if (!m) return;
  m.put(path.join(m.npm, 'claude.cmd'), CLAUDE_SHIM);
  const exe = m.put(path.join(m.env.USERPROFILE, '.local', 'bin', 'claude.exe'), PROGRAM);
  assert.equal(cli.cliInvocation('claude').command, exe);
});

test('native install whose update left only a backup is reported as broken, with the installer command', (t) => {
  const m = machine(t); if (!m) return;
  m.put(path.join(m.env.USERPROFILE, '.local', 'bin', 'claude.exe.old.123'), PROGRAM);
  const p = cli.cliProblem('claude');
  assert.equal(p.kind, 'broken');
  assert.match(p.message, /claude\.exe\.old\.123/);
  assert.match(p.message, /install\.ps1/);
});

test('Codex: the standalone installer folder and winget links are found', (t) => {
  const m = machine(t); if (!m) return;
  const exe = m.put(path.join(m.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), PROGRAM);
  assert.equal(cli.cliInvocation('codex').command, exe);
  fs.rmSync(exe);
  const link = m.put(path.join(m.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'codex.exe'), PROGRAM);
  assert.equal(cli.cliInvocation('codex').command, link);
});

test('Codex npm launcher whose script is gone is broken, with the npm reinstall command', (t) => {
  const m = machine(t); if (!m) return;
  m.put(path.join(m.npm, 'codex.cmd'), CODEX_SHIM);
  const p = cli.cliProblem('codex');
  assert.equal(p.kind, 'broken');
  assert.match(p.message, /codex\.js/);
  assert.match(p.message, /npm install -g @openai\/codex@latest/);
});

test('a CLAUDE_CLI_EXE that points nowhere is named, not reported as "not installed"', (t) => {
  const m = machine(t); if (!m) return;
  process.env.CLAUDE_CLI_EXE = path.join(m.env.USERPROFILE, 'gone.exe');
  const p = cli.cliProblem('claude');
  assert.equal(p.kind, 'broken');
  assert.match(p.message, /CLAUDE_CLI_EXE/);
});

test('every caller of a missing CLI uses the diagnosis, not the old fixed sentence', () => {
  const panel = path.join(__dirname, '../panel');
  for (const f of fs.readdirSync(panel).filter((x) => x.endsWith('.js'))) {
    const s = fs.readFileSync(path.join(panel, f), 'utf8');
    assert.doesNotMatch(s, /" was not found in PATH or the npm installation folder\."/, f);
    assert.doesNotMatch(s, /executable was not found"/, f);
  }
});

test('on a clean machine (no Codex, no Node.js) Codex is offered its own installer, and any npm step says Node.js comes first', (t) => {
  /* Seen on a clean Windows machine, 6 October 2026: the suggested `npm install -g @openai/codex` failed with
   * "npm is not recognized", because npm comes with Node.js and Node.js was not installed. */
  const m = machine(t);
  if (!m) return;
  delete process.env.NODE_CLI_EXE;
  assert.equal(cli.nodeMissing(), true, 'this narrowed PATH has no Node.js');
  const codex = cli.cliProblem('codex');
  assert.equal(codex.kind, 'missing');
  assert.match(codex.message, /irm https:\/\/chatgpt\.com\/codex\/install\.ps1 \| iex/, 'Codex gets its own Windows installer, which needs no Node.js');
  assert.doesNotMatch(codex.message, /npm install/);
  m.put(path.join(m.npm, 'codex.cmd'), CODEX_SHIM);   // an npm launcher whose script is gone: the fix is an npm command
  const broken = cli.cliProblem('codex');
  assert.match(broken.message, /winget install --id OpenJS\.NodeJS\.LTS/, 'Node.js is named before the npm command');
  assert.match(broken.message, /npm install -g @openai\/codex@latest/);
  assert.match(cli.nodeNeeded('X'), /Node\.js 22\.12/);
});
