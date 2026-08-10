import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { submitDaemonEvent } from '../src/daemon/event-submission.js';
import {
  BENCHMARK_NO_TOOLS_RUN_POLICY,
  parseRequestedLocalRunPolicy,
  VOICE_CONVERSATION_RUN_POLICY,
} from '../src/daemon/local-run-policy.js';
import { SessionWorkspaceRegistry } from '../src/daemon/session-workspace-registry.js';
import { MimiStore } from '../src/daemon/store.js';
import type { EventEnvelope } from '../src/daemon/types.js';

test('authenticated local submit persists a versioned no-tools marker through the immutable Event', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-local-run-policy-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const workspaceRegistry = new SessionWorkspaceRegistry(path.join(root, 'session-workspaces.json'));
  try {
    const accepted = await submitDaemonEvent({
      text: 'calibration turn',
      source: 'local-cli',
      trust: 'owner',
      profileId: 'owner',
      sessionKey: 'calibration-session',
      workspaceRoot: workspace,
      requestedRunPolicy: BENCHMARK_NO_TOOLS_RUN_POLICY,
      eventId: 'calibration-event',
      externalId: 'local-cli:calibration-event',
    }, {
      defaultWorkspaceRoot: workspace,
      attachmentRoot: path.join(root, 'attachments'),
      store,
      workspaceRegistry,
      ingestOwnerPrompt: (event: EventEnvelope, prompt: string) => {
        const payload = event.payload as Record<string, unknown>;
        return store.ingestEvent({ ...event, payload: { ...payload, prompt } });
      },
    });
    assert.equal(accepted.inserted, true);
    assert.equal(
      (accepted.event.payload as Record<string, unknown>).requestedRunPolicy,
      BENCHMARK_NO_TOOLS_RUN_POLICY,
    );
    assert.equal(
      (accepted.task?.objective as Record<string, unknown>).requestedRunPolicy,
      BENCHMARK_NO_TOOLS_RUN_POLICY,
    );

    await assert.rejects(submitDaemonEvent({
      payload: { prompt: 'bypass', requestedRunPolicy: BENCHMARK_NO_TOOLS_RUN_POLICY },
      source: 'local-cli',
      trust: 'owner',
      sessionKey: 'calibration-session',
    }, {
      defaultWorkspaceRoot: workspace,
      attachmentRoot: path.join(root, 'attachments'),
      store,
      workspaceRegistry,
      ingestOwnerPrompt: (event, _prompt) => store.ingestEvent(event),
    }), /保留字段/u);

    await assert.rejects(submitDaemonEvent({
      payload: { text: 'external' },
      source: 'connector:test',
      trust: 'external',
      requestedRunPolicy: BENCHMARK_NO_TOOLS_RUN_POLICY,
    }, {
      defaultWorkspaceRoot: workspace,
      attachmentRoot: path.join(root, 'attachments'),
      store,
      workspaceRegistry,
      ingestOwnerPrompt: (event, _prompt) => store.ingestEvent(event),
    }), /仅允许认证 local-cli owner/u);
  } finally {
    store.close();
  }
});

test('local no-tools policy parser is exact and fail-closed', () => {
  assert.equal(
    parseRequestedLocalRunPolicy(BENCHMARK_NO_TOOLS_RUN_POLICY),
    BENCHMARK_NO_TOOLS_RUN_POLICY,
  );
  assert.equal(
    parseRequestedLocalRunPolicy(VOICE_CONVERSATION_RUN_POLICY),
    VOICE_CONVERSATION_RUN_POLICY,
  );
  assert.equal(parseRequestedLocalRunPolicy(undefined), undefined);
  assert.throws(() => parseRequestedLocalRunPolicy('no-tools'), /不支持/u);
});

test('stable media refs persist through the authenticated Event boundary without payload bypasses', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-ref-ingress-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const workspaceRegistry = new SessionWorkspaceRegistry(path.join(root, 'session-workspaces.json'));
  const evidenceId = `media-evidence:sha256:${'a'.repeat(64)}`;
  const options = {
    defaultWorkspaceRoot: workspace,
    attachmentRoot: path.join(root, 'attachments'),
    store,
    workspaceRegistry,
    ingestOwnerPrompt: (event: EventEnvelope, prompt: string) => {
      const payload = event.payload as Record<string, unknown>;
      return store.ingestEvent({ ...event, payload: { ...payload, prompt } });
    },
  };
  try {
    const accepted = await submitDaemonEvent({
      text: 'continue editing',
      source: 'local-cli',
      trust: 'owner',
      profileId: 'owner',
      sessionKey: 'media-session',
      workspaceRoot: workspace,
      referencedMediaEvidenceIds: [evidenceId],
      eventId: 'media-reference-event',
      externalId: 'local-cli:media-reference-event',
    }, options);
    assert.equal(accepted.inserted, true);
    assert.deepEqual(
      (accepted.event.payload as Record<string, unknown>).referencedMediaEvidenceIds,
      [evidenceId],
    );
    const durableJson = JSON.stringify(accepted.event);
    assert.doesNotMatch(durableJson, /data:|base64/u);
    assert.doesNotMatch(durableJson, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const base = {
      text: 'blocked', source: 'local-cli', trust: 'owner', sessionKey: 'media-session',
    };
    await assert.rejects(submitDaemonEvent({
      ...base, source: 'connector:test', trust: 'external',
      referencedMediaEvidenceIds: [evidenceId],
    }, options), /只有 local-cli owner/u);
    await assert.rejects(submitDaemonEvent({
      ...base, sessionKey: undefined, referencedMediaEvidenceIds: [evidenceId],
    }, options), /需要显式 Session/u);
    await assert.rejects(submitDaemonEvent({
      ...base, payload: { prompt: 'bypass' }, referencedMediaEvidenceIds: [evidenceId],
    }, options), /显式 payload/u);
    await assert.rejects(submitDaemonEvent({
      ...base, payload: { referencedMediaEvidenceIds: [evidenceId] },
    }, options), /保留字段/u);
    await assert.rejects(submitDaemonEvent({
      ...base, referencedMediaEvidenceIds: 'private-path',
    }, options), /必须是数组/u);
    await assert.rejects(submitDaemonEvent({
      ...base, referencedMediaEvidenceIds: [evidenceId, evidenceId],
    }, options), /不能重复/u);
    await assert.rejects(submitDaemonEvent({
      ...base,
      attachments: [{ kind: 'image', path: 'not-read-before-count.png' }],
      referencedMediaEvidenceIds: Array.from({ length: 8 }, (_, index) =>
        `media-evidence:sha256:${index.toString(16).padStart(64, '0')}`),
    }, options), /附件与媒体引用合计最多 8 个/u);
  } finally {
    store.close();
  }
});
