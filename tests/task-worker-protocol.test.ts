import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from '../src/config.js';
import {
  taskProviderEnvironmentName,
  taskWorkerConfig,
  taskWorkerInitSchema,
  withTaskEmbeddingCredential,
} from '../src/daemon/worker-protocol.js';

test('Task worker configuration excludes Computer Use capability', () => {
  const config = {
    provider: 'deepseek',
    workspaceRoot: '/workspace',
    dataRoot: '/data',
    daemonDataRoot: '/daemon',
    skillsRoot: '/workspace/skills',
    skillsRootConfigured: true,
    mcpConfig: '/workspace/mcp.json',
    historyLimit: 40,
    maxTurns: null,
    permissionMode: 'trusted',
    securityProfile: 'full-owner',
    computer: {
      backend: 'cua',
      driverCommand: '/usr/local/bin/cua-driver',
      actionTimeoutMs: 15_000,
      maxActionsPerRun: 50,
      maxScreenshotsPerRun: 12,
      pauseWhenTargetFrontmost: true,
      defaultAccess: 'background',
      foregroundLeaseSeconds: 30,
      artifactMaxBytes: 1024 * 1024,
    },
  } satisfies AppConfig;

  const workerConfig = taskWorkerConfig(config);
  assert.equal('computer' in workerConfig, false);
  assert.equal(workerConfig.securityProfile, 'full-owner');
  assert.equal(workerConfig.skillsRootConfigured, true);
  assert.doesNotThrow(() => taskWorkerInitSchema.parse({
    type: 'init',
    executor: 'codex',
    taskId: 'd4d0011b-d947-5963-b2ef-7982b303f612',
    database: '/daemon/mimi.db',
    assistantConfig: '/daemon/assistant.json',
    socket: '/daemon/mimi.sock',
    workerToken: 'a'.repeat(43),
    workspaceAccess: 'write',
    enableMcp: false,
    mcpEnvironment: {},
    config: workerConfig,
  }));
  assert.doesNotThrow(() => taskWorkerInitSchema.parse({
    type: 'init',
    executor: 'mimi',
    taskId: 'd4d0011b-d947-5963-b2ef-7982b303f612',
    database: '/daemon/mimi.db',
    assistantConfig: '/daemon/assistant.json',
    socket: '/daemon/mimi.sock',
    workerToken: 'a'.repeat(43),
    workspaceAccess: 'write',
    enableMcp: false,
    providerCredential: { provider: 'deepseek', apiKey: 'primary-key' },
    backupProvider: {
      id: 'openai:gpt-5.4-mini',
      provider: 'openai',
      model: 'gpt-5.4-mini',
    },
    backupProviderCredential: { provider: 'openai', apiKey: 'backup-key' },
    mcpEnvironment: {},
    config: workerConfig,
  }));
  assert.throws(() => taskWorkerInitSchema.parse({
    type: 'init',
    executor: 'mimi',
    taskId: 'd4d0011b-d947-5963-b2ef-7982b303f612',
    database: '/daemon/mimi.db',
    assistantConfig: '/daemon/assistant.json',
    socket: '/daemon/mimi.sock',
    workerToken: 'a'.repeat(43),
    workspaceAccess: 'write',
    enableMcp: false,
    providerCredential: { provider: 'deepseek', apiKey: 'primary-key' },
    backupProvider: { id: 'openai:default', provider: 'openai' },
    backupProviderCredential: { provider: 'deepseek', apiKey: 'wrong-key' },
    mcpEnvironment: {},
    config: workerConfig,
  }), /Backup Provider credential/);
});

test('Task worker accepts OpenAI-compatible provider configuration and credential', () => {
  const config = taskWorkerConfig({
    provider: 'openai-compatible',
    providerBaseUrl: 'https://api.provider.example/v1',
    defaultModel: 'provider-model',
    availableModels: ['provider-model', 'provider-fast'],
    workspaceRoot: '/workspace',
    dataRoot: '/data',
    daemonDataRoot: '/daemon',
    skillsRoot: '/workspace/skills',
    mcpConfig: '/workspace/mcp.json',
    historyLimit: 40,
    maxTurns: null,
  });
  assert.equal(taskProviderEnvironmentName('openai-compatible'), 'MIMI_PROVIDER_API_KEY');
  assert.doesNotThrow(() => taskWorkerInitSchema.parse({
    type: 'init',
    taskId: 'd4d0011b-d947-5963-b2ef-7982b303f612',
    database: '/daemon/mimi.db',
    assistantConfig: '/daemon/assistant.json',
    socket: '/daemon/mimi.sock',
    workerToken: 'a'.repeat(43),
    workspaceAccess: 'write',
    enableMcp: false,
    providerCredential: { provider: 'openai-compatible', apiKey: 'fixture-key' },
    mcpEnvironment: {},
    config,
  }));
});

test('Task worker accepts and scopes an independent OpenAI-compatible embedding credential', async () => {
  const environment: NodeJS.ProcessEnv = {
    MIMI_EMBEDDING_API_KEY: 'previous-key',
    MIMI_EMBEDDING_BASE_URL: 'https://previous.example/v1',
    EMBEDDING_MODEL: 'previous-model',
  };
  await withTaskEmbeddingCredential({
    apiKey: 'embedding-key',
    baseURL: 'https://embedding.example/v1',
    model: 'embedding-model',
  }, async () => {
    assert.equal(environment.MIMI_EMBEDDING_API_KEY, 'embedding-key');
    assert.equal(environment.MIMI_EMBEDDING_BASE_URL, 'https://embedding.example/v1');
    assert.equal(environment.EMBEDDING_MODEL, 'embedding-model');
  }, environment);
  assert.deepEqual(environment, {
    MIMI_EMBEDDING_API_KEY: 'previous-key',
    MIMI_EMBEDDING_BASE_URL: 'https://previous.example/v1',
    EMBEDDING_MODEL: 'previous-model',
  });
});
