import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.js';
import { SoulLoader } from '../src/core/guidance.js';
import { savePrompt, webManagement } from '../src/web/management.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-web-management-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { dataRoot: root, workspaceRoot: root, mcpConfig: path.join(root,'mcp.json'), modelsConfig: path.join(root,'models.json') } as AppConfig;
  const calls: unknown[][] = [];
  const manage = webManagement(config, async (...args) => { calls.push(args); return []; }, async (...args) => { calls.push(args); return { id:'new-schedule' }; });
  return {root,config,calls,manage};
}
test('prompt edits are atomic, reject stale revisions and never follow symlink targets', async t => {
  const {root} = await fixture(t), file = path.join(root,'PREFERENCES.md');
  await savePrompt(file,'original',hash(''));
  await savePrompt(file,'updated',hash('original'));
  await assert.rejects(savePrompt(file,'lost update',hash('original')), /已在其他地方修改/);
  assert.equal((await new SoulLoader(file).load()).files[0]!.content, 'updated');
  await symlink(file,path.join(root,'linked.md'));
  await assert.rejects(savePrompt(path.join(root,'linked.md'),'bad',hash('updated')), /普通配置文件/);
  assert.equal(await readFile(file,'utf8'),'updated');
});
test('MCP management masks secrets, preserves placeholders and rejects stale or invalid configs', async t => {
  const {config,manage} = await fixture(t);
  await writeFile(config.mcpConfig,JSON.stringify({mcpServers:{demo:{command:'node',env:{TOKEN:'do-not-expose'},enabled:true}}}));
  const value = await manage.read('mcp','s') as {config: {mcpServers: {demo: {command:string;enabled:boolean;env:{TOKEN:string}}}};revision:string};
  assert.equal(JSON.stringify(value).includes('do-not-expose'),false);
  value.config.mcpServers.demo.enabled=false;
  await manage.write('mcp.save','s',{config:value.config,revision:value.revision});
  const saved=JSON.parse(await readFile(config.mcpConfig,'utf8'));
  assert.equal(saved.mcpServers.demo.env.TOKEN,'do-not-expose');
  assert.equal(saved.mcpServers.demo.enabled,false);
  await assert.rejects(manage.write('mcp.save','s',{config:value.config,revision:value.revision}),/配置已变化/);
  const latest=await manage.read('mcp','s') as typeof value;
  latest.config.mcpServers.demo.command='';
  await assert.rejects(manage.write('mcp.save','s',{config:latest.config,revision:latest.revision}),/demo/);
  assert.equal(JSON.parse(await readFile(config.mcpConfig,'utf8')).mcpServers.demo.command,'node');
});
test('management uses an explicit action allowlist and validates scheduling and defaults',async t=>{
  const {manage,calls}=await fixture(t);
  await assert.rejects(manage.write('shutdown','s',{}),/未知管理操作/);
  await assert.rejects(manage.write('settings.save','s',{mode:'root'}));
  await manage.write('settings.save','s',{mode:'plan',outputLevel:'thinking',expandExecution:true});
  assert.equal((await manage.read('settings','s') as {mode:string}).mode,'plan');
  await manage.write('skills.set','s',{name:'review',scope:'project',enabled:false});
  assert.deepEqual(calls.at(-1),['skills.set',{name:'review',scope:'project',enabled:false},'s']);
  await assert.rejects(manage.write('schedule.add','s',{name:'test',prompt:'test',type:'at',at:'2000-01-01'}),/未来时间/);
  await manage.write('schedule.add','s',{name:'test',prompt:'test',type:'interval',minutes:30});
  assert.equal(calls.at(-1)![0],'schedules.add');
  assert.equal((calls.at(-1)![1] as {value:string}).value,'1800000');
  await assert.rejects(manage.write('runtime.save','s',{id:'../../anything',revision:hash(''),content:'bad'}),/未知提示词文件/);
});
test('model edits validate registered routes and persist using the shared model store',async t=>{
  const {manage,config}=await fixture(t);
  const target={providerId:'test',modelId:'one'};
  await writeFile(config.modelsConfig!,JSON.stringify({version:1,routeVersion:1,providers:[{id:'test',label:'Test',transport:'openai-responses',apiKeyEnv:'TEST_TOKEN',models:[{target,kind:'agent',capabilities:{toolCalling:true,imageInput:false,imageOutput:false}}]}],routing:{globalDefault:target,scenarios:{}}}));
  const value=await manage.read('models','s') as {config:{providers:unknown[]};revision:string};
  const invalid=structuredClone(value);invalid.config.providers=[];
  await assert.rejects(manage.write('models.save','s',invalid));
  await manage.write('models.save','s',{config:value.config,revision:value.revision});
  assert.equal(JSON.parse(await readFile(config.modelsConfig!,'utf8')).routeVersion,2);
  await assert.rejects(manage.write('models.save','s',{config:value.config,revision:value.revision}),/配置已变化/);
});

test('Web cron validation and preview use the same daemon scheduling rules',async t=>{
  const {manage,calls}=await fixture(t);
  const preview=await manage.write('schedule.preview','s',{cron:'*/15 * * * *'}) as {times:string[]};
  assert.equal(preview.times.length,3);
  for(const time of preview.times)assert.equal(new Date(time).getMinutes()%15,0);
  await assert.rejects(manage.write('schedule.add','s',{name:'bad',prompt:'test',type:'cron',cron:'0 60 * * *'}),/cron/);
  await manage.write('schedule.add','s',{name:'test',prompt:'test',type:'cron',cron:'0 9 * * 1-5'});
  assert.equal((calls.at(-1)![1] as {type:string}).type,'cron');
  assert.equal((calls.at(-1)![1] as {value:string}).value,'0 9 * * 1-5');
});
test('Skill browser traverses nested files and pages UTF-8 without allowing escapes or special files',async t=>{
  const {root}=await fixture(t);
  const {mkdir}=await import('node:fs/promises');
  const {skillResource}=await import('../src/web/skill-files.js');
  const directory=path.join(root,'skill');await mkdir(path.join(directory,'references'),{recursive:true});
  const source='技能内容\n'.repeat(30000);
  await writeFile(path.join(directory,'SKILL.md'),'# Skill');
  await writeFile(path.join(directory,'references','large.md'),source);
  const tree=await skillResource({root:directory});assert.equal(tree.kind,'directory');
  if(tree.kind==='directory')assert.equal(tree.entries[0]!.directory,true);
  let offset=0,content='';
  do{const page=await skillResource({root:directory},'references/large.md',offset);assert.equal(page.kind,'file');if(page.kind!=='file')break;content+=page.content;offset=page.nextOffset??0;}while(offset);
  assert.equal(content,source);
  await writeFile(path.join(root,'outside'),'private');await symlink(path.join(root,'outside'),path.join(directory,'escape'));
  await assert.rejects(skillResource({root:directory},'../outside'),/目录内/);
  await assert.rejects(skillResource({root:directory},'escape'),/目录之外/);
});
