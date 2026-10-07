'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../panel/panel.js'),'utf8');
function fixture(){
 const saved=new Map(),calls={plans:0,prompts:0,writes:0};
 const ctx=vm.createContext({project:'C:/Project A',localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},
 window:{panel:{setupPlan:async()=>{calls.plans++;return {steps:[{file:'settings.json',kind:'create'}]};},applySetup:async()=>{calls.writes++;return {written:['settings.json']};}}},
 confirm:async()=>{calls.prompts++;return false;},writeStatus:()=>{}});
 // The page's own call wrapper, taken from its source like the rest.
 vm.runInContext(source.slice(source.indexOf('function errorText('),source.indexOf('function showError(')),ctx);
 const start=source.indexOf('const pendingSetups =');
 // The following top-level function marks the end without reimplementing setup logic.
 const end=source.indexOf('\nfunction ',source.indexOf('async function askSetup(',start));
 vm.runInContext(source.slice(start,end),ctx);
 return {ctx,calls};
}
test('Repeated saves share one setup prompt; cancellation persists until manual setup',async()=>{
 const {ctx,calls}=fixture();
 await vm.runInContext('Promise.all([completeSetup(),completeSetup()])',ctx);
 assert.equal(calls.prompts,1);assert.equal(calls.writes,0);
 await vm.runInContext('completeSetup()',ctx);assert.equal(calls.prompts,1);
 await vm.runInContext('completeSetup(true)',ctx);assert.equal(calls.prompts,2);
});
