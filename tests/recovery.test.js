'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const json = require('../panel/persistent-json');
const operation = require('../panel/folder-transaction');
const skills = require('../panel/skills');
const logs = require('../panel/log-cleanup');
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchook-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
for(const committed of [false,true])test('uncertain transaction marker recovers from durable state: '+committed,t=>{
  delete require.cache[require.resolve('../panel/folder-transaction')];
  const operation=require('../panel/folder-transaction');
  const root=temp(t),journal=path.join(root,'journal'),file=path.join(root,'data');
  fs.writeFileSync(file,'old');operation.setup(journal);
  const original=json.atomic;
  t.mock.method(json,'atomic',(target,value)=>{
    if(value?.done===true){if(committed)original(target,value);throw Object.assign(new Error('uncertain marker'),{outcomeUncertain:true});}
    return original(target,value);
  });
  assert.throws(()=>operation.apply([{target:file,kind:'file',prepare:target=>fs.writeFileSync(target,'new')}]),/journal preserved/);
  assert.equal(fs.readFileSync(file,'utf8'),'new');
  operation.recover(journal);operation.recover(journal);
  assert.equal(fs.readFileSync(file,'utf8'),committed?'new':'old');
  assert.deepEqual(fs.readdirSync(journal),[]);
});
for (const mode of ['prepare', 'backup', 'install', 'delete', 'commit']) test('recovery by journal stage after a real process is interrupted: ' + mode, t => {
  const root = temp(t);
  for (const name of ['a', 'b']) { fs.mkdirSync(path.join(root, name)); fs.writeFileSync(path.join(root, name, 'data'), 'old-' + name); }
  const r = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/interruption.cjs'), root, mode], { windowsHide: true });
  assert.equal(r.status, 23, String(r.stderr));
  if (mode === 'install') {
    const interrupted = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/interruption.cjs'), root, 'recover'], { windowsHide: true });
    assert.equal(interrupted.status, 23, 'the recovery must be interrupted too');
  }
  operation.recover(path.join(root, 'journal'));
  operation.recover(path.join(root, 'journal'));
  for (const name of ['a', 'b']) assert.equal(fs.readFileSync(path.join(root, name, 'data'), 'utf8'), mode === 'commit' ? 'new' : 'old-' + name);
  assert.deepEqual(fs.readdirSync(path.join(root, 'journal')), []);
});
test('a corrupt layout is restored from the sound backup and the corrupt copy is kept', t => {
  const root = temp(t), file = path.join(root, 'layout.json');
  json.write(file, { project: 'A' }); json.write(file, { project: 'B' });
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(json.read(file), { project: 'A' });
  assert.ok(fs.readdirSync(root).some(n => n.startsWith('layout.json.corrupt-')));
  assert.deepEqual(json.read(file), { project: 'A' });
});
test('if both layout copies are corrupt they are not overwritten with an empty layout', t => {
  const file = path.join(temp(t), 'layout.json');
  fs.writeFileSync(file, 'bad'); fs.writeFileSync(file + '.backup', 'bad backup');
  assert.throws(() => json.write(file, {}), /preserved/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'bad');
});
test('when deleting the second skill fails the first side is restored', t => {
  const root = temp(t);
  for (const side of ['.claude', '.agents']) {
    const dir = path.join(root, side, 'skills/x'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), side);
  }
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (a, b) => {
    if (a === path.join(root, '.agents/skills/x')) throw new Error('injected delete failure');
    return rename(a, b);
  });
  assert.ok(skills.remove(root, 'x').error);
  for (const side of ['.claude', '.agents']) assert.equal(fs.readFileSync(path.join(root, side, 'skills/x/SKILL.md'), 'utf8'), side);
});
test('journal cleanup deletes only the traces of old closed panels', t => {
  const root = temp(t), now = Date.now(), old = new Date(now - 9 * 86400000);
  const dirs = ['11111111','22222222','33333333'].map(x => path.join(root, x + '-1234-1234-1234-123456789abc'));
  for (const dir of dirs) {
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'codex-tui.log'), 'trace');
    fs.utimesSync(path.join(dir, 'codex-tui.log'), old, old); fs.utimesSync(dir, old, old);
  }
  fs.writeFileSync(path.join(dirs[2], 'user.txt'), 'preserve');
  const r = logs.cleanup(root, [path.join(dirs[1], 'codex-tui.log')], now);
  assert.deepEqual(r.removedPaths, [dirs[0]]);
  assert.ok(fs.existsSync(dirs[1])); assert.ok(fs.existsSync(dirs[2]));
});
