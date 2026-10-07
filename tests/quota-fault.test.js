'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const cli=require('../panel/cli-path'),quota=require('../panel/quota-codex');
for(const mode of ['null-prefix','disconnect','reject'])test('quota reader tolerates '+mode,{timeout:20000},async t=>{
  t.mock.method(cli,'cliInvocation',()=>({command:process.execPath,leadingArgs:[path.join(__dirname,'fixtures/quota-fault.cjs'),mode]}));
  const result=await quota.query({provider:'codex',folder:__dirname});
  if(mode==='null-prefix')assert.equal(result.quota?.short.percent,25,JSON.stringify(result));
  else assert.match(result.error,mode==='reject'?/Fixture rate limit exceeded/:/closed|disconnected/);
});
