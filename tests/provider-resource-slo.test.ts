import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  classifyProviderFault,
  ProviderCircuitBreaker,
  ProviderFailoverCoordinator,
} from '../src/runtime/provider-reliability.js';
import {
  buildDailyResourceTrends,
  DEFAULT_RESOURCE_BUDGETS,
  processResourceSample,
  resourceHostSummary,
} from '../src/daemon/resource-slo.js';
import { MimiStore } from '../src/daemon/store.js';

test('Provider faults classify 429, balance, network and 5xx deterministically', () => {
  assert.equal(classifyProviderFault(Object.assign(new Error('rate limited'), { status: 429 })).kind, 'rate_limit');
  assert.equal(classifyProviderFault(Object.assign(new Error('insufficient balance'), { status: 402 })).kind, 'insufficient_balance');
  assert.equal(classifyProviderFault(Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' })).kind, 'network');
  assert.equal(classifyProviderFault(Object.assign(new Error('upstream'), { status: 503 })).kind, 'server');
  assert.equal(classifyProviderFault(new Error('invalid request')).kind, 'other');
});

test('Provider breaker stops retry storms and recovers through one half-open probe', () => {
  let now = Date.parse('2026-07-27T00:00:00.000Z');
  const breaker = new ProviderCircuitBreaker({
    failureThreshold: 2,
    openMs: 1_000,
    halfOpenSuccesses: 1,
  }, () => now);
  breaker.acquire('primary');
  breaker.failure('primary', Object.assign(new Error('server'), { status: 503 }));
  breaker.acquire('primary');
  breaker.failure('primary', Object.assign(new Error('server'), { status: 503 }));
  assert.equal(breaker.health('primary').state, 'open');
  assert.throws(() => breaker.acquire('primary'), /熔断中/);
  now += 1_001;
  breaker.acquire('primary');
  assert.equal(breaker.health('primary').state, 'half_open');
  assert.throws(() => breaker.acquire('primary'), /探测已在进行/);
  breaker.success('primary');
  assert.equal(breaker.health('primary').state, 'closed');
  assert.equal(breaker.health('primary').failures, 0);

  const immediate = new ProviderCircuitBreaker({ failureThreshold: 3, openMs: 1_000 });
  immediate.acquire('rate-limited');
  immediate.failure('rate-limited', Object.assign(new Error('rate limited'), { status: 429 }));
  assert.equal(immediate.health('rate-limited').state, 'open');
  assert.throws(() => immediate.acquire('rate-limited'), /熔断中/);
});

test('Provider half-open recovery honors multiple required successful probes', () => {
  let now = Date.parse('2026-07-27T00:00:00.000Z');
  const breaker = new ProviderCircuitBreaker({
    failureThreshold: 1,
    openMs: 1,
    halfOpenSuccesses: 2,
  }, () => now);
  breaker.acquire('primary');
  breaker.failure('primary', Object.assign(new Error('server'), { status: 503 }));
  now += 2;

  breaker.acquire('primary');
  breaker.success('primary');
  assert.equal(breaker.health('primary').state, 'half_open');
  breaker.acquire('primary');
  breaker.success('primary');
  assert.equal(breaker.health('primary').state, 'closed');
  assert.equal(breaker.health('primary').lastFailure, undefined);
  assert.throws(
    () => new ProviderCircuitBreaker({ halfOpenSuccesses: 0 }),
    /halfOpenSuccesses 必须是正安全整数/,
  );
});

test('Provider failover attempts each configured route once and never after side effects', async () => {
  const breaker = new ProviderCircuitBreaker({ failureThreshold: 1, openMs: 1_000 });
  const coordinator = new ProviderFailoverCoordinator(breaker);
  const attempts: string[] = [];
  const result = await coordinator.execute([
    { id: 'primary', role: 'primary' },
    { id: 'backup', role: 'backup' },
  ], async (provider) => {
    attempts.push(provider.id);
    if (provider.role === 'primary') throw Object.assign(new Error('rate limited'), { status: 429 });
    return 'ok';
  }, { sideEffectsStarted: () => false });
  assert.deepEqual(attempts, ['primary', 'backup']);
  assert.deepEqual(result, { provider: 'backup', value: 'ok', attempts: 2 });

  let sideEffectsStarted = false;
  const protectedAttempts: string[] = [];
  await assert.rejects(coordinator.execute([
    { id: 'primary-2', role: 'primary' },
    { id: 'backup-2', role: 'backup' },
  ], async (provider) => {
    protectedAttempts.push(provider.id);
    sideEffectsStarted = true;
    throw Object.assign(new Error('network disconnected after tool call'), { code: 'ECONNRESET' });
  }, { sideEffectsStarted: () => sideEffectsStarted }), /副作用已经开始/);
  assert.deepEqual(protectedAttempts, ['primary-2']);
});

test('daily resource trends aggregate runs, tokens, cost and host budgets', () => {
  const trends = buildDailyResourceTrends([
    {
      at: '2026-07-27T01:00:00.000Z',
      runs: 8,
      inputTokens: 600,
      outputTokens: 400,
      costUsd: 2,
      cpuSeconds: 10,
      memoryBytes: 100,
      diskBytes: 200,
    },
    {
      at: '2026-07-27T02:00:00.000Z',
      runs: 5,
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 1,
      cpuSeconds: 5,
      memoryBytes: 150,
      diskBytes: 250,
    },
  ], {
    runs: 10,
    tokens: 1_000,
    costUsd: 10,
    cpuSeconds: 100,
    memoryBytes: 1_000,
    diskBytes: 1_000,
  }, 0);
  assert.equal(trends.length, 1);
  assert.equal(trends[0]?.runs, 13);
  assert.equal(trends[0]?.totalTokens, 1_300);
  assert.equal(trends[0]?.peakMemoryBytes, 150);
  assert.deepEqual(trends[0]?.alerts, ['runs_budget_exceeded', 'tokens_budget_exceeded']);
  assert.ok((processResourceSample(0).memoryBytes ?? 0) > 0);
  assert.ok(resourceHostSummary().cpuCount > 0);
  assert.throws(() => buildDailyResourceTrends([{
    at: 'invalid',
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    cpuSeconds: 0,
    memoryBytes: 0,
    diskBytes: 0,
  }]), /时间无效/);
});

test('missing cost and unpersisted host metrics remain explicitly unknown', () => {
  const [trend] = buildDailyResourceTrends([{
    at: '2026-07-27T01:00:00.000Z',
    runs: 1,
    inputTokens: 10,
    outputTokens: 5,
    costUsd: null,
    cpuSeconds: null,
    memoryBytes: null,
    diskBytes: null,
  } as never], DEFAULT_RESOURCE_BUDGETS, 0);

  assert.equal(trend?.costUsd, null);
  assert.equal(trend?.cpuSeconds, null);
  assert.equal(trend?.peakMemoryBytes, null);
  assert.equal(trend?.peakDiskBytes, null);
  assert.deepEqual(trend?.sampling, {
    cost: 'unknown',
    host: 'not_sampled',
  });
  assert.ok(!trend?.alerts.includes('cost_budget_exceeded'));

  const [mixed] = buildDailyResourceTrends([
    {
      at: '2026-07-27T02:00:00.000Z',
      runs: 1,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 1,
      cpuSeconds: 1,
      memoryBytes: 10,
      diskBytes: 20,
    },
    {
      at: '2026-07-27T03:00:00.000Z',
      runs: 1,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: null,
      cpuSeconds: null,
      memoryBytes: null,
      diskBytes: null,
    },
  ], DEFAULT_RESOURCE_BUDGETS, 0);
  assert.equal(mixed?.costUsd, null);
  assert.equal(mixed?.cpuSeconds, null);
  assert.equal(mixed?.sampling.host, 'not_sampled');
});

test('resource unknown semantics survive a Daemon store restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-resource-restart-'));
  const databaseFile = path.join(root, 'mimi.db');
  let store = new MimiStore(databaseFile);
  const now = new Date();
  const event = store.appendEvent({
    id: 'resource-event',
    externalId: 'resource-event',
    source: 'fixture',
    type: 'command.received',
    trust: 'owner',
    payload: {},
    profileId: 'owner',
    occurredAt: now.toISOString(),
    receivedAt: now.toISOString(),
  }).event;
  const task = store.enqueueTask({
    id: 'resource-task',
    type: 'background',
    idempotencyKey: 'resource-task',
    authorityEventId: event.id,
    profileId: 'owner',
    sessionKey: 'resource-session',
    objective: { prompt: 'fixture' },
    executor: 'isolated_worker',
    workspaceAccess: 'write',
    priority: 50,
  });
  const executionAt = new Date(now.getTime() + 1_000);
  const claimed = store.claimTaskById(task.id, 'resource-worker', 60_000, executionAt);
  assert.ok(claimed?.sessionKey);
  const attempt = store.beginTaskAttempt(
    task.id, 'resource-worker', claimed.sessionKey, 'resource-worker', executionAt,
  );
  store.completeTask(task.id, 'resource-worker', {
    answer: 'done',
    usage: { runInputTokens: 10, runOutputTokens: 5 },
  }, attempt.id, executionAt);
  const before = store.activitySnapshot(1).resourceTrends.at(-1);
  store.close();

  store = new MimiStore(databaseFile);
  try {
    const after = store.activitySnapshot(1).resourceTrends.at(-1);
    assert.deepEqual(after, before);
    assert.equal(after?.costUsd, null);
    assert.equal(after?.sampling.cost, 'unknown');
    assert.equal(after?.sampling.host, 'not_sampled');
  } finally {
    store.close();
  }
});
