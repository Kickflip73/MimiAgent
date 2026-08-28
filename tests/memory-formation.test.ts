import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import type { RunMemoryContext, SourceRef } from '../src/core/memory.js';
import { createMemoryMaintenanceTools } from '../src/daemon/memory-maintenance-tools.js';
import { MimiStore } from '../src/daemon/store.js';
import { createMemoryHub } from '../src/extensions/memory/hub.js';
import { createMemoryTools } from '../src/extensions/memory/tools.js';

function source(id: string, marker: string, trust: SourceRef['trust'] = 'system'): SourceRef {
  return {
    type: 'mimi-event',
    id,
    digest: `sha256:${marker.repeat(64)}`,
    occurredAt: `2026-08-05T0${marker === 'a' ? '8' : '9'}:00:00.000Z`,
    trust,
  };
}

function context(root: string, sourceName = 'memory-maintenance'): RunMemoryContext {
  return {
    profileId: 'owner',
    workspaceRoot: root,
    sessionId: 'maintenance-session',
    runId: `run-${sourceName}`,
    cause: { trust: sourceName === 'memory-maintenance' ? 'system' : 'owner', source: sourceName },
  };
}

function addCompletedObservation(store: MimiStore, id: string, at: Date): void {
  const event = store.appendEvent({
    id: `event-${id}`,
    externalId: `event-${id}`,
    source: 'test',
    type: 'command.received',
    trust: 'owner',
    payload: { prompt: `observation ${id}` },
    profileId: 'owner',
    occurredAt: at.toISOString(),
    receivedAt: at.toISOString(),
  }).event;
  store.routeEvent(event.id, {
    routerVersion: 'test',
    decision: 'task_created',
    reasonCode: 'test',
    tasks: [{
      id,
      type: 'conversation',
      idempotencyKey: id,
      triggerEventId: event.id,
      authorityEventId: event.id,
      profileId: 'owner',
      sessionKey: `session-${id}`,
      objective: { prompt: `observation ${id}` },
      executor: 'session_actor',
      workspaceAccess: 'write',
      priority: 50,
    }],
  });
  const workerId = `worker-${id}`;
  const executionAt = new Date(at.getTime() + 1_000);
  store.claimTaskById(id, workerId, 60_000, executionAt);
  const attempt = store.beginTaskAttempt(id, workerId, `session-${id}`, workerId, executionAt);
  store.completeTask(id, workerId, { answer: `durable result ${id}` }, attempt.id, executionAt);
}

test('production maintenance tools form faceted L1 and inferred L2 with an L0 evidence chain', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-production-formation-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const at = new Date();
    addCompletedObservation(store, 'release-preference', at);
    addCompletedObservation(store, 'project-status', new Date(at.getTime() + 1_000));
    const task = store.memoryObservations.emitDue(at, 'owner')[0]!;
    assert.equal(task.type, 'memory_maintenance');
    const hub = await createMemoryHub({
      workspaceRoot: root,
      dataRoot: path.join(root, 'data'),
      profileId: 'owner',
      cutover: false,
    });
    const maintenance = context(root);
    const tools = createMemoryMaintenanceTools(store, task, {
      capture: (input, profileId) => hub.capture(input, { ...maintenance, profileId }),
      reject: (sourceRefs, reasonCode, profileId) => hub.reject(
        sourceRefs,
        reasonCode,
        { ...maintenance, profileId },
      ),
      lint: (profileId) => hub.lint({ ...maintenance, profileId }),
    });
    const invoke = (name: string, input: unknown) => tools.find((candidate) => candidate.name === name)!
      .invoke(new RunContext({}), JSON.stringify(input));
    const listed = await invoke('list_memory_observations', { limit: 20 }) as unknown as {
      observations: Array<{ observationId: string }>;
    };
    const sourceKeys = listed.observations.map((item) => item.observationId);
    assert.equal(sourceKeys.length, 2);

    const preferenceReceipt = await invoke('upsert_memory_page', {
      sourceKeys,
      action: 'upsert',
      title: 'Release safety preference',
      content: 'The owner expects release checks before declaring completion.',
      kind: 'fact',
      status: 'active',
      layer: 'L1',
      facets: {
        entities: ['owner'],
        time: { validFrom: '2026-08-05T08:00:00.000Z' },
      },
      reasonCode: 'maintenance_l1_extract',
    }) as unknown as { pageRefs: Array<{ scope: 'private'; id: string; profileId?: string }> };
    const preferenceRef = preferenceReceipt.pageRefs[0]!;
    const preference = await hub.read(preferenceRef, maintenance);
    assert.equal(preference.metadata.schemaVersion, 2);
    assert.equal(preference.metadata.layer, 'L1');
    assert.deepEqual(preference.metadata.facets.entities, ['owner']);
    assert.equal(preference.metadata.facets.kind, 'fact');
    assert.equal(preference.metadata.facets.time.validFrom, '2026-08-05T08:00:00.000Z');
    assert.equal(preference.metadata.facets.sources.length, 2);

    const projectReceipt = await invoke('upsert_memory_page', {
      sourceKeys,
      action: 'upsert',
      title: 'MimiAgent project state',
      content: 'MimiAgent is preparing the M2 memory milestone.',
      kind: 'fact',
      status: 'active',
      layer: 'L1',
      facets: { entities: ['MimiAgent'] },
      reasonCode: 'maintenance_l1_extract',
    }) as unknown as { pageRefs: Array<{ scope: 'private'; id: string; profileId?: string }> };
    const projectRef = projectReceipt.pageRefs[0]!;
    const sceneReceipt = await invoke('upsert_memory_page', {
      sourceKeys,
      action: 'upsert',
      title: 'M2 release scene',
      content: 'M2 release work combines project progress with strict verification preferences.',
      kind: 'synthesis',
      status: 'active',
      layer: 'L2',
      facets: {
        entities: ['owner', 'MimiAgent'],
        relations: [{ kind: 'governed-by', target: preferenceRef }],
      },
      derivedFrom: [preferenceRef, projectRef],
      reasonCode: 'maintenance_l2_aggregate',
    }) as unknown as { pageRefs: Array<{ scope: 'private'; id: string; profileId?: string }> };
    const scene = await hub.read(sceneReceipt.pageRefs[0]!, maintenance);
    assert.equal(scene.metadata.schemaVersion, 2);
    assert.equal(scene.metadata.layer, 'L2');
    assert.equal(scene.metadata.confidence, 'inferred');
    assert.deepEqual(scene.metadata.derivedFrom, [preferenceRef, projectRef]);
    assert.deepEqual(scene.metadata.facets.relations, [{ kind: 'governed-by', target: preferenceRef }]);

    const explanation = await hub.explain(scene.ref, maintenance);
    assert.deepEqual(explanation.conclusions.map((item) => item.layer), ['L2', 'L1', 'L1']);
    assert.equal(explanation.evidence.length, 2);
    assert.ok(explanation.evidence.every((item) => item.kind === 'mimi-event'));
    assert.equal(explanation.complete, true);
  } finally {
    store.close();
  }
});

test('owner remember tool persists generic facets instead of dropping them at the tool boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-owner-facets-'));
  const hub = await createMemoryHub({
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    profileId: 'owner',
    cutover: false,
  });
  const owner = context(root, 'cli');
  const remember = createMemoryTools(hub, () => owner).find((candidate) => candidate.name === 'remember')!;
  const page = await remember.invoke(new RunContext({}), JSON.stringify({
    title: 'Owner response preference',
    content: 'The owner prefers concise answers.',
    kind: 'profile',
    scope: 'private',
    layer: 'L1',
    facets: {
      entities: ['owner'],
      time: { validFrom: '2026-08-05T08:00:00.000Z' },
    },
    provenance: 'owner-explicit',
  })) as unknown as { ref: { scope: 'private'; id: string; profileId?: string } };
  const remembered = await hub.read(page.ref, owner);
  assert.equal(remembered.metadata.schemaVersion, 2);
  assert.equal(remembered.metadata.layer, 'L1');
  assert.deepEqual(remembered.metadata.facets.entities, ['owner']);
  assert.equal(remembered.metadata.facets.kind, 'profile');
  assert.equal(remembered.metadata.facets.time.validFrom, '2026-08-05T08:00:00.000Z');
  assert.equal(remembered.metadata.facets.sources.length, 1);
});

test('maintenance forms deduplicated L1 revisions and an explainable inferred L2 topic', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-formation-'));
  const hub = await createMemoryHub({
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    profileId: 'owner',
    cutover: false,
  });
  const ctx = context(root);
  const firstSource = source('event-1', 'a');
  const secondSource = source('event-2', 'b');
  const first = await hub.capture({
    title: 'Release safety preference',
    content: 'The owner expects release checks before declaring completion.',
    sourceRefs: [firstSource],
    scope: 'private',
    kind: 'fact',
    confidence: 'source-grounded',
    reasonCode: 'maintenance_l1_extract',
  }, ctx);
  const replay = await hub.capture({
    title: 'Release safety preference',
    content: 'The owner expects release checks before declaring completion.',
    sourceRefs: [firstSource],
    scope: 'private',
    kind: 'fact',
    confidence: 'source-grounded',
    reasonCode: 'maintenance_l1_extract',
  }, ctx);
  assert.equal(replay.id, first.id);

  const updated = await hub.capture({
    title: 'Release safety preference',
    content: 'The owner expects typecheck, tests, and package checks before completion.',
    sourceRefs: [secondSource],
    scope: 'private',
    kind: 'fact',
    confidence: 'source-grounded',
    reasonCode: 'maintenance_l1_update',
  }, { ...ctx, runId: 'maintenance-run-2' });
  assert.deepEqual(updated.pageRefs, first.pageRefs);
  const atom = await hub.read(first.pageRefs[0]!, ctx);
  assert.equal(atom.metadata.schemaVersion, 2);
  assert.equal(atom.metadata.layer, 'L1');
  assert.equal(atom.metadata.sourceRefs.length, 2);

  const project = await hub.capture({
    title: 'MimiAgent project state',
    content: 'MimiAgent is preparing the M2 memory milestone.',
    sourceRefs: [firstSource],
    scope: 'private',
    kind: 'fact',
    confidence: 'source-grounded',
    reasonCode: 'maintenance_l1_extract',
  }, { ...ctx, runId: 'maintenance-run-3' });
  const topic = await hub.capture({
    title: 'M2 release scene',
    content: 'M2 release work combines project progress with strict verification preferences.',
    sourceRefs: [firstSource, secondSource],
    scope: 'private',
    kind: 'synthesis',
    status: 'active',
    confidence: 'inferred',
    layer: 'L2',
    derivedFrom: [atom.ref, project.pageRefs[0]!],
    reasonCode: 'maintenance_l2_aggregate',
  }, { ...ctx, runId: 'maintenance-run-4' });
  const scene = await hub.read(topic.pageRefs[0]!, ctx);
  assert.equal(scene.metadata.schemaVersion, 2);
  assert.equal(scene.metadata.layer, 'L2');
  assert.equal(scene.metadata.confidence, 'inferred');
  const explanation = await hub.explain(scene.ref, ctx);
  assert.deepEqual(explanation.conclusions.map((item) => item.layer), ['L2', 'L1', 'L1']);
  assert.equal(explanation.evidence.length, 2);
  assert.equal(explanation.complete, true);
});

test('conflict, owner correction, expiration, and forgetting remain revisioned and traceable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-revision-lifecycle-'));
  const hub = await createMemoryHub({
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    profileId: 'owner',
    cutover: false,
  });
  const maintenance = context(root);
  const conflictedReceipt = await hub.capture({
    title: 'Deployment window',
    content: 'Evidence disagrees about whether the deployment window is Tuesday or Wednesday.',
    sourceRefs: [source('event-conflict', 'c', 'external')],
    scope: 'private',
    kind: 'decision',
    status: 'conflicted',
    confidence: 'inferred',
    reasonCode: 'maintenance_conflict_detected',
  }, maintenance);
  const conflicted = await hub.read(conflictedReceipt.pageRefs[0]!, maintenance);
  assert.equal(conflicted.metadata.status, 'conflicted');
  assert.equal(conflicted.metadata.confidence, 'inferred');

  const owner = context(root, 'cli');
  const correction = await hub.remember({
    title: 'Confirmed deployment window',
    content: 'The owner confirmed the deployment window is Wednesday.',
    kind: 'decision',
    supersedes: [conflicted.ref.id],
  }, owner);
  assert.equal((await hub.read(conflicted.ref, owner)).metadata.status, 'superseded');
  assert.equal(correction.metadata.confidence, 'user-confirmed');

  await hub.expire(correction.ref, 'deployment_window_elapsed', owner);
  const expired = await hub.read(correction.ref, owner);
  assert.equal(expired.metadata.status, 'expired');
  assert.ok(expired.metadata.validUntil);

  const forgotten = await hub.forget(correction.ref, owner);
  assert.equal(forgotten.forgotten, true);
  await assert.rejects(() => hub.remember({
    title: correction.metadata.title,
    content: 'The owner confirmed the deployment window is Wednesday.',
    kind: 'decision',
    autonomous: true,
  }, maintenance), /遗忘/);
});
