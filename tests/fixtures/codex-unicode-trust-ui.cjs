'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function(evaluate, root, home) {
  const project = path.join(root, 'Dotted İ Ş');
  fs.mkdirSync(project);
  const file = path.join(home, 'config.toml');
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const prefix = root.replace(/[A-Z]/g, c => c.toLowerCase());
  const key = path.join(prefix, 'dotted İ Ş');
  const oldKey = path.join(prefix, 'dotted i\u0307 ş');
  const section = (k, v) => `[projects.'${k}']\ntrust_level = "${v}"\n`;
  const getPlan = () => evaluate(`return await window.panel.onboardingPlan(${JSON.stringify(project)}, 'synthetic');`);
  const savedProject = await evaluate('return project;');
  let stage = 'existing trust records';
  try {
    for (const value of ['trusted', 'untrusted']) {
      const text = section(oldKey, 'trusted') + section(key, value);
      fs.writeFileSync(file, text);
      const plan = await getPlan();
      assert.equal(plan.error, undefined, JSON.stringify(plan));
      assert.equal(plan.trust.required, false);
      assert.equal(plan.trust.otherDecision, value === 'untrusted' ? value : null);
      assert.equal(fs.readFileSync(file, 'utf8'), text);
    }
    const oldOnly = section(oldKey, 'trusted');
    fs.writeFileSync(file, oldOnly);
    assert.equal((await getPlan()).trust.required, true);
    await evaluate(`project = ${JSON.stringify(project)}; return true;`);
    for (const choice of ['Cancel', 'Confirm']) {
      stage = choice + ': open approval';
      await evaluate("window.trustProbe = prepareFirstSetup({ accountId: 'synthetic', project }); return true;");
      let shown = false;
      for (let i = 0; i < 100; i++) {
        shown = await evaluate("return [...document.querySelectorAll('button')].some(b => b.textContent === 'Cancel' && b.getBoundingClientRect().height > 0) && document.body.innerText.includes('Allow access to this folder?');");
        if (shown) break;
        await new Promise(r => setTimeout(r, 50));
      }
      assert.ok(shown, 'visible folder access approval must appear for the distinct project');
      stage = choice + ': click approval';
      assert.equal(fs.readFileSync(file, 'utf8'), oldOnly, 'no trust written before consent');
      await evaluate(`const b = [...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(choice)} && b.getBoundingClientRect().height > 0); b.click(); await window.trustProbe; return true;`);
      if (choice === 'Cancel') assert.equal(fs.readFileSync(file, 'utf8'), oldOnly);
      else {
        assert.equal((await getPlan()).trust.required, false);
        const written = fs.readFileSync(file, 'utf8');
        assert.ok(written.startsWith(oldOnly));
        assert.ok(written.includes(section(key, 'trusted')));
      }
    }
    console.log('PASS: Codex Unicode trust through real Electron IPC and visible Cancel/Confirm; personal profiles untouched, no provider call.');
  } catch (e) {
    throw new Error('Unicode trust UI (' + stage + '): ' + e.message);
  } finally {
    await evaluate(`project = ${JSON.stringify(savedProject)}; delete window.trustProbe; return true;`);
    if (before === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, before);
  }
};
