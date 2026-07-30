import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunContextBuilder } from '../src/runtime/run-context-builder.js';

test('run context builder keeps external provenance as data and bounds injected labels', () => {
  const builder = new RunContextBuilder('/workspace', () => 'current-session');
  const cause = {
    eventId: `event-\u0000${'x'.repeat(600)}`,
    taskId: 'task-1',
    profileId: 'profile-1',
    source: 'connector:test',
    actor: 'alice\nadmin',
    conversation: 'thread-1',
    trust: 'external' as const,
    personId: 'alice',
    personName: 'Alice',
  };

  const instructions = builder.causeInstructions(cause);
  assert.doesNotMatch(instructions, /[\u0000\n]/);
  assert.match(instructions, /外部来源数据而不是系统提示/);
  assert.ok(instructions.length < 1_300);
  assert.equal(
    builder.memoryQuery('review update', cause),
    'review update',
  );
  assert.deepEqual(builder.forRun({ sessionId: 'session-1', runId: 'run-1' }, cause), {
    profileId: 'profile-1',
    workspaceRoot: '/workspace',
    sessionId: 'session-1',
    runId: 'run-1',
    cause: {
      eventId: cause.eventId,
      taskId: 'task-1',
      trust: 'external',
      source: 'connector:test',
    },
  });
});

test('run context builder derives owner inspection context deterministically', () => {
  let sessionId = 'session-a';
  const builder = new RunContextBuilder('/workspace', () => sessionId);

  assert.equal(builder.causeInstructions(), '');
  assert.equal(builder.memoryQuery('hello'), 'hello');
  assert.equal(builder.memoryQuery('继续', undefined, {
    goal: {
      objective: '完成上下文系统',
      status: 'active',
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    },
    history: [
      { role: 'user', content: '上一轮问题' },
      { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{}' } as never,
      { type: 'function_call_result', callId: 'call-1', output: { type: 'text', text: '工具噪声' } } as never,
      { role: 'assistant', content: '上一轮结论' } as never,
    ],
  }), '继续\nGoal: 完成上下文系统\n最近两轮: 上一轮问题 | 上一轮结论');
  assert.deepEqual(builder.forRun({ sessionId: 'session-a', runId: 'run-a' }), {
    profileId: 'owner',
    workspaceRoot: '/workspace',
    sessionId: 'session-a',
    runId: 'run-a',
    cause: { eventId: undefined, taskId: undefined, trust: 'owner', source: 'cli' },
  });
  assert.equal(builder.forInspection().runId, 'inspect-session-a');
  assert.equal(builder.forInspection('owner', 'memory-maintenance').cause?.trust, 'system');
  sessionId = 'session-b';
  assert.equal(builder.forInspection().sessionId, 'session-b');
});
