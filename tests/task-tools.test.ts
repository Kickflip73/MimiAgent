import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunContext, type Tool } from '@openai/agents';
import { test } from 'node:test';
import { MimiStore } from '../src/daemon/store.js';
import {
  backgroundTaskSummary,
  createBackgroundTaskTools,
} from '../src/daemon/task-tools.js';
import type { TaskRecord } from '../src/daemon/types.js';
import { BASE_INSTRUCTIONS } from '../src/runtime/instructions.js';

async function invoke(tools: Tool[], name: string, input: unknown): Promise<unknown> {
  const selected = tools.find((candidate) => candidate.name === name);
  assert.ok(selected && 'invoke' in selected && typeof selected.invoke === 'function');
  return selected.invoke(new RunContext({}), JSON.stringify(input));
}

test('progress guidance treats active Codex evidence as authoritative over an old attempt error', () => {
  const summary = backgroundTaskSummary({
    id: randomUUID(),
    type: 'background',
    idempotencyKey: 'delegate:test',
    authorityEventId: randomUUID(),
    profileId: 'owner',
    objective: { objective: 'build game', executor: 'codex' },
    executor: 'codex',
    workspaceAccess: 'write',
    priority: 70,
    status: 'running',
    notBefore: new Date().toISOString(),
    attemptCount: 2,
    maxAttempts: 3,
    leaseOwner: 'codex-worker',
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    error: 'Task worker 意外退出（signal=SIGKILL）',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } satisfies TaskRecord);

  assert.equal(summary.execution?.leaseActive, true);
  assert.equal(summary.error, undefined);
  assert.match(summary.previousAttemptError ?? '', /SIGKILL/);
  assert.match(BASE_INSTRUCTIONS, /active lease、持续更新的日志和 latest activity 优先于 previousAttemptError/);
  assert.match(BASE_INSTRUCTIONS, /终态 error\/result 才是本次结果/);
});

test('repeated background delegation returns the same durable task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-tools-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const now = new Date().toISOString();
    const eventId = randomUUID();
    const routed = store.ingestEvent({
      id: eventId,
      externalId: eventId,
      source: 'test',
      kind: 'command',
      trust: 'owner',
      payload: { prompt: 'delegate work' },
      occurredAt: now,
      receivedAt: now,
      priority: 100,
      profileId: 'owner',
      sessionKey: 'test-session',
      replyRoute: { channel: 'system' },
    });
    assert.ok(routed.task);
    const tools = createBackgroundTaskTools({
      store,
      task: routed.task,
      event: routed.event,
      sessionId: 'test-session',
      workspaceRoot: path.join(root, 'selected-workspace'),
    });
    const input = {
      objective: 'Implement the game MVP',
      executor: 'codex',
      workspaceAccess: 'write',
      requiredCapabilities: ['workspace.read', 'workspace.write', 'shell.execute'],
    };

    const first = await invoke(tools, 'delegate_background_task', input) as { taskId: string };
    const repeated = await invoke(tools, 'delegate_background_task', input) as { taskId: string };

    assert.equal(typeof first.taskId, 'string', JSON.stringify(first));
    assert.equal(repeated.taskId, first.taskId);
    assert.equal(store.taskChildCount(routed.task.id), 1);
    const newerEventId = randomUUID();
    store.ingestEvent({
      id: newerEventId,
      externalId: newerEventId,
      source: 'test',
      kind: 'command',
      trust: 'owner',
      payload: { prompt: 'newer foreground work' },
      occurredAt: new Date(Date.now() + 1_000).toISOString(),
      receivedAt: new Date(Date.now() + 1_000).toISOString(),
      priority: 100,
      profileId: 'owner',
      sessionKey: 'newer-session',
      replyRoute: { channel: 'system' },
    });
    const listed = await invoke(tools, 'list_background_tasks', { limit: 1 }) as Array<{
      taskId: string;
    }>;
    assert.deepEqual(listed.map((task) => task.taskId), [first.taskId]);
    assert.equal(
      (store.getTask(first.taskId)?.objective as Record<string, unknown>).workspaceRoot,
      path.join(root, 'selected-workspace'),
    );
    assert.deepEqual(
      (store.getTask(first.taskId)?.objective as Record<string, unknown>).requiredCapabilities,
      ['workspace.read', 'workspace.write', 'shell.execute'],
    );
    const supervisedShell = await invoke(tools, 'delegate_background_task', {
      objective: 'Keep the local development server running without modifying files',
      workspaceAccess: 'read',
      requiredCapabilities: ['workspace.read', 'shell.execute'],
    }) as { taskId: string; workspaceAccess: string };
    assert.equal(supervisedShell.workspaceAccess, 'write');
    assert.equal(store.getTask(supervisedShell.taskId)?.workspaceAccess, 'write');
    assert.match(
      String((store.getTask(supervisedShell.taskId)?.objective as Record<string, unknown>).prompt),
      /## 工作区访问\nwrite/,
    );
    const targeted = await invoke(tools, 'delegate_background_task', {
      ...input,
      objective: 'Implement the game MVP with Kimi',
      executor: 'mimi',
      modelTarget: {
        providerId: 'friday',
        modelId: 'kimi-k3',
      },
    }) as { taskId: string; requestedModelTarget?: unknown };
    assert.deepEqual(targeted.requestedModelTarget, {
      providerId: 'friday',
      modelId: 'kimi-k3',
    });
    assert.deepEqual(
      (store.getTask(targeted.taskId)?.objective as Record<string, unknown>).modelProfile,
      {
        modelTarget: {
          providerId: 'friday',
          modelId: 'kimi-k3',
        },
      },
    );

    const summary = backgroundTaskSummary(store.getTask(targeted.taskId)!);
    assert.deepEqual(summary.requestedModelTarget, {
      providerId: 'friday',
      modelId: 'kimi-k3',
    });

    const incompatible = await invoke(tools, 'delegate_background_task', {
      objective: 'Use the desktop to submit a form',
      executor: 'mimi',
      workspaceAccess: 'write',
      requiredCapabilities: ['computer.act'],
    });
    assert.match(JSON.stringify(incompatible), /不具备必需能力.*computer\.act/);

    const codexModelTarget = await invoke(tools, 'delegate_background_task', {
      objective: 'Run Codex with a Mimi Provider target',
      executor: 'codex',
      modelTarget: {
        providerId: 'friday',
        modelId: 'kimi-k3',
      },
      workspaceAccess: 'write',
      requiredCapabilities: ['workspace.read', 'workspace.write', 'shell.execute'],
    });
    assert.match(JSON.stringify(codexModelTarget), /modelTarget.*executor=mimi/);

    const outputJsonlPath = path.join(root, 'events.jsonl');
    await writeFile(outputJsonlPath, `${JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'file_change', status: 'completed',
        changes: [{ kind: 'add', path: '/workspace/src/game.ts' }],
      },
    })}\n`);
    const workerId = 'codex-progress-test';
    assert.ok(store.claimTaskById(first.taskId, workerId, 60_000));
    store.checkpointCodexTask(first.taskId, workerId, {
      outputJsonlPath,
      lastEvent: 'item.completed',
    });

    const inspected = await invoke(tools, 'inspect_background_task', {
      taskId: first.taskId.slice(0, 8),
    }) as {
      taskId?: string;
      codex?: { latestActivity?: string; recentEvents?: unknown[]; logUpdatedAt?: string };
      execution?: { leaseActive: boolean };
    };
    assert.equal(inspected.taskId, first.taskId, JSON.stringify(inspected));
    assert.match(inspected.codex?.latestActivity ?? '', /file_change.*game\.ts/);
    assert.equal(inspected.codex?.recentEvents?.length, 1);
    assert.match(inspected.codex?.logUpdatedAt ?? '', /^\d{4}-/);
    assert.equal(inspected.execution?.leaseActive, true);

    const collidingTaskId = `${first.taskId.slice(0, 8)}-0000-4000-8000-000000000001`;
    store.enqueueTask({
      id: collidingTaskId,
      type: 'background',
      idempotencyKey: 'delegate:short-id-collision',
      triggerEventId: routed.event.id,
      authorityEventId: routed.event.id,
      parentTaskId: routed.task.id,
      profileId: 'owner',
      sessionKey: `mimi-task-${collidingTaskId}`,
      objective: { objective: 'colliding task' },
      executor: 'isolated_worker',
      workspaceAccess: 'write',
      priority: 70,
    });
    const ambiguous = await invoke(tools, 'inspect_background_task', {
      taskId: first.taskId.slice(0, 8),
    });
    assert.match(JSON.stringify(ambiguous), /短 ID 不唯一.*完整 UUID/);
  } finally {
    store.close();
  }
});
