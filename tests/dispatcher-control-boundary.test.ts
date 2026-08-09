import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, writeFile } from 'node:fs/promises';
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
import { SessionWorkspaceRegistry } from '../src/daemon/session-workspace-registry.js';
import {
  attachRunFinalization,
  createRunFinalization,
} from '../src/core/run-finalization.js';
import { createOriginalMediaEvidence } from '../src/core/media-evidence.js';
import { FileSession } from '../src/core/session.js';
import { RunFailureError } from '../src/core/run-failure.js';
import { MimiHost } from '../src/runtime/mimi-host.js';
import { MimiAgent } from '../src/runtime/mimi-agent.js';
import { stageAttachments } from '../src/runtime/attachments.js';

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

test('dispatcher resolves modern and queued legacy attachments through the configured artifact root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-attachments-'));
  const workspace = path.join(root, 'workspace');
  const attachmentRoot = path.join(root, 'attachments');
  await mkdir(workspace, { recursive: true });
  await mkdir(attachmentRoot, { recursive: true });
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  await writeFile(path.join(workspace, 'photo.png'), image);
  const modern = await stageAttachments(
    [{ path: 'photo.png', kind: 'image' }],
    workspace,
    attachmentRoot,
    {
      profileId: 'owner',
      sessionId: 'owner',
      eventId: 'modern-event',
      sourceId: 'modern-event',
      trust: 'owner',
      occurredAt: '2026-08-09T00:00:00.000Z',
    },
  );
  const digest = createHash('sha256').update(image).digest('hex');
  const legacyPath = path.join(attachmentRoot, digest);
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const session = new FileSession(path.join(root, 'sessions'), 'owner');
  await session.ensure();
  const captured: Array<{ modelInput?: unknown; mediaEvidence?: readonly unknown[] }> = [];
  const agent = {
    currentSessionId: 'owner',
    session,
    currentCapabilitySnapshot: () => undefined,
    completedExecution: async () => undefined,
    finalizeExecutionLedger: async () => undefined,
    reopenExecutionLedger: async () => undefined,
    close: async () => undefined,
  } as unknown as MimiAgent;
  const host = new MimiHost(agent, {
    execute: async (request) => {
      captured.push({
        modelInput: request.modelInput,
        mediaEvidence: request.options?.mediaEvidence,
      });
      return { answer: 'inspected', effects: [] };
    },
  });
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const dispatcher = new MimiDispatcher(store, host, attention, undefined, undefined, {
    attachmentRoot,
  });
  try {
    const now = new Date().toISOString();
    const events = [
      {
        id: 'modern-event',
        sessionKey: 'owner',
        attachments: modern,
      },
      {
        id: 'legacy-event',
        sessionKey: 'owner',
        attachments: [{
          kind: 'image',
          name: 'legacy.png',
          mediaType: 'image/png',
          bytes: image.length,
          sha256: digest,
          path: legacyPath,
        }],
      },
    ];
    for (const item of events) {
      const routed = store.ingestEvent({
        id: item.id,
        externalId: item.id,
        source: 'local-cli',
        kind: 'command',
        trust: 'owner',
        payload: { prompt: 'inspect image', attachments: item.attachments },
        occurredAt: now,
        receivedAt: now,
        priority: 100,
        profileId: 'owner',
        sessionKey: item.sessionKey,
      });
      assert.ok(routed.task);
      assert.equal(await dispatcher.processTaskById(routed.task.id), true);
      const terminal = store.getTask(routed.task.id);
      assert.equal(terminal?.status, 'completed', terminal?.error);
    }
    assert.equal(captured.length, 2);
    for (const request of captured) {
      assert.ok(Array.isArray(request.modelInput));
      assert.match(JSON.stringify(request.modelInput), /input_image/);
    }
    assert.equal(captured[0]!.mediaEvidence?.length, 1);
    assert.equal(captured[1]!.mediaEvidence, undefined);
  } finally {
    store.close();
  }
});

test('CLI trigger Event provenance reaches the real run pipeline without confusing the Task id', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-media-pipeline-'));
  const workspace = path.join(root, 'workspace');
  const dataRoot = path.join(root, 'data');
  const attachmentRoot = path.join(root, 'attachments');
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, 'photo.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const staged = await stageAttachments(
    [{ path: 'photo.png', kind: 'image' }],
    workspace,
    attachmentRoot,
    {
      profileId: 'owner', sessionId: 'owner', eventId: 'source-media-event',
      sourceId: 'source-media-event', trust: 'owner', occurredAt: '2026-08-09T00:00:00.000Z',
    },
  );
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only-media-pipeline-key';
  const agent = await MimiAgent.create({
    provider: 'openai',
    workspaceRoot: workspace,
    dataRoot,
    daemonDataRoot: root,
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: 20,
  }, 'owner').catch((error: unknown) => {
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    throw error;
  });
  const runner = (agent as unknown as {
    runner: { run: (...args: unknown[]) => Promise<unknown> };
  }).runner;
  const modelInputs: unknown[] = [];
  runner.run = async (_runtimeAgent, modelInput) => {
    modelInputs.push(modelInput);
    return {
      rawResponses: [],
      runContext: { usage: {} },
      finalOutput: 'image inspected',
      completed: Promise.resolve(),
      cancelled: false,
      interruptions: [],
      async *[Symbol.asyncIterator]() {},
    };
  };
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  assert.equal(agent.mediaArtifacts.root, attachmentRoot);
  const dispatcher = new MimiDispatcher(store, agent, attention, undefined, undefined, {
    attachmentRoot,
  });
  try {
    const now = new Date().toISOString();
    const routed = store.ingestEvent({
      id: 'source-media-event',
      externalId: 'source-media-event',
      source: 'local-cli',
      kind: 'command',
      trust: 'owner',
      payload: { prompt: 'inspect image', attachments: staged },
      occurredAt: now,
      receivedAt: now,
      priority: 100,
      profileId: 'owner',
      sessionKey: 'owner',
    });
    assert.ok(routed.task);
    assert.notEqual(routed.task.id, 'source-media-event');
    assert.equal(await dispatcher.processTaskById(routed.task.id), true);
    const terminal = store.getTask(routed.task.id);
    assert.equal(terminal?.status, 'completed', terminal?.error);
    const session = new FileSession(path.join(dataRoot, 'sessions'), 'owner');
    assert.equal((await session.listMediaEvidence()).length, 1);
    const evidence = (await session.listMediaEvidence())[0]!;
    assert.equal(evidence.sourceRef.eventId, 'source-media-event');

    const followUp = store.ingestEvent({
      id: 'source-media-follow-up',
      externalId: 'source-media-follow-up',
      source: 'local-cli',
      kind: 'command',
      trust: 'owner',
      payload: {
        prompt: 'inspect the exact same original image again',
        referencedMediaEvidenceIds: [evidence.id],
      },
      occurredAt: now,
      receivedAt: now,
      priority: 100,
      profileId: 'owner',
      sessionKey: 'owner',
    });
    assert.ok(followUp.task);
    assert.equal(await dispatcher.processTaskById(followUp.task.id), true);
    assert.equal(store.getTask(followUp.task.id)?.status, 'completed');
    assert.equal(modelInputs.length, 2);
    assert.match(JSON.stringify(modelInputs[1]), /input_image/u);
    assert.match(JSON.stringify(modelInputs[1]), new RegExp(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ).toString('base64').slice(0, 40),
      'u',
    ));
    assert.match(JSON.stringify(modelInputs[1]), new RegExp(evidence.id, 'u'));
    assert.equal((await session.listMediaEvidence()).length, 1);
    assert.deepEqual(
      (await readdir(path.join(attachmentRoot, '.refs'))).map((name) => name.split('-')[0]).sort(),
      ['event', 'session'],
    );
    await agent.clearSession();
    assert.equal((await session.listMediaEvidence()).length, 0);
    assert.deepEqual(
      (await readdir(path.join(attachmentRoot, '.refs'))).map((name) => name.split('-')[0]),
      ['event'],
    );
  } finally {
    await agent.close();
    store.close();
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
  }
});

test('combined attachment and Session Evidence budget fails before current CAS reads or model dispatch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-combined-media-budget-'));
  const workspace = path.join(root, 'workspace');
  const dataRoot = path.join(root, 'data');
  const attachmentRoot = path.join(root, 'attachments');
  await mkdir(workspace, { recursive: true });
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only-combined-media-budget-key';
  const agent = await MimiAgent.create({
    provider: 'openai',
    workspaceRoot: workspace,
    dataRoot,
    daemonDataRoot: root,
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: 20,
  }, 'owner').catch((error: unknown) => {
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    throw error;
  });
  let modelCalls = 0;
  const runner = (agent as unknown as {
    runner: { run: (...args: unknown[]) => Promise<unknown> };
  }).runner;
  runner.run = async () => {
    modelCalls += 1;
    throw new Error('model must not run after media budget rejection');
  };

  const sourceRunId = 'combined-budget-source-run';
  const referencedSha = 'c'.repeat(64);
  await agent.session.beginRun('register referenced image metadata', sourceRunId, 'test-owner');
  const referenced = createOriginalMediaEvidence({
    kind: 'image',
    sha256: referencedSha,
    mimeType: 'image/png',
    bytes: 68,
    originalName: 'prior.png',
    mediaRef: `media-artifact:sha256:${referencedSha}`,
    sourceRef: {
      entry: 'local-attachment',
      sourceId: 'combined-budget-source',
      trust: 'owner',
      profileId: 'owner',
      sessionId: 'owner',
      runId: sourceRunId,
    },
    occurredAt: '2026-08-10T02:00:00.000Z',
  });
  assert.equal(await agent.session.registerMediaEvidence([referenced], sourceRunId), 1);
  await agent.session.completeRun('metadata registered', sourceRunId);

  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const dispatcher = new MimiDispatcher(store, agent, attention, undefined, undefined, {
    attachmentRoot,
    maxAttempts: 1,
  });
  try {
    const now = new Date().toISOString();
    const firstSha = 'a'.repeat(64);
    const secondSha = 'b'.repeat(64);
    const routed = store.ingestEvent({
      id: 'combined-media-budget-event',
      externalId: 'combined-media-budget-event',
      source: 'local-cli',
      kind: 'command',
      trust: 'owner',
      profileId: 'owner',
      sessionKey: 'owner',
      priority: 100,
      occurredAt: now,
      receivedAt: now,
      payload: {
        prompt: 'compare current files with the prior image',
        referencedMediaEvidenceIds: [referenced.id],
        attachments: [
          {
            kind: 'file', name: 'first.bin', mediaType: 'application/octet-stream',
            bytes: 10 * 1024 * 1024, sha256: firstSha,
            artifactRef: `media-artifact:sha256:${firstSha}`,
          },
          {
            kind: 'file', name: 'second.bin', mediaType: 'application/octet-stream',
            bytes: 10 * 1024 * 1024, sha256: secondSha,
            artifactRef: `media-artifact:sha256:${secondSha}`,
          },
        ],
      },
    });
    assert.ok(routed.task);
    assert.equal(await dispatcher.processTaskById(routed.task.id), true);
    const terminal = store.getTask(routed.task.id);
    assert.equal(terminal?.status, 'failed');
    assert.match(terminal?.error ?? '', /合计超过 20MB/u);
    assert.equal(modelCalls, 0);
    await assert.rejects(realpath(path.join(attachmentRoot, firstSha)), /ENOENT/u);
    await assert.rejects(realpath(path.join(attachmentRoot, secondSha)), /ENOENT/u);
  } finally {
    await agent.close();
    store.close();
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
  }
});

test('opaque Session workspace binding scopes a new Session first Run without leaking its path into Event', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-workspace-binding-'));
  const workspaceA = path.join(root, 'daemon-default');
  const workspaceB = path.join(root, 'client-project');
  await mkdir(workspaceA);
  await mkdir(workspaceB);
  const registry = new SessionWorkspaceRegistry(path.join(root, 'session-workspaces.json'));
  const binding = await registry.bind('new-session', workspaceB);
  const createdRoots: Array<string | undefined> = [];
  const fakeAgent = (sessionId: string) => ({
    currentSessionId: sessionId,
    bindSessionActor: () => undefined,
    completedExecution: async () => undefined,
    finalizeExecutionLedger: async () => undefined,
    reopenExecutionLedger: async () => undefined,
    currentCapabilitySnapshot: () => undefined,
    close: async () => undefined,
  }) as unknown as MimiAgent;
  const primary = fakeAgent('primary');
  const host = new MimiHost(primary, {
    execute: async () => ({ answer: 'primary', effects: [] }),
  }, {
    primaryWorkspaceRoot: workspaceA,
    createSessionRuntime: async (sessionId, workspaceRoot) => {
      createdRoots.push(workspaceRoot);
      return {
        agent: fakeAgent(sessionId),
        runs: { execute: async () => ({ answer: 'scoped', effects: [] }) },
      };
    },
  });
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const dispatcher = new MimiDispatcher(store, host, attention, undefined, undefined, {
    resolveWorkspace: async (event, sessionId) => {
      const payload = event.payload as Record<string, unknown>;
      const resolved = await registry.resolve(sessionId, String(payload.workspaceId));
      return resolved?.workspaceRoot;
    },
  });
  try {
    const now = new Date().toISOString();
    const routed = store.ingestEvent({
      id: 'workspace-event', externalId: 'workspace-event', source: 'local-cli', kind: 'command',
      trust: 'owner', payload: { prompt: 'list project files', workspaceId: binding.workspaceId },
      occurredAt: now, receivedAt: now, priority: 100, profileId: 'owner', sessionKey: 'new-session',
    });
    assert.ok(routed.task);
    const durable = store.getImmutableEvent('workspace-event');
    assert.ok(durable);
    assert.doesNotMatch(JSON.stringify(durable.payload), new RegExp(workspaceB.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.doesNotMatch(JSON.stringify(durable.payload), /client-project|\/Users\//u);
    assert.equal(await dispatcher.processTaskById(routed.task.id), true);
    assert.equal(store.getTask(routed.task.id)?.status, 'completed');
    assert.deepEqual(createdRoots, [await realpath(workspaceB)]);
  } finally {
    await host.close();
    store.close();
  }
});

test('dispatcher rejects forged external attachments and media refs without an explicit Session before Host', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-media-ingress-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  let hostCalls = 0;
  const agent = {
    currentSessionId: 'owner',
    currentCapabilitySnapshot: () => undefined,
    completedExecution: async () => undefined,
    finalizeExecutionLedger: async () => undefined,
    reopenExecutionLedger: async () => undefined,
    close: async () => undefined,
  } as unknown as MimiAgent;
  const host = new MimiHost(agent, {
    execute: async () => {
      hostCalls += 1;
      return { answer: 'must not run', effects: [] };
    },
  });
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const dispatcher = new MimiDispatcher(store, host, attention, undefined, undefined, {
    attachmentRoot: path.join(root, 'missing-artifacts'),
    maxAttempts: 1,
  });
  try {
    const now = new Date().toISOString();
    const digest = 'a'.repeat(64);
    const external = store.ingestEvent({
      id: 'forged-external-attachment', externalId: 'forged-external-attachment',
      source: 'connector:forged', kind: 'command', trust: 'external', profileId: 'owner',
      sessionKey: 'external-session', priority: 100, occurredAt: now, receivedAt: now,
      payload: {
        prompt: 'pretend this attachment was inspected',
        attachments: [{
          kind: 'file', name: 'notes.txt', mediaType: 'text/plain', bytes: 1,
          sha256: digest, artifactRef: `media-artifact:sha256:${digest}`,
        }],
      },
    });
    assert.ok(external.task);
    assert.equal(await dispatcher.processTaskById(external.task.id), true);
    assert.match(store.getTask(external.task.id)?.error ?? '', /只有 local-cli owner/u);

    const unbound = store.ingestEvent({
      id: 'unbound-owner-media-ref', externalId: 'unbound-owner-media-ref',
      source: 'local-cli', kind: 'command', trust: 'owner', profileId: 'owner',
      priority: 100, occurredAt: now, receivedAt: now,
      payload: {
        prompt: 'reuse an image without choosing a Session',
        referencedMediaEvidenceIds: [`media-evidence:sha256:${'b'.repeat(64)}`],
      },
    });
    assert.ok(unbound.task);
    assert.equal(await dispatcher.processTaskById(unbound.task.id), true);
    assert.match(store.getTask(unbound.task.id)?.error ?? '', /显式 Session/u);
    assert.equal(hostCalls, 0);
  } finally {
    await host.close();
    store.close();
  }
});

test('completed execution receipt is recovered before a missing attachment is read or provider is called', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-ledger-media-recovery-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  let providerCalls = 0;
  const agent = {
    currentSessionId: 'owner',
    currentCapabilitySnapshot: () => undefined,
    completedExecution: async () => ({
      answer: 'recovered answer',
      effects: [],
      finalization: createRunFinalization({
        runId: 'completed-run', answer: 'recovered answer', calls: [], outcome: 'completed',
      }),
    }),
    finalizeExecutionLedger: async () => undefined,
    reopenExecutionLedger: async () => undefined,
    close: async () => undefined,
  } as unknown as MimiAgent;
  const host = new MimiHost(agent, {
    execute: async () => {
      providerCalls += 1;
      return { answer: 'unexpected provider answer', effects: [] };
    },
  });
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const dispatcher = new MimiDispatcher(store, host, attention, undefined, undefined, {
    attachmentRoot: path.join(root, 'missing-artifacts'),
  });
  try {
    const now = new Date().toISOString();
    const digest = 'a'.repeat(64);
    const routed = store.ingestEvent({
      id: 'recovery-media-event', externalId: 'recovery-media-event', source: 'local-cli',
      kind: 'command', trust: 'owner', profileId: 'owner', sessionKey: 'owner', priority: 100,
      occurredAt: now, receivedAt: now,
      payload: {
        prompt: 'read attachment',
        referencedMediaEvidenceIds: [`media-evidence:sha256:${'b'.repeat(64)}`],
        attachments: [{
          kind: 'file', name: 'notes.txt', mediaType: 'text/plain', bytes: 1,
          sha256: digest, artifactRef: `media-artifact:sha256:${digest}`,
        }],
      },
    });
    assert.ok(routed.task);
    assert.equal(await dispatcher.processTaskById(routed.task.id), true);
    const terminal = store.getTask(routed.task.id);
    assert.equal(terminal?.status, 'completed', terminal?.error);
    assert.equal((terminal?.result as { answer?: string }).answer, 'recovered answer');
    assert.equal(providerCalls, 0);
  } finally {
    await host.close();
    store.close();
  }
});

test('dispatcher records idle timeout as a retryable typed failure after SDK abort wrapping', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-idle-timeout-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const agent = {
    currentSessionId: 'owner',
    currentCapabilitySnapshot: () => undefined,
    completedExecution: async () => undefined,
    finalizeExecutionLedger: async () => undefined,
    reopenExecutionLedger: async () => undefined,
  } as unknown as MimiAgent;
  const host = new MimiHost(agent, {
    execute: async (request) => new Promise((_, reject) => {
      const signal = request.signal;
      assert.ok(signal);
      const abort = () => reject(new Error(signal.reason instanceof Error
        ? signal.reason.message
        : String(signal.reason)));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }),
  });
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const dispatcher = new MimiDispatcher(store, host, attention, undefined, undefined, {
    runIdleTimeoutMs: 25,
  });
  try {
    const now = new Date().toISOString();
    const routed = store.ingestEvent({
      id: 'idle-timeout-event',
      externalId: 'idle-timeout-event',
      source: 'local-cli',
      kind: 'command',
      trust: 'owner',
      payload: { prompt: 'wait for provider' },
      occurredAt: now,
      receivedAt: now,
      priority: 100,
      profileId: 'owner',
      sessionKey: 'owner',
    });
    assert.ok(routed.task);

    assert.equal(await dispatcher.processTaskById(routed.task.id), true);
    const task = store.getTask(routed.task.id);
    assert.equal(task?.status, 'queued');
    assert.match(task?.error ?? '', /Agent 连续 25ms 无进展/);
    assert.deepEqual((task?.result as { failure?: unknown }).failure, {
      code: 'runtime.idle_timeout',
      disposition: {
        phase: 'runtime',
        kind: 'transient',
        retryable: true,
        dispatchStarted: false,
      },
    });
  } finally {
    store.close();
  }
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
