'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {resolve}=require('../panel/data-path');
test('data folder is BENCHOOK_DATA_DIR when set, otherwise Benchook under APPDATA; other folders are never read',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'benchook-data-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const current=path.join(root,'Benchook'),other=path.join(root,'older-app'),custom=path.join(root,'custom');
  assert.equal(resolve({APPDATA:root}),current);
  fs.mkdirSync(other);fs.writeFileSync(path.join(other,'sentinel'),'kept');
  assert.equal(resolve({APPDATA:root}),current);
  assert.equal(resolve({APPDATA:root,BENCHOOK_DATA_DIR:custom}),custom);
  assert.equal(fs.readFileSync(path.join(other,'sentinel'),'utf8'),'kept');
});
