import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MimiDispatcher } from '../src/daemon/dispatcher.js';
import type { AttentionEngine } from '../src/daemon/attention.js';
import { MimiStore } from '../src/daemon/store.js';
import { MimiHost } from '../src/runtime/mimi-host.js';
import type { MimiAgent } from '../src/runtime/mimi-agent.js';

test('dispatcher control surface is idempotent for missing, queued, paused, and terminal tasks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-control-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const host = new MimiHost({ currentSessionId: 'primary-session' } as MimiAgent, {
    execute: async () => ({ answer: 'unused', effects: [] }),
  });
  let routines = 0;
  let briefings = 0;
  const attention = {
    maintenance: { enabled: false, historyRetentionDays: 90, intervalHours: 24 },
    emitDueRoutines: () => { routines += 1; },
    emitDueBriefings: () => { briefings += 1; },
  } as unknown as AttentionEngine;
  const dispatcher = new MimiDispatcher(store, host, attention, undefined, undefined, {
    pollMs: 1,
    maxConcurrentTasks: 1,
  });
  try {
    const now = new Date().toISOString();
    const event = store.appendEvent({
      id: 'event',
      externalId: 'event',
      source: 'local-cli',
      type: 'command.received',
      trust: 'owner',
      payload: {},
      profileId: 'owner',
      occurredAt: now,
      receivedAt: now,
    }).event;
    const background = store.enqueueTask({
      id: 'background',
      type: 'background',
      idempotencyKey: 'background',
      authorityEventId: event.id,
      profileId: 'owner',
      objective: {},
      executor: 'isolated_worker',
      workspaceAccess: 'write',
      priority: 50,
    });
    const conversation = store.enqueueTask({
      id: 'conversation',
      type: 'conversation',
      idempotencyKey: 'conversation',
      authorityEventId: event.id,
      profileId: 'owner',
      objective: {},
      executor: 'session_actor',
      workspaceAccess: 'write',
      priority: 50,
    });

    assert.deepEqual(dispatcher.cancel('missing'), { state: 'not_found' });
    assert.deepEqual(dispatcher.pause(conversation.id), { state: 'not_found' });
    assert.deepEqual(dispatcher.pause(background.id, ' owner pause '), { state: 'paused' });
    assert.deepEqual(dispatcher.pause(background.id), { state: 'already_paused' });
    assert.equal(store.getTask(background.id)?.controlReason, 'owner pause');
    assert.deepEqual(dispatcher.cancel(background.id, ' owner cancel '), { state: 'cancelled' });
    assert.deepEqual(dispatcher.cancel(background.id), { state: 'already_terminal' });
    assert.deepEqual(dispatcher.pause(background.id), { state: 'already_terminal' });
    assert.deepEqual(dispatcher.cancel(conversation.id, 'cancel queued'), { state: 'cancelled' });

    const status = dispatcher.status();
    assert.equal(status.activeEventCount, 0);
    assert.equal(status.activeEventIds?.length, 0);
    assert.equal(status.tasks.cancelled, 2);
    assert.equal(await dispatcher.processTaskById('missing'), false);
    assert.equal(await dispatcher.processOnce(), false);
    assert.ok(routines >= 1);
    assert.ok(briefings >= 1);

    dispatcher.start();
    dispatcher.start();
    await dispatcher.stop();
    dispatcher.forceStop('already stopped');
  } finally {
    store.close();
  }
});
