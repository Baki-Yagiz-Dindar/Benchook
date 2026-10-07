'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const setup = require('../panel/project-setup');
const accounts = require('../panel/accounts');
const { modelCheck } = require('../panel/worker');
const { externalUrl, trustedSender } = require('../panel/security');
const { stopTerminal } = require('../panel/terminal-stop');
const { pathToFileURL } = require('node:url');
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchook-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
test('Codex onboarding preserves trust decisions across TOML representations', t => {
  const onboarding = require('../panel/onboarding');
  const root = temp(t), file = path.join(root, 'config.toml'), key = onboarding.codexProjectKey(root);
  for (const text of [
    `[projects.'${key}'] # project\ntrust_level = 'untrusted'\n`,
    `projects = { '${key}' = { trust_level = 'untrusted' } }\n`,
  ]) {
    fs.writeFileSync(file, text);
    assert.equal(onboarding.status({ provider: 'codex' }, root, root).trust.otherDecision, 'untrusted');
    onboarding.apply({ provider: 'codex' }, root, root, { trust: true });
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
  for (const text of ['broken = [', 'projects = false', `[projects.'${key}']\ntrust_level = 3`]) {
    fs.writeFileSync(file, text);
    assert.throws(() => onboarding.apply({ provider: 'codex' }, root, root, { trust: true }));
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});

/* This test used to exercise the write, delete and source-write paths in `agent-writer.js`. The write
   direction was later reversed and those three paths lost every caller; they were removed together with
   the dead paths. The PROTECTED BEHAVIOUR is the same: the panel does not write or delete outside the
   project through a junction. The real path now is `agent-sync.js` `allowed`/`saveForm`; the protection
   against writing to a path it did not produce is structural -- the target path is computed from the
   registry and the project, not from user input. */
test('publishing an agent does not follow a junction out of the project', t => {
  const sync = require('../panel/agent-sync');
  const registry = require('../panel/agent-registry');
  const root = temp(t);
  registry.setup(path.join(root, 'agents.json'));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const outside = path.join(root, 'important.md');
  fs.writeFileSync(outside, 'preserve');
  assert.equal(sync.allowed(project, outside), false, 'the file is outside the agent folder');
  if (process.platform === 'win32') {
    const external = path.join(root, 'external'); fs.mkdirSync(external);
    fs.mkdirSync(path.join(project, '.benchook'));
    fs.symlinkSync(external, path.join(project, '.benchook/agents'), 'junction');
    const file = path.join(project, '.benchook/agents/agent.md');
    fs.writeFileSync(file, 'preserve');
    assert.equal(sync.allowed(project, file), false, 'the junction chain leads outside the project');
    const r = sync.saveForm({ project, name: 'agent', intent: 'new',
      content: ['---', 'name: agent', 'description: d', 'account: orchestrator',
        'model: orchestrator', '---', '', 'changed', ''].join('\n') });
    assert.ok(r.error || (r.publishErrors && r.publishErrors.length), 'a write through a junction must be refused');
    assert.match(JSON.stringify(r), /outside the project's agent folders/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'preserve');
  }
});

test('project setup preserves malformed JSON and unsupported settings structures', t => {
  for (const contents of ['{broken', 'null', '[]', '{"hooks":[]}', '{"hooks":{"SessionStart":{}}}', '{"mcpServers":false}']) {
    const root = temp(t), file = path.join(root, '.mcp.json');
    fs.writeFileSync(file, contents);
    const plan = setup.plan(root, () => null);
    assert.ok(plan.error); assert.equal(plan.steps, undefined);
    assert.equal(fs.readFileSync(file, 'utf8'), contents);
    assert.equal(fs.existsSync(path.join(root, '.claude')), false);
  }
});
test('project setup rejects changed, created and deleted destinations before writing any file', t => {
  for (const action of ['change', 'create', 'delete']) {
    const root = temp(t), file = path.join(root, '.mcp.json');
    if (action !== 'create') fs.writeFileSync(file, '{}');
    const plan = setup.plan(root, () => null);
    if (action === 'delete') fs.unlinkSync(file); else fs.writeFileSync(file, '{"external":true}');
    const result = setup.apply(plan.steps);
    assert.match(result.error, /changed since preview/); assert.deepEqual(result.written, []);
    assert.equal(fs.existsSync(path.join(root, '.claude/settings.json')), false);
    if (action !== 'delete') assert.equal(fs.readFileSync(file, 'utf8'), '{"external":true}');
  }
});
test('project setup rolls back earlier writes if a later destination cannot be installed', t => {
  const root = temp(t), file = path.join(root, '.mcp.json'); fs.writeFileSync(file, '{}');
  const plan = setup.plan(root, () => null), rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file && path.basename(from).startsWith('.benchook-new-')) throw new Error('injected install error');
    return rename(from, to);
  });
  assert.match(setup.apply(plan.steps).error, /injected/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
  assert.equal(fs.existsSync(path.join(root, '.claude/settings.json')), false);
});
test('unrecoverable account stores reject mutations without replacing saved bytes', t => {
  for (const contents of ['{broken', '{"accounts":[null]}', '{"accounts":{}}']) {
    const file = path.join(temp(t), 'accounts.json'); fs.writeFileSync(file, contents); accounts.setup(file);
    assert.throws(() => accounts.list(), /preserved/);
    assert.throws(() => accounts.remove('test'), /preserved/);
    assert.throws(() => accounts.add({ provider: 'claude', name: 'Test' }), /preserved/);
    assert.equal(fs.readFileSync(file, 'utf8'), contents);
  }
});
test('account stores recover the last intact backup instead of inventing default accounts', t => {
  const root = temp(t), file = path.join(root, 'accounts.json'); accounts.setup(file);
  const data = { accounts: [{ id: 'own', name: 'Own account', provider: 'claude', folder: null }] };
  fs.writeFileSync(file, '{broken'); fs.writeFileSync(file + '.bak', JSON.stringify(data));
  assert.equal(accounts.list()[0].id, 'own');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), data);
  assert.ok(fs.readdirSync(root).some(name => name.includes('.corrupt-')));
});
test('Windows profile aliases cannot register the same folder twice', { skip: process.platform !== 'win32' }, t => {
  const root = temp(t), profile = path.join(root, 'Profile'); fs.mkdirSync(profile);
  const file = path.join(root, 'accounts.json'); fs.writeFileSync(file, '{"accounts":[]}'); accounts.setup(file);
  accounts.add({ provider: 'codex', name: 'First', folder: profile });
  assert.throws(() => accounts.add({ provider: 'codex', name: 'Second', folder: profile.toUpperCase() }), /already used/);
  const alias = path.join(root, 'alias'); fs.symlinkSync(profile, alias, 'junction');
  assert.throws(() => accounts.add({ provider: 'codex', name: 'Alias', folder: alias }), /already used/);
});
test('model verification rejects partial names and different versions', () => {
  for (const [requested, actual] of [['claude-sonnet-4-5-20250929', 'claude-sonnet-4'], ['gpt-5', 'gpt-5.6'], ['last', 'claude-sonnet-5'], ['opus', 'not-claude-opus-5']])
    assert.equal(modelCheck(requested, [actual], 'claude').verified, false);
  assert.equal(modelCheck('sonnet', ['claude-sonnet-5'], 'claude').verified, true);
});
test('external links accept web URLs and reject executable or ambiguous URLs', () => {
  assert.equal(externalUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(externalUrl('http://localhost:3000/'), 'http://localhost:3000/');
  for (const value of ['file:///C:/Windows/notepad.exe', 'javascript:alert(1)', 'data:text/html,hello', 'ms-settings:privacy', 'https://user:pass@example.com', ' https://example.com', '\\server\share', null, {}]) assert.equal(externalUrl(value), null);
});
test('IPC trusts only the local main frame of the current window', () => {
  const file = path.resolve('panel/index.html'); const frame = { url: pathToFileURL(file).href + '?theme=pink' };
  const webContents = { mainFrame: frame }, window = { webContents, isDestroyed: () => false };
  assert.equal(trustedSender({ sender: webContents, senderFrame: frame }, window, file), true);
  assert.equal(trustedSender({ sender: webContents, senderFrame: { ...frame } }, window, file), false);
  frame.url = 'https://example.com/'; assert.equal(trustedSender({ sender: webContents, senderFrame: frame }, window, file), false);
});
test('terminal shutdown reports timeout and kill errors instead of hanging or claiming success', async () => {
  let disposed = false;
  const pending = { onExit: () => ({ dispose: () => { disposed = true; } }), kill() {} };
  assert.match((await stopTerminal(pending, 15)).error, /did not stop/); assert.equal(disposed, true);
  assert.match((await stopTerminal({ ...pending, kill() { throw new Error('blocked'); } }, 15)).error, /blocked/);
  let callback;
  const ok = { onExit(f) { callback = f; return { dispose() {} }; }, kill() { callback(); } };
  assert.deepEqual(await stopTerminal(ok), { done: true });
});
