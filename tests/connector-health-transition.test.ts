import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MimiStore } from '../src/daemon/store.js';

const base = new Date('2026-08-02T12:00:00.000Z');

function state(
  status: 'ready' | 'unavailable' | 'stale' | 'unknown',
  reasonCode?: string,
) {
  return {
    connectorId: 'fixture',
    connectorSource: 'connector:fixture',
    status,
    reasonCode,
    automaticRestart: true,
    profileId: 'owner',
    sessionKey: 'mimi-connector-health-fixture',
    eventsEnabled: true,
  } as const;
}

test('10,000 unchanged Connector heartbeats create no Event, Task, Run, or Digest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connector-health-unchanged-'));
  const file = path.join(root, 'mimi.db');
  let store = new MimiStore(file);
  try {
    for (let index = 0; index < 10_000; index += 1) {
      assert.equal(store.recordConnectorHealthState(state('ready'), base), undefined);
    }
    assert.equal(store.listEventSummaries(200).length, 0);
    assert.equal(store.listTasks(200).length, 0);
    assert.equal(store.countRunsSince(new Date(0)), 0);
    assert.equal(store.pendingDigestCount(), 0);
  } finally {
    store.close();
  }

  store = new MimiStore(file);
  try {
    assert.equal(store.recordConnectorHealthState(state('ready'), base), undefined);
    assert.equal(store.listEventSummaries(200).length, 0);
    assert.equal(store.listTasks(200).length, 0);
  } finally {
    store.close();
  }
});

test('Connector health emits only degradation, reason change, state change, and recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connector-health-transition-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    assert.equal(store.recordConnectorHealthState(state('ready'), base), undefined);
    assert.equal(
      store.pruneHistory(new Date(base.getTime() + 365 * 24 * 60 * 60_000)).attentionState,
      0,
    );
    assert.ok(store.recordConnectorHealthState(state('unavailable', 'target_not_bound'), base));
    assert.equal(store.recordConnectorHealthState(state('unavailable', 'target_not_bound'), base), undefined);
    assert.ok(store.recordConnectorHealthState(state('unavailable', 'account_expired'), base));
    assert.ok(store.recordConnectorHealthState(state('stale', 'readiness_expired'), base));
    assert.ok(store.recordConnectorHealthState(state('ready'), base));
    assert.equal(store.recordConnectorHealthState(state('ready'), base), undefined);

    const healthEvents = store.listEventSummaries(200)
      .filter((event) => event.source === 'system:connector-health')
      .reverse()
      .map((event) => store.getImmutableEvent(event.id))
      .filter((event) => event !== undefined);
    assert.equal(healthEvents.length, 4);
    assert.deepEqual(healthEvents.map((event) => (
      (event.payload as { connectorHealth: { status: string } }).connectorHealth.status
    )), ['unavailable', 'unavailable', 'stale', 'recovered']);
    assert.equal(store.listTasks(200).length, 4);
    assert.equal(store.countRunsSince(new Date(0)), 0);
  } finally {
    store.close();
  }
});
