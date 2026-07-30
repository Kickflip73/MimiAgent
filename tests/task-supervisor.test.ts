import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.js';
import {
  TaskProcessSupervisor,
  defaultTaskWorkerEntry,
  resolveTaskModel,
  routedTaskProviderCredential,
  taskEmbeddingCredential,
  taskWorkerEnvironment,
  taskWorkerExecArgv,
  taskWorkerRuntimeReadiness,
} from '../src/daemon/task-supervisor.js';
import type { TaskRecord } from '../src/daemon/types.js';
import { ModelConfigStore } from '../src/runtime/model-config.js';

function task(id: string, executor: TaskRecord['executor']): TaskRecord {
  return {
    id,
    type: 'background',
    idempotencyKey: id,
    authorityEventId: 'authority',
    profileId: 'owner',
    sessionKey: `mimi-task-${id}`,
    objective: { objective: 'build game' },
    executor,
    workspaceAccess: 'write',
    priority: 70,
    status: 'queued',
    notBefore: '2026-07-20T00:00:00.000Z',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  };
}

test('process supervisor schedules Codex background tasks instead of ignoring them', async () => {
  const sessionTask = task('session-task', 'session_actor');
  const codexTask = task('codex-task', 'codex');
  const store = {
    emitDueMemoryMaintenanceTasks: () => [],
    runningTasks: () => [],
    readyTasks: () => [sessionTask, codexTask],
  };
  const supervisor = new TaskProcessSupervisor(
    store as never,
    {} as never,
    { database: '/tmp/mimi.db', assistantConfig: '/tmp/assistant.json', socket: '/tmp/mimi.sock' },
    { maxWorkers: 1 },
  );
  const internal = supervisor as unknown as {
    pump(): Promise<void>;
    launch(taskId: string, workspaceAccess: 'read' | 'write'): Promise<void>;
  };
  const launched: Array<{ taskId: string; workspaceAccess: 'read' | 'write' }> = [];
  internal.launch = async (taskId, workspaceAccess) => {
    launched.push({ taskId, workspaceAccess });
  };

  await internal.pump();

  assert.deepEqual(launched, [{ taskId: codexTask.id, workspaceAccess: 'write' }]);
});

test('detached Codex write task keeps the workspace reservation', async () => {
  const queued = task('queued-task', 'isolated_worker');
  const runningCodex = { ...task('running-codex', 'codex'), status: 'running' as const };
  const store = {
    emitDueMemoryMaintenanceTasks: () => [],
    runningTasks: () => [runningCodex],
    readyTasks: () => [queued],
  };
  const supervisor = new TaskProcessSupervisor(
    store as never,
    {} as never,
    { database: '/tmp/mimi.db', assistantConfig: '/tmp/assistant.json', socket: '/tmp/mimi.sock' },
    { maxWorkers: 2 },
  );
  const internal = supervisor as unknown as {
    pump(): Promise<void>;
    launch(taskId: string, workspaceAccess: 'read' | 'write'): Promise<void>;
  };
  const launched: string[] = [];
  internal.launch = async (taskId) => { launched.push(taskId); };

  await internal.pump();

  assert.deepEqual(launched, []);
});

test('task worker boundary strips dotenv preloads and redacted connector credentials', () => {
  assert.deepEqual(taskWorkerExecArgv([
    '--trace-warnings',
    '--env-file', '/private/.env',
    '--env-file-if-exists=/private/optional.env',
    '--require', 'dotenv/config',
    '--import=dotenv/config.js',
    '--import', 'tsx',
    '-r/custom/preload.js',
  ]), [
    '--trace-warnings',
    '--import', 'tsx',
    '-r/custom/preload.js',
  ]);
  const environment = taskWorkerEnvironment({
    PATH: '/usr/bin',
    HOME: '/fixture/home',
    OPENAI_API_KEY: 'fixture-secret',
    DEEPSEEK_API_KEY: 'fixture-backup-secret',
    MIMI_BACKUP_PROVIDER: 'deepseek',
    TASK_WORKER_MODE: 'isolated',
    CONNECTOR_TOKEN: 'connector-secret',
    RANDOM_VALUE: 'discarded',
  }, ['CONNECTOR_TOKEN']);
  assert.equal(environment.PATH, '/usr/bin');
  assert.equal(environment.HOME, '/fixture/home');
  assert.equal(environment.TASK_WORKER_MODE, 'isolated');
  assert.equal(environment.CONNECTOR_TOKEN, undefined);
  assert.equal(environment.RANDOM_VALUE, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.DEEPSEEK_API_KEY, undefined);
  assert.equal(environment.MIMI_BACKUP_PROVIDER, undefined);
  assert.match(defaultTaskWorkerEntry('file:///tmp/daemon/task-supervisor.ts'), /task-worker-entry\.ts$/);
  assert.match(defaultTaskWorkerEntry('file:///tmp/daemon/task-supervisor.js'), /task-worker-entry\.js$/);
});

test('task worker forwards explicit embedding configuration and keeps the DeepSeek OpenAI fallback', () => {
  const config = {
    provider: 'openai-compatible',
  } as AppConfig;
  assert.deepEqual(taskEmbeddingCredential(config, {
    MIMI_EMBEDDING_API_KEY: 'embedding-key',
    MIMI_EMBEDDING_BASE_URL: 'https://embedding.example/v1',
    EMBEDDING_MODEL: 'embedding-model',
  }), {
    apiKey: 'embedding-key',
    baseURL: 'https://embedding.example/v1',
    model: 'embedding-model',
  });
  assert.deepEqual(taskEmbeddingCredential({ provider: 'deepseek' } as AppConfig, {
    OPENAI_API_KEY: 'legacy-openai-key',
  }), {
    apiKey: 'legacy-openai-key',
  });
  assert.equal(taskEmbeddingCredential(config, {
    DEEPSEEK_API_KEY: 'chat-only-key',
  }), undefined);
});

test('background routing sends only the selected Provider and credential to a worker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-model-routing-'));
  const modelsConfig = path.join(root, 'models.json');
  await new ModelConfigStore(modelsConfig).write({
    version: 1,
    routeVersion: 6,
    providers: [
      {
        id: 'left',
        label: 'Left',
        transport: 'openai-chat-completions',
        baseUrl: 'https://left.example/v1',
        apiKeyEnv: 'TASK_LEFT_KEY',
        models: [{
          target: { providerId: 'left', modelId: 'left-model' },
          kind: 'agent',
          capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
        }],
      },
      {
        id: 'right',
        label: 'Right',
        transport: 'openai-chat-completions',
        baseUrl: 'https://right.example/v1',
        apiKeyEnv: 'TASK_RIGHT_KEY',
        models: [{
          target: { providerId: 'right', modelId: 'right-model' },
          kind: 'agent',
          capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
        }],
      },
    ],
    routing: {
      globalDefault: { providerId: 'left', modelId: 'left-model' },
      scenarios: {
        'background.default': {
          target: { providerId: 'right', modelId: 'right-model' },
        },
      },
    },
  });
  const saved = {
    left: process.env.TASK_LEFT_KEY,
    right: process.env.TASK_RIGHT_KEY,
  };
  process.env.TASK_LEFT_KEY = 'left-fixture-key';
  process.env.TASK_RIGHT_KEY = 'right-fixture-key';
  try {
    const routed = await resolveTaskModel({
      provider: 'openai',
      modelsConfig,
      workspaceRoot: root,
      dataRoot: path.join(root, 'data'),
      skillsRoot: path.join(root, 'skills'),
      mcpConfig: path.join(root, 'mcp.json'),
      historyLimit: 40,
      maxTurns: null,
    }, task('routed-task', 'isolated_worker') as never);
    assert.deepEqual(routed.binding.target, {
      providerId: 'right',
      modelId: 'right-model',
    });
    assert.equal(routed.configuration.providers.length, 1);
    assert.equal(routed.configuration.providers[0]?.id, 'right');
    assert.equal(routed.configuration.providers[0]?.models.length, 1);
    assert.doesNotMatch(JSON.stringify(routed.configuration), /fixture-key/);
    assert.deepEqual(routedTaskProviderCredential(
      routed.provider,
      routed.binding,
      {
        TASK_LEFT_KEY: 'left-fixture-key',
        TASK_RIGHT_KEY: 'right-fixture-key',
      },
    ), {
      providerId: 'right',
      apiKeyEnv: 'TASK_RIGHT_KEY',
      target: { providerId: 'right', modelId: 'right-model' },
      apiKey: 'right-fixture-key',
    });
  } finally {
    if (saved.left === undefined) delete process.env.TASK_LEFT_KEY;
    else process.env.TASK_LEFT_KEY = saved.left;
    if (saved.right === undefined) delete process.env.TASK_RIGHT_KEY;
    else process.env.TASK_RIGHT_KEY = saved.right;
  }
});

test('task worker dependency preflight fails before a queued task can consume an attempt', async () => {
  assert.deepEqual(
    taskWorkerRuntimeReadiness('/tmp/mimi-missing-runtime/task-worker-entry.js'),
    {
      ready: false,
      reason: 'Task worker runtime 缺少 @openai/agents',
    },
  );
  let storeTouched = false;
  const supervisor = new TaskProcessSupervisor(
    {
      getTask: () => {
        storeTouched = true;
        throw new Error('missing runtime must fail before reading or claiming the task');
      },
    } as never,
    {} as never,
    { database: '/tmp/mimi.db', assistantConfig: '/tmp/assistant.json', socket: '/tmp/mimi.sock' },
    { workerEntry: '/tmp/mimi-missing-runtime/task-worker-entry.js' },
  );
  const internal = supervisor as unknown as {
    lastWorkerRuntimeErrorLogAt: number;
    launch(taskId: string, workspaceAccess: 'read' | 'write'): Promise<void>;
  };
  internal.lastWorkerRuntimeErrorLogAt = Date.now();
  await internal.launch('queued-task', 'write');
  assert.equal(storeTouched, false);
  assert.deepEqual(supervisor.runtimeStatus(), {
    ready: false,
    reason: 'Task worker runtime 缺少 @openai/agents',
  });
});

test('supervisor status includes detached Codex runtime evidence and rejects unknown workers', async () => {
  const runningCodex = {
    ...task('running-codex', 'codex'),
    status: 'running' as const,
    workspaceAccess: 'read' as const,
    objective: {
      codex: {
        runnerPid: 123,
        codexPid: 456,
        startedAt: '2026-07-27T00:00:00.000Z',
      },
    },
  };
  const store = {
    runningTasks: () => [runningCodex],
    getTask: () => undefined,
  };
  const supervisor = new TaskProcessSupervisor(
    store as never,
    {} as never,
    { database: '/tmp/mimi.db', assistantConfig: '/tmp/assistant.json', socket: '/tmp/mimi.sock' },
  );
  assert.deepEqual(supervisor.status(), [{
    taskId: 'running-codex',
    pid: 123,
    codexPid: 456,
    spawnedAt: '2026-07-27T00:00:00.000Z',
    heartbeatAt: runningCodex.updatedAt,
    workspaceAccess: 'read',
    executor: 'codex',
  }]);
  assert.equal(supervisor.authorizeWorker('missing', 'x'.repeat(43)), false);
  assert.equal(supervisor.authorizeWorkerAction('missing', 'x'.repeat(43)), false);
  await supervisor.stop();
  await supervisor.stop();
});
