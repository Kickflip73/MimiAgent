import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MimiStore } from '../src/daemon/store.js';
import type { TaskInput } from '../src/daemon/types.js';

const base = new Date('2026-07-24T10:00:00.000Z');

async function fixture(name: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const authority = store.appendEvent({
    id: `${name}-authority`,
    externalId: `${name}-authority`,
    source: 'local-cli',
    type: 'command.received',
    trust: 'owner',
    payload: { prompt: 'authority' },
    profileId: 'owner',
    replyRoute: { channel: 'connector:test', target: 'owner' },
    occurredAt: base.toISOString(),
    receivedAt: base.toISOString(),
  }).event;
  return { store, authority };
}

function taskInput(
  authorityEventId: string,
  id: string,
  overrides: Partial<TaskInput> = {},
): TaskInput {
  return {
    id,
    type: 'background',
    idempotencyKey: id,
    authorityEventId,
    profileId: 'owner',
    sessionKey: `session-${id}`,
    objective: { objective: id },
    executor: 'isolated_worker',
    workspaceAccess: 'write',
    priority: 50,
    notBefore: base.toISOString(),
    maxAttempts: 3,
    ...overrides,
  };
}

test('v12 task lifecycle enforces idempotency, selectors, leases, attempts, and atomic delivery', async () => {
  const { store, authority } = await fixture('mimi-store-lifecycle-v12');
  try {
    const low = store.enqueueTask(taskInput(authority.id, 'low', { priority: 10, executor: 'codex' }));
    const high = store.enqueueTask(taskInput(authority.id, 'high', { priority: 90 }));
    assert.equal(store.enqueueTask(taskInput(authority.id, 'high', { priority: 90 })).id, high.id);
    assert.throws(
      () => store.enqueueTask(taskInput(authority.id, 'conflict', { idempotencyKey: 'high' })),
      /幂等键冲突/,
    );
    const executorOwned = store.enqueueTask(taskInput(authority.id, 'executor-owned', {
      type: 'conversation', executor: 'isolated_worker', workspaceAccess: 'write',
      notBefore: new Date(base.getTime() + 60 * 60_000).toISOString(),
    }));
    assert.equal(executorOwned.executor, 'isolated_worker');
    assert.throws(
      () => store.enqueueTask(taskInput(authority.id, 'invalid-briefing', {
        type: 'briefing', executor: 'isolated_worker', workspaceAccess: 'write',
      })),
      /briefing.*workspaceAccess=read/,
    );
    assert.deepEqual(store.readyTasks({}, 10, base).map((candidate) => candidate.id), ['high', 'low']);
    assert.deepEqual(store.readyTasks({ executor: 'codex' }, 10, base).map((candidate) => candidate.id), ['low']);
    assert.deepEqual(
      store.readyTasks({ excludedSessionKeys: [high.sessionKey!] }, 10, base).map((candidate) => candidate.id),
      ['low'],
    );

    const claimed = store.claimTask('worker-1', { executor: 'isolated_worker' }, 60_000, base);
    assert.equal(claimed?.id, high.id);
    assert.equal(store.runningTasks().length, 1);
    assert.equal(store.claimTaskById(high.id, 'worker-2', 60_000, base), undefined);
    assert.equal(store.renewTaskLease(high.id, 'worker-1', 120_000, new Date(base.getTime() + 1_000)), true);
    assert.equal(store.renewTaskLease(high.id, 'wrong-owner', 120_000, new Date(base.getTime() + 1_000)), false);
    store.bindRunningTaskSession(high.id, 'worker-1', 'bound-session', new Date(base.getTime() + 2_000));
    const attempt = store.beginTaskAttempt(
      high.id,
      'worker-1',
      'bound-session',
      'worker-process',
      new Date(base.getTime() + 3_000),
    );
    assert.equal(attempt.attemptNo, 1);
    assert.throws(
      () => store.beginTaskAttempt(high.id, 'wrong-owner', 'bound-session', 'worker', base),
      /租约已失效/,
    );

    const completed = store.completeTask(
      high.id,
      'worker-1',
      { answer: 'done' },
      attempt.id,
      new Date(base.getTime() + 4_000),
      { route: { channel: 'connector:test', target: 'owner' }, payload: { text: 'done' } },
    );
    assert.equal(completed.status, 'completed');
    assert.equal(store.runs.get(attempt.id)?.status, 'completed');
    assert.equal(store.outbox.listSummaries().length, 1);
    assert.equal(store.runs.listSummaries().length, 1);
    assert.equal(store.runs.listSummaries()[0]?.answerAvailable, true);
    assert.throws(
      () => store.completeTask(high.id, 'worker-1', {}, undefined, new Date(base.getTime() + 5_000)),
      /租约已失效/,
    );

    const message = store.outbox.claim('delivery-1', 60_000, new Date(base.getTime() + 5_000));
    assert.ok(message);
    assert.equal(store.outbox.claim('delivery-2', 60_000, new Date(base.getTime() + 5_000)), undefined);
    store.outbox.complete(message.id, 'delivery-1');
    assert.equal(store.outbox.get(message.id)?.status, 'sent');
    assert.throws(() => store.outbox.complete(message.id, 'delivery-1'), /租约已失效/);
  } finally {
    store.close();
  }
});

test('pause, resume, block, cancel, and safe-boundary control preserve Task ownership', async () => {
  const { store, authority } = await fixture('mimi-store-control-v12');
  try {
    const queued = store.enqueueTask(taskInput(authority.id, 'queued-control'));
    assert.equal(store.pauseTask(queued.id, 'pause queued', base).status, 'paused');
    assert.equal(store.pauseTask(queued.id, 'again', base).status, 'paused');
    assert.equal(store.resumeTask(queued.id, 'new context', new Date(base.getTime() + 1_000)).status, 'queued');
    assert.match(JSON.stringify(store.getTask(queued.id)?.objective), /new context/);

    const running = store.claimTaskById(queued.id, 'worker', 60_000, new Date(base.getTime() + 2_000))!;
    const attempt = store.beginTaskAttempt(
      running.id,
      'worker',
      running.sessionKey!,
      'worker',
      new Date(base.getTime() + 3_000),
    );
    assert.equal(store.pauseTask(running.id, 'safe pause', new Date(base.getTime() + 4_000)).controlIntent, 'pause');
    assert.deepEqual(store.taskControl(running.id), { intent: 'pause', reason: 'safe pause' });
    assert.equal(store.renewTaskLease(running.id, 'worker', 60_000, new Date(base.getTime() + 5_000)), false);
    assert.equal(
      store.settleTaskControl(running.id, 'worker', attempt.id, new Date(base.getTime() + 6_000))?.status,
      'paused',
    );
    assert.equal(store.runs.get(attempt.id)?.status, 'interrupted');
    assert.equal(store.settleTaskControl(running.id, 'worker'), undefined);

    store.resumeTask(running.id, undefined, new Date(base.getTime() + 7_000));
    const reclaimed = store.claimTaskById(running.id, 'worker-2', 60_000, new Date(base.getTime() + 8_000))!;
    const secondAttempt = store.beginTaskAttempt(
      reclaimed.id,
      'worker-2',
      reclaimed.sessionKey!,
      'worker-2',
      new Date(base.getTime() + 9_000),
    );
    assert.equal(store.cancelTask(reclaimed.id, 'owner cancelled', new Date(base.getTime() + 10_000)).controlIntent, 'cancel');
    assert.equal(store.pauseTask(reclaimed.id, 'pause loses', new Date(base.getTime() + 11_000)).controlIntent, 'cancel');
    assert.equal(
      store.settleTaskControl(reclaimed.id, 'worker-2', secondAttempt.id, new Date(base.getTime() + 12_000))?.status,
      'cancelled',
    );

    const blocked = store.enqueueTask(taskInput(authority.id, 'blocked-control'));
    store.claimTaskById(blocked.id, 'blocker', 60_000, new Date(base.getTime() + 13_000));
    const blockedAttempt = store.beginTaskAttempt(
      blocked.id,
      'blocker',
      blocked.sessionKey!,
      'blocker',
      new Date(base.getTime() + 14_000),
    );
    assert.equal(store.blockTask(
      blocked.id,
      'blocker',
      { question: 'need input' },
      'missing input',
      blockedAttempt.id,
      new Date(base.getTime() + 15_000),
    ).status, 'blocked');
    assert.equal(store.resumeTask(blocked.id, 'provided input', new Date(base.getTime() + 16_000)).status, 'queued');
    assert.equal(store.cancelTask(blocked.id, 'no longer needed', new Date(base.getTime() + 17_000)).status, 'cancelled');
    assert.equal(store.cancelTask(blocked.id).status, 'cancelled');
    assert.throws(() => store.resumeTask(blocked.id), /不是可恢复状态/);
  } finally {
    store.close();
  }
});

test('retry, preemption, terminal failure, and dead-letter recovery are explicit', async () => {
  const { store, authority } = await fixture('mimi-store-failure-v12');
  try {
    const retry = store.enqueueTask(taskInput(authority.id, 'retry-task', { maxAttempts: 3 }));
    store.claimTaskById(retry.id, 'worker-1', 60_000, base);
    const firstAttempt = store.beginTaskAttempt(retry.id, 'worker-1', retry.sessionKey!, 'worker-1', base);
    const requeued = store.requeueTask(
      retry.id,
      'worker-1',
      'host shutdown',
      firstAttempt.id,
      new Date(base.getTime() + 1_000),
    );
    assert.equal(requeued.status, 'queued');
    store.claimTaskById(retry.id, 'worker-2', 60_000, new Date(base.getTime() + 2_000));
    const secondAttempt = store.beginTaskAttempt(
      retry.id,
      'worker-2',
      retry.sessionKey!,
      'worker-2',
      new Date(base.getTime() + 3_000),
    );
    const preempted = store.preemptTask(
      retry.id,
      'worker-2',
      'urgent owner command',
      secondAttempt.id,
      new Date(base.getTime() + 4_000),
    );
    assert.equal(preempted.status, 'queued');
    assert.equal(preempted.maxAttempts, 4);

    store.claimTaskById(retry.id, 'worker-3', 60_000, new Date(base.getTime() + 5_000));
    const thirdAttempt = store.beginTaskAttempt(
      retry.id,
      'worker-3',
      retry.sessionKey!,
      'worker-3',
      new Date(base.getTime() + 6_000),
    );
    const failed = store.failTask(
      retry.id,
      'worker-3',
      new Error('provider rejected request'),
      {
        code: 'provider.rejected',
        disposition: {
          phase: 'provider', kind: 'validation', retryable: false, dispatchStarted: false,
        },
      },
      thirdAttempt.id,
      new Date(base.getTime() + 7_000),
    );
    assert.equal(failed.status, 'failed');
    assert.equal(store.runs.get(thirdAttempt.id)?.status, 'failed');

    const dead = store.enqueueTask(taskInput(authority.id, 'dead-task', { maxAttempts: 1 }));
    store.claimTaskById(dead.id, 'worker-dead', 60_000, new Date(base.getTime() + 8_000));
    const deadAttempt = store.beginTaskAttempt(
      dead.id,
      'worker-dead',
      dead.sessionKey!,
      'worker-dead',
      new Date(base.getTime() + 9_000),
    );
    assert.equal(store.failTask(
      dead.id,
      'worker-dead',
      'permanent failure',
      {
        code: 'provider.exhausted',
        disposition: {
          phase: 'provider', kind: 'transient', retryable: true, dispatchStarted: false,
        },
      },
      deadAttempt.id,
      new Date(base.getTime() + 10_000),
    ).status, 'dead_letter');
    assert.equal(store.retryDeadLetterTask(dead.id, new Date(base.getTime() + 11_000)).status, 'queued');
    assert.throws(() => store.retryDeadLetterTask(dead.id), /不是 dead letter/);
    assert.equal(store.listEventSummaries(5).length, 5);
    assert.ok(store.counts().tasks.failed >= 1);
  } finally {
    store.close();
  }
});

test('Outbox retries are route-scoped and terminal delivery creates one system fallback', async () => {
  const { store, authority } = await fixture('mimi-store-outbox-v12');
  try {
    const completeWithDelivery = (id: string, target: string) => {
      const queued = store.enqueueTask(taskInput(authority.id, id));
      store.claimTaskById(queued.id, `worker-${id}`, 60_000, base);
      return store.completeTask(
        queued.id,
        `worker-${id}`,
        { answer: id },
        undefined,
        new Date(base.getTime() + 1_000),
        { route: { channel: 'connector:test', target }, payload: { text: id } },
      );
    };
    completeWithDelivery('delivery-a', 'a');
    completeWithDelivery('delivery-b', 'b');
    const first = store.outbox.claim('sender-a', 60_000, new Date(base.getTime() + 2_000), [
      { channel: 'connector:test', target: 'b' },
    ]);
    assert.equal(first?.target, 'a');
    store.outbox.fail(first!.id, 'sender-a', 'temporary', 2, new Date(base.getTime() + 3_000));
    assert.equal(store.outbox.get(first!.id)?.status, 'pending');

    const retryAt = new Date(base.getTime() + 5_000);
    const retried = store.outbox.claim('sender-a2', 60_000, retryAt, [
      { channel: 'connector:test', target: 'b' },
    ]);
    assert.equal(retried?.id, first?.id);
    store.outbox.fail(retried!.id, 'sender-a2', 'terminal', 2, new Date(base.getTime() + 6_000));
    assert.equal(store.outbox.get(retried!.id)?.status, 'dead_letter');
    assert.ok(store.outbox.listSummaries().some((message) => message.channel === 'system'));
    assert.equal(store.outbox.retryDeadLetter(retried!.id, new Date(base.getTime() + 7_000)).status, 'pending');

    const pending = store.outbox.claim('sender-a3', 60_000, new Date(base.getTime() + 8_000), [
      { channel: 'connector:test', target: 'b' },
      { channel: 'system' },
    ]);
    assert.equal(pending?.id, retried?.id);
    store.outbox.fail(pending!.id, 'sender-a3', 'terminal again', 1, new Date(base.getTime() + 9_000));
    assert.equal(store.outbox.archiveDeadLetter(pending!.id, new Date(base.getTime() + 10_000)).status, 'archived');
    assert.throws(() => store.outbox.archiveDeadLetter(pending!.id), /不是 dead letter/);
    assert.ok(store.outbox.listSummaries().length >= 3);
  } finally {
    store.close();
  }
});

test('schedules retain authority, wake matching watches, emit once, and cancel queued occurrences', async () => {
  const { store, authority } = await fixture('mimi-store-schedule-v12');
  try {
    const watch = store.schedules.add({
      name: 'watch build',
      type: 'watch',
      value: '60000',
      prompt: 'check build',
      profileId: 'owner',
      sessionKey: 'schedule-session',
      authorityEventId: authority.id,
      replyRoute: { channel: 'system' },
      trust: 'owner',
      nextRunAt: new Date(base.getTime() + 60_000).toISOString(),
    });
    const at = store.schedules.add({
      name: 'one shot',
      type: 'at',
      value: base.toISOString(),
      prompt: 'run once',
      profileId: 'owner',
      authorityEventId: authority.id,
      trust: 'owner',
      nextRunAt: base.toISOString(),
    });
    assert.equal(store.schedules.count(), 2);
    const revision = store.schedules.revision();
    assert.equal(store.schedules.wake('other-session', 'trigger', base), 0);
    assert.equal(store.schedules.wake('schedule-session', 'trigger', base), 1);
    assert.notEqual(store.schedules.revision(), revision);
    const emitted = store.schedules.emitDue(new Date(base.getTime() + 1_000));
    assert.equal(emitted.length, 2);
    assert.equal(store.schedules.get(at.id)?.enabled, false);
    assert.equal(store.schedules.get(watch.id)?.enabled, true);
    assert.equal(store.schedules.listSummaries(1, 0).length, 1);
    assert.equal(store.schedules.remove(watch.id, new Date(base.getTime() + 2_000)), true);
    assert.equal(store.schedules.remove(watch.id), false);
    assert.equal(store.schedules.count(), 1);
    assert.equal(store.listTasks().filter((candidate) => candidate.status === 'cancelled').length, 1);

    assert.throws(() => store.schedules.add({
      name: 'external without authority',
      type: 'at',
      value: base.toISOString(),
      prompt: 'unsafe',
      profileId: 'owner',
      trust: 'external',
      nextRunAt: base.toISOString(),
    }), /必须保留/);
  } finally {
    store.close();
  }
});
