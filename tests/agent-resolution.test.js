'use strict';
// THE OWN CONTRACT OF AGENT RESOLUTION.
//
// Why a separate file: this module is the ONE place that answers which account and which model an agent
// will run on, yet no test called it directly; it was only exercised indirectly through its callers.
// The biggest error of one day was exactly a caller SKIPPING this module. Indirect coverage
// cannot catch that error, because when the caller does not call the module the test does not either.
//
// Every assertion here matches a documented rule of the module; what is pinned is the rule itself, not
// the behaviour of its callers.
const test = require('node:test');
const assert = require('node:assert');
const resolution = require('../panel/agent-resolution');

const registry = {
  'claude-account-a': { id: 'claude-account-a', name: 'account-a', provider: 'claude' },
  'codex-account-b': { id: 'codex-account-b', name: 'account-b', provider: 'codex' },
};
const find = (x) => registry[x] || null;

test('with no account written it binds to the orchestrator and NO REASON is written', () => {
  const c = resolution.resolve({}, find);
  assert.equal(c.asOrchestrator, true);
  assert.equal(c.reason, null, 'with no event there is no reason to explain to the user either');
  assert.equal(resolution.accountLabel(c), 'Same as orchestrator');
  assert.equal(resolution.modelLabel(c), 'Same as orchestrator');
});

test('an account explicitly set to "orchestrator" is the choice of the user; no reason is written', () => {
  const c = resolution.resolve({ account: resolution.ORCHESTRATOR, model: 'haiku' }, find);
  assert.equal(c.asOrchestrator, true);
  assert.equal(c.reason, null);
  assert.equal(c.model, resolution.ORCHESTRATOR, 'the model follows the account, not what the file says');
});

test('an account missing from the registry does not hide the agent; it binds to the orchestrator and gives the reason', () => {
  const c = resolution.resolve({ account: 'deleted-account', model: 'haiku' }, find);
  assert.equal(c.asOrchestrator, true);
  assert.match(c.reason, /deleted-account/, 'it must say which account went missing');
  assert.match(c.reason, /not registered/, 'the text must be English: it appears on screen');
  assert.equal(c.fileAccount, 'deleted-account', 'what the file says is not lost');
  assert.equal(c.fileModel, 'haiku');
});

test('for a real account the IDENTITY comes from the registry, not the display name in the file', () => {
  const c = resolution.resolve({ account: 'claude-account-a', model: 'haiku' }, find);
  assert.equal(c.asOrchestrator, false);
  assert.equal(c.account, 'claude-account-a');
  assert.equal(c.provider, 'claude');
  assert.equal(c.model, 'haiku');
  assert.equal(c.reason, null);
});

test('the provider comes from the registry; a contradiction in the file is NOT swallowed, it stays visible', () => {
  const c = resolution.resolve({ account: 'codex-account-b', provider: 'account-a' }, find);
  assert.equal(c.provider, 'codex', 'olgu ipucunu yener');
  assert.match(c.providerConflict, /account-a/);
  assert.match(c.providerConflict, /codex/);
});

test('an unwritten model is not invented: the default of the account is used', () => {
  const c = resolution.resolve({ account: 'claude-account-a' }, find);
  assert.equal(c.model, null, 'it is left empty; the model of the orchestrator is NOT copied');
  assert.equal(resolution.modelLabel(c), 'Account default');
});

test('with no registry function supplied no account counts as real', () => {
  const c = resolution.resolve({ account: 'claude-account-a' }, null);
  assert.equal(c.asOrchestrator, true, 'if it cannot consult the registry it does not guess');
  assert.match(c.reason, /not registered/);
});

test('whitespace and an empty string count as not written', () => {
  for (const empty of ['', '   ', null, undefined]) {
    assert.equal(resolution.resolve({ account: empty }, find).asOrchestrator, true, JSON.stringify(empty));
  }
});

/* THE FIXTURE WAS CORRECTED. The old one had no opening `---` line: a front-matter-less plain
   Markdown with a `---` rule in the middle, which the NEW rule counts entirely as BODY -- exactly what
   R16 asked for. The rule was not loosened to make the old fixture pass; the fixture was brought to the
   shape of a real file and the opposite direction is written separately below. */
test('the front matter reader separates the fields from the body', () => {
  const { get, body, corrupt } = resolution.parseFrontmatter(
    '---\nname: auditor\naccount: claude-account-a\n---\nTask text.');
  assert.equal(corrupt, null);
  assert.equal(get('name'), 'auditor');
  assert.equal(get('account'), 'claude-account-a');
  assert.equal(get('noSuch'), null);
  assert.equal(body, 'Task text.');
});

test('front matter exists only at the START of the file; otherwise the whole text is the body', () => {
  // R16 itself: a file containing a newline followed by `---` but with no front matter.
  const raw = 'name: not a heading\n---\nTask text.';
  const { get, body, hasOnText } = resolution.parseFrontmatter(raw);
  assert.equal(hasOnText, false);
  assert.equal(get('name'), null, 'a line in the body must not be mistaken for a front matter field');
  assert.equal(body, raw, 'not even one character may be lost');
});

test('front matter that opens but never closes returns WITH ITS REASON; it is not silently emptied', () => {
  const { corrupt, body } = resolution.parseFrontmatter('---\nname: auditor\n\nTask text.');
  assert.match(corrupt, /never closes/);
  assert.equal(body, '', 'no body is produced either, so the caller cannot publish a corrupt record');
});

test('an unknown field and a comment in the front matter are preserved with their raw line', () => {
  const { entries } = resolution.parseFrontmatter(
    '---\nname: auditor\n# comment\ndisallowedTools:\n  - Bash\n---\nTask.');
  const unknown = entries.find((g) => g.key === 'disallowedTools');
  assert.deepEqual(unknown.lines, ['disallowedTools:', '  - Bash']);
  assert.ok(entries.some((g) => g.key === null && g.lines[0] === '# comment'));
  assert.equal(resolution.singleLines(unknown), false, 'a multi-line value must not count as a single line');
});

test('the routing text has one source; the places that read it do not write their own copy', () => {
  // If the texts drift apart the orchestrator hears two different rules. The SOURCE is compared, not a copy.
  const fs = require('node:fs');
  for (const file of ['../tools/mcp-server.js', '../tools/project-catalog.js']) {
    const source = fs.readFileSync(require('node:path').join(__dirname, file), 'utf8');
    assert.match(source, /resolution\.(ROUTING|routing\()/, file + ' must not write its own copy');
  }
  assert.match(resolution.ROUTING, /run_agent/);
  assert.match(resolution.ROUTING, /Same as orchestrator/);
});

/* THE ACCOUNT OF THE SESSION IS STATED - the test for a measured defect. The old text told the
   orchestrator to determine its active account and not to guess; a session has no way of knowing its
   own panel identity, so the rule contained a step that could not be carried out. */
test('when the account is known the routing STATES it instead of making it guess', () => {
  const m = resolution.routing({ id: 'claude-abc', name: 'sample', provider: 'claude' });
  assert.match(m, /claude-abc/, 'the id must be written');
  assert.match(m, /sample/, 'the label must be written too');
  assert.doesNotMatch(m, /do not guess/i, 'it is no longer asked to guess; it is told');
});

test('when the account is unknown no id is INVENTED and this is stated plainly', () => {
  assert.match(resolution.ROUTING, /could not determine which account/i);
  assert.doesNotMatch(resolution.ROUTING, /You are running as account/);
});

test('for an agent with no account the absence of the native path is not a dead end', () => {
  // In an empty `.claude/agents/` folder, saying use native would describe a path that does not exist;
  // the text now names the second path too.
  for (const m of [resolution.ROUTING, resolution.routing({ id: 'x', name: 'x', provider: 'claude' })]) {
    assert.match(m, /Same as orchestrator/);
    assert.match(m, /run_agent/);
  }
});
