import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Browser module is intentionally dependency-free JavaScript.
import { historyExecution, projectEvent, finishAnswers, elapsedLabel, createTextReveal } from '../src/web/assets/execution.js';

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
