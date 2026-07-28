import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext, tool, type MCPServer } from '@openai/agents';
import { z } from 'zod';
import { ExecutionLedger } from '../src/core/execution-ledger.js';
import {
  ACTION_INTENT_SCHEMA_VERSION,
  actionExecutionKey,
  actionPayloadDigest,
  ActionFailedSafeError,
  ActionIntentUncertainError,
  evaluateActionAuthorization,
  type ActionIntent,
  type ActionIntentV2,
} from '../src/core/action-intent.js';
import { TOOL_ACTION_INTENT } from '../src/core/tool-metadata.js';
import { withExecutionLedger } from '../src/runtime/tool-ledger.js';
import { withMcpExecutionLedger } from '../src/runtime/mcp-ledger.js';

function call(runId = 'run-a', argumentsJson = '{"path":"a.txt"}') {
  return {
    sessionId: 'demo',
    runId,
    toolName: 'write_file',
    callId: 'call-1',
    argumentsJson,
  };
}

function actionIntent(
  route: string,
  overrides: Partial<ActionIntentV2> = {},
): ActionIntentV2 {
  const payloadDigest = actionPayloadDigest({ text: 'bounded fixture' });
  const policyRevision = 'guarded:v1';
  const base = {
    schemaVersion: ACTION_INTENT_SCHEMA_VERSION,
    intentId: `intent-${route}`,
    businessActionRef: 'event:fixture:send:1',
    actionFamily: 'personal-message.send',
    targetRef: 'daxiang:account:conversation',
    payloadDigest,
    selectedRoute: route,
    executionKey: '',
    policyRevision,
    status: 'not_started',
    ...overrides,
  } as ActionIntentV2;
  return {
    ...base,
    executionKey: overrides.executionKey ?? actionExecutionKey(
      base.actionFamily,
      base.targetRef,
      base.payloadDigest,
      base.policyRevision,
      base.businessActionRef,
    ),
  };
}

test('replays a successful local side effect instead of executing it twice', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-ledger-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  const operation = async () => ({ value: ++executions });

  const [first, replay] = await Promise.all([
    ledger.executeOnce(call(), operation),
    ledger.executeOnce(call(), operation),
  ]);
  const laterReplay = await new ExecutionLedger(path.join(root, 'ledger.json')).executeOnce(call(), operation);

  assert.deepEqual(first, { value: 1 });
  assert.deepEqual(replay, first);
  assert.deepEqual(laterReplay, first);
  assert.equal(executions, 1);
});

test('ActionIntent fences the same business action across Tool, Provider and route', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-action-intent-'));
  const file = path.join(root, 'ledger.json');
  const firstLedger = new ExecutionLedger(file);
  let executions = 0;
  const context = {
    ownerAuthenticated: true,
    exactTarget: true,
    lowRisk: true,
    reversible: true,
  };
  const first = await firstLedger.executeActionIntent(
    'owner',
    'event:action',
    actionIntent('connector'),
    context,
    undefined,
    async () => ({ executions: ++executions, provider: 'openai' }),
  );
  const replay = await new ExecutionLedger(file).executeActionIntent(
    'owner',
    'event:action:provider-fallback',
    actionIntent('computer', { intentId: 'fallback-intent' }),
    context,
    undefined,
    async () => ({ executions: ++executions, provider: 'deepseek' }),
  );
  assert.equal(first.outcome, 'confirmed');
  assert.deepEqual(replay, first);
  assert.equal(executions, 1);
});

test('different business action references execute identical payloads independently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-action-business-ref-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  const context = {
    ownerAuthenticated: true,
    exactTarget: true,
    lowRisk: true,
    reversible: true,
  };
  let executions = 0;
  const first = {
    ...actionIntent('connector'),
    businessActionRef: 'event:first:send:1',
  };
  first.executionKey = actionExecutionKey(
    first.actionFamily, first.targetRef, first.payloadDigest, first.policyRevision, first.businessActionRef,
  );
  const second = {
    ...actionIntent('connector', { intentId: 'intent-second-event' }),
    businessActionRef: 'event:second:send:1',
  };
  second.executionKey = actionExecutionKey(
    second.actionFamily, second.targetRef, second.payloadDigest, second.policyRevision, second.businessActionRef,
  );

  await ledger.executeActionIntent(
    'owner', 'event:first', first, context, undefined, async () => ++executions,
  );
  await ledger.executeActionIntent(
    'owner', 'event:second', second, context, undefined, async () => ++executions,
  );

  assert.equal(executions, 2);
});

test('ActionIntent permits route change only after failed_safe and fences uncertain', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-action-intent-state-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  const context = {
    ownerAuthenticated: true,
    exactTarget: true,
    lowRisk: true,
    reversible: true,
  };
  let executions = 0;
  const safeFailure = await ledger.executeActionIntent(
    'owner',
    'event:safe',
    actionIntent('connector'),
    context,
    undefined,
    async () => {
      executions += 1;
      throw new ActionFailedSafeError('request was rejected before dispatch');
    },
  );
  assert.equal(safeFailure.outcome, 'failed_safe');
  await assert.rejects(
    ledger.executeActionIntent(
      'owner',
      'event:safe',
      actionIntent('connector'),
      context,
      undefined,
      async () => ++executions,
    ),
    /必须选择不同执行路径/,
  );
  const recovered = await ledger.executeActionIntent(
    'owner',
    'event:safe',
    actionIntent('computer', { intentId: 'intent-recovery' }),
    context,
    undefined,
    async () => ({ executions: ++executions }),
  );
  assert.equal(recovered.outcome, 'confirmed');
  assert.equal(recovered.attempts, 2);

  const uncertainIntent = actionIntent('connector', {
    intentId: 'uncertain',
    targetRef: 'qq:account:other',
  });
  uncertainIntent.executionKey = actionExecutionKey(
    uncertainIntent.actionFamily,
    uncertainIntent.targetRef,
    uncertainIntent.payloadDigest,
    uncertainIntent.policyRevision,
    uncertainIntent.businessActionRef,
  );
  await assert.rejects(
    ledger.executeActionIntent(
      'owner',
      'event:uncertain',
      uncertainIntent,
      context,
      undefined,
      async () => { executions += 1; throw new Error('connection ended after dispatch'); },
    ),
    ActionIntentUncertainError,
  );
  await assert.rejects(
    ledger.executeActionIntent(
      'owner',
      'event:uncertain',
      { ...uncertainIntent, selectedRoute: 'computer', intentId: 'uncertain-fallback' },
      context,
      undefined,
      async () => ++executions,
    ),
    /禁止换路或自动重放/,
  );
  assert.equal(executions, 3);
});

test('Security owner authorization requires an exact target and ignores legacy one-time grants', () => {
  const intent = actionIntent('computer');
  assert.deepEqual(evaluateActionAuthorization(intent, {
    ownerAuthenticated: true,
    exactTarget: true,
    lowRisk: true,
    reversible: true,
  }), { allowed: true, source: 'guarded-owner-fast-path' });
  assert.deepEqual(evaluateActionAuthorization(intent, {
    ownerAuthenticated: true,
    exactTarget: true,
    lowRisk: true,
    reversible: false,
  }), { allowed: true, source: 'guarded-owner-fast-path' });
  assert.deepEqual(evaluateActionAuthorization(intent, {
    ownerAuthenticated: true,
    exactTarget: true,
    lowRisk: false,
    reversible: false,
    boundedLocal: true,
  }), { allowed: true, source: 'guarded-owner-fast-path' });
  assert.equal(evaluateActionAuthorization(intent, {
    ownerAuthenticated: false,
    exactTarget: true,
    lowRisk: false,
    reversible: false,
    boundedLocal: true,
  }).allowed, false);

  const authorization = {
    schemaVersion: 1 as const,
    authorizationId: 'authorization-1',
    intentId: intent.intentId,
    targetRef: intent.targetRef,
    payloadDigest: intent.payloadDigest,
    policyRevision: intent.policyRevision,
    expiresAt: '2026-07-28T00:00:00.000Z',
    maxUses: 1 as const,
  };
  assert.equal(evaluateActionAuthorization(intent, {
    ownerAuthenticated: false,
    exactTarget: false,
    lowRisk: false,
    reversible: false,
  }, authorization, new Date('2026-07-27T00:00:00.000Z')).allowed, false);
  assert.equal(evaluateActionAuthorization(intent, {
    ownerAuthenticated: false,
    exactTarget: false,
    lowRisk: false,
    reversible: false,
  }, authorization, new Date('2026-07-29T00:00:00.000Z')).allowed, false);

});

test('blocks ambiguous or conflicting side-effect retries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-ledger-failure-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  await assert.rejects(ledger.executeOnce(call(), async () => {
    executions += 1;
    throw new Error('operation failed after an unknown boundary');
  }), /unknown boundary/);

  await assert.rejects(ledger.executeOnce(call(), async () => { executions += 1; }), /不会自动重试/);
  await assert.rejects(ledger.executeOnce(call('run-a', '{"path":"other.txt"}'), async () => undefined), /参数冲突/);
  assert.equal(executions, 1);
});

test('keeps identical call ids isolated by run and clears them with the session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-ledger-clear-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  await ledger.executeOnce(call('run-a'), async () => ++executions);
  await ledger.executeOnce(call('run-b'), async () => ++executions);
  await ledger.clearSession('demo');
  await ledger.executeOnce(call('run-a'), async () => ++executions);
  assert.equal(executions, 3);
});

test('reads only exact successful calls with validated outputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-successes-'));
  const file = path.join(root, 'ledger.json');
  const ledger = new ExecutionLedger(file);
  await ledger.executeOnce({
    sessionId: 'demo', runId: 'event:one', toolName: 'new_session', callId: 'call-new', argumentsJson: '{}',
  }, async () => ({ sessionId: 'generated', effective: 'after_current_turn' }));
  await ledger.executeOnce({
    sessionId: 'demo', runId: 'event:one:team:child', toolName: 'write_file', callId: 'call-child', argumentsJson: '{}',
  }, async () => 'child');
  await assert.rejects(ledger.executeOnce({
    sessionId: 'demo', runId: 'event:one', toolName: 'clear_session', callId: 'call-failed', argumentsJson: '{}',
  }, async () => { throw new Error('failed'); }), /failed/);

  assert.deepEqual(await new ExecutionLedger(file).listSucceededCalls('demo', 'event:one'), [{
    sessionId: 'demo', runId: 'event:one', toolName: 'new_session', callId: 'call-new', argumentsJson: '{}',
    output: { sessionId: 'generated', effective: 'after_current_turn' },
  }]);
});

test('lists all root and child call outcomes for completion evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-evidence-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  await ledger.executeOnce({
    sessionId: 'demo', runId: 'event:one', toolName: 'connector_action', callId: 'sent', argumentsJson: '{}',
  }, async () => ({ outcome: 'accepted' }));
  await assert.rejects(ledger.executeOnce({
    sessionId: 'demo', runId: 'event:one:team:test', toolName: 'run_shell', callId: 'test', argumentsJson: '{}',
  }, async () => { throw new Error('tests failed'); }));

  assert.deepEqual((await ledger.listCalls('demo', 'event:one')).map((item) => ({
    toolName: item.toolName, callId: item.callId, status: item.status, output: item.output, error: item.error,
  })), [
    { toolName: 'connector_action', callId: 'sent', status: 'succeeded', output: { outcome: 'accepted' }, error: undefined },
    { toolName: 'run_shell', callId: 'test', status: 'failed', output: undefined, error: 'tests failed' },
  ]);
});

test('clears a Session while retaining the current execution root and children', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-clear-except-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  for (const runId of ['old', 'event:one', 'event:one:runtime-actions', 'event:one:team:child', 'event:one-other']) {
    await ledger.executeOnce(call(runId), async () => ++executions);
  }

  await ledger.clearSessionExcept('demo', 'event:one');
  await ledger.executeOnce(call('old'), async () => ++executions);
  await ledger.executeOnce(call('event:one-other'), async () => ++executions);
  assert.equal(await ledger.executeOnce(call('event:one'), async () => ++executions), 2);
  assert.equal(await ledger.executeOnce(call('event:one:runtime-actions'), async () => ++executions), 3);
  assert.equal(await ledger.executeOnce(call('event:one:team:child'), async () => ++executions), 4);
  assert.equal(executions, 7);
});

test('persists a completed execution receipt until the durable host transaction commits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-receipt-'));
  const file = path.join(root, 'ledger.json');
  const first = new ExecutionLedger(file);
  await first.commitReceipt('owner', 'event:event-1', {
    runId: 'runtime-run-1', answer: 'already completed', usage: { runTotalTokens: 42 },
  });

  const reopened = new ExecutionLedger(file);
  assert.deepEqual(await reopened.getReceipt('owner', 'event:event-1'), {
    runId: 'runtime-run-1', answer: 'already completed', usage: { runTotalTokens: 42 },
  });
  await reopened.clearRun('owner', 'event:event-1');
  assert.equal(await reopened.getReceipt('owner', 'event:event-1'), undefined);
});

test('clears Team worker ledger children with their parent run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-ledger-team-clear-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  const child = call('run-a:team:build:claim');
  await ledger.executeOnce(child, async () => ++executions);
  await ledger.clearRun('demo', 'run-a');
  await ledger.executeOnce(child, async () => ++executions);
  assert.equal(executions, 2);
});

test('never TTL-prunes durable Event ledgers before explicit host finalization', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-durable-retention-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'), { retentionMs: 1 });
  let eventExecutions = 0;
  const durable = {
    sessionId: 'owner', runId: 'event:dead-letter', toolName: 'connector_action',
    callId: 'send-once', argumentsJson: '{"text":"hello"}',
  };
  await ledger.executeOnce(durable, async () => ({ executions: ++eventExecutions }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await ledger.executeOnce({
    sessionId: 'owner', runId: 'ordinary-run', toolName: 'write_file',
    callId: 'other', argumentsJson: '{}',
  }, async () => 'other');

  assert.deepEqual(await ledger.executeOnce(durable, async () => ({ executions: ++eventExecutions })), {
    executions: 1,
  });
  assert.equal(eventExecutions, 1);
});

test('wraps SDK side-effect tools with the active run ledger', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-ledger-tool-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  const original = tool({
    name: 'write_file',
    description: 'test',
    parameters: z.object({ path: z.string() }),
    execute: async () => ({ executions: ++executions }),
  });
  const [wrapped] = withExecutionLedger([original], ledger, () => ({ sessionId: 'demo', runId: 'run-a' }));
  assert.ok(wrapped && 'invoke' in wrapped);
  const details = { toolCall: { callId: 'sdk-call-1' } } as never;

  const first = await wrapped.invoke(new RunContext({}), '{"path":"a.txt"}', details);
  const replay = await wrapped.invoke(new RunContext({}), '{"path":"a.txt"}', details);

  assert.deepEqual(replay, first);
  assert.equal(executions, 1);
});

test('declared read actions bypass side-effect authorization and uncertain ledger fencing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-read-action-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  let authorizations = 0;
  const original = tool({
    name: 'invoke_capability',
    description: 'bounded read capability',
    parameters: z.object({ target: z.string() }),
    execute: async () => {
      executions += 1;
      if (executions === 1) throw new Error('read failed before returning');
      return { outcome: 'confirmed', messages: ['bounded'] };
    },
  }) as ReturnType<typeof tool> & {
    [TOOL_ACTION_INTENT]?: (rawInput: string) => {
      actionFamily: string;
      targetRef: string;
      payload: unknown;
      selectedRoute: string;
      effect: 'read';
    };
  };
  original[TOOL_ACTION_INTENT] = (rawInput) => ({
    actionFamily: 'connector.message.context.read',
    targetRef: JSON.parse(rawInput).target as string,
    payload: rawInput,
    selectedRoute: 'capability-router',
    effect: 'read',
  });
  const [wrapped] = withExecutionLedger([original], ledger, () => ({
    sessionId: 'owner',
    runId: 'event:read-retry',
    semanticCallIds: true,
    authorizeSideEffect: async () => { authorizations += 1; },
  }));
  assert.ok(wrapped && 'invoke' in wrapped);
  const input = '{"target":"owner"}';

  assert.match(
    String(await wrapped.invoke(
      new RunContext({}),
      input,
      { toolCall: { callId: 'read-a' } } as never,
    )),
    /read failed/,
  );
  assert.deepEqual(
    await wrapped.invoke(new RunContext({}), input, { toolCall: { callId: 'read-b' } } as never),
    { outcome: 'confirmed', messages: ['bounded'] },
  );
  assert.equal(executions, 2);
  assert.equal(authorizations, 0);
  assert.deepEqual(await ledger.listCalls('owner', 'event:read-retry'), []);
});

test('confirmed Connector actions expose a verifiable external receipt for Plan completion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-connector-receipt-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  const original = tool({
    name: 'connector_action',
    description: 'test connector action',
    parameters: z.object({ action: z.string() }),
    execute: async () => ({ outcome: 'confirmed', operationId: 'operation-1' }),
  });
  const [wrapped] = withExecutionLedger(
    [original],
    ledger,
    () => ({ sessionId: 'demo', runId: 'run-connector' }),
  );
  assert.ok(wrapped && 'invoke' in wrapped);
  const result = await wrapped.invoke(
    new RunContext({}),
    '{"action":"submit"}',
    { toolCall: { callId: 'connector-call-1' } } as never,
  ) as Record<string, unknown>;
  const evidence = result.mimiExecutionReceipt as Record<string, unknown>;
  assert.match(String(evidence.ref), /^execution:/);
  assert.equal(await ledger.isConfirmedExternalReceipt(String(evidence.ref), 'demo'), true);
  assert.equal(await ledger.isConfirmedExternalReceipt(String(evidence.ref), 'other-session'), false);
});

test('daemon semantic call ids replay consecutive duplicate effects and distinguish them after another effect', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-ledger-semantic-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  const original = tool({
    name: 'write_file',
    description: 'test',
    parameters: z.object({ path: z.string() }),
    execute: async () => ({ executions: ++executions }),
  });
  const identity = () => ({
    sessionId: 'demo', runId: 'event:event-1', semanticCallIds: true,
  });
  const [wrapped] = withExecutionLedger([original], ledger, identity);
  assert.ok(wrapped && 'invoke' in wrapped);
  const first = await wrapped.invoke(
    new RunContext({}), '{"path":"a.txt"}', { toolCall: { callId: 'sdk-call-1' } } as never,
  );
  const second = await wrapped.invoke(
    new RunContext({}), '{ "path": "a.txt" }', { toolCall: { callId: 'sdk-call-2' } } as never,
  );
  const different = await wrapped.invoke(
    new RunContext({}), '{"path":"b.txt"}', { toolCall: { callId: 'sdk-call-3' } } as never,
  );
  const third = await wrapped.invoke(
    new RunContext({}), '{"path":"a.txt"}', { toolCall: { callId: 'sdk-call-4' } } as never,
  );
  assert.match(JSON.stringify(second), /already_executed/);
  assert.notDeepEqual(different, first);
  assert.notDeepEqual(third, first);
  assert.equal(executions, 3);

  const [retryWrapped] = withExecutionLedger([original], ledger, identity);
  assert.ok(retryWrapped && 'invoke' in retryWrapped);
  assert.deepEqual(await retryWrapped.invoke(
    new RunContext({}), '{"path":"a.txt"}', { toolCall: { callId: 'retry-call-1' } } as never,
  ), first);
  assert.deepEqual(await retryWrapped.invoke(
    new RunContext({}), '{"path":"a.txt"}', { toolCall: { callId: 'retry-call-2' } } as never,
  ), {
    executions: 1,
    mimiStatus: 'already_executed',
    message: '相同操作已经成功执行且其后没有新的副作用；本次未重复执行，请使用 previousResult 继续回答。',
    previousResult: first,
  });
  await retryWrapped.invoke(
    new RunContext({}), '{"path":"b.txt"}', { toolCall: { callId: 'retry-call-3' } } as never,
  );
  assert.deepEqual(await retryWrapped.invoke(
    new RunContext({}), '{"path":"a.txt"}', { toolCall: { callId: 'retry-call-4' } } as never,
  ), third);
  assert.equal(executions, 3);
  const replayedCalls = await ledger.listCalls('demo', 'event:event-1');
  assert.deepEqual(replayedCalls[0]?.modelCallIds, [
    'sdk-call-1', 'sdk-call-2', 'retry-call-1', 'retry-call-2',
  ]);
});

test('semantic call ids canonicalize nested JSON object keys across attempts without reordering arrays', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-canonical-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  const original = tool({
    name: 'write_file',
    description: 'test',
    parameters: z.object({ metadata: z.record(z.string(), z.unknown()), order: z.array(z.number()) }),
    execute: async () => ({ executions: ++executions }),
  });
  const identity = () => ({
    sessionId: 'demo', runId: 'event:event-canonical', semanticCallIds: true,
  });
  const [wrapped] = withExecutionLedger([original], ledger, identity);
  assert.ok(wrapped && 'invoke' in wrapped);
  const first = await wrapped.invoke(
    new RunContext({}),
    '{"metadata":{"b":2,"nested":{"z":1,"a":0}},"order":[2,1]}',
    { toolCall: { callId: 'sdk-a' } } as never,
  );
  await wrapped.invoke(
    new RunContext({}),
    '{"metadata":{"b":2,"nested":{"a":0,"z":1}},"order":[1,2]}',
    { toolCall: { callId: 'sdk-c' } } as never,
  );
  assert.equal(executions, 2);
  const [retryWrapped] = withExecutionLedger([original], ledger, identity);
  assert.ok(retryWrapped && 'invoke' in retryWrapped);
  const replay = await retryWrapped.invoke(
    new RunContext({}),
    '{"order":[2,1],"metadata":{"nested":{"a":0,"z":1},"b":2}}',
    { toolCall: { callId: 'sdk-b' } } as never,
  );
  assert.deepEqual(replay, first);
  assert.equal(executions, 2);
});

test('side-effect authorization is consumed only inside the first semantic ledger execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-ledger-authorization-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let authorizations = 0;
  let executions = 0;
  const original = tool({
    name: 'write_file', description: 'test', parameters: z.object({ path: z.string() }),
    execute: async () => ({ executions: ++executions }),
  });
  const identity = () => ({
    sessionId: 'demo', runId: 'event:authorized', semanticCallIds: true,
    authorizeSideEffect: async () => { authorizations += 1; },
  });
  const [wrapped] = withExecutionLedger([original], ledger, identity);
  assert.ok(wrapped && 'invoke' in wrapped);
  const input = '{"path":"reports/today.md"}';
  await wrapped.invoke(new RunContext({}), input, { toolCall: { callId: 'sdk-a' } } as never);
  const [retryWrapped] = withExecutionLedger([original], ledger, identity);
  assert.ok(retryWrapped && 'invoke' in retryWrapped);
  await retryWrapped.invoke(new RunContext({}), input, { toolCall: { callId: 'sdk-b' } } as never);
  assert.equal(authorizations, 1);
  assert.equal(executions, 1);
});

test('daemon retries replay native MCP calls through the execution ledger', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-mcp-ledger-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  const server = {
    name: 'messages', cacheToolsList: false,
    connect: async () => undefined, close: async () => undefined,
    listTools: async () => [], invalidateToolsCache: async () => undefined,
    callTool: async (name: string, args: Record<string, unknown> | null) => ([{
      type: 'text', text: JSON.stringify({ name, args, executions: ++executions }),
    }]),
  } as MCPServer;
  const [wrapped] = withMcpExecutionLedger([server], ledger, () => ({
    sessionId: 'owner', runId: 'event:mcp-send', semanticCallIds: true,
  }));
  assert.ok(wrapped);

  const first = await wrapped.callTool('send_message', { target: 'alice', text: 'hello' });
  const replay = await wrapped.callTool('send_message', { text: 'hello', target: 'alice' });
  await wrapped.callTool('send_message', { target: 'bob', text: 'hello' });

  assert.deepEqual(replay, first);
  assert.equal(executions, 2);
});

test('native MCP calls with an uncertain result are never executed again automatically', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-mcp-ledger-failure-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  const server = {
    name: 'calendar', cacheToolsList: false,
    connect: async () => undefined, close: async () => undefined,
    listTools: async () => [], invalidateToolsCache: async () => undefined,
    callTool: async () => {
      executions += 1;
      throw new Error('connection ended after dispatch');
    },
  } as MCPServer;
  const [wrapped] = withMcpExecutionLedger([server], ledger, () => ({
    sessionId: 'owner', runId: 'event:mcp-calendar', semanticCallIds: true,
  }));
  assert.ok(wrapped);

  await assert.rejects(wrapped.callTool('create_event', { title: 'demo' }), /after dispatch/);
  await assert.rejects(wrapped.callTool('create_event', { title: 'demo' }), /不会自动重试/);
  assert.equal(executions, 1);
});

test('fails closed when the execution ledger is corrupt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-ledger-corrupt-'));
  const file = path.join(root, 'ledger.json');
  await writeFile(file, '{broken');
  let executions = 0;

  await assert.rejects(
    new ExecutionLedger(file).executeOnce(call(), async () => ++executions),
    /状态文件损坏，已隔离/,
  );
  await assert.rejects(
    new ExecutionLedger(file).executeOnce(call(), async () => ++executions),
    /状态文件损坏，已隔离/,
  );
  assert.equal(executions, 0);
  assert.ok((await readdir(root)).some((name) => name.startsWith('ledger.json.corrupt-')));
  const marker = JSON.parse(await readFile(`${file}.corrupt-state`, 'utf8')) as {
    state?: unknown;
    backup?: unknown;
  };
  assert.equal(marker.state, 'quarantined');
  assert.equal(typeof marker.backup, 'string');
  assert.match(String(marker.backup), /ledger\.json\.corrupt-/);
});

test('preserves an incompatible execution ledger schema without quarantining it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-incompatible-'));
  const file = path.join(root, 'ledger.json');
  const source = `${JSON.stringify({ version: 2, entries: [], actionIntents: {} })}\n`;
  await writeFile(file, source);
  let executions = 0;

  await assert.rejects(
    new ExecutionLedger(file).executeOnce(call(), async () => ++executions),
    /状态文件格式与当前程序不兼容，已保留原文件/,
  );

  assert.equal(executions, 0);
  assert.equal(await readFile(file, 'utf8'), source);
  assert.deepEqual(await readdir(root), ['ledger.json']);
});

test('migrates a v1 execution ledger to v2 without losing existing entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-v1-migration-'));
  const file = path.join(root, 'ledger.json');
  await new ExecutionLedger(file).executeOnce(call('legacy-run'), async () => 'legacy-result');
  const current = JSON.parse(await readFile(file, 'utf8')) as {
    entries: Record<string, unknown>;
  };
  const originalKeys = Object.keys(current.entries);
  await writeFile(file, JSON.stringify({ version: 1, entries: current.entries }));

  const migrated = new ExecutionLedger(file);
  await migrated.initialize();
  const initialized = JSON.parse(await readFile(file, 'utf8')) as {
    version: number;
    entries: Record<string, unknown>;
    actionIntents?: Record<string, unknown>;
  };
  assert.equal(initialized.version, 2);
  assert.ok(originalKeys.every((key) => Object.hasOwn(initialized.entries, key)));
  assert.deepEqual(initialized.actionIntents, {});

  assert.equal(await migrated.executeOnce(call('legacy-run'), async () => 'must-not-run'), 'legacy-result');
  await migrated.executeOnce(call('new-run'), async () => 'new-result');

  const stored = JSON.parse(await readFile(file, 'utf8')) as {
    version: number;
    entries: Record<string, unknown>;
    actionIntents?: Record<string, unknown>;
  };
  assert.equal(stored.version, 2);
  assert.equal(Object.keys(stored.entries).length, originalKeys.length + 1);
});

test('initializing an existing v2 execution ledger is idempotent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-v2-initialize-'));
  const file = path.join(root, 'ledger.json');
  await new ExecutionLedger(file).executeOnce(call(), async () => 'fixture');
  const before = await readFile(file, 'utf8');

  await new ExecutionLedger(file).initialize();

  assert.equal(await readFile(file, 'utf8'), before);
});

test('refuses a newer execution ledger as a deployment rollback without quarantining valid state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-newer-version-'));
  const file = path.join(root, 'ledger.json');
  await new ExecutionLedger(file).executeOnce(call(), async () => 'fixture');
  const current = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...current, version: 3 }));

  await assert.rejects(
    new ExecutionLedger(file).executeOnce(call('new-run'), async () => 'must-not-run'),
    /状态版本 3 高于当前支持的 2.*拒绝版本回退/u,
  );
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 3);
  assert.deepEqual((await readdir(root)).sort(), ['ledger.json']);
});

test('reports a persisted started ActionIntent as uncertain while the operation is in flight', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-intent-started-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  const intent = actionIntent('connector');
  let signalStarted!: () => void;
  let finishOperation!: (value: string) => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const operation = new Promise<string>((resolve) => { finishOperation = resolve; });
  const pending = ledger.executeActionIntent(
    'owner',
    'event:started',
    intent,
    { ownerAuthenticated: true, exactTarget: true, lowRisk: true, reversible: true },
    undefined,
    async () => {
      signalStarted();
      return operation;
    },
  );
  await started;

  const persisted = await ledger.getActionIntent(intent.executionKey);
  assert.equal(persisted?.outcome, 'uncertain');
  assert.equal(persisted?.attempts, 1);
  assert.equal(persisted?.authorizationSource, 'guarded-owner-fast-path');

  finishOperation('done');
  assert.equal((await pending).outcome, 'confirmed');
});

test('bounds ledger outputs and entry growth without replaying side effects', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-ledger-limits-'));
  const outputLedger = new ExecutionLedger(path.join(root, 'outputs.json'), { maxOutputBytes: 16 });
  let outputExecutions = 0;
  await assert.rejects(
    outputLedger.executeOnce(call(), async () => ({ value: 'too-large', count: ++outputExecutions })),
    /超过执行账本 16 字节限制/,
  );
  await assert.rejects(
    outputLedger.executeOnce(call(), async () => { outputExecutions += 1; }),
    /不会自动重试/,
  );
  assert.equal(outputExecutions, 1);

  const entryLedger = new ExecutionLedger(path.join(root, 'entries.json'), { maxEntries: 1 });
  await entryLedger.executeOnce(call('run-a'), async () => 'first');
  await assert.rejects(
    entryLedger.executeOnce(call('run-b'), async () => 'second'),
    /达到 1 条上限/,
  );
});

test('commits an oversized successful output as one bounded replay-safe receipt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-bounded-receipt-'));
  const file = path.join(root, 'ledger.json');
  const ledger = new ExecutionLedger(file, { maxOutputBytes: 512 });
  let executions = 0;
  const first = await ledger.executeOnce(call(), async () => ({
    value: 'sensitive-fixture-'.repeat(1_000),
    executions: ++executions,
  })) as unknown as Record<string, unknown>;
  const replay = await new ExecutionLedger(file, { maxOutputBytes: 512 })
    .executeOnce(call(), async () => {
      executions += 1;
      throw new Error('oversized successful output must not execute twice');
    });

  assert.equal(first.mimiStatus, 'output_truncated');
  assert.equal(first.originalBytes, 18_029);
  assert.match(String(first.sha256), /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(first), /sensitive-fixture/);
  assert.deepEqual(replay, first);
  assert.equal(executions, 1);
});

test('keeps an oversized ActionIntent result confirmed and replayable without the original payload', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-intent-bounded-receipt-'));
  const file = path.join(root, 'ledger.json');
  const context = {
    ownerAuthenticated: true,
    exactTarget: true,
    lowRisk: true,
    reversible: true,
  };
  let executions = 0;
  const first = await new ExecutionLedger(file, { maxOutputBytes: 1_024 }).executeActionIntent(
    'owner',
    'event:oversized-intent',
    actionIntent('connector'),
    context,
    undefined,
    async () => ({ value: 'private-result-'.repeat(2_000), executions: ++executions }),
  );
  const replay = await new ExecutionLedger(file, { maxOutputBytes: 1_024 }).executeActionIntent(
    'owner',
    'event:oversized-intent:retry',
    actionIntent('computer', { intentId: 'oversized-retry' }),
    context,
    undefined,
    async () => {
      executions += 1;
      throw new Error('confirmed ActionIntent must not execute twice');
    },
  );

  assert.equal(first.outcome, 'confirmed');
  assert.equal((first.result as unknown as Record<string, unknown>).mimiStatus, 'output_truncated');
  assert.doesNotMatch(JSON.stringify(first), /private-result/);
  assert.deepEqual(replay, first);
  assert.equal(executions, 1);
});

test('rejects conflicting arguments while the same call id is still in flight', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-ledger-inflight-conflict-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let executions = 0;
  const first = ledger.executeOnce(call(), async () => {
    executions += 1;
    started();
    await barrier;
    return 'done';
  });
  await entered;

  await assert.rejects(
    ledger.executeOnce(call('run-a', '{"path":"other.txt"}'), async () => { executions += 1; }),
    /参数冲突/,
  );
  release();
  assert.equal(await first, 'done');
  assert.equal(executions, 1);
});

test('tool authorization can gate read tools without writing them to the execution ledger', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-tool-gate-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let invoked = false;
  const original = tool({
    name: 'read_file',
    description: 'read fixture',
    parameters: z.object({ path: z.string() }),
    execute: async () => { invoked = true; return 'content'; },
  });
  const [wrapped] = withExecutionLedger([original], ledger, () => ({
    sessionId: 'demo',
    runId: 'run-read',
    authorizeTool: async () => { throw new Error('prepare_task required'); },
  }));
  assert.ok(wrapped && 'invoke' in wrapped);
  await assert.rejects(
    wrapped.invoke(new RunContext({}), JSON.stringify({ path: 'README.md' })),
    /prepare_task required/,
  );
  assert.equal(invoked, false);
  assert.deepEqual(await ledger.listCalls('demo', 'run-read'), []);
});
