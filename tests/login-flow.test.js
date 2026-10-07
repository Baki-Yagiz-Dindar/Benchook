// THE LOGIN FLOW WITHOUT A TERMINAL.
//
// The texts in these tests were NOT INVENTED: `codex login` and `claude auth login` were really run with
// throwaway identity folders and their output was copied here. The two programs behaved differently,
// and the screen was designed around that difference.

const test = require('node:test');
const assert = require('node:assert');
const { signInCommand, readOutput, result, signOutCommand, signOutResult } = require('../panel/login-flow.js');

const CODEX_OUTPUT = 'Starting local login server on http://localhost:1455.\n'
  + 'If your browser did not open, navigate to this URL to authenticate:\n\n'
  + 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoam'
  + '&code_challenge=PikF&code_challenge_method=S256&originator=codex_cli_rs\n\n'
  + 'On a remote or headless machine? Use `codex login --device-auth` instead.';

const CLAUDE_OUTPUT = 'Opening browser to sign in…\n'
  + "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true"
  + '&client_id=9d1c250a&response_type=code&code_challenge=-20biJt&code_challenge_method=S256\n'
  + 'Paste code here if prompted > ';

test('the commands are right', () => {
  assert.deepStrictEqual(signInCommand('codex'), { name: 'codex', args: ['login'] });
  assert.deepStrictEqual(signInCommand('claude'), { name: 'claude', args: ['auth', 'login'] });
});

test('the address is read from the Codex output and NO CODE is requested', () => {
  const r = readOutput(CODEX_OUTPUT);
  assert.ok(r.url && r.url.startsWith('https://auth.openai.com/'), 'the address could not be read: ' + r.url);
  assert.strictEqual(r.codeWants, false, 'Codex asks for no code; if the box appears the user waits for nothing');
});

test('the address is read from the Claude output AND a code is requested', () => {
  const r = readOutput(CLAUDE_OUTPUT);
  assert.ok(r.url && r.url.startsWith('https://claude.com/'), 'the address could not be read: ' + r.url);
  assert.strictEqual(r.codeWants, true, 'without the box a Claude login can never be completed');
});

/* "code_challenge" appears INSIDE the URL. Had the pattern looked only for "code", the box would have
   appeared under Codex too and the user would have waited for a code that does not exist. */
test('the word "code" inside a URL is not mistaken for a code request', () => {
  assert.strictEqual(readOutput('https://x.com/a?code_challenge=abc&response_type=code').codeWants, false);
});

test('while the output is still empty the screen invents nothing', () => {
  assert.deepStrictEqual(readOutput(''), { url: null, codeWants: false });
});

/* THE RESULT LOOKS AT THE IDENTITY FILE, NOT THE EXIT CODE. When the user gives up in the browser the
   process can return 0; if the panel showed that as signed in, agents would try to run on an account
   with no login. */
test('if the identity file was written the login happened', () => {
  assert.strictEqual(result(0, true).status, 'done');
});

test('exit code 0 with no file means the login did NOT happen', () => {
  const r = result(0, false);
  assert.strictEqual(r.status, 'error');
  assert.match(r.reason, /not completed/);
});

test('on an error exit the reason carries the code', () => {
  assert.match(result(1, false).reason, /code 1/);
  assert.equal(result(1, true).status, 'error', 'existing credentials cannot prove a failed login succeeded');
});

/* SIGNING OUT: signing in and out of accounts from the program has to work cleanly.
   The measured defect: the panel had NO sign-out function at all; deleting the account from the
   registry removed only the record of the panel, while the identity file stayed on disk. */

test('the sign-out command is the OWN command of each provider; the panel never touches the token', () => {
  // Both were read from `--help` output, not invented:
  //   codex logout       -> "Remove stored authentication credentials"
  //   claude auth logout -> "Log out from your Anthropic account"
  assert.deepEqual(signOutCommand('codex'), { name: 'codex', args: ['logout'] });
  assert.deepEqual(signOutCommand('claude'), { name: 'claude', args: ['auth', 'logout'] });
});

test('the proof of a sign-out is that the identity file is GONE, not the exit code', () => {
  // The command returned 0 but the file remains: the sign-out DID NOT happen; it is not called done.
  assert.equal(signOutResult(0, true).status, 'error');
  assert.match(signOutResult(0, true).reason, /still present/);
  // If the file is gone the sign-out happened -- even if the command returned a non-zero code.
  assert.equal(signOutResult(0, false).status, 'done');
  assert.equal(signOutResult(1, false).status, 'done');
});

test('if the sign-out command ends with an error code and the file remains, the reason carries the code', () => {
  const s = signOutResult(3, true);
  assert.equal(s.status, 'error');
  assert.match(s.reason, /code 3/);
});
