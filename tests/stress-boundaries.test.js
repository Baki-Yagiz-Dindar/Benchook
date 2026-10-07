'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const context=require('../panel/claude-context');
const saved=require('../panel/persistent-json');
test('malformed context numbers never produce nonfinite percentages or infinite totals',()=>{
  for(const value of [Infinity,NaN,-1,'50',null,{},[]]) {
    const result=context.parse({session_id:'s',cwd:__dirname,context_window:{used_percentage:value}});
    assert.equal(result.percent,null,'invalid percentage '+JSON.stringify(value));
  }
  const result=context.parse({session_id:'s',cwd:__dirname,context_window:{
    current_usage:{input_tokens:1e308,cache_creation_input_tokens:1e308,cache_read_input_tokens:0}}});
  assert.equal(result.used,null,'overflowed sum must be unknown');
});
test('MCP arbitrary rejection values cannot crash transport or suppress later ping',()=>{
  const requests=[null,0,'failure',false,{}].map((params,id)=>({jsonrpc:'2.0',id,method:'fail',params}));
  requests.push({jsonrpc:'2.0',id:99,method:'ping'});
  const r=spawnSync(process.execPath,[path.join(__dirname,'fixtures/mcp-rejection.cjs')],{
    input:requests.map(x=>JSON.stringify(x)).join('\n')+'\n',encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(r.status,0,r.stderr);
  const replies=r.stdout.trim().split('\n').map(x=>JSON.parse(x));
  for(let id=0;id<5;id++) assert.equal(replies.find(x=>x.id===id)?.error?.code,-32603);
  assert.deepEqual(replies.find(x=>x.id===99)?.result,{});
});
test('failure committing a saved file retains readable previous state and leaves no temporary files',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'benchook-atomic-stress-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'state.json'); saved.write(file,{sequence:1});
  const rename=fs.renameSync;
  t.mock.method(require('../panel/windows-atomic'),'replace',()=>{throw new Error('injected busy file');});
  t.mock.method(fs,'renameSync',(from,to)=>{if(to===file)throw Object.assign(new Error('injected busy file'),{code:'EBUSY'});return rename(from,to);});
  assert.throws(()=>saved.write(file,{sequence:2}),/injected/);
  assert.deepEqual(saved.read(file),{sequence:1});
  assert.equal(fs.readdirSync(root).some(x=>x.endsWith('.tmp')),false);
});
for(const point of ['writeFileSync','fsyncSync','backup-rename']) {
  test('saved state survives injected '+point+' failure',t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'benchook-save-fault-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const file=path.join(root,'state.json');saved.write(file,{sequence:1});
    const method=point==='backup-rename'?'renameSync':point,original=fs[method];
    t.mock.method(fs,method,(...args)=>{
      if(point!=='backup-rename'||args[1]===file+'.bak')throw Object.assign(new Error('injected storage fault'),{code:'ENOSPC'});
      return original(...args);
    });
    assert.throws(()=>saved.write(file,{sequence:2}),/injected/);
    assert.deepEqual(saved.read(file),{sequence:1});
    assert.equal(fs.readdirSync(root).some(x=>x.endsWith('.tmp')),false);
  });
}
test('repeated writes and corrupted-primary recovery retain complete validated generations',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'benchook-recovery-cycles-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'state.json');
  const valid=v=>v&&Number.isInteger(v.sequence)&&v.payload===('ş漢🙂'+v.sequence).repeat(40);
  const value=i=>({sequence:i,payload:('ş漢🙂'+i).repeat(40)});
  saved.write(file,value(0),valid);
  for(let i=1;i<=100;i++) {
    saved.write(file,value(i),valid);assert.deepEqual(saved.read(file,valid),value(i));
    if(i%7===0) {
      fs.writeFileSync(file,'{"sequence":');
      assert.deepEqual(saved.read(file,valid),value(i-1));
    }
  }
  assert.equal(fs.readdirSync(root).some(x=>x.endsWith('.tmp')),false);
});
