import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decorateSessionTimeline } from '../src/web/session-timeline.js';

const message = (role: string, content: string) => ({ role, content });
const at = (second: number) => `2026-10-09T00:00:${String(second).padStart(2, '0')}.000Z`;
async function fixture(t: { after: (fn: () => Promise<void>) => void }, items: unknown[], events: unknown[] = []) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'mimi-timeline-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  await mkdir(path.join(dataRoot, 'sessions')); await mkdir(path.join(dataRoot, 'traces'));
  await writeFile(path.join(dataRoot, 'sessions/chat.json'), JSON.stringify({ items }));
  await writeFile(path.join(dataRoot, 'traces/chat.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  return { dataRoot, sessionId: 'chat' };
}
const event = (type: string, second: number, data: object) => ({ sessionId: 'chat', type, timestamp: at(second), data });

test('timeline restores tool details and real run times onto message-only snapshots', async (t) => {
  const items = [message('user', 'work'), { type: 'reasoning', content: [{ text: 'check the evidence' }] },
    { type: 'function_call', name: 'read_file', callId: 'c1', arguments: '{"path":"a.txt"}' },
    { type: 'function_call_result', callId: 'c1', output: 'verified' }, message('assistant', 'done')];
  const options = await fixture(t, items, [event('turn_start', 1, { input: 'work' }), event('status', 2, { tone: 'tool', title: 'read_file' }), event('turn_end', 4, { answer: 'done' })]);
  const result = await decorateSessionTimeline({ ...options, items: [items[0], items[4]] });
  assert.equal(result.items[0]!.timestamp, at(1));
  assert.equal(result.items[0]!.timestampSource, 'run-start');
  assert.equal(result.items[1]!.timestamp, at(4));
  assert.equal(result.items[1]!.duration, 3000);
  assert.equal(result.items[1]!.execution!.steps[1]!.timestamp, at(2));
  assert.match(result.items[1]!.execution!.steps[1]!.fullDetail!, /verified/);
  assert.equal(result.timeline.reasoningAvailable, true);
});

test('same user text across turns binds distinct answers and times, including a tail snapshot', async (t) => {
  const items = [message('user', 'continue'), message('assistant', 'first'), message('user', 'continue'), message('assistant', 'second')];
  const options = await fixture(t, items, [event('turn_start', 1, { input: 'continue' }), event('turn_end', 2, { answer: 'first' }), event('turn_start', 5, { input: 'continue' }), event('turn_end', 7, { answer: 'second' })]);
  const all = await decorateSessionTimeline({ ...options, items });
  assert.deepEqual(all.items.map((item) => item.timestamp), [at(1), at(2), at(5), at(7)]);
  const tail = await decorateSessionTimeline({ ...options, items: items.slice(2) });
  assert.deepEqual(tail.items.map((item) => item.timestamp), [at(5), at(7)]);
});

test('missing old trace does not invent timestamps, durations or encrypted reasoning', async (t) => {
  const items = [message('user', 'work'), { type: 'reasoning', rawContent: 'opaque secret' }, { type: 'function_call', name: 'read_file', callId: 'c', arguments: '{}' }, message('assistant', 'done')];
  const options = await fixture(t, items);
  const result = await decorateSessionTimeline({ ...options, items: [items[0], items[3]] });
  assert.equal(result.items[0]!.timestamp, undefined); assert.equal(result.items[1]!.duration, undefined);
  assert.equal(result.timeline.reasoningAvailable, false); assert.equal(result.items[1]!.execution!.durationKnown, false);
  assert.doesNotMatch(JSON.stringify(result), /opaque secret/);
});

test('persisted reasoning phases restore when SDK canonical has no text and reject other run IDs', async (t) => {
  const items = [message('user', 'work'), message('assistant', 'done')];
  const options = await fixture(t, items, [event('turn_start', 1, { input: 'work' }),
    event('model_binding_event', 1, { workUnitKind: 'conversation', workUnitId: 'run-1' }),
    event('reasoning', 2, { runId: 'other', text: 'wrong turn' }),
    event('reasoning', 3, { runId: 'run-1', text: 'persisted thought', startedAt: at(2) }), event('turn_end', 4, { answer: 'done' })]);
  const result = await decorateSessionTimeline({ ...options, items });
  assert.deepEqual(result.items[1]!.execution!.steps.map((step) => step.text), ['persisted thought']);
  assert.equal(result.items[1]!.execution!.steps[0]!.timestamp, at(2));
});

test('interrupted turn retains process on user anchor without manufacturing an assistant answer', async (t) => {
  const items = [message('user', 'work'), { type: 'function_call', name: 'run_shell', callId: 'c', arguments: '{}' }];
  const options = await fixture(t, items, [event('turn_start', 1, { input: 'work' }), event('turn_interrupted', 3, {})]);
  const result = await decorateSessionTimeline({ ...options, items: [items[0]] });
  assert.equal(result.items.length, 1); assert.equal(result.items[0]!.execution!.status, 'cancelled');
});

test('SQLite task run metadata recovers scheduled child session timing without trace', async (t) => {
  const items = [message('user', 'daily'), message('assistant', 'report')];
  const options = await fixture(t, items);
  const database = new DatabaseSync(':memory:'); t.after(async () => database.close());
  database.exec('CREATE TABLE runs(id TEXT, task_id TEXT, session_key TEXT, status TEXT, started_at TEXT, completed_at TEXT, answer_json TEXT)');
  database.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?)').run('r', 'task', 'chat', 'completed', at(1), at(9), JSON.stringify({ answer: 'report' }));
  const result = await decorateSessionTimeline({ ...options, items, database });
  assert.equal(result.items[1]!.duration, 8000); assert.equal(result.items[1]!.timelineRunId, 'r');
});

test('bounded tail skips partial JSON and records truncation without taking times from another session', async (t) => {
  const items = [message('user', 'work'), message('assistant', 'done')];
  const options = await fixture(t, items, [event('turn_start', 1, { input: 'work' }), event('status', 2, { detail: 'x'.repeat(3000) }), { ...event('turn_end', 3, { answer: 'done' }), sessionId: 'other' }]);
  const result = await decorateSessionTimeline({ ...options, items, maxTraceBytes: 1024 });
  assert.equal(result.timeline.truncated, true); assert.equal(result.items[1]!.timestamp, undefined);
  await assert.rejects(decorateSessionTimeline({ ...options, sessionId: '../outside', items }));
});


test('explicit trace run ID wins over a distinct model work-unit ID', async (t) => {
  const items = [message('user', 'work'), message('assistant', 'done')];
  const options = await fixture(t, items, [event('turn_start', 1, { input: 'work', runId: 'real-run' }),
    event('model_binding_event', 1, { workUnitKind: 'conversation', workUnitId: 'different-unit' }),
    event('reasoning', 2, { runId: 'real-run', text: 'right owner' }), event('turn_end', 3, { answer: 'done' })]);
  const result = await decorateSessionTimeline({ ...options, items });
  assert.equal(result.items[1]!.timelineRunId, 'real-run');
  assert.equal(result.items[1]!.execution!.steps[0]!.text, 'right owner');
});

test('tool projection redacts credential-shaped data without altering the canonical file', async (t) => {
  const secret = ['sk', 'TimelineCredentialFixture1234567890'].join('-');
  const items = [message('user', 'work'), { type: 'function_call', name: 'fetch', callId: 'c', arguments: '{}' },
    { type: 'function_call_result', callId: 'c', output: { apiKey: secret } }, message('assistant', 'done')];
  const options = await fixture(t, items);
  const result = await decorateSessionTimeline({ ...options, items: [items[0], items[3]] });
  assert.ok(!JSON.stringify(result).includes(secret));
});


test('unique scheduled input binds Host-wrapped final answer to canonical model output', async (t) => {
  const items = [message('user', 'daily task'), message('assistant', 'model draft')];
  const options = await fixture(t, items, [event('turn_start', 1, { input: 'daily task' }), event('turn_end', 7, { answer: 'Host partial: model draft' })]);
  const result = await decorateSessionTimeline({ ...options, items });
  assert.equal(result.items[0]!.timestamp, at(1)); assert.equal(result.items[1]!.duration, 6000);
});

for (const outcome of ['completed', 'partial', 'blocked', 'interrupted', 'failed', 'uncertain']) {
  test(`finalization preserves ${outcome} after a successful stream end`, async (t) => {
    const items = [message('user', 'work'), { type: 'function_call', name: 'read_file', callId: 'c', arguments: '{}' }, message('assistant', 'draft')];
    const options = await fixture(t, items, [event('turn_start', 1, { input: 'work', runId: 'r' }),
      event('run_finalization', 2, { runId: 'r', outcome }), event('turn_end', 3, { answer: 'draft' })]);
    const result = await decorateSessionTimeline({ ...options, items: [items[0], items[2]] });
    assert.equal(result.items[1]!.execution!.status, outcome);
    assert.equal(result.items[1]!.duration, 2000);
  });
}

test('finalization rejects another run and overrides only provisional legacy work-unit IDs', async (t) => {
  const items = [message('user', 'one'), { type: 'function_call', name: 'read_file', arguments: '{}' }, message('assistant', 'a'),
    message('user', 'two'), { type: 'function_call', name: 'read_file', arguments: '{}' }, message('assistant', 'b')];
  const options = await fixture(t, items, [event('turn_start', 1, { input: 'one', runId: 'first' }),
    event('run_finalization', 2, { runId: 'wrong', outcome: 'partial' }), event('turn_end', 3, { answer: 'a' }),
    event('turn_start', 4, { input: 'two' }), event('model_binding_event', 4, { workUnitKind: 'conversation', workUnitId: 'unit' }),
    event('run_finalization', 5, { runId: 'second', outcome: 'partial' }), event('turn_end', 6, { answer: 'b' })]);
  const result = await decorateSessionTimeline({ ...options, items: items.filter((item) => 'role' in item) });
  assert.equal(result.items[1]!.execution!.status, 'completed');
  assert.equal(result.items[3]!.execution!.status, 'partial');
  assert.equal(result.items[3]!.timelineRunId, 'second');
});


test('history places tools between the replies that surrounded them, including a tail snapshot', async (t) => {
  const items = [message('user','work'), {type:'reasoning',content:[{text:'initial'}]},
    message('assistant','checking'), {type:'function_call',name:'read_file',callId:'c',arguments:'{}'},
    {type:'function_call_result',callId:'c',output:'data'}, message('assistant','done'),
    {type:'reasoning',content:[{text:'follow-up'}]}];
  const options = await fixture(t,items);
  const result = await decorateSessionTimeline({...options,items:items.filter(i=>'role' in i)});
  assert.deepEqual(result.items[1]!.execution!.steps.map(s=>s.text),['initial']);
  assert.equal(result.items[1]!.executionAfter!.steps[0]!.title,'read_file');
  assert.match(result.items[1]!.executionAfter!.steps[0]!.fullDetail!,/data/);
  assert.deepEqual(result.items[2]!.executionAfter!.steps.map(s=>s.text),['follow-up']);
  const tail = await decorateSessionTimeline({...options,items:[items[5]]});
  assert.ok(tail.items[0]!.execution!.steps.some(s=>s.title==='read_file'));
});


test('persisted reply positions restore trace-only thinking between multiple answers', async (t) => {
  const items=[message('user','work'),message('assistant','first'),message('assistant','second')];
  const options=await fixture(t,items,[event('turn_start',1,{input:'work',runId:'r'}),
    event('reasoning',2,{runId:'r',text:'initial',afterAnswer:-1}),
    event('reasoning',4,{runId:'r',text:'between',afterAnswer:0}),event('turn_end',6,{answer:'second'})]);
  const result=await decorateSessionTimeline({...options,items});
  assert.equal(result.items[1]!.execution!.steps[0]!.text,'initial');
  assert.equal(result.items[1]!.executionAfter!.steps[0]!.text,'between');
  assert.equal(result.items[2]!.execution,undefined);
});
