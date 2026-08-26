import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MimiLiveEvents,
  mimiRuntimeStreamEvent,
  mimiStreamEvent,
  mimiStreamTaskState,
} from '../src/daemon/live-events.js';
import type { TaskRecord } from '../src/daemon/types.js';

test('live event adapters preserve bounded model, tool, reasoning, and plan semantics', () => {
  assert.deepEqual(mimiStreamEvent({
    type: 'agent_updated_stream_event',
    agent: { name: 'Worker' },
  } as never), {
    kind: 'status',
    tone: 'agent',
    title: 'Worker',
    next: 'Agent 工作中',
  });
  assert.deepEqual(mimiStreamEvent({
    type: 'run_item_stream_event',
    name: 'tool_called',
    item: { rawItem: { name: 'read_file', arguments: { path: 'a.ts' } } },
  } as never), {
    kind: 'status',
    tone: 'tool',
    title: 'read_file',
    detail: '{"path":"a.ts"}',
    fullDetail: '{\n  "path": "a.ts"\n}',
    next: '正在执行 read_file',
  });
  const output = mimiStreamEvent({
    type: 'run_item_stream_event',
    name: 'tool_output',
    item: { rawItem: { name: 'run_team' }, output: { ok: true } },
  } as never);
  assert.equal(output?.kind, 'status');
  assert.equal(output && 'title' in output ? output.title : undefined, 'Ultra Team');
  assert.equal(mimiStreamEvent({
    type: 'run_item_stream_event',
    name: 'reasoning_item_created',
    item: {},
  } as never), undefined);
  assert.equal(mimiStreamEvent({
    type: 'run_item_stream_event',
    name: 'unknown',
    item: {},
  } as never), undefined);
  assert.deepEqual(mimiStreamEvent({
    type: 'raw_model_stream_event',
    data: { type: 'output_text_delta', delta: 'answer' },
  } as never), { kind: 'answer', text: 'answer' });
  assert.deepEqual(mimiStreamEvent({
    type: 'raw_model_stream_event',
    data: { type: 'model', event: { choices: [{ delta: { reasoning_content: 'think' } }] } },
  } as never), { kind: 'reasoning', text: 'think' });
  assert.deepEqual(mimiStreamEvent({
    type: 'raw_model_stream_event',
    data: {
      type: 'model',
      event: { type: 'response.reasoning_summary_text.delta', delta: 'summary' },
    },
  } as never), { kind: 'reasoning', text: 'summary' });
  assert.equal(mimiStreamEvent({ type: 'raw_model_stream_event', data: { type: 'model', event: {} } } as never), undefined);
  assert.equal(mimiRuntimeStreamEvent({ type: 'run_started' } as never), undefined);
  assert.deepEqual(mimiRuntimeStreamEvent({
    type: 'plan_updated',
    sessionId: 'session',
    steps: [{ id: 'step', description: 'work', status: 'running' }],
  }), {
    kind: 'plan',
    steps: [{ id: 'step', description: 'work', status: 'running' }],
  });
});

test('live event storage enforces event, run, page, and byte bounds', () => {
  const events = new MimiLiveEvents(2, 2);
  events.publish('first', { kind: 'answer', text: 'a' });
  events.publish('first', { kind: 'answer', text: 'b' });
  events.publish('first', { kind: 'answer', text: 'c' });
  assert.deepEqual(events.recent('first', 100).map((event) => event.kind === 'answer' ? event.text : ''), ['b', 'c']);
  const firstPage = events.page('first', 0, 4 * 1024, 1);
  assert.equal(firstPage.events.length, 1);
  assert.equal(firstPage.hasMore, true);
  const secondPage = events.page('first', firstPage.nextSequence);
  assert.equal(secondPage.events.length, 1);
  assert.equal(secondPage.hasMore, false);
  assert.equal(events.after('missing', 0).length, 0);

  events.publish('second', {
    kind: 'status',
    tone: 'tool',
    title: 'x'.repeat(2_000),
    detail: 'y'.repeat(10_000),
    fullDetail: 'z'.repeat(40_000),
    next: 'next'.repeat(1_000),
  });
  events.publish('third', { kind: 'reasoning', text: 'r' });
  assert.equal(events.recent('first').length, 0);
  const bounded = events.recent('second')[0];
  assert.ok(bounded && bounded.kind === 'status');
  assert.ok(bounded.title.length <= 1_024);
  assert.ok((bounded.detail?.length ?? 0) <= 4_096);

  const oversized = new MimiLiveEvents();
  oversized.publish('large', { kind: 'answer', text: '😀'.repeat(20_000) });
  const page = oversized.page('large', 0, 4 * 1024, 10);
  assert.equal(page.events[0]?.kind, 'status');
  assert.equal(page.events[0] && 'tone' in page.events[0] ? page.events[0].tone : undefined, 'failure');
});

test('stream task state bounds answer, effects and errors without inventing data', () => {
  assert.equal(mimiStreamTaskState(undefined), undefined);
  const now = new Date().toISOString();
  const base: TaskRecord = {
    id: 'task',
    type: 'background',
    idempotencyKey: 'task',
    authorityEventId: 'event',
    profileId: 'owner',
    objective: {},
    executor: 'isolated_worker',
    workspaceAccess: 'write',
    priority: 50,
    status: 'completed',
    notBefore: now,
    attemptCount: 1,
    maxAttempts: 1,
    createdAt: now,
    updatedAt: now,
  };
  const state = mimiStreamTaskState({
    ...base,
    result: { answer: 'ok', effects: { changed: true }, ignored: 'private' },
    error: 'x'.repeat(20_000),
  });
  assert.deepEqual(state?.result, { answer: 'ok', effects: { changed: true } });
  assert.ok((state?.error?.length ?? 0) < 20_000);

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const unsafe = mimiStreamTaskState({ ...base, result: { effects: circular } });
  assert.deepEqual(unsafe?.result, {
    effects: { invalid: 'RuntimeEffect payload is not serializable' },
  });
});
