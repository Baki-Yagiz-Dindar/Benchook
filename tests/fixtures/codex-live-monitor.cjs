'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
module.exports = async function(evaluate, root) {
  const until = async (code, label) => {
    const end = Date.now() + 25000;
    do { if (await evaluate(code)) return; await wait(250); } while (Date.now() < end);
    throw new Error(label);
  };
  await evaluate("window.monitorTabA=activePage.id; createPane('codex', null, 'Monitor A', 'synthetic', 'fixture'); return true;");
  await until("const confirm=[...document.querySelectorAll('button')].find(b=>b.textContent==='Confirm' && b.offsetParent); if(confirm) confirm.click(); await refreshContext(); return !!panes[0]?.id && !!panes[0]?.connection && !!panes[0]?.id;", 'First terminal did not become ready');
  const pane = await evaluate('return panes[0].connection;');
  await evaluate("const tab=createPage(null); window.monitorTabB=tab.id; await goToPage(tab.id); createPane('codex', null, 'Monitor B', 'synthetic', 'fixture'); return true;");
  await until("await refreshContext(); return !!panes[0]?.id && !!panes[0]?.connection && !!panes[0]?.sessionId;", 'Second terminal did not become ready');
  fs.writeFileSync(path.join(root, 'monitor-control.json'), JSON.stringify({ pane }));
  await evaluate("await goToPage(monitorTabA); selectLayout('sideBySide'); return true;");
  await until("await refreshAgent(); return panes[0].agents?.list.some(a=>a.name==='live-monitor-worker' && a.status==='running');", 'Running worker was not bound through the actual process tree');
  const worker = JSON.parse(fs.readFileSync(path.join(root, 'monitor-worker.json'), 'utf8'));
  assert.equal(worker.inheritedParent, null, 'Fixture must not inherit the parent identifier');
  assert.equal(await evaluate("return !!sg('flowContainer').offsetParent && sg('flowContainer').innerText.includes('live-monitor-worker') && sg('flowContainer').innerText.includes('Running');"), true);
  await evaluate('await goToPage(monitorTabB); await refreshAgent(); return true;');
  assert.equal(await evaluate("return panes[0].agents.list.some(a=>a.name==='live-monitor-worker');"), false);
  assert.equal(await evaluate("return sg('flowContainer').innerText.includes('live-monitor-worker');"), false, 'Other pane must not display the worker');
  await evaluate('await goToPage(monitorTabA); await refreshAgent(); return true;');
  if (process.env.BENCHOOK_SCREENSHOT) {
    const shot = await evaluate.command('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.BENCHOOK_SCREENSHOT, Buffer.from(shot.result.data, 'base64'));
  }
  fs.writeFileSync(path.join(root, 'monitor-control.json'), JSON.stringify({ pane, complete: true }));
  await until("await refreshAgent(); return sg('flowContainer').innerText.includes('Completed') && sg('flowContainer').innerText.includes('CODEX_MONITOR_COMPLETE');", 'Completed result did not remain in its pane');
  await wait(300);
  assert.throws(() => process.kill(worker.pid, 0), { code: 'ESRCH' });
  await evaluate('await goToPage(monitorTabB); await refreshAgent(); return true;');
  assert.equal(await evaluate("return panes[0].agents.list.some(a=>a.name==='live-monitor-worker');"), false);
  console.log('PASS: actual Electron IPC, Windows process ancestry and disk record show Running then Completed in the correct pane only; no completed MCP rollout event or copied worker record; provider CLI is a deterministic fixture.');
};
