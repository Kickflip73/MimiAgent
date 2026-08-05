import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectorCapability } from '../src/daemon/connectors.js';
import {
  buildDaemonHealth,
  doctorBlockingHealthRisks,
} from '../src/daemon/health-model.js';
import type { OutboxStatus, TaskStatus } from '../src/daemon/types.js';

function taskCounts(overrides: Partial<Record<TaskStatus, number>> = {}): Record<TaskStatus, number> {
  return {
    queued: 0,
    running: 0,
    paused: 0,
    blocked: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    dead_letter: 0,
    ...overrides,
  };
}

function outboxCounts(overrides: Partial<Record<OutboxStatus, number>> = {}): Record<OutboxStatus, number> {
  return {
    pending: 0,
    sending: 0,
    sent: 0,
    dead_letter: 0,
    archived: 0,
    ...overrides,
  };
}

function connector(
  id: string,
  options: Partial<ConnectorCapability> = {},
): ConnectorCapability {
  return {
    id,
    enabled: true,
    online: true,
    readiness: { inbound: 'ready', outbound: 'ready' },
    source: `connector:${id}`,
    trust: 'trusted',
    claimedComputerApps: [],
    actions: [],
    ...options,
  };
}

test('reports ready only when durable backlogs and enabled connectors are healthy', () => {
  const health = buildDaemonHealth({
    tasks: taskCounts(),
    outbox: outboxCounts(),
    pendingDigest: 2,
    connectors: [connector('mail')],
    checkedAt: '2026-07-24T00:00:00.000Z',
  });

  assert.equal(health.state, 'ready');
  assert.deepEqual(health.risks, []);
  assert.deepEqual(health.backlog, {
    tasks: 0,
    outbox: 0,
    digest: 2,
    taskDeadLetters: 0,
    outboxDeadLetters: 0,
  });
  assert.deepEqual(health.connectors, {
    enabled: 1,
    online: 1,
    ready: 1,
    offline: [],
    unavailable: [],
    stale: [],
    unknown: [],
  });
});

test('distinguishes an online process from degraded connector readiness and capacity risk', () => {
  const health = buildDaemonHealth({
    tasks: taskCounts({ queued: 99, running: 1 }),
    outbox: outboxCounts({ pending: 100 }),
    pendingDigest: 100,
    connectors: [
      connector('offline', { online: false }),
      connector('unavailable', {
        readiness: { inbound: 'unavailable', outbound: 'unavailable' },
      }),
      connector('unknown', {
        readiness: { inbound: 'unknown', outbound: 'ready' },
      }),
      connector('stale', {
        readiness: {
          inbound: 'ready',
          outbound: 'ready',
          reportedAt: '2026-07-24T00:00:00.000Z',
          freshUntil: '2026-07-24T00:01:00.000Z',
          stale: true,
        },
      }),
    ],
  });

  assert.equal(health.state, 'degraded');
  assert.deepEqual(health.risks.map((risk) => risk.code), [
    'task_backlog',
    'outbox_backlog',
    'digest_backlog',
    'connector_offline',
    'connector_unavailable',
    'connector_stale',
    'connector_readiness_unknown',
  ]);
  assert.deepEqual(health.connectors.offline, ['offline']);
  assert.deepEqual(health.connectors.unavailable, ['unavailable']);
  assert.deepEqual(health.connectors.stale, ['stale']);
  assert.deepEqual(health.connectors.unknown, ['unknown']);
});

test('retained dead letters degrade daemon health without implying the process is down', () => {
  const health = buildDaemonHealth({
    tasks: taskCounts({ dead_letter: 2 }),
    outbox: outboxCounts({ dead_letter: 3 }),
  });

  assert.equal(health.state, 'degraded');
  assert.deepEqual(health.risks.map((risk) => ({
    code: risk.code,
    severity: risk.severity,
    nextAction: risk.nextAction,
  })), [
    { code: 'task_dead_letters', severity: 'warning', nextAction: 'mimi daemon tasks' },
    { code: 'outbox_dead_letters', severity: 'warning', nextAction: 'mimi daemon outbox' },
  ]);
});

test('Doctor keeps retained classified dead letters visible without treating them as a current blocker', () => {
  const health = buildDaemonHealth({
    tasks: taskCounts({ dead_letter: 2 }),
    outbox: outboxCounts(),
  });

  assert.equal(health.state, 'degraded');
  assert.deepEqual(doctorBlockingHealthRisks(health, 0), []);
  assert.deepEqual(
    doctorBlockingHealthRisks(health, 1).map((risk) => risk.code),
    ['task_dead_letters'],
  );
});

test('Doctor keeps safely throttled autonomous budgets visible without blocking owner work', () => {
  const health = buildDaemonHealth({
    tasks: taskCounts(),
    outbox: outboxCounts(),
    autonomousBudgetExhaustions: 4,
  });

  assert.equal(health.state, 'degraded');
  assert.deepEqual(health.risks.map((risk) => risk.code), ['autonomous_budget_exhausted']);
  assert.deepEqual(doctorBlockingHealthRisks(health, 0), []);
});

test('Task worker runtime dependency failure is an unhealthy fail-closed risk', () => {
  const health = buildDaemonHealth({
    tasks: taskCounts(),
    outbox: outboxCounts(),
    taskWorkerRuntime: {
      ready: false,
      reason: 'Task worker runtime 缺少 @openai/agents',
    },
  });

  assert.equal(health.state, 'unhealthy');
  assert.deepEqual(health.risks, [{
    code: 'task_worker_runtime_unavailable',
    severity: 'error',
    message: 'Task worker runtime 缺少 @openai/agents',
    nextAction: '修复 Task worker 依赖或 LaunchAgent 运行路径后重启 MimiAgent',
  }]);
});

test('Computer supervisor outage is unhealthy until Cua Driver recovers', () => {
  const health = buildDaemonHealth({
    tasks: taskCounts(),
    outbox: outboxCounts(),
    computer: {
      configured: true,
      state: 'recovering',
      ready: false,
      managed: true,
      launchAttempts: 2,
      recoveries: 1,
      consecutiveFailures: 1,
      lastFailure: 'daemon is not running',
    },
  });

  assert.equal(health.state, 'unhealthy');
  assert.deepEqual(health.risks, [{
    code: 'computer_unavailable',
    severity: 'error',
    message: 'Computer Use recovering：daemon is not running',
    nextAction: 'mimi daemon doctor',
  }]);
});

test('Computer transport health does not claim UI readiness before a real observation', () => {
  const health = buildDaemonHealth({
    tasks: taskCounts(),
    outbox: outboxCounts(),
    computer: {
      configured: true,
      state: 'ready',
      ready: false,
      transportReady: true,
      operationalReadiness: 'unknown',
      managed: true,
      launchAttempts: 0,
      recoveries: 0,
      consecutiveFailures: 0,
    },
  });

  assert.equal(health.state, 'unhealthy');
  assert.match(health.risks[0]?.message ?? '', /尚无真实窗口 observation/);
});

test('Computer degraded UI readiness reports the observation failure', () => {
  const health = buildDaemonHealth({
    tasks: taskCounts(),
    outbox: outboxCounts(),
    computer: {
      configured: true,
      state: 'ready',
      ready: false,
      transportReady: true,
      operationalReadiness: 'degraded',
      lastOperationalFailure: 'observation_unusable: ax_window_unresolved',
      managed: true,
      launchAttempts: 0,
      recoveries: 0,
      consecutiveFailures: 0,
    },
  });

  assert.equal(health.state, 'unhealthy');
  assert.match(health.risks[0]?.message ?? '', /UI 路径退化.*ax_window_unresolved/);
});
