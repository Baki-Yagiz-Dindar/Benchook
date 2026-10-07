'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const context = require('../panel/claude-context');
const log = require('../panel/bounded-log');
function temp(t) { const d=fs.mkdtempSync(path.join(os.tmpdir(),'benchook-context-')); t.after(()=>fs.rmSync(d,{recursive:true,force:true})); return d; }
test('the session-specific limit of a new model is read from the real statusline script', t => {
  const root = temp(t), output = path.join(root,'status.json');
  const input = { session_id:'synthetic', workspace:{project_dir:root}, model:{id:'unknown-model'},
    context_window:{context_window_size:432100,used_percentage:12,current_usage:{input_tokens:11,cache_creation_input_tokens:22,cache_read_input_tokens:33}} };
  const r = spawnSync(process.execPath,[path.resolve(__dirname,'../panel/claude-context.js'),output],{input:JSON.stringify(input),encoding:'utf8',windowsHide:true});
  assert.equal(r.status,0,r.stderr);
  const v=context.read(output,root); assert.equal(v.limit,432100); assert.equal(v.percent,12); assert.equal(v.used,66);
  assert.equal(context.read(output,path.join(root,'other')),null);
});
test('a null usage before the first call is not shown as zero tokens',()=>{
  const v=context.parse({session_id:'s',context_window:{context_window_size:123,current_usage:null,used_percentage:null}});
  assert.equal(v.used,null); assert.equal(v.percent,null);
});
test("a custom Claude status line is not overwritten - it is wrapped now",t=>{
  const root=temp(t); fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({statusLine:{command:'custom'}}));
  const a=context.setting(root,root,path.join(root,'out'),'node');
  assert.ok(a, 'the old expectation was null: the panel was not installed and no percentage arrived');
  assert.match(a.statusLine.command, /--after 'custom'$/, 'the command of the user is preserved verbatim and runs last');
});
test('the panel journals come back with a bounded archive while writing is active',t=>{
  const file=path.join(temp(t),'trace.jsonl');
  for(let i=0;i<100;i++) log.add(file,{i,data:'x'.repeat(30)},200);
  assert.ok(fs.statSync(file).size<=200); assert.ok(fs.statSync(file+'.previous').size<=200);
  const rows=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse); assert.equal(rows.at(-1).i,99);
});
test('when the JSON is valid but the layout shape is broken the sound backup is used', t=>{
  const json=require('../panel/persistent-json'), {layoutValid}=require('../panel/layout-shape');
  const file=path.join(temp(t),'layout.json');
  json.write(file,{projects:['A']},layoutValid);
  fs.writeFileSync(file,JSON.stringify({projectState:{A:{pages:'broken'}}}));
  assert.deepEqual(json.read(file,layoutValid),{projects:['A']});
  assert.throws(()=>json.write(file,{projects:3},layoutValid),/Invalid/);
});

test('an unchanged session log is answered from memory, and a new line is seen at once', (t) => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.jsonl');
  const line = (n) => JSON.stringify({ message: { model: 'claude-x', usage: { input_tokens: n, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + '\n';
  fs.writeFileSync(file, line(100));
  const sessions = require('../panel/sessions');
  const originalRead = fs.readSync;
  let reads = 0;
  fs.readSync = (...args) => { reads++; return originalRead(...args); };
  t.after(() => { fs.readSync = originalRead; });
  assert.equal(sessions.read('claude', file).used, 100);
  const afterFirst = reads;
  assert.ok(afterFirst >= 1);
  const first = sessions.read('claude', file);
  assert.equal(reads, afterFirst, 'an unchanged log is not read again');
  first.used = -1;   // a caller changing its copy does not change the remembered answer
  assert.equal(sessions.read('claude', file).used, 100);
  fs.appendFileSync(file, line(250));
  assert.equal(sessions.read('claude', file).used, 250, 'the appended line is read');
});
