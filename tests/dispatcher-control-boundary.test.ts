import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import {
  MimiDispatcher,
  runStreamMakesObservableProgress,
} from '../src/daemon/dispatcher.js';
import { AttentionEngine } from '../src/daemon/attention.js';
import type { ConnectorManager } from '../src/daemon/connectors.js';
import { MimiStore } from '../src/daemon/store.js';
import {
  attachRunFinalization,
  createRunFinalization,
} from '../src/core/run-finalization.js';
import { RunFailureError } from '../src/core/run-failure.js';
import { MimiHost } from '../src/runtime/mimi-host.js';
import type { MimiAgent } from '../src/runtime/mimi-agent.js';

test('dispatcher idle progress ignores provider keepalives without observable progress', () => {
  assert.equal(runStreamMakesObservableProgress({
    type: 'raw_model_stream_event',
    data: { type: 'model', event: {} },
  } as never), false);
  assert.equal(runStreamMakesObservableProgress({
    type: 'raw_model_stream_event',
    data: { type: 'output_text_delta', delta: '' },
  } as never), false);
  assert.equal(runStreamMakesObservableProgress({
    type: 'raw_model_stream_event',
    data: { type: 'model', event: { choices: [{ delta: { reasoning_content: '' } }] } },
  } as never), false);
  assert.equal(runStreamMakesObservableProgress({
    type: 'raw_model_stream_event',
    data: { type: 'output_text_delta', delta: 'done' },
  } as never), true);
  assert.equal(runStreamMakesObservableProgress({
    type: 'raw_model_stream_event',
    data: { type: 'model', event: { choices: [{ delta: { reasoning_content: 'thinking' } }] } },
  } as never), true);
  assert.equal(runStreamMakesObservableProgress({
    type: 'run_item_stream_event',
    name: 'tool_output',
    item: { rawItem: { name: 'inspect_mimi_activity' }, output: { ok: true } },
  } as never), true);
});

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

test('dispatcher publishes completion only after host bookkeeping leaves the active boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-completion-boundary-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  let releaseFinalization!: () => void;
  const finalizationReleased = new Promise<void>((resolve) => { releaseFinalization = resolve; });
  let reportFinalizationStarted!: () => void;
  const finalizationStarted = new Promise<void>((resolve) => { reportFinalizationStarted = resolve; });
  const agent = {
    currentSessionId: 'owner',
    currentCapabilitySnapshot: () => undefined,
    completedExecution: async () => undefined,
    finalizeExecutionLedger: async () => {
      reportFinalizationStarted();
      await finalizationReleased;
    },
    reopenExecutionLedger: async () => undefined,
  } as unknown as MimiAgent;
  const answer = 'provider switch scheduled';
  const finalization = createRunFinalization({ runId: 'run-provider', answer, calls: [] });
  const host = new MimiHost(agent, {
    execute: async () => {
      return {
        answer,
        effects: [{ type: 'provider_change_requested', provider: 'openai-compatible' }],
        finalization,
      };
    },
  });
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const dispatcher = new MimiDispatcher(store, host, attention);
  try {
    const now = new Date().toISOString();
    const routed = store.ingestEvent({
      id: 'provider-switch-event',
      externalId: 'provider-switch-event',
      source: 'local-cli',
      kind: 'command',
      trust: 'owner',
      payload: { prompt: '切换 Provider' },
      occurredAt: now,
      receivedAt: now,
      priority: 100,
      profileId: 'owner',
      sessionKey: 'owner',
      replyRoute: { channel: 'system' },
    });
    assert.ok(routed.task);

    const processing = dispatcher.processTaskById(routed.task.id);
    await finalizationStarted;

    assert.equal(store.getTask(routed.task.id)?.status, 'running');
    assert.equal(dispatcher.status().activeEventCount, 1);
    assert.equal(dispatcher.status().activeToolCount, 0);

    releaseFinalization();
    assert.equal(await processing, true);
    assert.equal(store.getTask(routed.task.id)?.status, 'completed');
    const taskFinalization = (store.getTask(routed.task.id)?.result as {
      finalization?: unknown;
    }).finalization;
    assert.deepEqual(taskFinalization, finalization);
    const outboxId = store.outbox.listSummaries()[0]!.id;
    assert.deepEqual((store.outbox.get(outboxId)?.payload as { finalization?: unknown }).finalization, finalization);
    assert.equal(dispatcher.status().activeEventCount, 0);
    assert.equal(dispatcher.status().activeToolCount, 0);
  } finally {
    releaseFinalization();
    store.close();
  }
});

test('dispatcher persists the Host failure Finalization on the terminal Task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-failure-finalization-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const answer = 'Host 终态：outcome=failed';
  const finalization = createRunFinalization({
    runId: 'run-failed',
    answer,
    outcome: 'failed',
    reason: 'unsupported request',
    nextAction: 'change the request',
    calls: [],
  });
  const agent = {
    currentSessionId: 'owner',
    currentCapabilitySnapshot: () => undefined,
    completedExecution: async () => undefined,
    finalizeExecutionLedger: async () => undefined,
    reopenExecutionLedger: async () => undefined,
  } as unknown as MimiAgent;
  const host = new MimiHost(agent, {
    execute: async () => {
      throw attachRunFinalization(new RunFailureError(
        'fixture.unsupported',
        'unsupported request',
        {
          phase: 'pre_dispatch',
          kind: 'unsupported',
          retryable: false,
          dispatchStarted: false,
        },
      ), finalization);
    },
  });
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const dispatcher = new MimiDispatcher(store, host, attention);
  try {
    const timestamp = new Date().toISOString();
    const routed = store.ingestEvent({
      id: 'failed-finalization-event',
      externalId: 'failed-finalization-event',
      source: 'local-cli',
      kind: 'command',
      trust: 'owner',
      payload: { prompt: 'unsupported' },
      occurredAt: timestamp,
      receivedAt: timestamp,
      priority: 100,
      profileId: 'owner',
      sessionKey: 'owner',
    });
    assert.ok(routed.task);

    assert.equal(await dispatcher.processTaskById(routed.task.id), true);
    const terminal = store.getTask(routed.task.id);
    assert.equal(terminal?.status, 'failed');
    assert.deepEqual(
      (terminal?.result as { finalization?: unknown }).finalization,
      finalization,
    );
    const runId = store.runs.listSummaries(1)[0]!.id;
    assert.deepEqual((store.runs.get(runId)?.answer as { finalization?: unknown }).finalization, finalization);
  } finally {
    store.close();
  }
});

test('dispatcher fails before completion when Browser cleanup is uncertain and never replays close', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-browser-cleanup-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  let closeCalls = 0;
  const connectors = {
    listCapabilities: () => [{
      id: 'browser',
      enabled: true,
      online: true,
      readiness: { inbound: 'unavailable', outbound: 'ready' },
      source: 'browser',
      trust: 'external',
      claimedComputerApps: ['com.google.Chrome'],
      actions: [
        {
          name: 'open_session',
          description: 'open',
          capability: 'browser.session.write',
          effect: 'write',
          routeOwner: 'browser',
          modelVisible: true,
        },
        {
          name: 'close_session',
          description: 'close',
          capability: 'browser.session.write',
          effect: 'write',
          routeOwner: 'browser',
          modelVisible: true,
        },
      ],
    }],
    executeCapability: async (request: { action: string }) => {
      if (request.action === 'close_session') {
        closeCalls += 1;
        const error = new Error('close delivery uncertain');
        error.name = 'UncertainDeliveryError';
        throw error;
      }
      return { connector: 'browser', effect: 'write' as const, result: { outcome: 'confirmed' } };
    },
  } as unknown as ConnectorManager;
  const agent = {
    currentSessionId: 'owner',
    currentCapabilitySnapshot: () => undefined,
    completedExecution: async () => undefined,
    finalizeExecutionLedger: async () => undefined,
    reopenExecutionLedger: async () => undefined,
  } as unknown as MimiAgent;
  const host = new MimiHost(agent, {
    execute: async (request) => {
      assert.equal('computerDeniedApps' in (request.options ?? {}), false);
      const open = request.options?.hostTools?.find((tool) => tool.name === 'browser_open');
      assert.ok(open && 'invoke' in open);
      await open.invoke(new RunContext({}), JSON.stringify({ url: 'https://example.com' }));
      return { answer: 'browser work completed', effects: [] };
    },
  });
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const dispatcher = new MimiDispatcher(store, host, attention, undefined, connectors);
  try {
    const now = new Date().toISOString();
    const routed = store.ingestEvent({
      id: 'browser-cleanup-event',
      externalId: 'browser-cleanup-event',
      source: 'local-cli',
      kind: 'command',
      trust: 'owner',
      payload: { prompt: 'browse' },
      occurredAt: now,
      receivedAt: now,
      priority: 100,
      profileId: 'owner',
      sessionKey: 'owner',
    });
    assert.ok(routed.task);

    assert.equal(await dispatcher.processTaskById(routed.task.id), true);
    const task = store.getTask(routed.task.id);
    assert.equal(task?.status, 'dead_letter');
    assert.match(task?.error ?? '', /Browser session cleanup failed.*close delivery uncertain/);
    assert.equal(closeCalls, 1);
  } finally {
    store.close();
  }
});
