import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ModelConfigStore,
  legacyModelConfiguration,
  parseModelsConfig,
} from '../src/runtime/model-config.js';

const deepseek = {
  id: 'deepseek-main',
  label: 'DeepSeek',
  transport: 'openai-chat-completions' as const,
  baseUrl: 'https://api.deepseek.com',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  models: [{
    target: { providerId: 'deepseek-main', modelId: 'deepseek-v4-pro' },
    kind: 'agent' as const,
    capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
  }],
};

test('model config validates unique exact targets and fails closed on unknown capabilities', () => {
  const base = {
    version: 1,
    routeVersion: 1,
    providers: [deepseek],
    routing: {
      globalDefault: { providerId: 'deepseek-main', modelId: 'deepseek-v4-pro' },
      scenarios: {},
    },
  };
  assert.equal(parseModelsConfig(base).providers.length, 1);
  assert.throws(() => parseModelsConfig({
    ...base,
    providers: [deepseek, { ...deepseek, id: 'duplicate' }],
  }), /重复|target/);
  assert.throws(() => parseModelsConfig({
    ...base,
    providers: [{
      ...deepseek,
      models: [{
        target: { providerId: 'deepseek-main', modelId: 'unknown' },
        kind: 'agent',
        capabilities: { toolCalling: true },
      }],
    }],
  }), /imageInput|imageOutput/);
  assert.throws(() => parseModelsConfig({
    ...base,
    providers: [{
      ...deepseek,
      models: [{ ...deepseek.models[0], contextWindow: 4_096 }],
    }],
    routing: {
      ...base.routing,
      scenarios: {
        'conversation.default': {
          target: { providerId: 'deepseek-main', modelId: 'deepseek-v4-pro' },
          maxOutputTokens: 4_096,
        },
      },
    },
  }), /maxOutputTokens|contextWindow|输出/);
});

test('private model config writes atomically with owner-only permissions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-model-config-'));
  const file = path.join(root, 'models.json');
  const store = new ModelConfigStore(file);
  await store.write({
    version: 1,
    routeVersion: 1,
    providers: [deepseek],
    routing: {
      globalDefault: { providerId: 'deepseek-main', modelId: 'deepseek-v4-pro' },
      scenarios: {},
    },
  });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(file, 'utf8'), /never-persist-this/);
  assert.equal((await store.read()).routeVersion, 1);
});

test('concurrent route mutations serialize without losing either scenario', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-model-config-concurrent-'));
  const store = new ModelConfigStore(path.join(root, 'models.json'));
  await store.write({
    version: 1,
    routeVersion: 1,
    providers: [deepseek],
    routing: {
      globalDefault: { providerId: 'deepseek-main', modelId: 'deepseek-v4-pro' },
      scenarios: {},
    },
  });
  await Promise.all([
    store.update((value) => ({
      ...value,
      routeVersion: value.routeVersion + 1,
      routing: {
        ...value.routing,
        scenarios: {
          ...value.routing.scenarios,
          'team.simple': {
            target: { providerId: 'deepseek-main', modelId: 'deepseek-v4-pro' },
          },
        },
      },
    })),
    store.update((value) => ({
      ...value,
      routeVersion: value.routeVersion + 1,
      routing: {
        ...value.routing,
        scenarios: {
          ...value.routing.scenarios,
          'team.hard': {
            target: { providerId: 'deepseek-main', modelId: 'deepseek-v4-pro' },
          },
        },
      },
    })),
  ]);
  const current = await store.read();
  assert.equal(current.routeVersion, 3);
  assert.deepEqual(Object.keys(current.routing.scenarios).sort(), ['team.hard', 'team.simple']);
});

test('malformed model config is quarantined and fails closed without creating an empty replacement', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-model-config-corrupt-'));
  const file = path.join(root, 'models.json');
  await writeFile(file, '{invalid-json', { mode: 0o600 });
  await assert.rejects(new ModelConfigStore(file).read(), /状态文件损坏|隔离/);
  const entries = await readdir(root);
  assert.ok(entries.some((entry) => entry.startsWith('models.json.corrupt-')));
  assert.equal(entries.includes('models.json'), false);
});

test('legacy environment synthesizes a compatible exact target without persisting credentials', () => {
  const config = legacyModelConfiguration({
    MIMI_MODEL_PROVIDER: 'openai-compatible',
    MIMI_PROVIDER_BASE_URL: 'http://127.0.0.1:9999/v1',
    MIMI_PROVIDER_API_KEY: 'never-persist-this',
    MIMI_MODEL: 'fake-model',
  });
  assert.deepEqual(config.routing.globalDefault, {
    providerId: 'legacy-compatible',
    modelId: 'fake-model',
  });
  assert.equal(config.providers[0]?.apiKeyEnv, 'MIMI_PROVIDER_API_KEY');
  assert.doesNotMatch(JSON.stringify(config), /never-persist-this/);
});
