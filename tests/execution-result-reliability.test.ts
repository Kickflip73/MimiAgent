import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { APIUserAbortError } from 'openai';
import type { RunStreamEvent } from '@openai/agents';
import type { ExecutionCallRecord } from '../src/core/execution-ledger.js';
import { classifyRunOutcome, createRunFinalization } from '../src/core/run-finalization.js';
import { projectRunStreamEvent } from '../src/runtime/stream-projection.js';
import { ProviderCircuitBreaker, ProviderCircuitOpenError, ProviderFailoverCoordinator, providerRetryAt } from '../src/runtime/provider-reliability.js';
import { classifyRunFailureRecord } from '../src/daemon/dispatcher-retry-policy.js';
import { MimiStore } from '../src/daemon/store.js';

const call = (id: string, args: unknown, status: ExecutionCallRecord['status'], output: unknown): ExecutionCallRecord => ({
  sessionId: 'test', runId: 'run', callId: id, toolName: 'memory_search',
  argumentsJson: JSON.stringify(args), status, output,
});
const rejection = {
  mimiStatus: 'tool_input_rejected',
  disposition: { phase: 'pre_dispatch', kind: 'validation', dispatchStarted: false, toolName: 'memory_search' },
  issues: [{ path: 'limit', code: 'too_big', maximum: 20 }],
};

test('corrected rejected arguments recover only the matching task, preserving every failed attempt', () => {
  const failed = call('bad', { query: 'alpha', limit: 30 }, 'failed', rejection);
  const repaired = call('fixed', { query: 'alpha', limit: 10 }, 'succeeded', { matches: [] });
  assert.equal(classifyRunOutcome({ sdk: 'completed', calls: [failed, repaired] }), 'completed');
  assert.equal(createRunFinalization({ runId: 'run', answer: 'done', calls: [failed, repaired] }).toolManifest[0]?.recoveredByCallId, 'fixed');
  assert.deepEqual(createRunFinalization({ runId: 'run', answer: 'done', calls: [failed, repaired] })
    .toolManifest.map(c => c.status), ['failed', 'succeeded']);
  assert.equal(classifyRunOutcome({ sdk: 'completed', calls: [failed,
    call('unrelated', { query: 'beta', limit: 10 }, 'succeeded', { matches: [] })] }), 'partial');
  assert.equal(classifyRunOutcome({ sdk: 'completed', calls: [
    call('bad', { query: 'alpha', limit: 30 }, 'failed', { ok: false, message: 'runtime failed' }), repaired] }), 'partial');
  assert.equal(classifyRunOutcome({ sdk: 'completed', calls: [
    call('bad', { query: 'alpha', limit: 30 }, 'uncertain', rejection), repaired] }), 'uncertain');
  assert.equal(classifyRunOutcome({ sdk: 'completed', calls: [failed,
    call('fixed', { query: 'alpha', limit: 10 }, 'succeeded', { outcome: 'accepted' })] }), 'partial');
});

test('live tool status agrees with Host facts for shell failures, MCP errors and uncertain effects', () => {
  for (const [output, expected] of [
    [{ exitCode: 1, stderr: 'failed' }, 'failed'],
    [JSON.stringify({ isError: true, content: [{ type: 'text', text: 'MCP failed' }] }), 'failed'],
    [{ mimiStatus: 'action_uncertain' }, 'uncertain'],
    [{ exitCode: 0 }, 'completed'],
  ] as const) {
    const projection = projectRunStreamEvent({ type: 'run_item_stream_event', name: 'tool_output',
      item: { rawItem: { name: 'run_shell' }, output },
    } as unknown as RunStreamEvent);
    assert.equal(projection?.kind, 'status');
    if (projection?.kind === 'status') assert.equal(projection.tone, expected === 'completed' ? 'success' : 'failure');
    assert.equal(classifyRunOutcome({ sdk: 'completed', calls: [call('tool', {}, 'succeeded', output)] }), expected);
  }
});

test('Retry-After persists through provider cooldown and typed dispatcher retry classification', () => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  const rate = Object.assign(new Error('limited'), { status: 429, headers: new Headers({ 'Retry-After': '120' }) });
  assert.equal(providerRetryAt(rate, now), new Date(now + 120000).toISOString());
  assert.equal(providerRetryAt({ headers: { 'Retry-After': new Date(now + 300000).toUTCString() } }, now), new Date(now + 300000).toISOString());
  assert.equal(providerRetryAt({ headers: { 'retry-after-ms': '3500' } }, now), new Date(now + 3500).toISOString());
  assert.equal(providerRetryAt({ headers: { 'retry-after': 'garbage' } }, now), undefined);
  const breaker = new ProviderCircuitBreaker({ openMs: 1000 }, () => now);
  breaker.failure('provider', rate);
  assert.equal(breaker.health('provider').retryAt, new Date(now + 120000).toISOString());
  assert.throws(() => breaker.acquire('provider'), (error) => {
    assert.ok(error instanceof ProviderCircuitOpenError);
    const failure = classifyRunFailureRecord(error);
    assert.equal(failure.disposition.retryable, true);
    assert.equal(failure.retryAt, breaker.health('provider').retryAt);
    return true;
  });
  assert.equal(classifyRunFailureRecord(rate).disposition.retryable, true);
});

test('owner cancellation never opens the provider circuit or invokes backup', async () => {
  for (const error of [new DOMException('cancelled', 'AbortError'), new APIUserAbortError()]) {
    const breaker = new ProviderCircuitBreaker({ failureThreshold: 1 });
    const failover = new ProviderFailoverCoordinator(breaker);
    const invoked: string[] = [];
    await assert.rejects(failover.execute([{ id: 'primary', role: 'primary' }, { id: 'backup', role: 'backup' }], async (p) => {
      invoked.push(p.id); throw error;
    }, { sideEffectsStarted: () => false }), e => e === error);
    assert.deepEqual(invoked, ['primary']);
    assert.equal(breaker.health('primary').failures, 0);
    assert.equal(breaker.health('primary').state, 'closed');
    assert.equal(classifyRunFailureRecord(error).disposition.retryable, false);
  }
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-result-state-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const at = new Date('2030-01-01T00:00:00Z');
  store.appendEvent({ id: 'authority', externalId: 'authority', source: 'fixture', type: 'command.received',
    trust: 'owner', payload: {}, profileId: 'owner', occurredAt: at.toISOString(), receivedAt: at.toISOString() });
  const claim = (id: string) => {
    store.enqueueTask({ id, type: 'background', idempotencyKey: id, authorityEventId: 'authority', profileId: 'owner',
      objective: {}, executor: 'isolated_worker', workspaceAccess: 'read', priority: 50, sessionKey: id, maxAttempts: 5 });
    assert.ok(store.claimTaskById(id, 'worker', 60000, at));
    return store.beginTaskAttempt(id, 'worker', id, 'worker', at);
  };
  return { store, at, claim };
}

test('daemon does not publish non-completed Host outcomes as successful deliveries or automatically replay them', async t => {
  const { store, at, claim } = await fixture(t);
  for (const [outcome, status] of [['partial', 'blocked'], ['blocked', 'blocked'], ['interrupted', 'blocked'], ['failed', 'failed'], ['uncertain', 'dead_letter'], ['completed', 'completed']] as const) {
    const attempt = claim(outcome);
    const finalization = createRunFinalization({ runId: outcome, answer: 'saved answer', outcome, calls: [] });
    const task = store.completeTask(outcome, 'worker', { answer: 'saved answer', finalization }, attempt.id, at,
      { route: { channel: 'system' }, payload: { type: 'background_task_completed', text: '已完成' } });
    assert.equal(task.status, status);
    assert.equal((task.result as { answer: string }).answer, 'saved answer');
    assert.equal((task.result as { finalization: { outcome: string } }).finalization.outcome, outcome);
    const payloads = store.outbox.listSummaries(100).filter(item => item.taskId === outcome)
      .map(item => JSON.stringify(store.outbox.get(item.id)?.payload));
    if (outcome !== 'completed') {
      assert.ok(payloads.length > 0);
      assert.doesNotMatch(payloads.join(''), /background_task_completed|已完成/);
    }
  }
});

test('durable retry respects Retry-After while uncertain side effects override provider retryability', async t => {
  const { store, at, claim } = await fixture(t);
  const attempt = claim('limited');
  const retryAt = new Date(at.getTime() + 120000).toISOString();
  const failure = classifyRunFailureRecord(Object.assign(new Error('limited'), { status: 429, retryAt }));
  const queued = store.failTask('limited', 'worker', new Error('limited'), failure, attempt.id, at);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.notBefore, retryAt);
  assert.equal(queued.failure?.retryAt, retryAt);
  assert.equal(store.claimTaskById('limited', 'early', 1000, new Date(at.getTime() + 1000)), undefined);
  const unsafe = claim('unsafe');
  const finalization = createRunFinalization({ runId: 'unsafe', answer: 'check receipt', calls: [call('dispatch', {}, 'uncertain', undefined)] });
  const stopped = store.failTask('unsafe', 'worker', new Error('limited'), failure, unsafe.id, at, undefined, finalization);
  assert.equal(stopped.status, 'dead_letter');
  assert.equal(stopped.failure?.disposition.retryable, false);
  assert.equal(stopped.failure?.disposition.kind, 'uncertain');
});

test('SDK argument repair survives ledger and fact collection without replaying a successful effect', async t => {
  const { tool } = await import('../src/tool-factory.js');
  const { z } = await import('zod');
  const { RunContext } = await import('@openai/agents');
  const { ExecutionLedger } = await import('../src/core/execution-ledger.js');
  const { withExecutionLedger } = await import('../src/runtime/tool-ledger.js');
  const { RunFactCollector, mergeRunCalls } = await import('../src/runtime/pipeline/run-fact-collector.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-argument-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  const facts = new RunFactCollector();
  let effects = 0;
  const candidate = tool({ name: 'write_file', description: 'fixture',
    parameters: z.object({ path: z.string(), limit: z.number().max(20) }),
    execute: async () => { effects += 1; return { path: 'result.txt', written: true }; },
  });
  const [wrapped] = facts.wrap(withExecutionLedger([candidate], ledger, () => ({ sessionId: 's', runId: 'r' })));
  assert.ok(wrapped && 'invoke' in wrapped);
  await wrapped.invoke(new RunContext({}), JSON.stringify({ path: 'result.txt', limit: 30 }), { toolCall: { callId: 'bad' } } as never);
  await wrapped.invoke(new RunContext({}), JSON.stringify({ path: 'result.txt', limit: 10 }), { toolCall: { callId: 'good' } } as never);
  const calls = mergeRunCalls(facts.calls('s', 'r'), await ledger.listCalls('s', 'r'));
  assert.equal(effects, 1);
  assert.equal(classifyRunOutcome({ sdk: 'completed', calls }), 'completed');
  const manifest = createRunFinalization({ runId: 'r', answer: 'done', calls }).toolManifest;
  assert.deepEqual(manifest.map(c => c.status), ['failed', 'succeeded']);
  assert.equal(manifest[0]?.recoveredByCallId, 'good');
});

test('dispatcher retains effect receipts for incomplete and uncertain returns', async t => {
  const { MimiDispatcher } = await import('../src/daemon/dispatcher.js');
  const { AttentionEngine } = await import('../src/daemon/attention.js');
  const { MimiHost } = await import('../src/runtime/mimi-host.js');
  for (const outcome of ['partial', 'uncertain', 'completed'] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatch-outcome-'));
    const store = new MimiStore(path.join(root, 'mimi.db'));
    t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
    let finalized = 0;
    let reopened = 0;
    const agent = { currentSessionId: 'owner', currentCapabilitySnapshot: () => undefined,
      completedExecution: async () => undefined, finalizeExecutionLedger: async () => { finalized++; },
      reopenExecutionLedger: async () => { reopened++; },
    } as unknown as import('../src/runtime/mimi-agent.js').MimiAgent;
    const host = new MimiHost(agent, { execute: async () => ({ answer: outcome, effects: [],
      finalization: createRunFinalization({ runId: outcome, answer: outcome, outcome, calls: [] }),
    }) });
    const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
    const dispatcher = new MimiDispatcher(store, host, attention);
    const now = new Date().toISOString();
    const routed = store.ingestEvent({ id: outcome, externalId: outcome, source: 'local-cli', kind: 'command',
      trust: 'owner', payload: { prompt: 'task' }, occurredAt: now, receivedAt: now, priority: 100,
      profileId: 'owner', sessionKey: 'owner' });
    assert.ok(routed.task);
    assert.equal(await dispatcher.processTaskById(routed.task.id), true);
    assert.equal(finalized, outcome === 'completed' ? 1 : 0);
    assert.equal(reopened, outcome === 'partial' ? 1 : 0);
    assert.equal(store.getTask(routed.task.id)?.status,
      outcome === 'completed' ? 'completed' : outcome === 'uncertain' ? 'dead_letter' : 'blocked');
  }
});
