import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.js';
import {
  parseProviderSetRequest,
  persistProviderConfiguration,
} from '../src/provider-config.js';
import {
  launchAgentProviderConfigured,
  persistLaunchAgentProviderApiKey,
} from '../src/daemon/service.js';

test('provider set uses one current Run secret and atomically writes one private configuration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-provider-config-'));
  const environmentFile = path.join(root, '.env');
  await writeFile(
    environmentFile,
    'UNRELATED=keep\nMIMI_MODEL_PROVIDER=deepseek\nMIMI_PROVIDER_API_KEY=old\n',
  );
  const environment = { MIMI_EPHEMERAL_SECRET_1: 'fixture-kimi-key' };
  const request = parseProviderSetRequest([
    'set',
    'openai-compatible',
    '--base-url',
    'https://api.moonshot.cn/v1',
    '--model',
    'kimi-k3',
    '--context-window',
    '1048576',
  ], environment);
  assert.equal(request.apiKeyEnvironment, 'MIMI_EPHEMERAL_SECRET_1');
  const names = [
    'MIMI_MODEL_PROVIDER',
    'MIMI_PROVIDER_API_KEY',
    'MIMI_PROVIDER_BASE_URL',
    'MIMI_MODEL',
    'MIMI_MODELS',
    'MIMI_CONTEXT_WINDOW',
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    const result = await persistProviderConfiguration(request, environmentFile);
    assert.deepEqual(result, {
      environmentFile,
      provider: 'openai-compatible',
      model: 'kimi-k3',
      baseUrl: 'https://api.moonshot.cn/v1',
    });
    const contents = await readFile(environmentFile, 'utf8');
    assert.match(contents, /^UNRELATED=keep$/m);
    assert.match(contents, /^MIMI_MODEL_PROVIDER=openai-compatible$/m);
    assert.match(contents, /^MIMI_PROVIDER_API_KEY=fixture-kimi-key$/m);
    assert.match(contents, /^MIMI_PROVIDER_BASE_URL=https:\/\/api\.moonshot\.cn\/v1$/m);
    assert.match(contents, /^MIMI_MODEL=kimi-k3$/m);
    assert.match(contents, /^MIMI_MODELS=kimi-k3$/m);
    assert.match(contents, /^MIMI_CONTEXT_WINDOW=1048576$/m);
    assert.equal(contents.match(/^MIMI_PROVIDER_API_KEY=/gm)?.length, 1);
    assert.equal((await stat(environmentFile)).mode & 0o777, 0o600);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('provider set requires an explicit choice only when a Run has multiple secrets', () => {
  assert.throws(() => parseProviderSetRequest([
    'set',
    'openai-compatible',
    '--base-url',
    'https://api.moonshot.cn/v1',
    '--model',
    'kimi-k3',
  ], {
    MIMI_EPHEMERAL_SECRET_1: 'first',
    MIMI_EPHEMERAL_SECRET_2: 'second',
  }), /多个临时敏感值/);
});

test('launchd automatically persists an available provider key instead of blocking restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-provider-launchd-'));
  const environmentFile = path.join(root, '.env');
  const config: AppConfig = {
    provider: 'openai-compatible',
    providerBaseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k3',
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: null,
  };
  const previous = process.env.MIMI_PROVIDER_API_KEY;
  process.env.MIMI_PROVIDER_API_KEY = 'fixture-provider-key';
  try {
    assert.equal(await launchAgentProviderConfigured(config, environmentFile), false);
    await persistLaunchAgentProviderApiKey(config, environmentFile);
    assert.equal(await launchAgentProviderConfigured(config, environmentFile), true);
    assert.equal((await stat(environmentFile)).mode & 0o777, 0o600);
  } finally {
    if (previous === undefined) delete process.env.MIMI_PROVIDER_API_KEY;
    else process.env.MIMI_PROVIDER_API_KEY = previous;
  }
});
