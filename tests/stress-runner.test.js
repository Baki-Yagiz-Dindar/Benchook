'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const wait=require('../tools/stress-child.cjs');
function child(){const c=new EventEmitter();c.unref=()=>{c.unreferenced=true;};return c;}
test('root exit cannot hide failed or stalled descendant cleanup',async()=>{
  for(const outcome of [()=>Promise.reject(new Error('descendants denied')),()=>Promise.resolve('denied'),()=>new Promise(()=>{})]){
    const c=child();
    const r=await wait(c,()=>{c.emit('exit',1,null);return outcome();},{timeout:5,grace:10});
    assert.equal(r.cleanupUnconfirmed,true);assert.equal(r.code,undefined);
  }
});
test('real child timeout waits for confirmed process termination',async()=>{
  const {spawn}=require('node:child_process');
  const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
  const r=await wait(c,()=>{c.kill();return null;},{timeout:100,grace:3000});
  assert.equal(r.timedOut,true);assert.equal(r.cleanupUnconfirmed,undefined);
  assert.ok(c.exitCode!==null||c.signalCode!==null);
});
test('failed or stalled cleanup returns uncertainty without claiming child exited',async()=>{
  for(const stop of [()=>Promise.resolve('denied'),()=>Promise.reject(new Error('failure')),()=>new Promise(()=>{}),()=>Promise.resolve(null)]){
    const c=child(),r=await wait(c,stop,{timeout:5,grace:10});
    assert.equal(r.cleanupUnconfirmed,true);assert.equal(r.timedOut,true);assert.equal(r.code,undefined);assert.equal(c.unreferenced,true);
  }
});
test('ordinary exit is complete and timeout cleanup exit remains timed out',async()=>{
  const c=child(),pending=wait(c,()=>assert.fail('unnecessary cleanup'),{timeout:100});c.emit('exit',0,null);
  assert.deepEqual(await pending,{timedOut:false,code:0,signal:null});
  const d=child(),r=await wait(d,()=>{d.emit('exit',1,null);return null;},{timeout:5,grace:100});
  assert.deepEqual(r,{timedOut:true,code:1,signal:null});
});
