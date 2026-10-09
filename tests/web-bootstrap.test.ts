import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,readdir,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.js';
import { daemonWebBackend } from '../src/web/backend.js';

test('draft bootstrap and model catalog never queue behind daemon execution or migrate newer sessions',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mimi-web-bootstrap-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const target={providerId:'test',modelId:'one'},modelsConfig=path.join(root,'models.json');
  await writeFile(modelsConfig,JSON.stringify({version:1,routeVersion:1,providers:[{id:'test',label:'Test',transport:'openai-responses',apiKeyEnv:'TEST_TOKEN',models:[{target,kind:'agent',capabilities:{toolCalling:true,imageInput:false,imageOutput:false},contextWindow:64000}]}],routing:{globalDefault:target,scenarios:{}}}));
  await mkdir(path.join(root,'sessions'));
  const source=JSON.stringify({id:'newer-session',futureSchema:42,checkpoint:{newerRuntime:'opaque'},preferences:{modelTarget:target}});
  await writeFile(path.join(root,'sessions','newer-session.json'),source);
  // No IPC server exists. A queued bootstrap/invoke would fail rather than pass this check.
  const backend=daemonWebBackend({workspaceRoot:root,dataRoot:root,daemonDataRoot:root,modelsConfig} as AppConfig, { homeDirectory: root });
  const draft=await backend.session('draft',true) as {draft:boolean;contextWindow:number;items:unknown[];workspaceRoot:string};
  assert.equal(draft.workspaceRoot,path.join(root,'Mimi','WorkSpace','default'));assert.equal(draft.draft,true);assert.equal(draft.contextWindow,64000);assert.deepEqual(draft.items,[]);
  const catalog=await backend.models('newer-session') as {choices:unknown[];current:{sessionTarget:unknown}};
  assert.equal(catalog.choices.length,1);assert.deepEqual(catalog.current.sessionTarget,target);
  assert.equal(await readFile(path.join(root,'sessions','newer-session.json'),'utf8'),source);
  assert.deepEqual(await readdir(path.join(root,'sessions')),['newer-session.json']);
});
