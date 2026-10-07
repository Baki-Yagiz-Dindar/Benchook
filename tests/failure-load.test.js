'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const saved=require('../panel/persistent-json'),runner=require('../panel/subprocess');
function temp(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'benchook-failure-load-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
test('denied reads preserve saved state without silently returning an empty store',t=>{
  const file=path.join(temp(t),'state.json');saved.write(file,{keep:true});
  const original=fs.readFileSync,contents=original(file,'utf8');
  t.mock.method(fs,'readFileSync',(...args)=>{if(String(args[0]).startsWith(file))throw Object.assign(new Error('denied'),{code:'EACCES'});return original(...args);});
  assert.throws(()=>saved.read(file),/preserved/);assert.equal(original(file,'utf8'),contents);
});
test('concurrent atomic snapshot writers never expose partial JSON', {timeout:30000},async t=>{
  const file=path.join(temp(t),'state.json');saved.atomic(file,{writer:'initial',sequence:0,payload:'initial'.repeat(2000)});
  const errors=[];
  let remaining=2;const children=['A','B'].map(writer=>{
    const child=spawn(process.execPath,[path.join(__dirname,'fixtures/atomic-writer.cjs'),file,writer],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    child.stderr.on('data',data=>errors.push(String(data)));
    t.after(()=>{if(child.exitCode===null)child.kill();});
    return new Promise(resolve=>{child.on('error',e=>{remaining--;resolve(e.message);});child.on('exit',code=>{remaining--;resolve(code);});});
  });
  while(remaining){const value=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(value.payload,value.writer.repeat(2000));await new Promise(r=>setTimeout(r,2));}
  assert.deepEqual(await Promise.all(children),[0,0],errors.join(''));
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).sequence,29);
});
test('concurrent timed-out and excessive-output workers terminate with explicit failures', {timeout:30000},async()=>{
  const work=[];
  for(let i=0;i<6;i++) {
    const overflow=i%2===0;
    work.push(runner.run({command:process.execPath,arg:['-e',overflow
      ? "setInterval(()=>process.stdout.write('x'.repeat(8192)),5)"
      : 'setInterval(()=>{},1000)'],durationMs:overflow?4000:400,maxOutput:16384}));
  }
  const results=await Promise.all(work);
  results.forEach((r,i)=>{assert.match(r.error,i%2===0?/output size limit/:/timed out/);assert.ok(!r.couldNotStop,r.error);});
});
