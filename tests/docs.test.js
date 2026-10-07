'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),checker=path.join(root,'tools/check-docs.cjs');
test('public documentation resolves local links and images',()=>{
 const r=spawnSync(process.execPath,[checker],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
});
test('documentation checker rejects missing documents and heading anchors',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'benchook-docs-'));
 const files=['README.md','SECURITY.md','CONTRIBUTING.md','ARCHITECTURE.md','THIRD_PARTY_NOTICES.md','CHANGELOG.md'];
 for(const file of files)fs.copyFileSync(path.join(root,file),path.join(temp,file));
 fs.cpSync(path.join(root,'docs'),path.join(temp,'docs'),{recursive:true});
 const readme=path.join(temp,'README.md'),original=fs.readFileSync(readme,'utf8');
 for(const broken of ['docs/not-present.md','docs/QUICKSTART.md#missing-heading']){
   fs.writeFileSync(readme,original+'\n[Deliberately broken fixture]('+broken+')\n');
   const r=spawnSync(process.execPath,[checker,temp],{encoding:'utf8'});
   assert.notEqual(r.status,0); assert.match(r.stderr,/missing (link|heading)/);
 }
 // Retained disposable fixture permits inspection of the negative check.
});
