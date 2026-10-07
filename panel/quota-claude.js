'use strict';
// Supported status-line observations only. No credentials or HTTP calls.
function window(p, now = Date.now()) {
  if (!p || !Number.isFinite(p.used_percentage) || p.used_percentage < 0 || p.used_percentage > 100
    || !Number.isFinite(p.resets_at) || p.resets_at * 1000 <= now) return null;
  const date = new Date(p.resets_at * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  return { percent:p.used_percentage, resetsAt:date.toISOString() };
}
function parse(v, now = Date.now()) {
  return { short:window(v?.five_hour,now), long:window(v?.seven_day,now) };
}
function read(observation, now = Date.now(), reason = false) {
  // The third parameter used to be a single flag; it now also takes {identityChanged, identityUnknown}.
  const idChanged = typeof reason === 'object' && reason ? !!reason.idChanged : !!reason;
  const idUnknown = typeof reason === 'object' && reason ? !!reason.idUnknown : false;
  const k = observation?.quota;
  const valid = p => p && Number.isFinite(p.percent) && p.percent >= 0 && p.percent <= 100
    && Date.parse(p.resetsAt) > now ? p : null;
  const short=valid(k?.short), long=valid(k?.long);
  if (!short && !long) return {error: idChanged
    ? 'Usage limits unavailable: sign-in information changed after this terminal started. Open a new Claude terminal to collect usage for the current sign-in.'
    : idUnknown
    /* There is an observation but which login it belongs to could not be read yet. The old
       sentence told the user to start a session while one was already running; the real reason is that the identity could not be verified. */
    ? "Usage limits unavailable: this terminal's sign-in could not be confirmed yet. Benchook retries shortly."
    : 'Usage limits unavailable. Start a Claude Code session with status-line reporting.'};
  return {short,long,stale:true,wasRead:observation.time,source:'Claude Code status line'};
}
/* WHICH TERMINAL OBSERVATION IS TRUSTED. The login identity read from the CLI when the
   terminal opened is compared with the current identity of the account. If they match the observation
   belongs to that account; if they differ the terminal was opened under another login and the changed-login
   explanation applies. A terminal whose identity could never be read is not trusted, but it does not count as changed either: unknown does not mean changed. */
function terminalTrust(candidates, idNow) {
  const trusted = [], changed = [];
  let unknown = 0;
  for (const o of candidates || []) {
    if (!o) continue;
    if (!o.authId || !idNow) { unknown++; continue; }
    (o.authId === idNow ? trusted : changed).push(o);
  }
  return { trusted, idChanged: changed.length > 0, idUnknown: unknown > 0 };
}
/* AN OBSERVATION WITHOUT USAGE NUMBERS DOES NOT REPLACE THE LAST KNOWN ONES . The
   panel resumes the Claude terminal on reopening, and the first status line of a resumed session carries
   no `rate_limits`. Taken as the newest observation it blanked the account row and was written over the
   saved numbers. The newest observation WITH numbers is used and saved; with none, the saved numbers of
   the same sign-in are used and nothing is written.
   @returns {{observation: object|null, save: boolean}} */
function choose(observations, saved, idNow) {
  const hasNumbers = (o) => !!(o && o.quota && (o.quota.short || o.quota.long));
  const list = observations || [];
  const live = list.find(hasNumbers);
  if (live) return { observation: live, save: !!idNow };
  const last = saved && idNow && saved.authId === idNow && hasNumbers(saved.observation) ? saved.observation : null;
  return { observation: last || list[0] || null, save: false };
}
module.exports={parse,read,terminalTrust,choose};
