import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Usage, type AgentInputItem } from '@openai/agents';
import { MimiAgent } from '../src/runtime/mimi-agent.js';
import { FileSession } from '../src/core/session.js';
import { MediaUnderstandingRuntime } from '../src/runtime/media-understanding.js';
import { ModelGateway } from '../src/runtime/model-gateway.js';
import { WorkUnitModelResolver } from '../src/runtime/work-unit-model-resolver.js';
// @ts-expect-error Browser module is intentionally dependency-free JavaScript.
import { runningActivity } from '../src/web/assets/execution.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
const pixels=[{role:'user',content:[{type:'input_text',text:'图片是什么'},{type:'input_image',image:`data:image/png;base64,${png.toString('base64')}`,detail:'auto'}]}] as AgentInputItem[];

test('real SDK separates vision from a pinned text model and preserves canonical media through restart',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mimi-perception-sdk-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const oldFetch=globalThis.fetch,oldKey=process.env.MIMI_TEST_MEDIA;process.env.MIMI_TEST_MEDIA='fixture';
  t.after(()=>{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.MIMI_TEST_MEDIA;else process.env.MIMI_TEST_MEDIA=oldKey;});
  const requests:any[]=[];
  globalThis.fetch=async (_url,init)=>{
    const body=JSON.parse(String(init?.body));requests.push(body);
    if(!body.stream) return new Response(JSON.stringify({id:'vision',object:'chat.completion',created:1,model:'vision',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'图片中有数字 7319 和三个红色圆形。'}}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}),{headers:{'content-type':'application/json'}});
    const chunk=(delta:unknown,finish:string|null)=>`data: ${JSON.stringify({id:'main',object:'chat.completion.chunk',created:1,model:'text',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`;
    return new Response(chunk({role:'assistant',content:'图片里是 7319 和三个圆形。'},null)+chunk({},'stop')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  };
  const target={providerId:'fixture',modelId:'text'};
  const agent=await MimiAgent.create({provider:'openai-compatible',workspaceRoot:root,dataRoot:root,skillsRoot:path.join(root,'skills'),mcpConfig:path.join(root,'mcp.json'),historyLimit:30,maxTurns:4},'a',{
    enableMcp:false,modelConfiguration:{version:1,routeVersion:1,providers:[{id:'fixture',label:'fixture',transport:'openai-chat-completions',baseUrl:'http://fixture.invalid/v1',apiKeyEnv:'MIMI_TEST_MEDIA',models:['text','vision'].map(modelId=>({target:{providerId:'fixture',modelId},kind:'agent' as const,capabilities:{imageInput:modelId==='vision',imageOutput:false,toolCalling:modelId==='text'}}))}],routing:{globalDefault:target,scenarios:{}}},
  });t.after(()=>agent.close());
  const session=new FileSession(path.join(root,'sessions'),'a');await session.setPreferences({modelTarget:target});
  const input=structuredClone(pixels) as any[];
  input[0].mediaAttachments=[{kind:'audio',id:'a'.repeat(64)+'.wav',mediaType:'audio/wav',bytes:48,transcript:'图片是什么',duration:2}];input[0].displayText='图片是什么';
  const run=await agent.stream(input);
  for await(const _ of run){} await run.completed;
  await agent.completeRun('图片里是 7319 和三个圆形。');
  assert.equal(requests.length,2);assert.equal(requests[0].model,'vision');assert.equal(requests[1].model,'text');
  assert.match(JSON.stringify(requests[0]),/image_url/);assert.doesNotMatch(JSON.stringify(requests[1]),/data:image/);
  assert.match(JSON.stringify(requests[1]),/7319/);
  const history=await new FileSession(path.join(root,'sessions'),'a').getItems();const users=history.filter((i:any)=>i.role==='user') as any[];
  assert.equal(users.length,1);assert.equal(users[0].imageAttachments.length,1);assert.equal(users[0].mediaAttachments[0].transcript,'图片是什么');assert.ok(users[0].timestamp);
  assert.doesNotMatch(JSON.stringify(history),/data:image/);assert.deepEqual((await session.getPreferences()).modelTarget,target);
});

test('perception cache reuses immutable pixels and cancellation is enforced even when a provider ignores it',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'mimi-perception-'));t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
  const gateway={createPerceptionRuntime:()=>({model:{getResponse:async()=>{calls++;return {usage:new Usage(),output:[{content:[{type:'output_text',text:'observed'}]}]};}}})} as unknown as ModelGateway;
  const resolver={resolve:()=>({target:{providerId:'f',modelId:'v'}})} as unknown as WorkUnitModelResolver;
  const runtime=new MediaUnderstandingRuntime(gateway,resolver,root,1);
  await runtime.understand(pixels,'describe');await runtime.understand(pixels,'describe');assert.equal(calls,1);
  const controller=new AbortController();
  const stalled={createPerceptionRuntime:()=>({model:{getResponse:()=>{controller.abort(new Error('stop'));return new Promise(()=>{});}}})} as unknown as ModelGateway;
  await assert.rejects(new MediaUnderstandingRuntime(stalled,resolver,root,1).understand(pixels,'different',controller.signal),/stop/);
});

test('collapsed activity keeps the step prefix stable and changes only when the current step changes',()=>{
  assert.equal(runningActivity([]),'正在准备回答');
  assert.equal(runningActivity([{kind:'status',tone:'tool',title:'read_file',detail:'{"path":"run-pipeline.ts"}'}]),'read_file run-pipeline.ts');
  const text='先检查项目的配置与依赖。'+ '完整思考内容。'.repeat(60);
  const steps:any[]=[{kind:'reasoning',text}];
  const prefix=runningActivity(steps);
  assert.ok(prefix.startsWith('✦ 思考 先检查项目的配置与依赖。'));assert.ok(prefix.endsWith('…'));
  steps[0].text+='追加的推理尾部，不应替换开头。';
  assert.equal(runningActivity(steps),prefix);
  const argumentsText=JSON.stringify({command:'npm run check '+ 'x'.repeat(350)});
  steps.push({kind:'status',tone:'tool',title:'run_shell',detail:argumentsText.slice(0,160),fullDetail:argumentsText});
  assert.ok(runningActivity(steps).startsWith('run_shell npm run check '));assert.ok(runningActivity(steps).endsWith('…'));
  assert.equal(steps[0].text,text+'追加的推理尾部，不应替换开头。');assert.equal(steps[1].fullDetail,argumentsText);
  steps.push({kind:'reasoning',text:'现在核对检查结果。'});
  assert.equal(runningActivity(steps),'✦ 思考 现在核对检查结果。');
});
