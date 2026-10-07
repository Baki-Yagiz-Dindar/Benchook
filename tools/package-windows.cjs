'use strict';
// Builds an unsigned portable Windows folder from the installed, locked Electron runtime.
// Only tracked application sources and lockfile production dependencies are included.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const panel = path.join(root, 'panel');
const metadata = require('../panel/package.json');
const lock = require('../panel/package-lock.json');
const runtime = path.dirname(require(path.join(panel, 'node_modules/electron')));
const option = process.argv.indexOf('--out');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows x64.');
if (option >= 0 && !process.argv[option + 1]) throw new Error('--out needs a directory.');
const output = path.resolve(option >= 0 ? process.argv[option + 1]
  : path.join(root, 'dist', `Benchook-${metadata.version}-windows-x64-${Date.now()}`));
if (fs.existsSync(output)) throw new Error('Output must not exist; existing packages are never overwritten.');
if (fs.existsSync(output + '.zip')) throw new Error('ZIP already exists.');
const sourceFiles = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(file => /^panel\/[^/]+\.(js|css|html|cs)$/.test(file));
const toolFiles = ['tools/mcp-server.js', 'tools/approval-server.js', 'tools/project-catalog.js',
  'tools/reclaim-trace-storage.ps1'];
// User-facing documents only (decision of 7 October 2026). Contributing, architecture and the changelog
// live in the repository; README links to them there.
const docs = ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md',
  'docs/QUICKSTART.md', 'docs/USER-GUIDE.md', 'docs/LIMITATIONS.md',
  'docs/media/workspace.png', 'docs/media/agent-editor.png', 'docs/media/agents.png',
  'docs/media/skills.png', 'docs/media/skill-editor.png', 'docs/media/model-switch.png',
  'docs/media/settings.png', 'docs/media/demo.gif', 'docs/media/icon.png', 'docs/media/agent-history.png', 'docs/media/agents-running.png'];
const appRoot = path.join(output, 'resources', 'app');
function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, filter: source => {
    if (fs.lstatSync(source).isSymbolicLink()) throw new Error('Refusing to package symlink: ' + source);
    return true;
  } });
}
copy(runtime, output);
fs.renameSync(path.join(output, 'electron.exe'), path.join(output, 'Benchook.exe'));
execFileSync(process.execPath, [path.join(__dirname, 'brand-windows.cjs'), path.join(output, 'Benchook.exe')],
  { windowsHide: true, stdio: 'inherit' });
// This is Electron's copied demonstration app, not user data.
const demo = path.join(output, 'resources', 'default_app.asar');
if (fs.existsSync(demo)) fs.unlinkSync(demo);
for (const file of [...sourceFiles, ...toolFiles, 'panel/package.json', 'panel/package-lock.json', 'panel/benchook.ico'])
  copy(path.join(root, file), path.join(appRoot, file));
for (const file of docs) copy(path.join(root, file), path.join(appRoot, file));
fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({
  name: metadata.name, productName: metadata.productName, version: metadata.version,
  description: metadata.description, license: metadata.license, main: 'panel/main.js',
}, null, 2) + '\n');
for (const [relative, entry] of Object.entries(lock.packages)) {
  if (!relative.startsWith('node_modules/') || entry.dev || relative === 'node_modules/electron') continue;
  const source = path.join(panel, relative);
  if (!fs.existsSync(source)) {
    if (entry.optional) continue;
    throw new Error('Missing dependency; run npm ci --prefix panel: ' + relative);
  }
  copy(source, path.join(appRoot, 'panel', relative));
}
copy(path.join(root, 'LICENSE'), path.join(output, 'BENCHOOK-LICENSE.txt'));
fs.writeFileSync(path.join(output, 'START-HERE.txt'), [
  `Benchook ${metadata.version} - Windows x64 portable application`, '',
  '1. Extract the complete ZIP to a permanent folder. Do not run inside the ZIP.',
  '2. Install what Benchook needs, in PowerShell (skip what you already have):',
  '     Node.js 22.12 or newer:  winget install --id OpenJS.NodeJS.LTS --exact --source winget',
  '     Claude Code:             irm https://claude.ai/install.ps1 | iex',
  '     Codex CLI:               irm https://chatgpt.com/codex/install.ps1 | iex',
  '   Node.js is required. Claude Code, Codex, or both. Open a new PowerShell window afterwards.',
  '3. Double-click Benchook.exe. Add an account and sign in through its provider.',
  '4. Open a project, choose an account and model, then start the orchestrator.', '',
  'Keep Benchook.exe and all accompanying files together. npm install is not required.',
  'This is an unsigned portable build, not an installer. Windows may show a publisher warning.',
  'Verify the download source and SHA-256 checksum before deciding whether to run it.',
  'Local settings use the application data folder (Benchook), not this extracted folder.',
  'Moving the application can invalidate project/MCP helper paths; run setup again afterwards.',
  'Existing development windows may use a different profile. This package does not migrate profiles.',
  'Provider accounts, credentials and project files are not included in this package.', '',
  'Node.js setup: resources/app/docs/QUICKSTART.md (Install Node.js).',
  'Documentation: resources/app/README.md',
  'Benchook license: BENCHOOK-LICENSE.txt',
  'Electron/Chromium notices: LICENSE and LICENSES.chromium.html',
  'Other dependencies retain their license files under resources/app/panel/node_modules.', '',
].join('\r\n'));
const hashes = {};
function hashTree(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) hashTree(file);
    else hashes[path.relative(output, file).replace(/\\/g, '/')] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
}
hashTree(output);
fs.writeFileSync(path.join(output, 'BUILD-MANIFEST.json'), JSON.stringify({
  version: metadata.version, electron: require(path.join(panel, 'node_modules/electron/package.json')).version,
  platform: 'win32', arch: 'x64', builtAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceHasLocalChanges: !!execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim(),
  hashes,
}, null, 2) + '\n');
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  'Compress-Archive -LiteralPath $env:BENCHOOK_ARCHIVE_SOURCE -DestinationPath $env:BENCHOOK_ARCHIVE_OUTPUT -CompressionLevel Optimal'],
  { windowsHide: true, stdio: 'inherit', env: { ...process.env,
    BENCHOOK_ARCHIVE_SOURCE: output, BENCHOOK_ARCHIVE_OUTPUT: output + '.zip' } });
const digest = createHash('sha256').update(fs.readFileSync(output + '.zip')).digest('hex');
fs.writeFileSync(output + '.zip.sha256', digest + '  ' + path.basename(output) + '.zip\n');
console.log(JSON.stringify({ folder: output, zip: output + '.zip', sha256: digest, files: Object.keys(hashes).length }));
