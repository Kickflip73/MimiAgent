import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Browser module is intentionally dependency-free JavaScript.
import { historyExecution, projectEvent, finishAnswers, elapsedLabel, createTextReveal, createTextFade, presentAnswer, executionGroups, isPreparationStatus } from '../src/web/assets/execution.js';

test('stream keeps answer chunks together but separates replies around tools and reasoning', () => {
  const run: { sequence: number; answers: string[]; steps: Array<{ text?: string }>; boundary: boolean } = { sequence: 0, answers: [], steps: [], boundary: true };
  for (const event of [
    { sequence: 1, kind: 'answer', text: '我先' },
    { sequence: 2, kind: 'answer', text: '检查。' },
    { sequence: 3, kind: 'status', tone: 'tool', title: 'read', fullDetail: 'file' },
    { sequence: 4, kind: 'reasoning', text: '分析' },
    { sequence: 5, kind: 'reasoning', text: '结果' },
    { sequence: 6, kind: 'answer', text: '检查完成。' },
    { sequence: 6, kind: 'answer', text: '重复事件' },
  ]) projectEvent(run, event);
  assert.deepEqual(run.answers, ['我先检查。', '检查完成。']);
  assert.equal(run.steps.length, 2);
  assert.equal(run.steps[1]!.text, '分析结果');
  assert.deepEqual(finishAnswers(run.answers, '检查完成。'), run.answers);
  assert.deepEqual(finishAnswers(['残缺'], '完整结果'), ['完整结果']);
  assert.deepEqual(finishAnswers(['先检查。'], '已完成。', true), ['先检查。', '已完成。']);
  assert.equal(elapsedLabel(61_000), '1m 01s');
  assert.equal(elapsedLabel(-100), '0s');
});

test('elapsed time starts with seconds and adds minutes only after 60 seconds', () => {
  assert.equal(elapsedLabel(999), '0s');
  assert.equal(elapsedLabel(59_999), '59s');
  assert.equal(elapsedLabel(60_000), '1m 00s');
});


test('a restored progress snapshot deduplicates SSE replay and polling while retaining earlier reasoning',()=>{
  let run:any={id:'run',sequence:0,answers:[],steps:[],boundary:true};
  projectEvent(run,{sequence:1,kind:'answer',text:'first'});
  projectEvent(run,{sequence:2,kind:'reasoning',text:'consider'});
  run=JSON.parse(JSON.stringify(run));
  projectEvent(run,{sequence:2,kind:'reasoning',text:'duplicate'});
  projectEvent(run,{sequence:3,kind:'answer',text:'new'});
  projectEvent(run,{sequence:3,kind:'answer',text:'duplicate'});
  assert.deepEqual(run.answers,['first','new']);assert.equal(run.steps[0].text,'consider');
});

test('historical tool arguments/results and reasoning reconstruct after live buffer eviction',async()=>{
  const steps=historyExecution([{type:'reasoning',summary:[{text:'核对来源'}]},{type:'function_call',callId:'call-1',name:'read_file',arguments:'{"path":"guide.md"}'},{type:'function_call_result',callId:'call-1',output:{text:'完整结果'}}]);
  assert.equal(steps.length,2);assert.equal(steps[0].text,'核对来源');
  assert.match(steps[1].fullDetail,/guide.md/);assert.match(steps[1].fullDetail,/完整结果/);
});


test('live burst text is frame-paced, bounded and preserves graphemes; replay is immediate', () => {
  const reveal = createTextReveal();
  const answer = '猫咪🐱和家人👨‍👩‍👧‍👦一起看世界。'.repeat(20);
  let shown = reveal.update([answer], 100);
  assert.ok(shown[0].length > 0 && shown[0].length < answer.length);
  const first = shown[0];
  shown = reveal.update([answer], 132);
  assert.ok(shown[0].startsWith(first) && shown[0].length > first.length);
  assert.ok(answer.startsWith(shown[0]));
  assert.deepEqual(reveal.update([answer], 801), [answer]);
  assert.equal(reveal.pending, false);
  assert.deepEqual(reveal.update([answer, '恢复的历史'], 820, true), [answer, '恢复的历史']);
  assert.deepEqual(reveal.update(['更正后的完整结果'], 840, true), ['更正后的完整结果']);
});


test('presentation removes only the generated Host envelope and keeps outcome separate', () => {
  const envelope = 'Host 终态：outcome=partial；本轮不构成整体完成声明。\n\n原因：未核验\n\n下一步：继续核验\n\n模型草稿（仅作未验证的执行摘要）：\n已整理资料。\n\n还需核对来源。';
  assert.deepEqual(presentAnswer(envelope), {text:'已整理资料。\n\n还需核对来源。',outcome:'partial'});
  assert.deepEqual(presentAnswer(envelope.replaceAll('\n','\r\n')), presentAnswer(envelope));
  assert.equal(presentAnswer('引用：\n'+envelope).text, '引用：\n'+envelope);
  assert.equal(presentAnswer('普通回答').text, '普通回答');
  assert.deepEqual(presentAnswer('Host 终态：outcome=failed；本轮不构成整体完成声明。\n\n原因：失败'), {text:'本次执行未完成。',outcome:'failed'});
  const prose = 'Host 终态：outcome=partial；本轮不构成整体完成声明。\n这是用户提供的示例。';
  assert.equal(presentAnswer(prose).text, prose);
});

test('new ink retains its fade age across rerenders without dimming existing text', () => {
  const fade = createTextFade();
  assert.deepEqual(fade('old',0,true), []);
  assert.deepEqual(fade('old new',10), [{start:3,end:7,born:10}]);
  assert.deepEqual(fade('old new猫',40), [{start:3,end:7,born:10},{start:7,end:8,born:40}]);
  assert.deepEqual(fade('old new猫!',180), [{start:7,end:8,born:40},{start:8,end:9,born:180}]);
  assert.deepEqual(fade('old corrected',190), [{start:4,end:13,born:190}]);
  assert.deepEqual(fade('restored history',200,true), []);
});

test('burst pacing uses steady frame increments and catches up within 350ms', () => {
  const reveal = createTextReveal();
  const text = '字'.repeat(300);
  const lengths: number[] = [];
  for(let now=100;now<450;now+=16) lengths.push(reveal.update([text],now)[0].length);
  assert.ok(lengths[0]! < 30);
  assert.ok(lengths.every((n,i)=>i===0 || n>=lengths[i-1]!));
  assert.ok(Math.max(...lengths.slice(1).map((n,i)=>n-lengths[i]!))<50);
  assert.deepEqual(reveal.update([text],451),[text]);
  assert.deepEqual(reveal.update([text+'🐱'],460,true),[text+'🐱']);
});


test('execution groups retain answer boundaries after persistence and replay', () => {
  let run: any = {sequence:0,answers:[],steps:[],boundary:true};
  const events = [
    {sequence:1,kind:'reasoning',text:'before'},
    {sequence:2,kind:'answer',text:'first'},
    {sequence:3,kind:'reasoning',text:'between'},
    {sequence:4,kind:'status',tone:'tool',title:'read'},
    {sequence:5,kind:'answer',text:'second'},
    {sequence:6,kind:'reasoning',text:'after'},
  ];
  events.slice(0,4).forEach(e=>projectEvent(run,e));
  run=JSON.parse(JSON.stringify(run));
  events.slice(3).forEach(e=>projectEvent(run,e));
  assert.deepEqual(executionGroups(run).map((g:any)=>[g.afterAnswer,g.steps.map((s:any)=>s.text||s.title)]),
    [[-1,['before']],[0,['between','read']],[1,['after']]]);
  assert.deepEqual(run.answers,['first','second']);
});

test('adjacent reasoning phases separated by an answer never merge', () => {
  const run:any={sequence:0,answers:[],steps:[],boundary:true};
  [{sequence:1,kind:'reasoning',text:'initial'}, {sequence:2,kind:'answer',text:'reply'},
    {sequence:3,kind:'reasoning',text:'next'}, {sequence:4,kind:'reasoning',text:' phase'}].forEach(e=>projectEvent(run,e));
  assert.deepEqual(executionGroups(run).map((g:any)=>g.steps[0].text),['initial','next phase']);
});


test('host preparation updates the preview without creating steps, counts or reply boundaries',()=>{
  const run:any={sequence:0,answers:[],steps:[],boundary:true};
  const preparation={kind:'status',tone:'thinking',title:'正在准备上下文',next:''};
  projectEvent(run,{...preparation,sequence:1});
  assert.equal(run.activity,'正在准备上下文');assert.deepEqual(run.steps,[]);assert.deepEqual(executionGroups(run),[]);
  projectEvent(run,{kind:'answer',text:'第一段',sequence:2});
  projectEvent(run,{...preparation,transient:true,title:'后续准备阶段',sequence:3});
  projectEvent(run,{kind:'answer',text:'继续',sequence:4});
  assert.deepEqual(run.answers,['第一段继续']);assert.equal(run.activity,undefined);
  projectEvent(run,{kind:'reasoning',text:'检查上下文内容',sequence:5});
  projectEvent(run,{kind:'status',tone:'tool',title:'read_file',fullDetail:'完整参数',sequence:6});
  assert.equal(run.steps.length,2);assert.equal(executionGroups(run)[0].steps.length,2);
  // Persisted legacy notices are also excluded; actual similarly named evidence remains.
  run.steps.unshift(preparation);
  assert.equal(executionGroups(run)[0].steps.length,2);
  assert.equal(isPreparationStatus({kind:'reasoning',text:preparation.title}),false);
  assert.equal(isPreparationStatus({...preparation,fullDetail:'真实执行内容'}),false);
});
