'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const trace=require('../panel/session-trace'),context=require('../panel/sessions');
const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
const line=id=>'INFO session_loop{thread_id='+id+'}: codex_core::session: new\n';
function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'benchook-log-stress-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('replacing a trace at the same path and size cannot retain the old session ID',t=>{
  const root=temp(t),file=path.join(root,'trace.log'),replacement=path.join(root,'replacement.log');
  fs.writeFileSync(file,line(first));assert.equal(trace.readSessionId(file),first);
  fs.writeFileSync(replacement,line(second));fs.renameSync(replacement,file);
  assert.equal(trace.readSessionId(file),second);
});
test('same-size in-place trace rewrite cannot retain the old session ID',t=>{
  const file=path.join(temp(t),'trace.log');fs.writeFileSync(file,line(first));
  assert.equal(trace.readSessionId(file),first);
  fs.writeFileSync(file,line(second));fs.utimesSync(file,new Date(),new Date(Date.now()+1000));
  assert.equal(trace.readSessionId(file),second);
});
test('partial lines are deferred and truncation resets trace identity',t=>{
  const file=path.join(temp(t),'trace.log'),bytes=Buffer.from('ş漢🙂\n'+line(first));
  fs.writeFileSync(file,'');
  for(let i=0;i<bytes.length-1;i++){fs.appendFileSync(file,bytes.subarray(i,i+1));assert.equal(trace.readSessionId(file),null);}
  fs.appendFileSync(file,bytes.subarray(-1));assert.equal(trace.readSessionId(file),first);
  fs.writeFileSync(file,'');assert.equal(trace.readSessionId(file),null);
  fs.appendFileSync(file,line(second));assert.equal(trace.readSessionId(file),second);
});
test('large context tail survives incomplete JSON and clears on truncation',t=>{
  const file=path.join(temp(t),'context.jsonl');
  const event=value=>JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:value},model_context_window:1000}}})+'\n';
  fs.writeFileSync(file,('x'.repeat(1023)+'\n').repeat(5000)+event(125)+'{"payload":');
  assert.equal(context.read('codex',file).used,125);
  fs.writeFileSync(file,event(250));assert.equal(context.read('codex',file).used,250);
  fs.writeFileSync(file,'{broken');assert.ok(context.read('codex',file).error);
});
