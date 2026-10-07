'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {read}=require('../panel/quota-claude');
test('Changed sign-in explains missing observation instead of showing an old quota',()=>{
 const r=read(null,Date.now(),true);
 assert.match(r.error,/sign-in information changed/);
 assert.equal(r.short,undefined);assert.equal(r.long,undefined);
 assert.doesNotMatch(read(null).error,/changed/);
});
test('A fresh valid observation wins over an older terminal sign-in warning',()=>{
 const now=Date.now(),r=read({time:new Date(now).toISOString(),quota:{short:{percent:0,resetsAt:new Date(now+60000).toISOString()}}},now,true);
 assert.equal(r.short.percent,0);assert.equal(r.error,undefined);
});

/* trust in a terminal's observation comes from the sign-in identity it
   was opened with, never from the credentials file's stat. Measured: Claude Code v2.1.270
   recreates `.credentials.json` 1-2 s after some starts with no sign-in change, which made the
   old stat stamp mismatch and hid a valid quota behind "sign-in information changed". */
const {terminalTrust}=require('../panel/quota-claude');
const {signInIdentity}=require('../panel/account-identity');
test('Sign-in identity is email plus org, and null when not signed in',()=>{
 assert.equal(signInIdentity({signedIn:true,email:'a@x',org:'org-1'}),'a@x|org-1');
 assert.equal(signInIdentity({signedIn:true,email:'a@x'}),'a@x|');
 assert.equal(signInIdentity({signedIn:false,email:'a@x'}),null);
 assert.equal(signInIdentity({error:'x'}),null);
});
test('A terminal opened with the same sign-in stays trusted even if the credentials file was rewritten',()=>{
 const pane={authId:'a@x|org-1',contextFile:'p.json'};
 const r=terminalTrust([pane],'a@x|org-1');
 assert.deepEqual(r.trusted,[pane]);assert.equal(r.idChanged,false);
});
test('A terminal opened with another sign-in is excluded and explains the change',()=>{
 const r=terminalTrust([{authId:'old@x|org-1'},{authId:'a@x|org-1'}],'a@x|org-1');
 assert.equal(r.trusted.length,1);assert.equal(r.trusted[0].authId,'a@x|org-1');
 assert.equal(r.idChanged,true);
});
test('A terminal whose identity is still unknown is neither trusted nor reported as changed',()=>{
 const r=terminalTrust([{authId:null}],'a@x|org-1');
 assert.equal(r.trusted.length,0);assert.equal(r.idChanged,false);
 const r2=terminalTrust([{authId:'a@x|org-1'}],null);
 assert.equal(r2.trusted.length,0);assert.equal(r2.idChanged,false);
});

/* An observation whose sign-in is not confirmed yet is explained as
   such — the old sentence told the user to start a session while one was already running. */
test('Unknown identity is reported separately so the missing-quota reason is honest',()=>{
 const r=terminalTrust([{authId:null}],'a@x|org-1');
 assert.equal(r.idUnknown,true);
 assert.match(read(null,Date.now(),{idUnknown:true}).error,/could not be confirmed yet/);
 assert.match(read(null,Date.now(),{idChanged:true,idUnknown:true}).error,/changed/,'a known change outranks an unknown one');
 assert.doesNotMatch(read(null,Date.now(),{}).error,/confirmed|changed/);
 assert.equal(terminalTrust([{authId:'a@x|org-1'}],'a@x|org-1').idUnknown,false);
});
