// Claude account metadata comes from the official CLI, never its credential file.
const fs = require('node:fs');
const path = require('node:path');
const cli = require('./cli-path');
const child = require('./subprocess');
const accounts = require('./accounts');
function claudeStamp(folder) {
  try { const s=fs.statSync(path.join(folder || accounts.defaultHome('claude'),'.credentials.json'));
    return [s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':'); } catch { return null; }
}
/* THE ACCOUNT CARDS POLL EVERY 5 SECONDS, and each poll started one `claude auth status` process per
   Claude account: with many accounts a constant stream of processes. A successful reading is reused
   while the credential file is unchanged, for at most a minute; signing in, signing out or a token
   refresh changes the file and forces a fresh reading. Failures are never reused. */
const claudeCache = new Map();
/* ONE READING AT A TIME PER FOLDER. A signed-out account is never cached, and one reading can take up to
   15 s; with the 5-second poll, two or three `claude auth status` processes used to run at once for the
   same folder. A poll that arrives while a reading runs now waits for that reading. A fresh reading
   (after a sign-in or sign-out) always starts its own. */
const claudePending = new Map();
async function claude(folder, { fresh = false } = {}) {
  folder = path.resolve(folder || accounts.defaultHome('claude'));
  const stamp = claudeStamp(folder);
  const cached = fresh ? null : claudeCache.get(folder);
  if (cached && cached.stamp === stamp && Date.now() - cached.at < 60000) return { ...cached.result };
  if (!fresh && claudePending.has(folder)) return { ...(await claudePending.get(folder)) };
  const reading = readClaude(folder, stamp);
  if (!fresh) claudePending.set(folder, reading);
  let result;
  try { result = await reading; }
  finally { if (claudePending.get(folder) === reading) claudePending.delete(folder); }
  /* Only a signed-in reading is reused. A "signed out" answer is always asked again, so a sign-in made
     anywhere (Benchook, a terminal, another tool) shows at the next poll even if it did not touch the
     file this cache watches. Without a credential file nothing is cached. */
  if (stamp && result.signedIn === true) claudeCache.set(folder, { stamp, at: Date.now(), result });
  else claudeCache.delete(folder);
  return result;
}
async function readClaude(folder, stamp) {
  const c = cli.cliInvocation('claude');
  if (!c) return { error: cli.cliProblem('claude').kind === 'broken' ? 'Claude Code installation is broken' : 'Claude Code is not installed' };
  const r = await child.run({ command:c.command, arg:[...c.leadingArgs,'auth','status','--json'],
    env:accounts.env({provider:'claude',folder}), durationMs:15000, maxOutput:65536 });
  if (r.error) return { error:'Could not read Claude Code sign-in status' };
  try {
    const v = JSON.parse(r.output);
    if (typeof v.loggedIn !== 'boolean' || stamp !== claudeStamp(folder)) throw new Error();
    if (!v.loggedIn) return { signedIn:false, error:'Not signed in to Claude Code' };
    if (r.code !== 0) throw new Error();
    return { signedIn:true, email:typeof v.email === 'string' ? v.email : null,
      org:typeof v.orgId === 'string' ? v.orgId : null,
      plan:typeof v.subscriptionType === 'string' ? v.subscriptionType : null,
      source:'Claude Code CLI', wasRead:new Date().toISOString() };
  } catch { return { error:'Could not read Claude Code sign-in status' }; }
}

function codex(folder) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(
    path.join(folder || accounts.defaultHome('codex'), 'auth.json'), 'utf8')); }
  catch (e) { return { error: "Could not read Codex credentials: " + e.message }; }

  const tokens = raw?.tokens?.id_token;
  if (typeof tokens !== 'string' || !tokens) return { error: "No identity token found in Codex credentials" };

  let body;
  try {
    body = JSON.parse(Buffer.from(tokens.split('.')[1], 'base64').toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid identity');
  } catch { return { error: "Could not decode the Codex identity token" }; }

  return {
    email: typeof body.email === 'string' ? body.email : null,
    name: typeof body.name === 'string' ? body.name : null,
    plan: typeof raw.auth_mode === 'string' ? raw.auth_mode : null,
    source: 'local',
    wasRead: typeof raw.last_refresh === 'string' ? raw.last_refresh : null,
  };
}

/* Bind observations to the login reported by the CLI (email and organization). Credential-file timestamps can change without an account switch and are not an identity signal. */
function signInIdentity(k) {
  if (!k || !k.signedIn || !k.email) return null;
  return k.email + '|' + (k.org || '');
}
module.exports = { claude, codex, claudeStamp, signInIdentity };
