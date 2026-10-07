'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const args = process.argv.slice(2);
if (args[0] === 'auth') {
  const root=process.env.CLAUDE_CONFIG_DIR;
  const file=path.join(root,'fixture-auth.json');
  if (args[1] === 'status') {
    // scenarios: identity can be read from the file (email/orgId), reading can fail (fixture-auth-fail).
    if (fs.existsSync(path.join(root,'fixture-auth-fail'))) { console.log('not json'); process.exit(1); }
    const loggedIn=fs.existsSync(file);
    let identity={}; if (loggedIn) { try { identity=JSON.parse(fs.readFileSync(file,'utf8')); } catch {} }
    console.log(JSON.stringify({loggedIn,...(loggedIn?{email:identity.email||'fixture@example.test',...(identity.orgId?{orgId:identity.orgId}:{})}:{})}));
    process.exit(loggedIn?0:1);
  }
  if (args[1] === 'logout') {fs.rmSync(file,{force:true});process.exit(0);}
  if (args[1] === 'login') {
    fs.writeFileSync(path.join(root,'fixture-login-pid'),String(process.pid));
    if(fs.existsSync(path.join(root,'fixture-wait'))) setInterval(()=>{},1000);
    else {fs.writeFileSync(file,'{}');process.exit(0);}
  }
} else
if (process.env.CLAUDE_CONFIG_DIR && args.includes('--settings')) {
  const {spawnSync}=require('node:child_process');
  const id=args[args.indexOf('--session-id')+1];
  const settings=JSON.parse(args[args.indexOf('--settings')+1]);
  const data={session_id:id,workspace:{project_dir:process.cwd()},model:{id:'fixture-claude'},
    context_window:{context_window_size:432100,used_percentage:12,current_usage:{input_tokens:100,cache_creation_input_tokens:0,cache_read_input_tokens:200}}};
  // if a quota observation is requested it is added from the file (fixture-rate.json); otherwise no quota, as before.
  try { data.rate_limits=JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,'fixture-rate.json'),'utf8')); } catch {}
  const r=spawnSync('bash',['-c',settings.statusLine.command],{input:JSON.stringify(data),encoding:'utf8',windowsHide:true});
  if(r.status!==0){console.error(r.stderr || r.error);process.exit(1);}
  console.log(r.stdout);setInterval(()=>console.log('CLAUDE_FIXTURE_READY'),150);
  setTimeout(()=>process.exit(0),20000);
} else {
const resume = args.indexOf('resume');
const id = resume >= 0 ? args[resume + 1] : randomUUID();
const setting = args.find(a => a.startsWith('log_dir='));
const log = JSON.parse(setting.slice('log_dir='.length));
const sessions = path.join(process.env.CODEX_HOME, 'sessions');
fs.mkdirSync(sessions, { recursive: true });
const file = path.join(sessions, 'rollout-' + id + '.jsonl');
console.log('FIXTURE_READY ' + id);
if (process.env.BENCHOOK_TEST_LIVE_WORKER === '1') {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('BENCHOOK_')) delete env[key];
  const worker = require('node:child_process').spawn(process.execPath,
    [path.join(__dirname, 'live-monitor-worker.cjs'), process.env.BENCHOOK_TEST_MONITOR_ROOT,
      process.cwd(), process.env.BENCHOOK_SESSION], { env, windowsHide: true, stdio: 'ignore' });
  process.on('exit', () => worker.kill());
}
let n = 0;
setInterval(() => console.log('FIXTURE_TICK ' + (++n) + ' ' + (resume >= 0 ? 'RESUME ' : 'NEW ') + id), 150);
setTimeout(() => process.exit(0), process.env.BENCHOOK_TEST_LIVE_WORKER === '1' ? 90000 : 20000); // bounded fixture lifetime
setTimeout(() => {
  fs.writeFileSync(path.join(log, 'codex-tui.log'), 'INFO session_loop{thread_id=' + id + '}: codex_core::session: new\n');
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd: process.cwd(), source: 'cli' } }) + '\n');
  fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: {
    type: 'token_count', info: { last_token_usage: { input_tokens: 123 }, model_context_window: 1000 } } }) + '\n');
}, 500);
}
