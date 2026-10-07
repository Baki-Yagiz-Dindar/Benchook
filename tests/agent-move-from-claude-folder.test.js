'use strict';

/* MOVING AN AGENT OUT OF CLAUDE CODE'S OWN FOLDER (user decision, 6 October 2026).
 *
 * An agent in `.claude/agents` is run by Claude Code itself, on the orchestrator's account: an account
 * or model chosen for it in Benchook never applied in that project. When the user changes its account
 * or model and approves, saving moves the file into Benchook's folder in every project, then rewrites it.
 * Without that change it stays where it is. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-move-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the form recognises an agent in .claude/agents on Windows and other paths, and only there', () => {
  const page = fs.readFileSync(path.join(__dirname, '../panel/panel.js'), 'utf8');
  const line = page.split(/\r?\n/).find((l) => l.startsWith('const inClaudeFolder'));
  const box = vm.createContext({});
  vm.runInContext(line.replace('const inClaudeFolder', 'this.inClaudeFolder'), box);
  assert.equal(box.inClaudeFolder('C:\\p\\.claude\\agents\\reviewer.md'), true);
  assert.equal(box.inClaudeFolder('/home/me/p/.claude/agents/reviewer.md'), true);
  assert.equal(box.inClaudeFolder('C:\\p\\.benchook\\agents\\reviewer.md'), false);
  assert.equal(box.inClaudeFolder('C:\\p\\.claude\\agents-old\\reviewer.md'), false);
});

test('saving with a move puts the agent in Benchook\'s folder in every project and removes the old copy', (t) => {
  const root = temp(t);
  process.env.BENCHOOK_DATA_DIR = path.join(root, 'data');
  t.after(() => { delete process.env.BENCHOOK_DATA_DIR; });
  for (const k of Object.keys(require.cache)) if (/[\\/]panel[\\/]/.test(k)) delete require.cache[k];
  const sync = require('../panel/agent-sync');
  const registry = require('../panel/agent-registry');
  registry.setup(path.join(root, 'agents.json'));
  const writer = require('../panel/agent-writer');
  const a = path.join(root, 'A'), b = path.join(root, 'B');
  const old = (p) => path.join(p, '.claude', 'agents', 'reviewer.md');
  const text = '---\nname: reviewer\ndescription: Reviews\nmodel: orchestrator\naccount: orchestrator\nprovider: orchestrator\n---\n\nReview the change.\n';
  for (const p of [a, b]) { fs.mkdirSync(path.dirname(old(p)), { recursive: true }); fs.writeFileSync(old(p), text); }
  registry.add({ ...registry.fromFile(text), name: 'reviewer', projects: [a, b] });

  const field = { name: 'reviewer', description: 'Reviews', task: 'Review the change.', account: 'orchestrator',
    provider: null, model: 'orchestrator', permission: 'default', tools: null, oldPath: old(a), moveToPanel: true };
  const preview = writer.preview(a, field);
  assert.equal(path.resolve(preview.filePath), path.resolve(sync.panelPath(a, 'reviewer')), 'the preview names the new place');
  assert.equal(path.resolve(preview.oldPath), path.resolve(old(a)), 'so the page shows the move warning');

  const r = sync.saveForm({ project: a, name: 'reviewer', content: preview.content, intent: 'edit',
    oldName: 'reviewer', oldPath: old(a), moveToPanel: true });
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.publishErrors, []);
  for (const p of [a, b]) {
    assert.equal(fs.existsSync(old(p)), false, 'the old copy is gone in ' + p);
    assert.equal(fs.existsSync(sync.panelPath(p, 'reviewer')), true, 'the agent is in Benchook\'s folder in ' + p);
  }
  assert.equal(r.moved.length, 2);
});

test('saving without a move leaves an agent in .claude/agents where it is', (t) => {
  const root = temp(t);
  process.env.BENCHOOK_DATA_DIR = path.join(root, 'data');
  t.after(() => { delete process.env.BENCHOOK_DATA_DIR; });
  for (const k of Object.keys(require.cache)) if (/[\\/]panel[\\/]/.test(k)) delete require.cache[k];
  const sync = require('../panel/agent-sync');
  const registry = require('../panel/agent-registry');
  registry.setup(path.join(root, 'agents.json'));
  const a = path.join(root, 'A');
  const old = path.join(a, '.claude', 'agents', 'reviewer.md');
  const text = '---\nname: reviewer\ndescription: Reviews\nmodel: orchestrator\naccount: orchestrator\nprovider: orchestrator\n---\n\nReview.\n';
  fs.mkdirSync(path.dirname(old), { recursive: true }); fs.writeFileSync(old, text);
  registry.add({ ...registry.fromFile(text), name: 'reviewer', projects: [a] });
  const r = sync.saveForm({ project: a, name: 'reviewer', content: text.replace('Review.', 'Review again.'),
    intent: 'edit', oldName: 'reviewer', oldPath: old });
  assert.ok(!r.error, r.error);
  assert.equal(fs.existsSync(old), true);
  assert.equal(fs.existsSync(sync.panelPath(a, 'reviewer')), false);
});

test('with the agent in both folders, a save is written where reconcile reads first and is not undone', (t) => {
  const root = temp(t);
  process.env.BENCHOOK_DATA_DIR = path.join(root, 'data');
  t.after(() => { delete process.env.BENCHOOK_DATA_DIR; });
  for (const k of Object.keys(require.cache)) if (/[\/]panel[\/]/.test(k)) delete require.cache[k];
  const sync = require('../panel/agent-sync');
  const registry = require('../panel/agent-registry');
  registry.setup(path.join(root, 'agents.json'));
  const a = path.join(root, 'A');
  const text = '---\nname: reviewer\ndescription: Reviews\nmodel: orchestrator\naccount: orchestrator\nprovider: orchestrator\n---\n\nReview.\n';
  const own = sync.panelPath(a, 'reviewer'), old = path.join(a, '.claude', 'agents', 'reviewer.md');
  for (const f of [own, old]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
  registry.add({ ...registry.fromFile(text), name: 'reviewer', projects: [a] });
  assert.equal(path.resolve(sync.targetPath(a, 'reviewer')), path.resolve(own));
  const edited = text.replace('Review.', 'Review again.');
  const r = sync.saveForm({ project: a, name: 'reviewer', content: edited, intent: 'edit', oldName: 'reviewer', oldPath: own });
  assert.ok(!r.error, r.error);
  sync.reconcile(a);
  assert.match(registry.text(registry.find('reviewer')), /Review again\./, 'the saved text stays in the registry');
});

test('the preview of an edit keeps front matter fields Benchook does not know, exactly as the save writes them', (t) => {
  const root = temp(t);
  process.env.BENCHOOK_DATA_DIR = path.join(root, 'data');
  t.after(() => { delete process.env.BENCHOOK_DATA_DIR; });
  for (const k of Object.keys(require.cache)) if (/[\/]panel[\/]/.test(k)) delete require.cache[k];
  const sync = require('../panel/agent-sync');
  const registry = require('../panel/agent-registry');
  registry.setup(path.join(root, 'agents.json'));
  const writer = require('../panel/agent-writer');
  const a = path.join(root, 'A');
  const text = '---\nschema: panel-agent/v1\nname: planner\ndescription: Plans\nmodel: orchestrator\naccount: orchestrator\n'
    + 'tools: Read, Grep, Glob, Bash\npermissionMode: plan\n---\n\nPlan.\n';
  const file = sync.panelPath(a, 'planner');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  registry.add({ ...registry.fromFile(text), name: 'planner', projects: [a] });
  const preview = writer.preview(a, { name: 'planner', description: 'Plans better', task: 'Plan.', account: 'orchestrator',
    provider: null, model: 'orchestrator', permission: null, tools: 'Read, Grep, Glob, Bash', oldPath: file });
  assert.match(preview.content, /^permissionMode: plan$/m, 'the preview shows the kept field');
  const r = sync.saveForm({ project: a, name: 'planner', content: preview.content, intent: 'edit', oldName: 'planner', oldPath: file });
  assert.ok(!r.error, r.error);
  assert.equal(fs.readFileSync(file, 'utf8'), preview.content, 'the approved preview is the file written');
});

test('recording the same publish state or the same name lock again does not rewrite the registry', (t) => {
  const root = temp(t);
  for (const k of Object.keys(require.cache)) if (/[\/]panel[\/]/.test(k)) delete require.cache[k];
  const registry = require('../panel/agent-registry');
  const file = path.join(root, 'agents.json');
  registry.setup(file);
  const text = '---\nname: scout\ndescription: Scouts\nmodel: orchestrator\naccount: orchestrator\n---\n\nScout.\n';
  registry.add({ ...registry.fromFile(text), name: 'scout', projects: [path.join(root, 'A')] });
  registry.savePublish('scout', path.join(root, 'A'), { succeeded: true, content: text });
  registry.markConflict('scout', path.join(root, 'B'), 'abc');
  const before = fs.statSync(file).ino + ':' + fs.readFileSync(file, 'utf8');
  registry.savePublish('scout', path.join(root, 'A'), { succeeded: true, content: text });
  registry.markConflict('scout', path.join(root, 'B'), 'abc');
  assert.equal(fs.statSync(file).ino + ':' + fs.readFileSync(file, 'utf8'), before, 'no new file replaced the registry');
  registry.markConflict('scout', path.join(root, 'B'), 'def');
  assert.equal(registry.find('scout').nameConflicts[registry.projectKey(path.join(root, 'B'))].digest, 'def', 'a changed lock is still written');
});
