'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const context=require('../panel/sessions');
test('Claude session lookup follows CLI punctuation and Unicode project encoding',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'benchook-slug-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const project='C:\\Users\\example\\Desktop\\Dotted İ Ş',id='session-fixture';
  const expected=path.join(root,'projects','C--Users-example-Desktop-Dotted----',id+'.jsonl');
  fs.mkdirSync(path.dirname(expected),{recursive:true});fs.writeFileSync(expected,JSON.stringify({cwd:project})+'\n');
  assert.equal(context.findSessionFile('claude',project,id,root),expected);
});
test('canonical and legacy directories coexist without hiding an older session',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'benchook-old-slug-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const project='C:\\Work\\Old Project',canonical=path.join(root,'projects','C--Work-Old-Project'),legacy=path.join(root,'projects','C--Work-Old Project');
  fs.mkdirSync(canonical,{recursive:true});fs.mkdirSync(legacy);
  const expected=path.join(legacy,'old.jsonl');fs.writeFileSync(expected,JSON.stringify({cwd:project})+'\n');
  fs.writeFileSync(path.join(canonical,'new.jsonl'),JSON.stringify({cwd:project})+'\n');
  assert.equal(context.findSessionFile('claude',project,'old',root),expected);
  assert.equal(context.snapshot('claude',project,root).size,2);
  const target=path.join(root,'target');fs.mkdirSync(path.join(target,'projects','C--Work-Old-Project'),{recursive:true});
  context.copySession('claude',project,'old',root,target);
  assert.ok(context.findSessionFile('claude',project,'old',target));
});
