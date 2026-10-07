'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicText } = require('./persistent-json');

// Only provider error fields enter this classifier, never task text or model replies.
function limitError(error) {
  return typeof error === 'string' && /(?:you(?:'|’)ve hit your (?:usage )?limit|you have reached your usage limit|usage limit (?:has been )?(?:reached|exceeded)|quota (?:has been )?(?:exceeded|exhausted)|insufficient_quota)/i.test(error);
}
function key(h) {
  const home = require('./accounts').folderPath(h);
  const file = path.join(home, h.provider === 'codex' ? 'auth.json' : '.credentials.json');
  let stamp = '';
  try { const s = fs.statSync(file); stamp = s.mtimeMs + ':' + s.size; } catch {}
  /* THE SIGNED-IN ACCOUNT, NOT THE FILE'S TIMESTAMP, identifies the warning when it is known: a token
     refresh rewrites the credential file, and the "limit reached" warning used to vanish with it while
     the account was still limited. A sign-in to another account changes the e-mail and starts clean. */
  if (h.email) stamp = 'email:' + String(h.email).trim().toLowerCase();
  return crypto.createHash('sha256').update(JSON.stringify([h.id,h.provider,path.resolve(home).toLowerCase(),stamp])).digest('hex');
}
function file(root,h) { return path.join(root,'quota-warnings',key(h)+'.json'); }
function save(root,h,error,time=Date.now()) {
  if (!root || !limitError(error)) return;
  // No raw provider text, account secrets, guessed percentage or guessed reset time.
  atomicText(file(root,h),JSON.stringify({time}));
}
function apply(root,h,d) {
  let event;
  try { event=JSON.parse(fs.readFileSync(file(root,h),'utf8')); } catch { return d; }
  if (!Number.isFinite(event.time) || event.resolved) return d;
  // Only a later actual quota observation supersedes this warning. A network/auth
  // failure and an older cached observation cannot clear it.
  if (d.quotaSourceTrusted === true && !d.quotaError && Date.parse(d.wasRead) > event.time && (Number.isFinite(d.short)||Number.isFinite(d.long))) {
    // Do not overwrite an event that arrived while the quota request was running.
    try {
      if (JSON.parse(fs.readFileSync(file(root,h),'utf8')).time === event.time)
        atomicText(file(root,h),JSON.stringify({...event,resolved:true}));
    } catch { /* the next successful read can reconcile it again */ }
    return d;
  }
  return {...d,stale:true,quotaWarning:'Usage limit reached for this account. Any displayed values are last known; current percentages and reset time were not reported by the worker.',quotaWarningTime:new Date(event.time).toISOString()};
}
module.exports={limitError,save,apply};
