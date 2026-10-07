'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { stopTree } = require('../panel/subprocess');
const panel = path.resolve(__dirname, '../panel');
const wait = ms => new Promise(r => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchook-e2e-'));
const profile = path.join(root, 'profile'), home = path.join(root, 'account');
const projects = ['Project A & boşluk', 'Project B'].map(n => path.join(root, n));
for (const p of [profile, home, ...projects]) fs.mkdirSync(p);
fs.writeFileSync(path.join(home, 'auth.json'), '{}'); // a purely local fixture; it is never sent to a provider
fs.writeFileSync(path.join(home, '.credentials.json'), '{}');
// `claude-signedOut` IS in the registry but its folder has no identity file: a signed-out account fixture.
const signedOutHome = path.join(root, 'account-signed-out');
fs.mkdirSync(signedOutHome);
fs.writeFileSync(path.join(profile, 'accounts.json'), JSON.stringify({ accounts: [
  { id: 'synthetic', provider: 'codex', name: 'Alpha', folder: home },
  { id: 'claude-synthetic', provider: 'claude', name: 'Beta', folder: home },
  { id: 'claude-signedOut', provider: 'claude', name: 'Gamma', folder: signedOutHome }] }));
fs.writeFileSync(path.join(profile, 'layout.json'), JSON.stringify({ project: projects[0], projects: projects }));
let child, socket;
async function launch() {
  const srv = net.createServer(); srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
  const port = srv.address().port; await new Promise(r => srv.close(r));
  child = spawn(require(path.join(panel, 'node_modules/electron')), [path.join(__dirname, 'fixtures/panel-bootstrap.cjs'),
    // Native Windows services can write relative to cwd, independently of userData.
    // Keep test artifacts in the disposable root, never in the source directory.
    '--user-data-dir=' + profile, '--remote-debugging-port=' + port], { cwd: root, windowsHide: true,
    env: { ...process.env, BENCHOOK_TEST: '1', BENCHOOK_TEST_NODE: process.execPath, BENCHOOK_TEST_EXTERNAL_LOG: path.join(root, 'external.jsonl'),
      ...(process.env.BENCHOOK_TEST_LIVE_WORKER === '1' ? { BENCHOOK_TEST_MONITOR_ROOT: root } : {}) }, stdio: ['ignore', 'ignore', 'ignore'] });
  let target;
  for (let i = 0; i < 100; i++) {
    try { target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(t => t.type === 'page'); } catch { /* startup */ }
    if (target) break; await wait(100);
  }
  assert.ok(target, 'Electron did not open');
  socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, 'open');
  let seq = 0; const pending = new Map();
  socket.addEventListener('message', e => { const r = JSON.parse(e.data); pending.get(r.id)?.(r); });
  const command = async (method, params) => {
    const id = ++seq;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout')); }, 10000);
      pending.set(id, r => { clearTimeout(timeout); pending.delete(id); resolve(r); });
    });
    socket.send(JSON.stringify({ id, method, params }));
    return response;
  };
  const evaluate = async code => {
    const r = await command('Runtime.evaluate', {
      expression: '(async()=>{' + code + '})()', awaitPromise: true, returnByValue: true });
    assert.ok(!r.result?.exceptionDetails, JSON.stringify(r.result?.exceptionDetails));
    return r.result.result.value;
  };
  evaluate.command = command;
  return evaluate;
}
async function close(evaluate) {
  // The real window-close path flushes the last identities to disk.
  const exited = once(child, 'exit');
  await evaluate('setTimeout(()=>window.close(), 50); return true;');
  await Promise.race([exited, wait(5000).then(() => { if (child.exitCode === null) throw new Error('the panel did not close'); })]);
  socket.close(); child = null;
}
(async () => {
  try {
    let evaluate = await launch();
    for (let i=0; i<100; i++) {
      if (await evaluate("return typeof createPane === 'function' && !!activePage && !!sg('topRight');")) break;
      await wait(100);
    }
    assert.equal(await evaluate("return typeof createPane === 'function' && !!activePage && !!sg('topRight');"), true,
      await evaluate('return location.href;'));
    assert.equal(await evaluate('return document.documentElement.lang;'), 'en');
    /* THE PAGE LOADS WITHOUT A SCRIPT ERROR. The debugger attaches after the first load, so the
       page is reloaded with exception reporting on; an unhandled rejection is reported here too. */
    {
      const thrown = [];
      socket.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.method === 'Runtime.exceptionThrown') {
          const d = m.params.exceptionDetails;
          thrown.push((d.exception && d.exception.description) || d.text);
        }
      });
      await evaluate.command('Runtime.enable', {});
      await evaluate.command('Page.reload', {});
      await wait(300);
      for (let i = 0; i < 100; i++) {
        try { if (await evaluate("return typeof createPane === 'function' && !!activePage && !!sg('topRight');")) break; }
        catch { /* the page is still loading */ }
        await wait(100);
      }
      await wait(500);
      assert.deepEqual(thrown, [], 'script errors while the page loaded:\n' + thrown.join('\n'));
      console.log('PASS: the page loads without a script error or unhandled rejection.');
    }
    await require('./fixtures/codex-unicode-trust-ui.cjs')(evaluate, root, home);
    if (process.env.BENCHOOK_TEST_TRUST_ONLY === '1') { await close(evaluate); return; }
    if (process.env.BENCHOOK_TEST_LIVE_WORKER === '1') {
      await require('./fixtures/codex-live-monitor.cjs')(evaluate, root);
      await close(evaluate);
      return;
    }
    // Inactive agents must retain their permission when the real form is opened.
    for (const [permission, tools] of [['default', null], ['read', 'Read, Grep, Glob'],
      ['edit', 'Read, Grep, Glob, Edit, Write'], ['full', 'Read, Grep, Glob, Edit, Write, Bash'], ['custom', 'Read']]) {
      await evaluate(`externalLine({name:'release-permission',description:'QA',task:'Read only.',
        model:'orchestrator',account:'orchestrator',provider:null,projects:[],
        permission:${JSON.stringify(permission)},tools:${JSON.stringify(tools)},
        resolution:{asOrchestrator:true}}).click(); return true;`);
      let selected;
      for (let i = 0; i < 60; i++) {
        selected = await evaluate("return document.getElementById('formPermission')?.value;");
        if (selected === permission) break;
        await wait(50);
      }
      assert.equal(selected, permission, 'inactive agent permission: ' + permission);
      await evaluate.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await evaluate.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      assert.equal(await evaluate("return document.getElementById('overlay').style.display;"), 'none');
    }
    console.log('PASS: inactive agent forms preserve all five permission states; Escape closes each form.');
    if (process.env.BENCHOOK_TEST_AUTH === '1') {
      await evaluate("window.authEvents=[]; window.panel.onSignIn(v=>window.authEvents.push(v)); await signInScreen(registry.find(h=>h.id==='claude-synthetic')); return true;");
      assert.equal(await evaluate("return !!document.getElementById('girisKod');"),false);
      for(let i=0;i<100;i++) {
        if(await evaluate("return authEvents.some(v=>v.status==='done');")) break;
        await wait(100);
      }
      assert.equal(await evaluate("return authEvents.some(v=>v.status==='done'&&v.email==='fixture@example.test');"),true);
      fs.writeFileSync(path.join(home,'fixture-wait'),'');
      fs.rmSync(path.join(home,'fixture-login-pid'),{force:true});
      await evaluate("authEvents=[]; await signInScreen(registry.find(h=>h.id==='claude-synthetic')); return true;");
      for(let i=0;i<100&&!fs.existsSync(path.join(home,'fixture-login-pid'));i++) await wait(100);
      assert.ok(fs.existsSync(path.join(home,'fixture-login-pid')));
      const pid=Number(fs.readFileSync(path.join(home,'fixture-login-pid'),'utf8'));
      assert.ok((await evaluate("return await window.panel.signOut('claude-synthetic');")).error);
      const cancelled=await evaluate("return await window.panel.cancelSignIn('claude-synthetic');");
      assert.equal(cancelled.cancel,true,JSON.stringify(cancelled));
      await wait(400);
      assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
      assert.equal(await evaluate("return authEvents.some(v=>v.status==='done');"),false);
      assert.ok((await evaluate("return await window.panel.signOut('claude-synthetic');")).done);
      await evaluate('await refreshRegistry(); return true;');
      for(let i=0;i<100;i++) {
        if(await evaluate("return registryStatus.get('claude-synthetic')?.signedIn === false;"))break;
        await wait(100);
      }
      assert.equal(await evaluate("return accountSignIn(registry.find(h=>h.id==='claude-synthetic'));"),false);
      assert.match(await evaluate("return g('accountStore').textContent;"),/SIGNED OUT/);
      assert.ok(await evaluate("return !!g('accountStore').querySelector('[title=\"Sign in to this account in your browser.\"]');"));
      await evaluate('signInPending=null; closeDetail(); return true;');
      console.log('PASS: Electron sign-in, identity, no code textbox, cancellation with existing login, and sign-out; provider responses are fixtures.');
    }
    if(process.env.BENCHOOK_TEST_STRESS==='1') {
      const loaded=await evaluate("const previous=registry; const start=performance.now(); registry=Array.from({length:500},(_,i)=>({id:'load-'+i,name:'Unicode ş漢🙂 '+i+' '+ 'long name '.repeat(12),provider:i%2?'claude':'codex',signedIn:false})); renderRegistry(); const count=g('accountStore').children.length;const elapsed=performance.now()-start;registry=previous;renderRegistry();return {count,elapsed};");
      assert.equal(loaded.count,500);assert.ok(loaded.elapsed<5000,JSON.stringify(loaded));
      console.log('Account load render: '+JSON.stringify(loaded));
      assert.equal(await evaluate('return 1+1;'),2,'renderer must respond after load');
      const projectsLoad=await evaluate("window.beforeLoadProjects=[...projects];window.beforeLoadProject=project;projects=[...projects,...Array.from({length:200},(_,i)=>project+'\\\\'+('long ş漢🙂 '+i+' ').repeat(12))];renderProjectList();return {count:g('projectList').children.length,selected:g('projectList').querySelectorAll('.selected').length};");
      assert.equal(projectsLoad.count,202);assert.equal(projectsLoad.selected,1);
      for(const width of [900,1400,1100]) {
        await evaluate.command('Emulation.setDeviceMetricsOverride',{width,height:700,deviceScaleFactor:1,mobile:false});
        await wait(100);
        assert.equal(await evaluate('return document.documentElement.scrollWidth<=window.innerWidth;'),true,'horizontal overflow at '+width);
        assert.equal(await evaluate("return g('projectList').querySelectorAll('.selected').length;"),1);
      }
      await evaluate.command('Emulation.clearDeviceMetricsOverride',{});
      await evaluate('projects=beforeLoadProjects;renderProjectList();return true;');
      console.log('PASS: long Unicode project list and viewport resizing preserve selection without page overflow; synthetic display paths only.');
      if(process.env.BENCHOOK_TEST_SOAK==='1') {
        await evaluate.command('HeapProfiler.collectGarbage',{});
        const baseline=(await evaluate.command('Runtime.getHeapUsage',{})).result;
        const finish=Date.now()+60000;let cycles=0;
        while(Date.now()<finish) {
          await evaluate('renderRegistry();renderProjectList();return true;');
          cycles++;await wait(200);
        }
        await evaluate.command('HeapProfiler.collectGarbage',{});
        const after=(await evaluate.command('Runtime.getHeapUsage',{})).result;
        assert.equal(await evaluate("return g('projectList').querySelectorAll('.selected').length;"),1);
        assert.ok(after.usedSize<baseline.usedSize+20*1024*1024,'retained JS heap exceeded the bounded growth budget');
        console.log('Bounded UI soak: '+JSON.stringify({cycles,baseline,after}));
      }
    }
    /* HANDOFF NOTES FILE: typed in the real settings dialog, saved to disk, read back by the
       main process for the provider-switch notice, and refused when it leaves the project. */
    {
      const layoutPath = path.join(profile, 'layout.json');
      const readHandover = () => JSON.parse(fs.readFileSync(layoutPath, 'utf8')).handoverFile;
      const setField = async (value) => {
        await evaluate("openSettings(); const f=g('handoverFile'); f.value=" + JSON.stringify(value)
          + "; f.dispatchEvent(new Event('change')); return true;");
        for (let i = 0; i < 50; i++) {
          const s = await evaluate("return g('handoverSaveStatus').textContent;");
          if (s && s !== 'Saving…') return s;
          await wait(100);
        }
        throw new Error('handoff setting: no save status');
      };
      const noteLines = () => evaluate('return (await window.panel.handoverStatus(project, "claude", null, null)).lines.join("\\n");');

      assert.match(await noteLines(), /unavailable/, 'default file does not exist yet in the test project');
      assert.equal(await setField('notes/handoff.md'), 'Saved on this device.');
      assert.equal(readHandover(), 'notes/handoff.md', 'setting reached layout.json');
      fs.mkdirSync(path.join(projects[0], 'notes'), { recursive: true });
      fs.writeFileSync(path.join(projects[0], 'notes', 'handoff.md'), 'x');
      assert.match(await noteLines(), /Handoff notes last updated/, 'the chosen file is the one read');
      if (process.env.BENCHOOK_SETTINGS_SCREENSHOT) {
        await evaluate("openSettings(); g('handoverSaveStatus').textContent='Saved on this device.'; return true;");
        await wait(200);
        const shot = await evaluate.command('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(process.env.BENCHOOK_SETTINGS_SCREENSHOT, Buffer.from(shot.result.data, 'base64'));
      }

      assert.match(await setField('../outside.md'), /inside the project folder/);
      assert.equal(readHandover(), 'notes/handoff.md', 'a path outside the project is not saved');

      assert.equal(await setField(''), 'Saved on this device.');
      assert.equal(readHandover(), '', 'clearing the field returns to the default');
      assert.match(await noteLines(), /unavailable/, 'back on the default file, which does not exist');
      await evaluate('closeSettings(); return true;');
      console.log('PASS: handoff notes file is set in the real settings dialog, saved to disk, read for the provider-switch notice, and kept inside the project.');
    }
    /* SAME NAME, DIFFERENT AGENTS: LOCKED. Two projects hold different definitions named "twin".
       The warning bar appears, the form allows only the name, and renaming touches one file only. */
    {
      const twin = (p, task) => { const d = path.join(p, '.claude', 'agents'); fs.mkdirSync(d, { recursive: true });
        const f = path.join(d, 'twin.md'); fs.writeFileSync(f, '---\nname: twin\ndescription: reviews\nmodel: sonnet\n---\n\n' + task + '\n'); return f; };
      const fa = twin(projects[0], 'Task in A.'), fb = twin(projects[1], 'Task in B.');
      const beforeB = fs.readFileSync(fb, 'utf8');
      const startProject = await evaluate('return project;');
      await evaluate('await changeProject(' + JSON.stringify(projects[1]) + '); return true;');
      await evaluate('await changeProject(' + JSON.stringify(projects[0]) + '); return true;');
      let bar = '';
      for (let i = 0; i < 50 && !/twin/.test(bar); i++) {
        await evaluate('await refreshDefinitions(); await renderNameConflicts(); return true;');
        bar = await evaluate("const b=g('nameConflictBar'); return b.hidden ? '' : b.textContent;");
        if (!/twin/.test(bar)) await wait(200);
      }
      assert.match(bar, /Agents with the same name/, 'the warning bar is shown');
      assert.match(bar, /twin/);
      if (process.env.BENCHOOK_LOCK_BAR_SCREENSHOT) {
        await evaluate("selectTab('agents'); return true;");
        await wait(200);
        const shot = await evaluate.command('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(process.env.BENCHOOK_LOCK_BAR_SCREENSHOT, Buffer.from(shot.result.data, 'base64'));
        await evaluate("selectTab('status'); return true;");   // later checks measure the Overview tab
      }
      const card = await evaluate("const a=definedAgents.find(x=>x.name==='twin'); return a ? { locked: a.nameConflict } : null;");
      assert.deepEqual(card, { locked: true }, 'the card is marked as locked');
      await evaluate("await agentForm(definedAgents.find(x=>x.name==='twin')); return true;");
      const form = await evaluate("return { note: !!g('formLockNote'), name: g('formName').disabled, task: g('formTask').disabled, "
        + "rename: !!g('formRename'), del: [...document.querySelectorAll('#detail button')].some(b=>/Delete agent|Remove from project/.test(b.textContent)) };");
      assert.deepEqual(form, { note: true, name: false, task: true, rename: true, del: false }, JSON.stringify(form));
      if (process.env.BENCHOOK_LOCK_SCREENSHOT) {
        const shot = await evaluate.command('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(process.env.BENCHOOK_LOCK_SCREENSHOT, Buffer.from(shot.result.data, 'base64'));
      }
      await evaluate("g('formName').value='twin-a'; g('formRename').click(); return true;");
      const renamed = path.join(path.dirname(fa), 'twin-a.md');
      for (let i = 0; i < 50 && !fs.existsSync(renamed); i++) await wait(100);
      assert.equal(fs.existsSync(renamed), true, 'the copy in this project was renamed in place');
      assert.equal(fs.existsSync(fa), false);
      assert.equal(fs.readFileSync(fb, 'utf8'), beforeB, 'the other project is untouched');
      for (let i = 0; i < 50 && bar; i++) {
        await evaluate('await refreshDefinitions(); await renderNameConflicts(); return true;');
        bar = await evaluate("const b=g('nameConflictBar'); return b.hidden ? '' : b.textContent;");
        if (bar) await wait(200);
      }
      assert.equal(bar, '', 'the warning bar is gone once the names differ');
      await evaluate('closeDetail(); await changeProject(' + JSON.stringify(startProject) + '); return true;');
      fs.rmSync(renamed, { force: true }); fs.rmSync(fb, { force: true });
      console.log('PASS: two different agents with one name are locked in the real panel: warning bar, name-only form, and a rename that changes one file.');
    }
    await evaluate('window.originalTestProject=project; return true;');
    for (const emptyProject of [true, false]) {
    await evaluate('project=' + (emptyProject ? 'null' : 'window.originalTestProject') + '; refreshButtons(); return true;');
    for (const theme of ['pink', 'purple', 'blue', 'classic']) {
      await evaluate('applyTheme(' + JSON.stringify(theme) + '); return true;');
      await wait(100);
      const brand = await evaluate("const mark=document.querySelector('#topBar .brand-mark'),p=mark.querySelector('path'),probe=document.createElement('span');probe.style.color='var(--accent)';document.body.append(probe);const accent=getComputedStyle(probe).color;probe.remove();return {fill:getComputedStyle(p).fill,accent,width:mark.getBoundingClientRect().width,height:mark.getBoundingClientRect().height,hidden:mark.getAttribute('aria-hidden'),rule:p.getAttribute('fill-rule'),shape:p.getAttribute('d')};");
      assert.equal(brand.fill, brand.accent, theme + ': logo follows theme accent');
      assert.equal(brand.width, 28); assert.equal(brand.height, 28);
      assert.equal(brand.hidden, 'true'); assert.equal(brand.rule, 'evenodd');
      assert.equal(brand.shape, 'M16 16h54c23 0 37 11 37 28 0 9-4 16-12 21 12 5 18 12 18 22 0 16-14 25-38 25H16V16Zm20 18v60h14V71h24v23h14V34H74v23H50V34H36Z');
      const layout = await evaluate("return ['orchestratorAccount','orchestratorModel'].map(id=>{const s=g(id),b=s.parentElement.querySelector('button');return {id,nativeRects:s.getClientRects().length,buttonHeight:b.getBoundingClientRect().height,wrapperHeight:s.parentElement.getBoundingClientRect().height};});");
      for (const control of layout) {
        assert.equal(control.nativeRects, 0, theme + ': native select must not overlap custom control: ' + JSON.stringify(control));
        assert.ok(control.buttonHeight > 0 && control.wrapperHeight >= control.buttonHeight);
      }
      const separation = await evaluate("const a=g('orchestratorAccount').parentElement.getBoundingClientRect(),m=g('orchestratorModel').parentElement.getBoundingClientRect(),buttons=g('orchestratorStart').getBoundingClientRect(); return m.top >= a.bottom && buttons.top >= m.bottom;");
      assert.equal(separation, true, theme + ': account, model and action controls must not overlap');
      if (emptyProject && theme === 'blue' && process.env.BENCHOOK_EMPTY_SCREENSHOT) {
        const shot = await evaluate.command('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(process.env.BENCHOOK_EMPTY_SCREENSHOT, Buffer.from(shot.result.data, 'base64'));
      }
    }
    }
    await evaluate("applyTheme('pink'); return true;");
    for (const [invoke, heading] of [['await agentForm()', 'Create agent'], ['skillForm()', 'New skill'], ['accountForm()', 'Add account']]) {
      const text = await evaluate(invoke + '; return document.body.innerText;');
      assert.ok(text.includes(heading), heading + ': ' + text.slice(-1200));
      await evaluate('closeDetail(); return true;');
    }
    /* THE ADD-ACCOUNT FORM SAYS ONLY WHAT IS NEEDED (Codex trial, 24 September): under the provider box
       it said "The provider used to run this agent." although no agent is involved, and with Codex
       chosen it still warned about being signed in at claude.ai. */
    for (const provider of ['claude', 'codex']) {
      const text = await evaluate("accountForm(); g('accountProvider').value = " + JSON.stringify(provider)
        + "; g('accountProvider').dispatchEvent(new Event('change')); return g('overlay').innerText;");
      assert.doesNotMatch(text, /agent/i, provider + ': the account form does not talk about agents: ' + text);
      assert.doesNotMatch(text, /claude\.ai/i, provider + ': the account form names no website: ' + text);
      await evaluate('closeDetail(); return true;');
    }
    console.log('PASS: the add-account form carries no agent wording and no website warning, for Claude and Codex.');

    /* Render synthetic agents in the real DOM and check that names, account/model labels, and activity headings fit their available space. */
    {
      const cards = await evaluate(`selectTab('agents');
        const kept = { d: definedAgents, e: externalAgents, r: registry };
        registry = [...registry, { id: 'fit-account', name: 'longaccountname', provider: 'claude', signedIn: true }];
        const same = { asOrchestrator: true };
        definedAgents = [{ name: 'reviewer-one', resolution: same }, { name: 'long-account-agent', account: 'fit-account',
          model: 'claude-haiku-4-5', provider: 'claude' }];
        externalAgents = [{ name: 'reviewer-two', resolution: same, projects: [] }];
        renderAgentList();
        const card = (n) => [...document.querySelectorAll('#agentList .agent-card')].find((c) => c.querySelector('.agent-name').textContent === n);
        const fits = (e) => !!e && e.scrollWidth <= e.clientWidth;
        const clipped = (c) => { const b = c.querySelector('.bottom'); return [b, ...b.querySelectorAll('*')].filter((e) => e.scrollWidth > e.clientWidth); };
        const own = card('reviewer-one'), far = card('reviewer-two'), pair = card('long-account-agent');
        const body = (c) => Math.round(c.querySelector('.history-body').getBoundingClientRect().width);
        const lineHeight = (c) => c.querySelector('.bottom').getBoundingClientRect().height;
        const result = {
          nameFits: fits(own.querySelector('.agent-name')),
          sameWidth: body(own) === body(far),
          ellipsis: [own, far].map((c) => clipped(c).map((e) => getComputedStyle(e).textOverflow)),
          oneLine: [own, far, pair].every((c) => lineHeight(c) < 2 * parseFloat(getComputedStyle(c.querySelector('.bottom')).fontSize)),
          model: pair.querySelector('.bottom-model') && pair.querySelector('.bottom-model').textContent,
          modelFits: fits(pair.querySelector('.bottom-model')),
          accountShown: pair.querySelector('.bottom-account') ? pair.querySelector('.bottom-account').clientWidth : 0,
          accountText: pair.querySelector('.bottom-account') && pair.querySelector('.bottom-account').textContent,
          removeInside: (() => { const x = own.querySelector('.remove'), c = own.getBoundingClientRect(), r = x && x.getBoundingClientRect();
            return !!r && r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom; })(),
        };
        const heading = g('agentDefinition');
        const many = Array.from({ length: 12 }, (_, i) => ({ name: 'n' + i }));
        result.summary = typeof agentSummary === 'function' ? agentSummary(many) : null;
        heading.textContent = result.summary || '';
        result.summaryFits = fits(heading);
        definedAgents = kept.d; externalAgents = kept.e; registry = kept.r; renderAgentList();
        return result;`);
      assert.equal(cards.nameFits, true, 'a short agent name is shown whole on a card of this project: ' + JSON.stringify(cards));
      assert.equal(cards.sameWidth, true, 'cards of this project and of other projects give the text the same width');
      for (const list of cards.ellipsis) for (const v of list) assert.equal(v, 'ellipsis', 'a clipped bottom line ends in an ellipsis: ' + JSON.stringify(cards.ellipsis));
      assert.equal(cards.oneLine, true, 'the bottom line never wraps to a second line');
      assert.equal(cards.model, 'Haiku 4.5');
      assert.equal(cards.modelFits, true, 'the model name is not cut while the account takes the room');
      assert.equal(cards.accountText, 'longaccountname', 'the account is written in full and shortened only by the width');
      assert.ok(cards.accountShown >= 20, 'some of the account name stays readable: ' + cards.accountShown);
      assert.equal(cards.removeInside, true, 'the remove button stays on the card');
      assert.equal(cards.summary, '12 agents', 'the heading states the count only');
      assert.equal(cards.summaryFits, true, 'the heading count is not cut');
      console.log('PASS: agent cards show whole names, one-line bottom lines with an ellipsis, a readable account and model, and an uncut heading count.');
    }

    /* MODEL LISTS USE THE PANEL'S MODEL NAMES, AND THE SAVE PLACE FOLLOWS THE NAME (first real-use trial,
       23 September). The orchestrator's and the agent form's Claude model lists showed raw ids ("haiku",
       "claude-haiku-4-5") while every other place wrote "Haiku 4.5"; the form's "Save to:" line kept
       "<name>.md" after a name was typed. */
    {
      const lists = await evaluate(`const h = registry.find((x) => x.provider === 'claude');
        g('orchestratorAccount').value = h.id; await refreshOrchModel();
        const orchestrator = [...g('orchestratorModel').options].map((o) => [o.value, o.textContent]);
        await agentForm();
        g('formAccount').value = h.id; g('formAccount').dispatchEvent(new Event('change'));
        for (let i = 0; i < 50 && g('formModel').options.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
        const form = [...g('formModel').options].map((o) => [o.value, o.textContent]);
        g('formName').value = 'smoke-agent'; g('formName').dispatchEvent(new Event('input'));
        const place = g('formPlace').textContent;
        closeDetail();
        return { orchestrator, form, place, expected: [...orchestrator, ...form].map(([v]) => v === 'default' ? 'Default' : modelName(v)) };`);
      const shown = [...lists.orchestrator, ...lists.form].map(([, t]) => t);
      assert.ok(lists.orchestrator.length > 1 && lists.form.length > 1, JSON.stringify(lists));
      assert.deepEqual(shown, lists.expected, 'model lists show the panel spelling: ' + JSON.stringify(lists));
      assert.ok(lists.place.endsWith('\\smoke-agent.md'), 'the save place follows the typed name: ' + lists.place);
      console.log('PASS: orchestrator and agent-form model lists use the panel model names; the save place follows the typed name.');
    }
    /* THE PERMISSION BOX : three levels, "edit" for a new agent, and on Claude the full level
       says plainly that Windows does not keep commands inside the project folder. Codex keeps its commands
       in its sandbox, so no such warning there. An old agent (the former default line) opens as read-only. */
    {
      const box = await evaluate(`await agentForm();
        const options = [...g('formPermission').options].map((o) => o.value);
        const start = g('formPermission').value;
        const hint = async (account, level) => { g('formAccount').value = account; g('formAccount').dispatchEvent(new Event('change'));
          await new Promise((r) => setTimeout(r, 150)); g('formPermission').value = level; g('formPermission').dispatchEvent(new Event('change'));
          return g('formPermissionHint').textContent; };
        const claude = registry.find((x) => x.provider === 'claude').id, codex = registry.find((x) => x.provider === 'codex').id;
        const labels = [...g('formPermission').options].map((o) => o.textContent);
        const r = { options, start, labels, defaultHint: await hint(claude, 'default'), claudeFull: await hint(claude, 'full'), claudeEdit: await hint(claude, 'edit'), codexFull: await hint(codex, 'full') };
        closeDetail();
        await agentForm({ name: 'old-agent', description: 'd', body: 't', tools: 'Read, Grep, Glob, Bash', permission: 'read', account: claude, filePath: null });
        r.old = g('formPermission').value; closeDetail();
        return r;`);
      /* Default permissions appear first; explicit restrictive levels remain available. */
      assert.deepEqual(box.options, ['default', 'read', 'edit', 'full'], JSON.stringify(box));
      assert.equal(box.start, 'default', 'a new agent starts on the default level');
      assert.match(box.labels.join('|'), /^Ask for approval|Read-only|/, JSON.stringify(box.labels));
      assert.match(box.defaultHint, /live run card/i, box.defaultHint);
      assert.match(box.claudeFull, /not limited to the project folder/i, 'Claude full access warns: ' + box.claudeFull);
      assert.doesNotMatch(box.claudeEdit, /not limited/i, 'no warning below full access');
      assert.doesNotMatch(box.codexFull, /not limited/i, 'Codex keeps commands in its sandbox: ' + box.codexFull);
      assert.equal(box.old, 'read', 'an old agent opens as read-only');
      console.log('PASS: the permission box offers the default level first and three locks, starts on the default, and warns only for Claude full access.');
    }

    /* AN AGENT FROM ANOTHER PROJECT KEEPS ITS ACCOUNT IN THE FORM. The same agent came up with its
       account selected in its own project, but when opened from another project's list the account
       box stayed empty ('Select account...'). The model was filled, so the two boxes disagreed.
       The fixture reads the real DOM value, not the application's own rule. */
    const farFolder = path.join(projects[1], '.benchook/agents');
    fs.mkdirSync(farFolder, { recursive: true });
    const farDefinition = (name, account, provider) => ['---', 'name: ' + name,
      'description: Remote project agent', 'model: haiku', 'account: ' + account,
      ...(provider ? ['provider: ' + provider] : []), '---', '', 'Inspect', ''].join('\n');
    fs.writeFileSync(path.join(farFolder, 'far-assigned.md'), farDefinition('far-assigned', 'claude-synthetic', 'claude'));
    fs.writeFileSync(path.join(farFolder, 'far-deleted.md'), farDefinition('far-deleted', 'none-such-account', null));
    /* the external list now comes FROM THE REGISTRY. A definition written into a project by
       hand is taken into the registry when the panel sets that project up (`watcher:setup` ->
       `reconcile`). The test goes through that real path; otherwise it would measure a situation the
       application never has. This step came from a gap a real Electron check caught: a definition
       created while the panel was CLOSED produced no event and never entered the registry. */
    await evaluate("await window.panel.setupWatcher(" + JSON.stringify(projects[1]) + "); return true;");
    await evaluate("await window.panel.setupWatcher(" + JSON.stringify(projects[0]) + "); return true;");
    await evaluate("selectTab('agents'); await refreshExternalAgent(); return true;");
    // An agent bound to an unregistered account comes up in the form with 'Same as orchestrator' selected;
    // the old binding is mentioned only in the tooltip sentence and is not offered as an option.
    for (const [name, expected] of [['far-assigned', 'claude-synthetic'], ['far-deleted', 'orchestrator']]) {
      // Exactly what a card click does (the outside-agent `onclick` in `panel.js`), so the form reads this
      // object rather than applying its own rule.
      const selected = await evaluate("const a=externalAgents.find(x=>x.name===" + JSON.stringify(name) + ");"
        + " if(!a) return 'LISTEDE NONE';"
        + " await agentForm({name:a.name,description:a.description,body:a.task||'',model:a.model,"
        + "account:a.account,provider:a.provider,resolution:a.resolution,projects:a.projects});"
        + " return g('formAccount').value;");
      assert.equal(selected, expected, name + ': account box must preserve the configured account');
      if (name === 'far-deleted') {
        assert.equal(await evaluate("return [...g('formAccount').options].some(o=>/Not registered/.test(o.textContent));"), false, 'an unregistered id is not offered as an option');
        assert.match(await evaluate("return g('formAccountHint').textContent;"), /none-such-account.*no longer registered/);
        assert.equal(await evaluate("return g('formModel').value;"), 'orchestrator');
      }
      await evaluate('closeDetail(); return true;');
    }
    console.log('PASS: an agent opened from another project keeps its resolved account in the form.');

    /* REACHABILITY IS VISIBLE ON THE CARD - the two silences that were measured.
       In the fixture no account has an installed worker connection and `claude-signedOut` is signed out;
       both are read from the real DOM text, not from the own rule of the application. */
    const localFolder = path.join(projects[0], '.benchook/agents');
    fs.mkdirSync(localFolder, { recursive: true });
    fs.writeFileSync(path.join(localFolder, 'closed-account.md'),
      farDefinition('closed-account', 'claude-signedOut', 'claude'));
    fs.writeFileSync(path.join(localFolder, 'orch-agent.md'),
      farDefinition('orch-agent', 'orchestrator', null));
    /* WITH NO ORCHESTRATOR ACCOUNT SELECTED, NO CONNECTION WARNING IS WRITTEN, and that is right: when it
       is unknown which session is meant, saying not installed would be invented. The real flow of the
       user starts by choosing the account as well. */
    await evaluate("selectTab('status'); g('orchestratorAccount').value='claude-synthetic';"
      + " g('orchestratorAccount').dispatchEvent(new Event('change')); selectTab('agents');"
      + " await refreshDefinitions(); await refreshMcpStatus(); return true;");
    const cardText = async (name) => evaluate("const n=[...document.querySelectorAll('#agentList .agent-card')]"
      + ".find(x=>x.querySelector('.agent-name')?.textContent===" + JSON.stringify(name) + ");"
      + " return n ? n.innerText : ('NO CARD - what is listed: ' + [...document.querySelectorAll('#agentList .agent-card .agent-name')].map(x=>x.textContent).join(',') + ' | tab=' + (document.querySelector('#agentList')?'present':'absent'));");
    let closed = '';
    for (let i = 0; i < 40; i++) {
      closed = await cardText('closed-account');
      if (/Signed out/.test(closed)) break;
      await wait(100);
    }
    const diagnosis = await evaluate("return JSON.stringify({warning:mcpWarning, orch:g('orchestratorAccount').value, pane:(panes[0]||{}).accountId, mod:orchChangeMode});");
    assert.match(closed, /Signed out/, closed + ' | ' + diagnosis);
    assert.match(closed, /Unreachable/, closed + ' | ' + diagnosis);
    const closedHints = await evaluate("const n=[...document.querySelectorAll('#agentList .agent-card')]"
      + ".find(x=>x.querySelector('.agent-name')?.textContent==='closed-account');"
      + "return [...n.querySelectorAll('[title]')].map(x=>x.title).join('\\n');");
    assert.match(closedHints, /Assigned account \(Gamma\) is signed out/);
    assert.match(closedHints, /MCP connection is not set up for/);
    // NEITHER is written for an agent bound to the orchestrator: that agent does not go through MCP.
    const orch = await cardText('orch-agent');
    assert.doesNotMatch(orch, /signed out|unreachable|MCP connection is not set up/i, orch);
    console.log('PASS: agent cards state a signed-out assigned account and a missing MCP connection.');
    const originalURL = await evaluate('return location.href;');
    await evaluate("window.open('https://example.test'); location.href='https://example.test'; return true;");
    await wait(200);
    assert.equal(await evaluate('return location.href;'), originalURL);
    await evaluate("window.panel.openLink('file:///C:/Windows/notepad.exe'); window.panel.openLink('javascript:alert(1)'); window.panel.openLink('https://example.test/allowed'); return true;");
    await wait(200);
    assert.deepEqual(fs.readFileSync(path.join(root, 'external.jsonl'), 'utf8').trim().split('\n').map(JSON.parse), ['https://example.test/allowed']);
    /* THE PREVIEW STEP IS GONE: the form saves with one click, so there are no two steps here.
       `previewAgent` is called WITHOUT awaiting: after saving, the setup confirmation window opens
       and is clicked in the loop below; if awaited, the call would hang on that window. */
    await evaluate("await agentForm(); g('formName').value='sample-agent'; g('formWhen').value='Review a requested change'; g('formTask').value='Inspect the requested files and report findings.'; g('formAccount').value='orchestrator'; g('formAccount').dispatchEvent(new Event('change')); previewAgent(); return true;");
    const agentFile = path.join(projects[0], '.benchook/agents/sample-agent.md');
    for (let i=0; i<40 && !fs.existsSync(agentFile); i++) await wait(100);
    assert.match(fs.readFileSync(agentFile, 'utf8'), /name: sample-agent/);
    /* New agents use the default permission level with provider approval prompts and no fixed tools field. */
    assert.doesNotMatch(fs.readFileSync(agentFile, 'utf8'), /^tools:/m, 'a new agent is saved with the default level');
    for (let i=0; i<30; i++) {
      if (await evaluate("const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='Confirm' && b.offsetParent); if(button){button.click();return true;}return false;")) break;
      await wait(100);
    }
    for (let i=0; i<30; i++) {
      if (await evaluate("return document.body.innerText.includes('files updated');")) break;
      await wait(100);
    }
    await evaluate("const cancel=[...document.querySelectorAll('button')].find(b=>b.textContent==='Cancel' && b.offsetParent); cancel?.click(); closeDetail(); skillForm(); g('skillFormName').value='sample-skill'; g('skillFormWhen').value='Review a change'; g('skillFormBody').value='Inspect the requested changes.'; [...document.querySelectorAll('button')].find(b=>b.textContent==='Create' && b.offsetParent).click(); return true;");
    for (let i=0; i<30; i++) {
      if (await evaluate("const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='Confirm' && b.offsetParent); if(button){button.click();return true;}return false;")) break;
      await wait(100);
    }
    const skillFile = path.join(projects[0], '.claude/skills/sample-skill/SKILL.md');
    for (let i=0; i<40 && !fs.existsSync(skillFile); i++) await wait(100);
    assert.ok(fs.existsSync(skillFile), await evaluate('return document.body.innerText;'));
    assert.match(fs.readFileSync(skillFile, 'utf8'), /name: sample-skill/);
    assert.equal(fs.readFileSync(path.join(projects[0], '.agents/skills/sample-skill/SKILL.md'), 'utf8'), fs.readFileSync(skillFile, 'utf8'));
    await evaluate("closeDetail(); selectTab('agents'); return true;");
    // External edit, not renderer API: let the real watcher or polling update the DOM.
    // The account label is read from the CURRENT name in the registry: the login flow renews the name from
    // the e-mail, and in AUTH mode 'Beta' becomes 'fixture'; expecting a fixed label made the test go stale.
    for(const [account,model,label,provider,display] of [['synthetic','external-codex-model','Alph','codex','External Codex Model'],['claude-synthetic','external-claude-model','Beta','claude','External Claude Model']]) {
      fs.writeFileSync(agentFile,fs.readFileSync(agentFile,'utf8').replace(/^account:.*$/m,'account: '+account).replace(/^model:.*$/m,'model: '+model).replace(/^provider:.*$/m,'provider: '+provider));
      let observed=false;
      for(let i=0;i<150;i++) {
        observed=await evaluate("return [...document.querySelectorAll('#agentList .agent-card.own')].some(n=>n.querySelector('.agent-name')?.textContent==='sample-agent' && n.offsetParent && n.querySelector('.bottom')?.textContent===(shortAccount("+JSON.stringify(account)+")+' · '+"+JSON.stringify(display)+") && n.querySelector('.bottom')?.title===('Account: '+registry.find(h=>h.id==="+JSON.stringify(account)+").name+'\\nModel: '+"+JSON.stringify(display)+"));");
        if(observed)break;await wait(100);
      }
      assert.equal(observed,true,'external account/model edit must become visible without manual refresh: '+await evaluate("return JSON.stringify({project:project,rows:[...document.querySelectorAll('#agentList .agent-card.own')].map(n=>({text:n.innerText,title:n.querySelector('.bottom')?.title,visible:!!n.offsetParent}))});"));
    }
    console.log('PASS: external agent account/model edits update the visible list without restart or forced refresh; watcher or polling path.');
    /* THE PERMISSION IS LIVE TOO : when the orchestrator or anyone changes
       the level in the file, the card shows it without a restart, and the form opens on it. */
    {
      // The agent has no tools line (default level); the edit ADDS one, as an orchestrator would.
      const before = fs.readFileSync(agentFile, 'utf8');
      assert.doesNotMatch(before, /^tools:/m, 'setup: the default level');
      fs.writeFileSync(agentFile, before.replace(/^(account:.*)$/m, '$1\ntools: Read, Grep, Glob, Edit, Write, Bash'));
      let seen = null;
      for (let i = 0; i < 150; i++) {
        seen = await evaluate("const c=[...document.querySelectorAll('#agentList .agent-card.own')].find(n=>n.querySelector('.agent-name')?.textContent==='sample-agent'); const i=c&&c.querySelector('.perm-icon'); return i ? {cls:i.getAttribute('class'), title:c.title} : null;");
        if (seen && /perm-full/.test(seen.cls)) break; await wait(100);
      }
      assert.ok(seen && /perm-full/.test(seen.cls), 'the card shows the new level: ' + JSON.stringify(seen));
      // The label follows the providers' terms ("Full access" in Codex means no sandbox at all).
      assert.match(seen.title, /Permission: Auto-approve edits and commands/, 'the card tooltip names the level');
      const opened = await evaluate("await agentForm(definedAgents.find(x=>x.name==='sample-agent')); const v=g('formPermission').value; closeDetail(); return v;");
      assert.equal(opened, 'full', 'the form opens on the level in the file');
      console.log('PASS: a permission changed in the agent file shows on the card and in the form without a restart.');
    }
    /* SCREEN TOUR: (1) search results showed the raw account id and raw model name
       ("claude-synthetic · external-claude-model") although the cards had been fixed to show names (K8/K16); (2) in the
       edit form "Delete agent" stood taller than the buttons beside it. */
    {
      const hint = await evaluate("const i=document.querySelector('#searchBox input'); i.focus(); i.value='sample-agent'; i.dispatchEvent(new Event('input')); await new Promise(r=>setTimeout(r,300)); const rows=[...document.querySelectorAll('#searchBox *')].filter(e=>e.children.length===0 && /sample-agent/.test(e.textContent)); const row=rows[0] && rows[0].closest('div,li,button'); const text=row? row.parentElement.innerText : document.getElementById('searchBox').innerText; i.value=''; i.dispatchEvent(new Event('input')); i.blur(); return text;");
      assert.doesNotMatch(hint, /claude-synthetic|external-claude-model/, 'no raw id or model name in search: ' + hint);
      assert.match(hint, /External Claude Model/, 'the model name as the cards write it: ' + hint);
      const heights = await evaluate("await agentForm(definedAgents.find(x=>x.name==='sample-agent')); const row=[...g('detail').querySelectorAll('button')].find(b=>b.textContent==='Delete agent').parentElement; const h=[...row.querySelectorAll('button')].map(b=>Math.round(b.getBoundingClientRect().height)); closeDetail(); return h;");
      assert.ok(heights.length >= 2 && heights.every((h) => h === heights[0]), 'the form buttons stand the same height: ' + JSON.stringify(heights));
      console.log('PASS: search results use account and model names, and the agent form buttons line up.');
    }
    await evaluate("window.rawFixture=''; window.panel.onTerminalData(v=>window.rawFixture+=v.data); createPane('codex', null, 'fixture', 'synthetic', 'fixture'); return true;");
    // Exercise the actual trust prompt, using only this test's temporary project.
    for (let i = 0; i < 30; i++) {
      const accepted = await evaluate("const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='Confirm' && b.offsetParent); if(button){button.click(); return true;} return false;");
      if (accepted) break; await wait(100);
    }
    let before = null;
    for (let i=0; i<50 && !before; i++) {
      before = await evaluate('return panes[0]?.id || null;');
      if (!before) await wait(100);
    }
    assert.ok(before, await evaluate('return JSON.stringify({message:document.getElementById("orchestratorStatus")?.textContent,pane:panes[0]?.status?.textContent,body:document.body.innerText.slice(-2000)});'));
    const tickBefore = await evaluate("return Math.max(0,...Array.from(window.rawFixture.matchAll(/FIXTURE_TICK (\\d+)/g), m=>Number(m[1])));");
    await evaluate('await changeProject(' + JSON.stringify(projects[1]) + '); return true;');
    await wait(1500);
    const tickAfter = await evaluate("return Math.max(0,...Array.from(window.rawFixture.matchAll(/FIXTURE_TICK (\\d+)/g), m=>Number(m[1])));");
    assert.ok(tickAfter > tickBefore, 'no new terminal output arrived in the background');
    const state = await evaluate('await refreshContext(); await waitLayoutSaveAnd(); return [...idMap.values()].map(b=>({id:b.id,sessionId:b.sessionId}));');
    assert.equal(state[0].id, before); assert.ok(state[0].sessionId);
    const identity = state[0].sessionId;
    await evaluate('await changeProject(' + JSON.stringify(projects[0]) + '); return true;');
    const text = await evaluate("const t=panes[0].terminal; return Array.from({length:t.buffer.active.length},(_,i)=>t.buffer.active.getLine(i)?.translateToString()).join(String.fromCharCode(10));");
    assert.ok(text.includes('FIXTURE_TICK'), await evaluate("return JSON.stringify({raw:window.rawFixture,first:panes[0]?.firstOutput});"));
    await close(evaluate);
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'layout.json')));
    assert.equal(saved.projectState[projects[0]].pages[0].orchestrator.sessionId, identity);
    evaluate = await launch(); await wait(1500);
    const restored = await evaluate('return panes.map(b=>b.sessionId);');
    assert.ok(restored.includes(identity), 'the resume identity was not preserved across the restart');
    // When the same conversation continues the connection identity of the pane is preserved too, so
    // past agent cards (parent = connection) are not lost on reopen or on an account or model change.
    const savedConnection = saved.projectState[projects[0]].pages[0].orchestrator.connection;
    assert.ok(savedConnection, 'the connection identity must be written into the layout');
    assert.equal(await evaluate('return panes[0].connection;'), savedConnection, 'the connection identity must be carried over on reopen');
    const resumedText = await evaluate("const t=panes[0].terminal; return Array.from({length:t.buffer.active.length},(_,i)=>t.buffer.active.getLine(i)?.translateToString()).join(' ');");
    assert.ok(resumedText.includes('RESUME ' + identity), 'the new CLI process did not receive the resume identity: ' + resumedText.replace(/ +/g, ' ').slice(-600));
    await evaluate('await changeProject(' + JSON.stringify(projects[1]) + '); return true;');
    await evaluate("createPane('claude', null, 'fixture', 'claude-synthetic', 'fixture'); return true;");
    for (let i = 0; i < 30; i++) {
      const accepted = await evaluate("const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='Confirm' && b.offsetParent); if(button){button.click(); return true;} return false;");
      if (accepted) break; await wait(100);
    }
    await wait(1300);
    const status=await evaluate('await refreshContext(); return {data:panes[0]?.context,text:panes[0]?.bottomLeft.textContent};');
    assert.equal(status.data?.limit,432100,JSON.stringify(status));
    assert.equal(status.data?.percent,12); assert.equal(status.data?.used,300);
    assert.match(status.text,/12/); assert.match(status.text,/300/);
    const monitorId=await evaluate('return panes[0].sessionId;');
    const monitorDir=path.join(home,'projects',projects[1].replace(/[^a-zA-Z0-9]/g,'-'));
    fs.mkdirSync(path.join(monitorDir,monitorId,'subagents'),{recursive:true});
    fs.writeFileSync(path.join(monitorDir,monitorId+'.jsonl'),JSON.stringify({type:'user',cwd:projects[1],message:{content:[]}})+'\n');
    const monitorBase=path.join(monitorDir,monitorId,'subagents','agent-monitor');
    fs.writeFileSync(monitorBase+'.meta.json',JSON.stringify({agentType:'monitor-fixture',description:'Observe real monitor card',toolUseId:'toolu_monitor'}));
    fs.writeFileSync(monitorBase+'.jsonl',JSON.stringify({type:'assistant',timestamp:new Date().toISOString(),message:{model:'fixture',content:[{type:'tool_use',name:'Read',input:{file_path:'fixture.txt'}}]}})+'\n');
    await evaluate("selectLayout('sideBySide'); return true;");
    await wait(1600);
    const monitor=await evaluate("await refreshAgent();return {count:cards.size,visible:!!sg('flowContainer').offsetParent,text:sg('flowContainer').innerText};");
    assert.ok(monitor.count&&monitor.visible&&monitor.text.includes('monitor-fixture'),JSON.stringify(monitor));
    assert.ok(monitor.text.includes('Running'));
    /* Measure element positions for each layout: agents below the terminal when stacked, beside it when side by side, and no terminal area in agents-only mode. */
    for(const layout of ['stacked','sideBySide']){
      await evaluate('selectLayout('+JSON.stringify(layout)+');return true;');
      assert.equal(await evaluate("return !!sg('flowContainer').offsetParent && !!sg('topRight').offsetParent;"),true);
      const box = await evaluate("const t=sg('topRight').getBoundingClientRect(), f=sg('flowContainer').getBoundingClientRect(); return {t:{l:t.left,r:t.right,top:t.top,b:t.bottom}, f:{l:f.left,r:f.right,top:f.top,b:f.bottom}};");
      if (layout === 'stacked') assert.ok(box.f.top >= box.t.b - 1, 'stacked: agents below the terminal ' + JSON.stringify(box));
      else assert.ok(box.f.l >= box.t.r - 1 && box.f.top < box.t.b, 'side by side: agents to the right of the terminal ' + JSON.stringify(box));
      // For an eye check: BENCHOOK_TEST_SHOTS=<folder> saves each layout as a picture.
      if (process.env.BENCHOOK_TEST_SHOTS) {
        const shot = await evaluate.command('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(process.env.BENCHOOK_TEST_SHOTS, 'layout-' + layout + '.png'), Buffer.from(shot.result.data, 'base64'));
      }
    }
    fs.appendFileSync(monitorBase+'.jsonl',JSON.stringify({type:'assistant',timestamp:new Date().toISOString(),message:{model:'fixture',content:[{type:'text',text:'MONITOR_COMPLETE'}]}})+'\n');
    await wait(1500);
    assert.equal(await evaluate("await refreshAgent();return sg('flowContainer').innerText.includes('Completed') && sg('flowContainer').innerText.includes('MONITOR_COMPLETE');"),true);
    console.log('PASS: native Claude fixture run appears in the visible right monitor.');
    /* A PERMISSION PROMPT ON THE LIVE RUN CARD . A running worker record of this pane with an open
       question: the card shows what the agent wants to do with Allow and Deny; a click answers it and the waiting
       asker gets the answer. The asker here is this test process through the real approvals module. */
    {
      const workerRecords = require(path.join(panel, 'worker-records.js'));
      const approvals = require(path.join(panel, 'approvals.js'));
      const connection = await evaluate('return panes[0].connection;');
      const runId = 'live-ask-1';
      workerRecords.write(profile, projects[1], { id: runId, name: 'ask-fixture', task: 'Change a file', account: 'claude-synthetic',
        parent: connection, serverPid: process.pid, model: 'haiku', status: 'running', startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), result: '', tokens: null, seconds: null });
      const folder = workerRecords.approvalsFolder(profile, projects[1], runId);
      const answers = [];
      const first = approvals.ask(folder, { kind: 'command', title: 'Run a command', detail: 'npm test -- --watch=false' }, { pollMs: 50 });
      await wait(200);
      const shown = await evaluate("await refreshAgent(); const c=[...cards.values()].find(k=>k.container.querySelector('.card-name').textContent==='ask-fixture'); if(!c) return null; const q=c.container.querySelector('.card-ask'); return {visible:!!(q&&q.offsetParent), text:q&&q.innerText, buttons:q?[...q.querySelectorAll('button')].map(b=>b.textContent):[]};");
      assert.ok(shown && shown.visible, JSON.stringify(shown));
      assert.match(shown.text, /Run a command/); assert.match(shown.text, /npm test -- --watch=false/);
      assert.deepEqual(shown.buttons, ['Allow', 'Deny']);
      await evaluate("const c=[...cards.values()].find(k=>k.container.querySelector('.card-name').textContent==='ask-fixture'); [...c.container.querySelectorAll('.card-ask button')].find(b=>b.textContent==='Allow').click(); return true;");
      answers.push((await first).decision);
      const second = approvals.ask(folder, { kind: 'edit', title: 'Write a file', detail: 'notes.txt' }, { pollMs: 50 });
      await wait(200);
      const next = await evaluate("await refreshAgent(); const c=[...cards.values()].find(k=>k.container.querySelector('.card-name').textContent==='ask-fixture'); const q=c.container.querySelector('.card-ask'); return {text:q.innerText}; ");
      assert.match(next.text, /notes.txt/, 'the next question replaces the answered one');
      await evaluate("const c=[...cards.values()].find(k=>k.container.querySelector('.card-name').textContent==='ask-fixture'); [...c.container.querySelectorAll('.card-ask button')].find(b=>b.textContent==='Deny').click(); return true;");
      answers.push((await second).decision);
      assert.deepEqual(answers, ['allow', 'deny']);
      await wait(100);
      const after = await evaluate("await refreshAgent(); const c=[...cards.values()].find(k=>k.container.querySelector('.card-name').textContent==='ask-fixture'); const q=c.container.querySelector('.card-ask'); return !!(q&&q.offsetParent);");
      assert.equal(after, false, 'with nothing open the question box is gone');
      workerRecords.write(profile, projects[1], { ...workerRecords.list(profile, projects[1]).find((r) => r.id === runId), status: 'done', result: 'ok' });
      console.log('PASS: a running agent asks on its live run card; Allow and Deny reach the waiting agent.');
    }
    /* Keep run headers on one line with ellipsis and hover detail. Terminal-only layout must not leave an overflowing agent strip. */
    {
      const workerRecords = require(path.join(panel, 'worker-records.js'));
      const connection = await evaluate('return panes[0].connection;');
      const longName = 'researcher-with-a-very-long-agent-name';
      workerRecords.write(profile, projects[1], { id: 'layout-long-1', name: longName, task: 'Find where the config is read', account: 'synthetic',
        parent: connection, serverPid: process.pid, model: 'gpt-5.6-luna', status: 'done', startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), result: 'ok', tokens: null, seconds: 3 });
      /* Narrow the agent column to exercise header overflow at small widths. */
      await evaluate("selectLayout('sideBySide'); await refreshAgent(); sg('grid').style.gridTemplateColumns = '290px'; return true;");
      await wait(300);
      const head = await evaluate("const c=[...cards.values()].find(k=>k.container.querySelector('.card-name').textContent===" + JSON.stringify(longName) + "); const top=c.container.querySelector('.card-top'); const n=c.container.querySelector('.card-name'); const lh=parseFloat(getComputedStyle(n).lineHeight)||17; const oneLine=[...top.children].filter(e=>e.offsetParent).every(e=>{const r=document.createRange(); r.selectNodeContents(e); const rows=new Set([...r.getClientRects()].map(x=>Math.round(x.top))); return rows.size<=1;}); return {height:top.getBoundingClientRect().height, lh, oneLine, cut:n.scrollWidth>n.clientWidth, overflow:getComputedStyle(n).textOverflow, title:n.title, width:c.container.getBoundingClientRect().width};");
      assert.equal(head.oneLine, true, 'every part of the header stays on one line: ' + JSON.stringify(head));
      assert.ok(head.height < 2.2 * head.lh + 16, 'the header is one line high: ' + JSON.stringify(head));
      if (head.cut) assert.equal(head.overflow, 'ellipsis', 'a cut name ends with an ellipsis');
      assert.equal(head.title, longName, 'the full name on hover');
      await evaluate("sg('grid').style.gridTemplateColumns = ''; selectLayout('terminalOnly'); await refreshAgent(); return true;");
      await wait(300);
      const strip = await evaluate("const s=sg('strip'); const w=document.createTreeWalker(s, NodeFilter.SHOW_TEXT); const spans=[]; while(w.nextNode()) if(w.currentNode.textContent.trim()) spans.push(w.currentNode); const rows=(e)=>{const r=document.createRange(); r.selectNodeContents(e); return new Set([...r.getClientRects()].map(x=>Math.round(getComputedStyle(s).writingMode.startsWith('vertical')?x.left:x.top))).size;}; return {visible:!!s.offsetParent, text:s.innerText, rows:spans.map(rows)};");
      assert.ok(strip.visible, JSON.stringify(strip));
      assert.ok(strip.rows.every((n) => n <= 1), 'each part of the strip stays in one line: ' + JSON.stringify(strip));
      assert.match(strip.text, /^◀/, 'the arrow points to where the agents open: ' + JSON.stringify(strip));
      // The character alone is not enough: turned with the vertical text, the left arrow pointed down (seen on the tour).
      assert.equal(await evaluate("return getComputedStyle(sg('strip').querySelector('.strip-arrow')).writingMode;"), 'horizontal-tb', 'the arrow is drawn as horizontal text, not turned with the strip');
      /* THE REVERSED LAYOUTS (the measurement check found them untested): dragging the terminal to the right or to the
         bottom puts the strip on the other edge; its arrow turns and its text stays readable there too. */
      for (const [side, arrow] of [[true, '▶'], [false, '▼']]) {
        const r = await evaluate("layout=" + JSON.stringify(side ? 'sideBySide' : 'stacked') + "; layoutReversed=true; terminalOnly=true; terminalHidden=false; applyLayout(); gridVisible(cards.size>0); await refreshAgent(); await new Promise(x=>setTimeout(x,300)); const s=sg('strip'); const w=document.createTreeWalker(s, NodeFilter.SHOW_TEXT); const rows=[]; const vertical=getComputedStyle(s).writingMode.startsWith('vertical'); while(w.nextNode()){ if(!w.currentNode.textContent.trim()) continue; const g=document.createRange(); g.selectNodeContents(w.currentNode); rows.push(new Set([...g.getClientRects()].map(x=>Math.round(vertical?x.left:x.top))).size); } return {text:s.innerText, rows, visible:!!s.offsetParent, arrowMode:getComputedStyle(s.querySelector('.strip-arrow')).writingMode};");
        assert.ok(r.visible && r.rows.every((n) => n <= 1), 'reversed strip readable: ' + JSON.stringify(r));
        assert.ok(r.text.startsWith(arrow), 'reversed arrow ' + arrow + ': ' + JSON.stringify(r));
        assert.equal(r.arrowMode, 'horizontal-tb');
        if (process.env.BENCHOOK_TEST_SHOTS) {
          const shot = await evaluate.command('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(path.join(process.env.BENCHOOK_TEST_SHOTS, 'strip-reversed-' + (side ? 'side' : 'stacked') + '.png'), Buffer.from(shot.result.data, 'base64'));
        }
      }
      await evaluate("layoutReversed=false; selectLayout('stacked'); selectLayout('terminalOnly'); await refreshAgent(); return true;");
      await wait(300);
      assert.match(await evaluate("return sg('strip').innerText;"), /^▲/, 'stacked keeps the up arrow');
      await evaluate("selectLayout('stacked'); return true;");
      workerRecords.write(profile, projects[1], { ...workerRecords.list(profile, projects[1]).find((r) => r.id === 'layout-long-1'), status: 'done' });
      console.log('PASS: a narrow agent column keeps run card headers on one line and the side strip readable.');
    }
    /* A MODEL SWITCH RESUMES THE SAME CONVERSATION. The switch passed the pane's terminal number where
       the session identity belongs; the main process could not use it, the old pane was closed and no
       new one opened, and nothing on screen said why. The fixture account signs in first: the panel
       refuses to switch to a signed-out account before any of the switch code runs. */
    fs.writeFileSync(path.join(home, 'fixture-auth.json'), '{}');
    for (let i = 0; i < 50; i++) {
      if (await evaluate("await refreshRegistry(true); return accountSignIn(registry.find(h=>h.id==='claude-synthetic'));")) break;
      await wait(200);
    }
    assert.equal(await evaluate("return accountSignIn(registry.find(h=>h.id==='claude-synthetic'));"), true, 'fixture account did not sign in');
    const paneBefore = await evaluate("return panes[0]?.id;");
    await evaluate("selectTab('status'); document.getElementById('orchestratorSwitch').click(); return true;");
    await wait(300);
    await evaluate("document.getElementById('orchestratorStart').click(); return true;");
    for (let i = 0; i < 30; i++) {
      const accepted = await evaluate("const button=[...document.querySelectorAll('.confirm-overlay button')].find(b=>b.textContent==='Confirm'); if(button){button.click(); return true;} return false;");
      if (accepted) break; await wait(100);
    }
    let switched = null;
    for (let i = 0; i < 60; i++) {
      switched = await evaluate("return {count:panes.length,sessionId:panes[0]?.sessionId,resumed:!!panes[0]?.resumeDid,id:panes[0]?.id,status:document.getElementById('orchestratorStatus').textContent};");
      if (switched.count === 1 && switched.id && switched.id !== paneBefore) break; await wait(100);
    }
    assert.equal(switched.count, 1, 'the model switch left no orchestrator pane: ' + JSON.stringify(switched));
    assert.notEqual(switched.id, paneBefore, 'the switch never replaced the terminal: ' + JSON.stringify(switched));
    assert.equal(switched.sessionId, monitorId, 'the switch must continue the same session');
    assert.equal(switched.resumed, true, 'the switch must resume, not start fresh: ' + JSON.stringify(switched));
    console.log('PASS: a model switch reopens the orchestrator on the same session.');
    /* A DECLINED CONNECTION IS SAID ABOVE THE TERMINAL, WITH A WAY BACK . When the user
       declines Benchook's connection in Claude's start-up question, Claude records it in the project and
       never asks again; the panel's old advice (/mcp) led nowhere, because Claude's /mcp list does not
       show a declined project server (measured on 2.1.280). The bar appears only while the connection is
       declined; its button removes the declined entry, with approval, and resumes the terminal so Claude
       asks again. */
    {
      const mcpFile = path.join(projects[1], '.mcp.json');
      const localFile = path.join(projects[1], '.claude', 'settings.local.json');
      const mcpBefore = fs.existsSync(mcpFile) ? fs.readFileSync(mcpFile, 'utf8') : null;
      fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { benchook: { command: 'node',
        args: [path.join(__dirname, '..', 'tools', 'mcp-server.js')] } } }, null, 2));
      fs.mkdirSync(path.dirname(localFile), { recursive: true });
      fs.writeFileSync(localFile, JSON.stringify({ disabledMcpjsonServers: [] }, null, 2));
      const bar = () => evaluate("await refreshMcpStatus(); const b=panes[0]?.container.querySelector('.mcp-declined'); return b ? {text:b.innerText, button:!!b.querySelector('button')} : null;");
      assert.equal(await bar(), null, 'no bar while the connection is not declined');
      fs.writeFileSync(localFile, JSON.stringify({ disabledMcpjsonServers: ['benchook'], other: 1 }, null, 2));
      const shown = await bar();
      assert.ok(shown && shown.button && /declined/i.test(shown.text), 'the bar appears when the connection is declined: ' + JSON.stringify(shown));
      const sessionBefore = await evaluate('return panes[0].sessionId;');
      const paneBeforeAsk = await evaluate('return panes[0].id;');
      await evaluate("panes[0].container.querySelector('.mcp-declined button').click(); return true;");
      for (let i = 0; i < 30; i++) {
        const accepted = await evaluate("const button=[...document.querySelectorAll('.confirm-overlay button')].find(b=>b.textContent==='Confirm'); if(button){button.click(); return true;} return false;");
        if (accepted) break; await wait(100);
      }
      let reopened = null;
      for (let i = 0; i < 60; i++) {
        reopened = await evaluate('return {count:panes.length,id:panes[0]?.id,sessionId:panes[0]?.sessionId};');
        if (reopened.count === 1 && reopened.id && reopened.id !== paneBeforeAsk) break; await wait(100);
      }
      const local = JSON.parse(fs.readFileSync(localFile, 'utf8'));
      assert.deepEqual(local, { other: 1 }, 'only the declined entry is removed: ' + JSON.stringify(local));
      assert.notEqual(reopened.id, paneBeforeAsk, 'the terminal is restarted so Claude asks again: ' + JSON.stringify(reopened));
      assert.equal(reopened.sessionId, sessionBefore, 'the restart continues the same conversation');
      assert.equal(await bar(), null, 'the bar goes once the connection is no longer declined');
      if (mcpBefore === null) fs.rmSync(mcpFile, { force: true }); else fs.writeFileSync(mcpFile, mcpBefore);
      console.log('PASS: a declined connection shows a bar above the terminal only then, and its button asks again on the same session.');
    }
    /* A FAILED START KEEPS ITS REASON ON SCREEN. The reason was written and then erased by the pane
       cleanup that followed it. A signed-out account is refused by the main process. */
    await evaluate("closePane(panes[0], true); return true;");
    await wait(500);
    await evaluate("createPane('claude', null, 'signed out', 'claude-signedOut', 'fixture'); return true;");
    let refused = '';
    for (let i = 0; i < 40; i++) {
      await evaluate("const c=[...document.querySelectorAll('.confirm-overlay button')].find(b=>b.textContent==='Cancel'); if(c) c.click(); return true;");
      refused = await evaluate("return document.getElementById('orchestratorStatus').textContent;");
      if (/Could not start/.test(refused)) break; await wait(100);
    }
    await wait(500);
    refused = await evaluate("return {status:document.getElementById('orchestratorStatus').textContent,count:panes.length};");
    assert.equal(refused.count, 0, JSON.stringify(refused));
    assert.match(refused.status, /Could not start.*signed out/i, 'the start failure reason vanished: ' + JSON.stringify(refused));
    console.log('PASS: a failed orchestrator start keeps its reason on screen.');
    if (process.env.BENCHOOK_SCREENSHOT) {
      const shot = await evaluate.command('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.BENCHOOK_SCREENSHOT, Buffer.from(shot.result.data, 'base64'));
    }
    let closingLoginPid=null;
    if(process.env.BENCHOOK_TEST_AUTH==='1') {
      fs.rmSync(path.join(home,'fixture-login-pid'),{force:true});
      await evaluate("await signInScreen(registry.find(h=>h.id==='claude-synthetic')); return true;");
      for(let i=0;i<100&&!fs.existsSync(path.join(home,'fixture-login-pid'));i++) await wait(100);
      assert.ok(fs.existsSync(path.join(home,'fixture-login-pid')));
      closingLoginPid=Number(fs.readFileSync(path.join(home,'fixture-login-pid'),'utf8'));
    }
    await close(evaluate);
    if(closingLoginPid) {
      assert.throws(()=>process.kill(closingLoginPid,0),{code:'ESRCH'});
      console.log('PASS: closing Electron stops its active native login process.');
    }
    console.log('PASS: real Electron, a background PTY, a late-learned id, a write to disk and a reopen. The CLI answer is synthetic.');
  } finally {
    socket?.close();
    if (child && child.exitCode === null) await stopTree(child);
    // Give the Electron child processes a chance to release their Windows file handles.
    await wait(300);
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
    catch (e) { console.error('test leftovers could not be deleted: ' + root + ': ' + e.message); }
  }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
