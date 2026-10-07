'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../panel/panel.js'),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('slow periodic status is not starved and known signed-out state survives refresh',async()=>{
  const state=deferred();let calls=0;
  const box={window:{panel:{listAccounts:async()=>[{id:'account',signedIn:true}],accountStatus:()=>{calls++;return state.promise;}}},renderRegistry:()=>{}};
  vm.createContext(box);vm.runInContext(source.slice(source.indexOf('let registry = [];'),source.indexOf('function renderRegistry()'))+
    "\nthis.refresh=refreshRegistry;this.read=()=>registryStatus.get('account');registryStatus.set('account',{id:'account',signedIn:false});",box);
  await box.refresh(false);
  for(let i=0;i<20;i++) await box.refresh(false);
  assert.equal(calls,1);assert.equal(box.read().signedIn,false);
  state.resolve([{id:'account',signedIn:true}]);await Promise.resolve();
  assert.equal(box.read().signedIn,true);
});
test('late account list/status cannot overwrite a newer refresh',async()=>{
  const lists=[deferred(),deferred()],states=[deferred(),deferred()];let li=0,si=0;
  const box={window:{panel:{listAccounts:()=>lists[li++].promise,accountStatus:()=>states[si++].promise}},renderRegistry:()=>{}};
  vm.createContext(box);
  vm.runInContext(source.slice(source.indexOf('let registry = [];'),source.indexOf('function renderRegistry()'))+
    '\nthis.refresh=refreshRegistry;this.read=()=>({list:registry,status:[...registryStatus.values()]});',box);
  const first=box.refresh();lists[0].resolve([{id:'old'}]);await first;
  const second=box.refresh();lists[1].resolve([{id:'new'}]);await second;
  states[1].resolve([{id:'new',email:'new@example.test'}]);await Promise.resolve();
  states[0].resolve([{id:'old',email:'old@example.test'}]);await Promise.resolve();
  assert.equal(box.read().status[0].id,'new');
});
test('reversed list completions cannot restore a removed account',async()=>{
  const lists=[deferred(),deferred()];let i=0;
  const box={window:{panel:{listAccounts:()=>lists[i++].promise,accountStatus:async()=>[]}},renderRegistry:()=>{}};
  vm.createContext(box);vm.runInContext(source.slice(source.indexOf('let registry = [];'),source.indexOf('function renderRegistry()'))+
    '\nthis.refresh=refreshRegistry;this.read=()=>registry;',box);
  const a=box.refresh(),b=box.refresh();lists[1].resolve([]);await b;
  lists[0].resolve([{id:'removed'}]);await a;assert.equal(box.read().length,0);
});
test('late provider model response cannot contaminate current account options',async()=>{
  const slow=deferred(),account={value:'codex'},model={options:[],appendChild(o){this.options.push(o);},set textContent(v){this.options=[];}};
  const box={registry:[{id:'codex',provider:'codex'},{id:'claude',provider:'claude'}],
    g:id=>id==='orchestratorAccount'?account:model,modelName:x=>x,document:{createElement:()=>({})},
    window:{panel:{codexModels:()=>slow.promise,claudeModels:async()=>['claude-model'],claudeLatest:async()=>({})}},
    modelOptionText:x=>x};
  vm.createContext(box);
  vm.runInContext(source.slice(source.indexOf('function errorText('),source.indexOf('function showError(')),box);
  const start=source.lastIndexOf('\n',source.indexOf('async function refreshOrchModel()')-2);
  vm.runInContext(source.slice(start,source.indexOf('async function refreshMcpStatus()'))+'\nthis.refresh=refreshOrchModel;',box);
  const first=box.refresh();account.value='claude';await box.refresh();
  slow.resolve({defaults:null,seen:[{name:'codex-model'}]});await first;
  assert.deepEqual(model.options.map(o=>o.value),['claude-model']);
});
test('repeated PTY spawn failures cannot publish orphan sessions',async()=>{
  const main=fs.readFileSync(path.join(__dirname,'../panel/main.js'),'utf8');
  const start=main.indexOf("  ipc.handle('terminal:open'");
  const end=main.indexOf('\n  });',start)+7;
  let handler;const sessions=new Map(),terminals=new Map();
  const box={ipc:{handle:(_name,fn)=>{handler=fn;}},process:{env:{}},randomUUID:()=> 'test-id',
    sessions:sessions,terminals:terminals,context:{snapshot:()=>({})},
    cleanEnv:()=>({}),os:{homedir:()=>__dirname},pty:{spawn:()=>{throw new Error('injected spawn failure');}}};
  vm.createContext(box);vm.runInContext('let nextId=1;\n'+main.slice(start,end),box);
  // terminal:ac is async since 15 Sep 2026 (sign-in identity is read before spawn); the renderer awaits it.
  for(let i=0;i<100;i++)await assert.rejects(()=>handler(null,{provider:'codex',workingDirectory:__dirname}),/injected spawn failure/);
  assert.equal(sessions.size,0);assert.equal(terminals.size,0);
});
