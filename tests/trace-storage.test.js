'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const trace=require('../panel/session-trace');
const repo=require('../panel/trace-storage');
function temp(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'benchook-sparse-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return path.join(d,'codex-tui.log');}
const id='11111111-1234-1234-1234-123456789abc', next='22222222-1234-1234-1234-123456789abc';
const line=x=>'INFO session_loop{thread_id='+x+'}: codex_core::session: new\n';
test('an open append writer is preserved and the identity of a truncated log is reloaded',async t=>{
  const file=temp(t);fs.writeFileSync(file,line(id)+('old diagnostic\n'.repeat(400000)));
  const fd=fs.openSync(file,'a'); t.after(()=>{try{fs.closeSync(fd);}catch{}});
  while(true){trace.readSessionIds(file);if(!trace.waiting(file))break;}
  await repo.wait(file);
  assert.equal(repo.warning(file),null);
  assert.equal(JSON.parse(fs.readFileSync(file+'.id.json','utf8')).freed,0,
    'the checkpoint must not treat an unfinished truncation as a success');
  const size=fs.statSync(file).size;
  const head=Buffer.alloc(128),read=fs.openSync(file,'r');fs.readSync(read,head,0,128,0);fs.closeSync(read);
  assert.ok(head.every(b=>b===0),'the old prefix was not cleared');
  trace.forget(file);assert.equal(trace.readSessionId(file),id,'the checkpoint must preserve the old identity');
  fs.writeSync(fd,line(next));fs.fsyncSync(fd);
  assert.ok(fs.statSync(file).size>size,'the open append writer must keep working in place');
  assert.equal(trace.readSessionId(file),next);
  trace.forget(file);assert.equal(trace.readSessionId(file),next);
  await repo.wait(file);
  const r=spawnSync(path.join(process.env.SystemRoot,'System32/fsutil.exe'),['sparse','queryrange',file],{encoding:'utf8',windowsHide:true});
  assert.equal(r.status,0,r.stderr);
  // Ranges allocated by NTFS: the physical allocation must shrink, not the logical EOF.
  const pairs=[...r.stdout.matchAll(/0x([0-9a-f]+)[^\r\n]*?0x([0-9a-f]+)/gi)];
  assert.ok(pairs.length,r.stdout);
  const allocated=pairs.reduce((s,m)=>s+parseInt(m[2],16),0);
  assert.ok(allocated<size,'the disk allocation did not shrink: '+r.stdout);
  fs.closeSync(fd);
});
test('if the identity checkpoint cannot be written the old journal is not truncated',t=>{
  const file=temp(t);fs.writeFileSync(file,line(id)+'x'.repeat(5*1024*1024));
  t.mock.method(require('../panel/persistent-json'),'atomic',()=>{throw Error('injected disk failure');});
  trace.readSessionIds(file);
  assert.match(repo.warning(file),/injected/);
  const fd=fs.openSync(file,'r'),b=Buffer.alloc(4);fs.readSync(fd,b,0,4,0);fs.closeSync(fd);
  assert.equal(b.toString(),'INFO');
});
