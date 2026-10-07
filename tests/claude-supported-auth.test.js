'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const identity=require('../panel/account-identity');
const cli=require('../panel/cli-path');
const processRunner=require('../panel/subprocess');
const quota=require('../panel/quota-claude');
const context=require('../panel/claude-context');

test('Claude identity uses official status with isolated profile, no token or HTTP reads',async t=>{
  t.mock.method(cli,'cliInvocation',()=>({command:'fixture',leadingArgs:[]}));
  t.mock.method(globalThis,'fetch',()=>{throw new Error('No HTTP allowed');});
  const read=fs.readFileSync;
  t.mock.method(fs,'readFileSync',function(file,...args){
    assert.ok(!String(file).endsWith('.credentials.json'),'Claude token content must not be read');
    return read.call(this,file,...args);
  });
  let value={loggedIn:true,email:'first@example.test'};
  t.mock.method(processRunner,'run',async options=>{
    assert.deepEqual(options.arg,['auth','status','--json']);
    assert.equal(options.env.CLAUDE_CONFIG_DIR,path.resolve('profile with spaces'));
    assert.ok(options.durationMs>0);return {code:0,output:JSON.stringify(value)};
  });
  assert.equal((await identity.claude('profile with spaces')).email,value.email);
  value={loggedIn:true,email:'second@example.test'};
  assert.equal((await identity.claude('profile with spaces')).email,value.email);
  value={loggedIn:false};assert.equal((await identity.claude('profile with spaces')).signedIn,false);
  value={email:'stale@example.test'};assert.ok((await identity.claude('profile with spaces')).error);
});
test('quota preserves zero, independently missing windows, and expires observations',()=>{
  const now=Date.now(),end=Math.ceil(now/1000)+60;
  const observation=context.parse({session_id:'session',cwd:__dirname,context_window:{},
    rate_limits:{five_hour:{used_percentage:0,resets_at:end}}});
  assert.equal(quota.read(observation,now).short.percent,0);
  assert.equal(quota.read(observation,now).long,null);
  assert.equal(quota.read(observation,now).stale,true);
  assert.ok(quota.read(observation,end*1000).error);
  assert.equal(quota.parse({five_hour:{used_percentage:101,resets_at:end}}).short,null);
  assert.ok(quota.read(context.parse({session_id:'session',cwd:__dirname,context_window:{}})).error);
});
test('native Windows login preserves arguments and exit code without captured streams',
  {skip:process.platform!=='win32',timeout:30000},async t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"benchook login ' Türkçe "));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const fixture=path.join(root,'fixture.cjs'),result=path.join(root,'result.json');
    fs.writeFileSync(fixture,"require('fs').writeFileSync(process.argv[2],JSON.stringify({args:process.argv.slice(3),profile:process.env.CLAUDE_CONFIG_DIR}));process.exit(37);");
    const args=['space value',"apostrophe's",'a"b','trailing\\','Türkçe'];
    const child=require('../panel/native-login').start({command:process.execPath,leadingArgs:[fixture]},[result,...args],
      {...process.env,CLAUDE_CONFIG_DIR:root});
    assert.equal(child.stdout,null);assert.equal(child.stdin,null);
    const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
    assert.equal(code,37);
    assert.deepEqual(JSON.parse(fs.readFileSync(result,'utf8')),{args,profile:root});
});
test('cancelling native login stops its external console process',
  {skip:process.platform!=='win32',timeout:30000},async t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'benchook-login-cancel-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const fixture=path.join(root,'wait.cjs'),file=path.join(root,'pid.txt');
    fs.writeFileSync(fixture,"require('fs').writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);");
    const child=require('../panel/native-login').start({command:process.execPath,leadingArgs:[fixture]},[file],process.env);
    const exited=new Promise(resolve=>{child.on('error',resolve);child.on('exit',resolve);});
    t.after(async()=>{if(child.exitCode===null) await processRunner.stopTree(child);});
    const deadline=Date.now()+12000;
    while(!fs.existsSync(file)&&Date.now()<deadline) await new Promise(r=>setTimeout(r,50));
    assert.ok(fs.existsSync(file),'external console did not start');
    const pid=Number(fs.readFileSync(file,'utf8'));
    assert.equal(await processRunner.stopTree(child),null);
    await exited;
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'},'external CLI survived cancellation');
});
