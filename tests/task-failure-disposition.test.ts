import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RunFailureRecord } from '../src/core/run-failure.js';
import { classifyRunFailureRecord } from '../src/daemon/dispatcher-retry-policy.js';
import { MimiStore } from '../src/daemon/store.js';

const base = new Date('2026-08-02T13:00:00.000Z');

test('typed failure facts alone choose failed, retry, and dead-letter terminal states', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-failure-disposition-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const authority = store.appendEvent({
      id: 'failure-authority', externalId: 'failure-authority', source: 'fixture',
      type: 'command.received', trust: 'owner', payload: {}, profileId: 'owner',
      occurredAt: base.toISOString(), receivedAt: base.toISOString(),
    }).event;
    const create = (id: string, maxAttempts = 5) => store.enqueueTask({
      id,
      type: 'background',
      idempotencyKey: id,
      authorityEventId: authority.id,
      profileId: 'owner',
      sessionKey: `mimi-${id}`,
      objective: {},
      executor: 'isolated_worker',
      workspaceAccess: 'read',
      priority: 50,
      maxAttempts,
    });
    const fail = (
      id: string,
      owner: string,
      failure: RunFailureRecord,
      at: Date,
    ) => {
      const claimed = store.claimTaskById(id, owner, 60_000, at);
      assert.ok(claimed);
      const attempt = store.beginTaskAttempt(id, owner, claimed.sessionKey!, owner, at);
      return store.failTask(id, owner, new Error('same explanation for every case'), failure, attempt.id, at);
    };

    create('deterministic');
    const deterministicFailure: RunFailureRecord = {
      code: 'fixture.validation',
      disposition: {
        phase: 'pre_dispatch', kind: 'validation', retryable: false, dispatchStarted: false,
      },
    };
    const deterministic = fail('deterministic', 'deterministic-worker', deterministicFailure, base);
    assert.equal(deterministic.status, 'failed');
    assert.deepEqual(deterministic.failure, deterministicFailure);
    assert.equal(deterministic.attemptCount, 1);

    create('transient', 2);
    const transientFailure: RunFailureRecord = {
      code: 'provider.connection_reset',
      disposition: {
        phase: 'provider', kind: 'transient', retryable: true, dispatchStarted: false,
      },
    };
    assert.equal(fail('transient', 'transient-worker-1', transientFailure, base).status, 'queued');
    const exhausted = fail(
      'transient', 'transient-worker-2', transientFailure, new Date(base.getTime() + 2_000),
    );
    assert.equal(exhausted.status, 'dead_letter');
    assert.deepEqual(exhausted.failure, transientFailure);

    create('uncertain');
    const uncertainFailure: RunFailureRecord = {
      code: 'connector.delivery_uncertain',
      disposition: {
        phase: 'dispatch', kind: 'uncertain', retryable: false, dispatchStarted: true,
      },
    };
    assert.equal(fail('uncertain', 'uncertain-worker', uncertainFailure, base).status, 'dead_letter');

    create('keyword-only');
    const keywordOnly = classifyRunFailureRecord(new Error('uncertain timeout provider retry me'));
    assert.equal(keywordOnly.disposition.kind, 'unclassified');
    assert.equal(fail('keyword-only', 'keyword-worker', keywordOnly, base).status, 'failed');

    const activity = store.activitySnapshot(20);
    assert.equal(activity.failureClassification.unclassifiedDeadLetters, 0);
    assert.deepEqual(
      activity.failureClassification.deadLetters.map((item) => item.category).sort(),
      ['provider', 'uncertain_side_effect'],
    );
  } finally {
    store.close();
  }
});
