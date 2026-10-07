// ACCOUNT LOGIN FLOW - without a terminal. There is no Electron in this file; pure, testable logic.
//
// The browser opens directly and the account is signed in in the interface afterwards; no terminal
// panel is put in front of the user.
//
// THE TWO PROGRAMS DO NOT BEHAVE THE SAME - measured against real runs:
//
//   codex login      -> opens the browser itself, the browser comes back to localhost, and THE WORK
//                       IS DONE. Nothing is written to the terminal.
//
//   claude auth login -> prints "Opening browser to sign in", then ASKS FOR A CODE with
//                       "Paste code here if prompted > ". Under Claude the login cannot complete
//                       without somewhere to type.
//
// So there is one screen but it adapts: the browser opens by itself in both cases, and a single
// paste box appears only if the program asks for a code. No terminal is ever opened.

/** Which command runs. Not invented: read from `codex login --help` and `claude auth --help`. */
function signInCommand(provider) {
  return provider === 'codex'
    ? { name: 'codex', args: ['login'] }
    : { name: 'claude', args: ['auth', 'login'] };
}

/* The login address: both programs print the full URL as "if your browser did not open, go here".
   The pattern is not written per provider; the first https address is taken - both print exactly one. */
const URL_PATTERN = /https:\/\/[^\s"'<>]+/;

/* The code prompt. The real line of Claude is "Paste code here if prompted > ".
   The word `code` alone is not enough (`code_challenge` appears inside the URL), so the PASTE verb
   is what is searched for. */
const CODE_PATTERN = /paste\s+(the\s+)?code|enter\s+(the\s+)?code|authorization code:/i;

/**
 * Reads the two things the screen needs to know out of the output of the program.
 * @param {string} text  the output accumulated so far
 * @returns {{url:string|null, codeWants:boolean}}
 */
function readOutput(text) {
  const m = String(text || '');
  const url = (m.match(URL_PATTERN) || [null])[0];
  // The URL line itself asks for no code; the pattern is searched for OUTSIDE the URL.
  const withoutUrl = m.replace(new RegExp(URL_PATTERN.source, 'g'), ' ');
  return { url: url || null, codeWants: CODE_PATTERN.test(withoutUrl) };
}

/**
 * Did the login really happen once the process ended?
 * The exit code ALONE is not enough: the process can return 0 when the user gave up in the browser.
 * The only real proof is that the identity file was written - look at the real thing itself.
 * @param {boolean} hasFile  whether the account has a sign-in file
 */
function result(signOutCode, hasFile) {
  if (signOutCode === 0 && hasFile) return { status: 'done' };
  return { status: 'error', reason: signOutCode === 0
    ? "Sign-in was not completed; it may have been cancelled in the browser"
    : "Sign-in process exited with code " + signOutCode + "" };
}

/* ---------------- SIGNING OUT ----------------
 *
 * THE MEASURED DEFECT: the panel had NO sign-out function at all. The only thing possible was to
 * delete the account from the registry, which removes the record of the panel only - the identity
 * file stays on disk. A user who deleted their accounts from the registry was left with sessions
 * still open and no screen left to sign out from, because a deleted account is not in the list.
 *
 * THE PANEL NEVER TOUCHES THE TOKEN. The deletion is done by the own command of each program; both
 * exist and both were read from their `--help` output, not invented.
 *
 * Which account it runs under is told, as at login, only through an environment variable.
 */
function signOutCommand(provider) {
  return provider === 'codex'
    ? { name: 'codex', args: ['logout'] }
    : { name: 'claude', args: ['auth', 'logout'] };
}

/**
 * Did the sign-out really happen?
 * The mirror image of the login rule: the exit code alone is not enough, and the only real proof is
 * that the identity file is NO LONGER THERE. What is checked is the thing itself, not its name.
 * @param {boolean} fileExists  the result of signedIn(account) AFTER the sign-out
 */
function signOutResult(signOutCode, hasFile) {
  if (!hasFile) return { status: 'done' };
  return { status: 'error', reason: signOutCode === 0
    ? "The sign-out command completed, but credentials are still present"
    : "Sign-out process exited with code " + signOutCode + "; credentials are still present" };
}

module.exports = { signInCommand, readOutput, result, signOutCommand, signOutResult };
