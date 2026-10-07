'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {list}=require('../panel/codex-agents');
function field(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-agents-'));
 const s=new DatabaseSync(path.join(root,'state_5.sqlite')),h=new DatabaseSync(path.join(root,'thread_history_1.sqlite'));
 s.exec('CREATE TABLE threads(id TEXT,agent_nickname TEXT,agent_role TEXT,model TEXT,history_mode TEXT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT);');
 h.exec('CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,rollout_ordinal INTEGER); CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_type TEXT,item_json TEXT,rollout_ordinal INTEGER);');
 t.after(()=>{h.close();s.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,s,h};
}
test('Codex native history uses explicit parent and latest turn, never reasoning',t=>{
 const {root,s,h}=field(t);
 for(const [id,parent] of [['child-a','parent-a'],['child-b','parent-b']]){
  s.prepare('INSERT INTO threads VALUES (?,?,?,?,?)').run(id,id,null,'known-model','paginated');
  s.prepare('INSERT INTO thread_spawn_edges VALUES (?,?)').run(parent,id);
 }
 h.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?,?)').run('child-a','old','completed',10,11,1);
 h.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?,?)').run('child-a','new','failed',20,21,2);
 const insert=h.prepare('INSERT INTO thread_items VALUES (?,?,?,?,?)');
 insert.run('child-a','old','agentMessage',JSON.stringify({type:'agentMessage',text:'stale',phase:'final_answer'}),1);
 insert.run('child-a','new','reasoning',JSON.stringify({type:'reasoning',text:'private reasoning'}),2);
 insert.run('child-a','new','agentMessage',JSON.stringify({type:'agentMessage',text:'current',phase:'final_answer'}),3);
 const r=list(root,'parent-a');
 assert.equal(r.list.length,1);assert.equal(r.list[0].id,'child-a');
 assert.equal(r.list[0].status,'error');assert.equal(r.list[0].result,'current');
 assert.doesNotMatch(JSON.stringify(r),/private reasoning|stale|child-b/);
 assert.equal(list(root,'unrelated').list.length,0);
});
test('Codex unknown turn state is not completion; unsupported history is explicit',t=>{
 const {root,s,h}=field(t);
 s.prepare('INSERT INTO threads VALUES (?,?,?,?,?)').run('child','A',null,null,'paginated');
 s.prepare('INSERT INTO thread_spawn_edges VALUES (?,?)').run('parent','child');
 h.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?,?)').run('child','turn','interrupted',10,11,1);
 assert.equal(list(root,'parent').list[0].status,'unknown');
 s.exec("UPDATE threads SET history_mode='legacy'");
 assert.equal(list(root,'parent').none,'support');
});
test('Missing Codex database is not an empty successful reading',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-missing-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 assert.equal(list(root,'parent').none,'support');
 assert.equal(list(root,null).none,'record');
});

test("project history takes only the children of parents whose cwd is this project; the long-path prefix and letter case are normalised", t => {
 const {root,s,h}=field(t);
 s.exec('ALTER TABLE threads ADD COLUMN cwd TEXT');
 const project=path.join(root,'Project A');
 const put=(id,cwd,mode)=>s.prepare('INSERT INTO threads(id,agent_nickname,agent_role,model,history_mode,cwd) VALUES (?,?,?,?,?,?)').run(id,id,null,'m',mode||'paginated',cwd);
 put('p1','\\\\?\\'+project.toUpperCase()); put('p2',path.join(root,'Project B')); put('c1',project); put('c2',project);
 s.prepare('INSERT INTO thread_spawn_edges VALUES (?,?)').run('p1','c1');
 s.prepare('INSERT INTO thread_spawn_edges VALUES (?,?)').run('p2','c2');
 for(const c of ['c1','c2']){h.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?,?)').run(c,'t','completed',10,11,1);
  h.prepare('INSERT INTO thread_items VALUES (?,?,?,?,?)').run(c,'t','agentMessage',JSON.stringify({type:'agentMessage',text:'done '+c,phase:'final_answer'}),1);}
 const {projectRuns}=require('../panel/codex-agents');
 const r=projectRuns(root,project.toLowerCase());
 assert.deepEqual(r.list.map(x=>x.id),['c1'],'a child of another project does not get in; prefix and case differences are no obstacle');
 assert.equal(r.list[0].session,'p1'); assert.equal(r.list[0].file,'codex:c1');
 assert.equal(projectRuns(root,path.join(root,'Project C')).list.length,0);
 assert.equal(projectRuns(path.join(root,'none'),project).none,'support','when there is no data base it says so plainly');
});
