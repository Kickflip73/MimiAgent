import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { submitDaemonEvent } from '../src/daemon/event-submission.js';
import {
  BENCHMARK_NO_TOOLS_RUN_POLICY,
  parseRequestedLocalRunPolicy,
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
  assert.equal(parseRequestedLocalRunPolicy(undefined), undefined);
  assert.throws(() => parseRequestedLocalRunPolicy('no-tools'), /不支持/u);
});
