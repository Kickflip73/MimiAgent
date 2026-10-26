import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { skillResource, saveSkillResource } from '../src/web/skill-files.js';
import { normalizeChatCompletionsInput } from '../src/runtime/providers/openai-compatible-model.js';
import type { AgentInputItem } from '@openai/agents';

test('chat history namespaces are made portable without mutating stored call/result pairs',()=>{
 const items=[{type:'function_call',name:'functions.read_file',namespace:'functions',callId:'call1',arguments:'{}'},{type:'function_call_result',callId:'call1',output:'ok'}] as unknown as AgentInputItem[];
 const normalized=normalizeChatCompletionsInput(items);
 assert.match((normalized[0] as any).name,/^[a-zA-Z0-9_-]{1,64}$/);
 assert.equal((normalized[0] as any).namespace,undefined);
 assert.equal((normalized[0] as any).callId,'call1');
 assert.equal(normalized[1],items[1]);assert.equal((items[0] as any).name,'functions.read_file');
});
test('skill edits preserve revisions and reject directory escapes',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mimi-skill-edit-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(path.join(root,'skill'));await writeFile(path.join(root,'skill','SKILL.md'),'old');
 const skill={root:path.join(root,'skill')};const current=await skillResource(skill,'SKILL.md');
 assert.equal(current.kind,'file');if(current.kind!=='file')return;
 await saveSkillResource(skill,'SKILL.md','new',current.revision!);
 await assert.rejects(saveSkillResource(skill,'SKILL.md','stale',current.revision!),/变化/);
 await writeFile(path.join(root,'outside'),'outside');await symlink(path.join(root,'outside'),path.join(skill.root,'escape'));
 await assert.rejects(saveSkillResource(skill,'escape','bad',current.revision!),/之外/);
 assert.equal(await readFile(path.join(skill.root,'SKILL.md'),'utf8'),'new');
 await writeFile(path.join(skill.root,'binary'),Buffer.from([255,254,65]));
 const binary=await skillResource(skill,'binary');
 assert.equal(binary.kind==='file' && binary.binary,true);
 await assert.rejects(saveSkillResource(skill,'binary','lossy','unused'),/文本/);
});

test('provider discovery authenticates without returning credentials and handles failures',async()=>{
 const {discoverProvider,providerEnvironmentName}=await import('../src/web/provider-access.js');
 assert.notEqual(providerEnvironmentName('foo-bar'),providerEnvironmentName('foo_bar'));
 assert.notEqual(providerEnvironmentName('Foo'),providerEnvironmentName('foo'));
 const request={id:'test',transport:'openai-chat-completions',baseUrl:'https://example.invalid/v1/',apiKey:'fixture-secret'};
 const fetcher=async(url:any,init:any)=>{assert.equal(String(url),'https://example.invalid/v1/models');assert.equal(init.headers.authorization,'Bearer fixture-secret');return new Response(JSON.stringify({data:[{id:'model-a'},{id:'model-b'}]}));};
 const value=await discoverProvider(request,fetcher as typeof fetch);assert.deepEqual(value.models.map(m=>m.id),['model-a','model-b']);assert.equal(JSON.stringify(value).includes('fixture-secret'),false);
 await assert.rejects(discoverProvider(request,(async()=>new Response('secret failure',{status:401})) as typeof fetch),/HTTP 401/);
});
test('execution history selects one attempt and recovers trace times after stream eviction',async t=>{
 const {DatabaseSync}=await import('node:sqlite');const {executionHistory}=await import('../src/web/execution-history.js');
 const root=await mkdtemp(path.join(os.tmpdir(),'mimi-run-history-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'traces'));
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE runs(id TEXT, task_id TEXT, session_key TEXT, started_at TEXT, completed_at TEXT,status TEXT,error TEXT)');
 db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?)').run('run','task','session','2026-10-08T01:00:00Z','2026-10-08T01:05:00Z','failed','fixture failure');
 await writeFile(path.join(root,'traces/session.jsonl'),[...['00:59','01:02','01:06'].map(time=>JSON.stringify({sessionId:'session',timestamp:`2026-10-08T${time}:00Z`,type:'status',data:{title:'Tool',tone:'tool',detail:'Details'}})),'{unfinished'].join('\n'));
 db.exec('ALTER TABLE runs ADD COLUMN answer_json TEXT');
 db.prepare('UPDATE runs SET answer_json=? WHERE id=?').run(JSON.stringify({answer:'原始执行结果'}),'run');
 const value=await executionHistory(db,root,'run');assert.equal(value?.answer,'原始执行结果');assert.ok(value);assert.equal(value.steps.length,1);assert.equal(value.steps[0]!.timestamp,'2026-10-08T01:02:00Z');assert.equal(value.steps[0]!.fullDetail,'Details');assert.equal(value.startedAt,'2026-10-08T01:00:00Z');
});

test('execution history resolves latest session attempt without a queued run ID',async t=>{
 const {DatabaseSync}=await import('node:sqlite');const {executionHistory}=await import('../src/web/execution-history.js');
 const root=await mkdtemp(path.join(os.tmpdir(),'mimi-latest-run-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE runs(id TEXT, task_id TEXT, session_key TEXT, started_at TEXT, completed_at TEXT,status TEXT,error TEXT)');
 const add=db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?)');
 add.run('earlier','task','session','2026-10-08T01:00:00Z','2026-10-08T01:05:00Z','failed','error');
 add.run('latest','task','session','2026-10-09T01:00:00Z',null,'running',null);
 assert.equal((await executionHistory(db,root,undefined,'session'))?.runId,'latest');
 assert.equal((await executionHistory(db,root,'earlier','session'))?.runId,'earlier');
 assert.equal(await executionHistory(db,root,undefined,'queued-session'),null);
});
