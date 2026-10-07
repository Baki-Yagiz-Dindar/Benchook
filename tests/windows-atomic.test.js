'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const native=require('../panel/windows-atomic'),saved=require('../panel/persistent-json');
test('simultaneous first use publishes a usable helper for every caller', {skip:process.platform!=='win32',timeout:20000},async t=>{
  const root=temp(t),cache=path.join(root,'cache');
  const {spawn}=require('node:child_process');
  const script='const n=require(process.argv[1]); process.stdout.write(n.prepare({cache:process.argv[2]}));';
  const results=await Promise.all(Array.from({length:4},()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['-e',script,require.resolve('../panel/windows-atomic'),cache],{windowsHide:true});
    let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
    child.on('error',reject);child.on('close',code=>resolve({code,out,err}));
  })));
  for(const result of results){assert.equal(result.code,0,result.err);assert.equal(result.out,path.join(cache,'atomic-rename.exe'));}
  const from=path.join(root,'from'),to=path.join(root,'to');fs.writeFileSync(from,'new');fs.writeFileSync(to,'old');
  native.replace(from,to,{executable:results[0].out});assert.equal(fs.readFileSync(to,'utf8'),'new');
  assert.deepEqual(fs.readdirSync(cache).sort(),['atomic-rename.exe','sha256.txt']);
});
test('native rejected directory replacement preserves both inputs', {skip:process.platform!=='win32'},t=>{
  const root=temp(t),from=path.join(root,'from'),to=path.join(root,'directory');
  fs.writeFileSync(from,'new');fs.mkdirSync(to);fs.writeFileSync(path.join(to,'sentinel'),'old');
  assert.throws(()=>native.replace(from,to),e=>!e.outcomeUncertain&&/Windows could not replace/.test(e.message));
  assert.equal(fs.readFileSync(from,'utf8'),'new');assert.equal(fs.readFileSync(path.join(to,'sentinel'),'utf8'),'old');
});
test('abandoned compiler output does not block the next initialization', {skip:process.platform!=='win32'},t=>{
  const root=temp(t),cache=path.join(root,'cache');fs.mkdirSync(cache);
  const abandoned=path.join(cache,'build-interrupted.exe');fs.writeFileSync(abandoned,'partial output');
  const executable=native.prepare({cache});
  const from=path.join(root,'from'),to=path.join(root,'to');fs.writeFileSync(from,'new');fs.writeFileSync(to,'old');
  native.replace(from,to,{executable});assert.equal(fs.readFileSync(to,'utf8'),'new');
  assert.equal(fs.readFileSync(abandoned,'utf8'),'partial output','unowned build output is retained');
});
function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),"benchook-native ' ş-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('native replacement preserves existing reader snapshot and validates cache', {skip:process.platform!=='win32'},t=>{
  const root=temp(t),cache=path.join(root,'cache'),file=path.join(root,'data.json'),from=file+'.tmp';
  const executable=native.prepare({cache});
  fs.writeFileSync(file,'old');fs.writeFileSync(from,'new');const fd=fs.openSync(file,'r');
  try{native.replace(from,file,{executable});const b=Buffer.alloc(3);fs.readSync(fd,b,0,3,0);assert.equal(b.toString(),'old');assert.equal(fs.readFileSync(file,'utf8'),'new');}
  finally{fs.closeSync(fd);}
  fs.writeFileSync(executable,'corrupted');
  assert.equal(native.prepare({cache}),executable);
  assert.notEqual(fs.readFileSync(executable,'utf8'),'corrupted');
});
test('unavailable helper compiler preserves destination and source', {skip:process.platform!=='win32'},t=>{
  const root=temp(t),from=path.join(root,'a'),to=path.join(root,'b');fs.writeFileSync(from,'new');fs.writeFileSync(to,'old');
  assert.throws(()=>native.replace(from,to,{cache:path.join(root,'cache'),compiler:path.join(root,'missing.exe')}),/unavailable/);
  assert.equal(fs.readFileSync(from,'utf8'),'new');assert.equal(fs.readFileSync(to,'utf8'),'old');
});
test('uncertain helper result preserves temporary recovery evidence',t=>{
  const root=temp(t),file=path.join(root,'state.json');fs.writeFileSync(file,'old');
  t.mock.method(fs,'renameSync',()=>{throw Object.assign(new Error('busy'),{code:'EPERM'});});
  t.mock.method(native,'replace',()=>{throw Object.assign(new Error('outcome uncertain'),{outcomeUncertain:true});});
  if(process.platform==='win32'){
    assert.throws(()=>saved.atomicText(file,'new'),/uncertain/);
    assert.equal(fs.readFileSync(file,'utf8'),'old');
    const recovery=fs.readdirSync(root).find(n=>n.endsWith('.tmp'));assert.ok(recovery);
    assert.equal(fs.readFileSync(path.join(root,recovery),'utf8'),'new');
  }
});
test('timeout after native commit reports uncertainty instead of unchanged-state failure', {skip:process.platform!=='win32',timeout:15000},t=>{
  const root=temp(t),source=path.join(root,'slow.cs'),executable=path.join(root,'slow.exe');
  fs.writeFileSync(source,fs.readFileSync(path.join(__dirname,'../panel/atomic-rename.cs'),'utf8')
    .replace('Console.WriteLine("COMMITTED");','System.Threading.Thread.Sleep(5000); Console.WriteLine("COMMITTED");'));
  const result=require('node:child_process').spawnSync(path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo','/out:'+executable,source],{windowsHide:true,encoding:'utf8',timeout:8000});
  assert.equal(result.status,0,result.stderr||result.stdout);
  const from=path.join(root,'new.tmp'),to=path.join(root,'saved.json');fs.writeFileSync(from,'new');fs.writeFileSync(to,'old');
  assert.throws(()=>native.replace(from,to,{executable,timeout:800}),error=>error.outcomeUncertain===true);
  assert.equal(fs.readFileSync(to,'utf8'),'new','commit occurred before process timeout');
  assert.equal(fs.existsSync(from),false);
});
test('postcommit reporting exception remains uncertain', {skip:process.platform!=='win32'},t=>{
  const root=temp(t),source=path.join(root,'throw.cs'),executable=path.join(root,'throw.exe');
  fs.writeFileSync(source,fs.readFileSync(path.join(__dirname,'../panel/atomic-rename.cs'),'utf8')
    .replace('Console.WriteLine("COMMITTED");return 0;','throw new Exception("postcommit failure");'));
  const result=require('node:child_process').spawnSync(path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo','/out:'+executable,source],{windowsHide:true,encoding:'utf8',timeout:8000});
  assert.equal(result.status,0,result.stderr||result.stdout);
  const from=path.join(root,'a'),to=path.join(root,'b');fs.writeFileSync(from,'new');fs.writeFileSync(to,'old');
  assert.throws(()=>native.replace(from,to,{executable}),e=>e.outcomeUncertain===true);
  assert.equal(fs.readFileSync(to,'utf8'),'new');
});
