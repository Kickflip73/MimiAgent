import assert from 'node:assert/strict';
import test from 'node:test';
import { Usage, type AgentInputItem, type Model } from '@openai/agents';
import { ContextManager, ContextProtocolBudgetError, estimateTokens } from '../src/core/context.js';
import { ModelContextSemanticSummarizer } from '../src/runtime/context-semantic-summarizer.js';

const data = `data:image/png;base64,${'Ab9/'.repeat(1_300_000)}`;
const image = { type: 'input_image', image: data, detail: 'auto' };
const message = (content: unknown[]): AgentInputItem => ({role:'user',content} as AgentInputItem);

test('image transport bytes do not count as text tokens or mutate native input', () => {
  const small = message([{...image,image:'data:image/png;base64,AA=='}]);
  const large = message([{type:'input_text',text:'请检查这张图片'},image]);
  const tokens = estimateTokens([large]);
  assert.ok(tokens < 20_000, `binary image inflated token estimate: ${tokens}`);
  assert.ok(tokens > 0);
  assert.ok(Math.abs(tokens-estimateTokens([small])) < 100);
  const view = new ContextManager().modelContextView([large], '检查图像', 100_000);
  assert.deepEqual(view.input,[large]);
  assert.equal((view.input[0] as any).content[1].image,data);
  assert.deepEqual(view.records,[]);
});

test('all native image sources have nonzero vision cost; ordinary text is still fully budgeted', () => {
  const inline=estimateTokens(message([image]));
  assert.ok(Math.abs(inline-estimateTokens(message([{...image,image:'https://example.com/photo.png'}])))<100);
  assert.ok(Math.abs(inline-estimateTokens(message([{...image,image:{id:'file-123'}}])))<100);
  assert.ok(estimateTokens(message([image,image])) > inline*1.8);
  assert.ok(estimateTokens([{type:'function_call_result',callId:'c',output:[{type:'image',image:data}]}]) < 20_000);
  assert.ok(estimateTokens(message([{type:'input_text',text:data}])) > 1_000_000);
  assert.throws(()=>new ContextManager().modelContextView([message([{type:'input_text',text:'x'.repeat(500_000)}])], '', 100_000),ContextProtocolBudgetError);
  assert.throws(()=>new ContextManager().modelContextView([message(Array(40).fill(image))], '', 100_000),ContextProtocolBudgetError);
});

test('text-only semantic summaries omit binary image transport while retaining surrounding facts', async () => {
  const snapshot={goal:[],progress:[],completed:[],decisions:[],constraints:[],openQuestions:[],evidence:[],keyFacts:[],references:[]};
  const input=[message([{type:'input_text',text:'约束：不要重做已经执行的操作'},image]),{role:'assistant',content:'画面存在一个红框；还没有修改项目。'}] as AgentInputItem[];
  const model={getResponse:async(request:any)=>{
    const text=request.input[0].content;
    assert.ok(text.length<2000, `summary contained binary (${text.length} chars)`);
    assert.ok(!text.includes('Ab9/'));
    assert.match(text,/不要重做已经执行的操作/);assert.match(text,/还没有修改项目/);assert.match(text,/图片/);
    return {usage:new Usage({requests:1}),output:[{content:[{type:'output_text',text:JSON.stringify(snapshot)}]}]};
  }} as unknown as Model;
  await new ModelContextSemanticSummarizer(model).summarize({input,seed:{},maxSnapshotTokens:3000});
  assert.equal((input[0] as any).content[1].image,data);
});

test('large image alone does not start semantic compression before the vision model call', async t => {
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const path=await import('node:path');
  const {MimiAgent}=await import('../src/agent.js');
  const root=await mkdtemp(path.join(tmpdir(),'mimi-image-budget-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const {MediaUnderstandingRuntime}=await import('../src/runtime/media-understanding.js');
  t.mock.method(MediaUnderstandingRuntime.prototype,'understand',async()=>({text:'图片包含一个红框',model:'fixture/vision',images:1}));
  let summaries=0;
  const agent=await MimiAgent.create({provider:'openai',defaultModel:'gpt-5.6',workspaceRoot:root,dataRoot:path.join(root,'state'),skillsRoot:path.join(root,'skills'),mcpConfig:path.join(root,'mcp.json'),contextWindow:1_048_576,historyLimit:100,maxTurns:null},'large-image',{
    contextSemanticSummarizer:{summarize:async()=>{summaries++;throw new Error('Image transport must not trigger a text summary');}},
  });t.after(()=>agent.close());
  const current=message([{type:'input_text',text:'只描述画面，不执行其他任务'},image]);
  const history=[{role:'user',content:'历史约束：不执行任何操作'},{role:'assistant',content:'已记住。'},current] as AgentInputItem[];
  const host=agent as unknown as {runner:{run:(...args:any[])=>Promise<unknown>}};
  host.runner.run=async(_runtime,_input,options)=>{
    const result=await options.callModelInputFilter({modelData:{input:history,instructions:'只读图片描述'}});
    assert.ok(!result.input.some((item:any)=>item.content?.some?.((block:any)=>block.image===data)));
    assert.match(JSON.stringify(result.input),/图片包含一个红框/);
    return {};
  };
  await agent.stream([current]);await agent.failRun(new Error('test complete'),true);
  assert.equal(summaries,0);
});
