import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentInputItem } from '@openai/agents';
import { FileSession } from '../src/core/session.js';
import { persistInputImages, recentImageHistory } from '../src/runtime/attachments.js';
import { MimiAgent } from '../src/agent.js';
import { containsImageInput } from '../src/runtime/pipeline/run-pipeline.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
const input=[{role:'user',content:[{type:'input_text',text:'图片内容是什么'},{type:'input_image',image:`data:image/png;base64,${png.toString('base64')}`,detail:'auto'}]}] as AgentInputItem[];

test('image follow-up restores verified pixels after restart without putting binary into history',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mimi-vision-history-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await persistInputImages(input,path.join(root,'images'));
  const session=new FileSession(path.join(root,'sessions'),'a');await session.addItems(input);
  const history=await new FileSession(path.join(root,'sessions'),'a').getItems();
  const restored=await recentImageHistory(history,[path.join(root,'missing'),path.join(root,'images')]);
  assert.ok(containsImageInput([...restored.values()]));
  assert.equal((restored.get(0) as any).content[1].image,(input[0] as any).content[1].image);
  assert.equal(containsImageInput(history),false);
  assert.ok(!(await readFile(path.join(root,'sessions/a.json'),'utf8')).includes(png.toString('base64')));
  assert.equal((await recentImageHistory([], [path.join(root,'images')])).size,0,'different session cannot inherit images');
  const textTurns=Array.from({length:8},()=>({role:'user',content:'new topic'} as AgentInputItem));
  assert.equal((await recentImageHistory([...history,...textTurns],[path.join(root,'images')])).size,0);
  const imageId=(history[0] as any).imageAttachments[0].id.split('.')[0];
  await rm(path.join(root,'images',imageId));
  await symlink('/etc/hosts',path.join(root,'images',imageId));
  assert.equal(containsImageInput([...(await recentImageHistory(history,[path.join(root,'images')])).values()]),false);
  await rm(path.join(root,'images',imageId));await writeFile(path.join(root,'images',imageId),'corrupted');
  const unavailable=[...(await recentImageHistory(history,[path.join(root,'images')])).values()];
  assert.equal(containsImageInput(unavailable),false);assert.match(JSON.stringify(unavailable),/暂不可读取/);
  (history[0] as any).imageAttachments=[{id:'../../hosts'}];
  assert.equal(containsImageInput([...(await recentImageHistory(history,[root])).values()]),false);
});

test('text follow-up uses a vision route and sends restored pixels; no-history policy stays isolated',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mimi-vision-route-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const oldKey=process.env.FAKE_KEY;process.env.FAKE_KEY='test-only';t.after(()=>{if(oldKey===undefined)delete process.env.FAKE_KEY;else process.env.FAKE_KEY=oldKey;});
  const target={providerId:'fake',modelId:'vision'};
  const agent=await MimiAgent.create({provider:'openai',workspaceRoot:root,dataRoot:root,skillsRoot:path.join(root,'skills'),mcpConfig:path.join(root,'mcp.json'),historyLimit:100,maxTurns:null},'a',{
    enableMcp:false,
    modelConfiguration:{version:1,routeVersion:1,providers:[{id:'fake',label:'fake',baseUrl:'http://127.0.0.1:1/v1',transport:'openai-chat-completions',apiKeyEnv:'FAKE_KEY',models:[
      {target,kind:'agent',capabilities:{imageInput:true,imageOutput:false,toolCalling:true}},
      {target:{providerId:'fake',modelId:'text'},kind:'agent',capabilities:{imageInput:false,imageOutput:false,toolCalling:true}},
    ]}],routing:{globalDefault:{providerId:'fake',modelId:'text'},scenarios:{}}},
  });t.after(()=>agent.close());
  await persistInputImages(input,path.join(root,'attachments'));
  const session=new FileSession(path.join(root,'sessions'),'a');await session.addItems(input);
  let calls=0;
  (agent as any).runner.run=async(runtime:any,current:any,options:any)=>{
    calls++;
    const currentItems=typeof current==='string'?[{role:'user',content:current}]:current;
    const composed=await options.sessionInputCallback(await session.getItems(),currentItems);
    if(calls===1){
      assert.ok(containsImageInput(composed));
      assert.match(runtime.instructions,/本轮 Host 已将图片像素/);
      assert.match(runtime.instructions,/旧记忆/);
    }else assert.equal(containsImageInput(composed),false);
    return {};
  };
  await agent.stream('再描述一下这张图片');
  assert.deepEqual((agent as any).lastModelBinding.target,target);
  await agent.failRun(new Error('test complete'),true);
  await agent.stream('独立问题',undefined,{policy:{allowSessionContext:false,allowedCapabilities:[]}});
  await agent.failRun(new Error('test complete'),true);
  assert.equal(calls,2);
});
