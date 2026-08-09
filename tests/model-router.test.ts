import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderDefinition } from '../src/core/model-routing.js';
import { WorkUnitModelResolver } from '../src/runtime/work-unit-model-resolver.js';

const provider: ProviderDefinition = {
  id: 'fake',
  label: 'Fake',
  transport: 'openai-chat-completions',
  apiKeyEnv: 'FAKE_KEY',
  models: [
    {
      target: { providerId: 'fake', modelId: 'text' },
      kind: 'agent',
      capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
      contextWindow: 32_000,
    },
    {
      target: { providerId: 'fake', modelId: 'vision' },
      kind: 'agent',
      capabilities: { imageInput: true, imageOutput: false, toolCalling: true, fileInput: true },
      contextWindow: 16_000,
    },
    {
      target: { providerId: 'fake', modelId: 'image' },
      kind: 'image-generation',
      capabilities: { imageInput: false, imageOutput: true, toolCalling: false },
    },
  ],
};

test('resolver applies explicit, team, session, scenario and global precedence deterministically', () => {
  const resolver = new WorkUnitModelResolver({
    providers: [provider],
    routing: {
      globalDefault: { providerId: 'fake', modelId: 'text' },
      scenarios: {
        'team.hard': {
          target: { providerId: 'fake', modelId: 'vision' },
          maxTurns: 7,
          maxOutputTokens: 2_048,
        },
      },
    },
  });
  assert.equal(resolver.resolve({
    scenario: 'team.hard',
    profile: { modelTarget: { providerId: 'fake', modelId: 'text' } },
    teamTarget: { providerId: 'fake', modelId: 'vision' },
    sessionTarget: { providerId: 'fake', modelId: 'vision' },
    routeVersion: 7,
  }).reason, 'explicit-work-unit');
  assert.equal(resolver.resolve({
    scenario: 'team.hard',
    teamTarget: { providerId: 'fake', modelId: 'text' },
    sessionTarget: { providerId: 'fake', modelId: 'vision' },
    routeVersion: 7,
  }).reason, 'team-override');
  assert.equal(resolver.resolve({
    scenario: 'conversation.default',
    sessionTarget: { providerId: 'fake', modelId: 'vision' },
    routeVersion: 7,
  }).reason, 'session-preference');
  const routed = resolver.resolve({
    scenario: 'team.hard',
    routeVersion: 7,
  });
  assert.equal(routed.reason, 'scenario-route');
  assert.equal(routed.contextWindow, 16_000);
  assert.equal(routed.maxTurns, 7);
  assert.equal(routed.maxOutputTokens, 2_048);
  assert.equal(resolver.resolve({
    scenario: 'background.default',
    routeVersion: 7,
  }).reason, 'global-default');
});

test('resolver distinguishes image input from image output and blocks incompatible explicit targets', () => {
  const resolver = new WorkUnitModelResolver({
    providers: [provider],
    routing: {
      globalDefault: { providerId: 'fake', modelId: 'text' },
      scenarios: {
        'image-understanding.default': {
          candidates: [{ providerId: 'fake', modelId: 'vision' }],
        },
        'image-generation.default': {
          candidates: [{ providerId: 'fake', modelId: 'image' }],
        },
      },
    },
  });
  assert.equal(resolver.resolve({
    scenario: 'image-understanding.default',
    profile: { requirements: { imageInput: true } },
    routeVersion: 1,
  }).target.modelId, 'vision');
  assert.equal(resolver.resolve({
    scenario: 'image-generation.default',
    profile: { requirements: { imageOutput: true } },
    routeVersion: 1,
  }).target.modelId, 'image');
  assert.throws(() => resolver.resolve({
    scenario: 'image-generation.default',
    profile: {
      modelTarget: { providerId: 'fake', modelId: 'vision' },
      requirements: { imageOutput: true },
    },
    routeVersion: 1,
  }), /imageOutput|生图/);
  assert.throws(() => resolver.resolve({
    scenario: 'image-understanding.default',
    profile: {
      modelTarget: { providerId: 'fake', modelId: 'text' },
      requirements: { imageInput: true },
    },
    routeVersion: 1,
  }), /imageInput|图片输入/);
  const textOnly = new WorkUnitModelResolver({
    providers: [{ ...provider, models: [provider.models[0]!] }],
    routing: {
      globalDefault: { providerId: 'fake', modelId: 'text' },
      scenarios: {},
    },
  });
  assert.throws(() => textOnly.resolve({
    scenario: 'image-understanding.default',
    profile: { requirements: { imageInput: true } },
    routeVersion: 1,
  }), /没有兼容模型|imageInput|图片输入/);
});

test('resolver treats fileInput as an independent hard capability', () => {
  const resolver = new WorkUnitModelResolver({
    providers: [provider],
    routing: {
      globalDefault: { providerId: 'fake', modelId: 'text' },
      scenarios: {
        'file-understanding.default': {
          candidates: [
            { providerId: 'fake', modelId: 'text' },
            { providerId: 'fake', modelId: 'vision' },
          ],
        },
      },
    },
  });
  assert.equal(resolver.resolve({
    scenario: 'file-understanding.default',
    profile: { requirements: { fileInput: true } },
    routeVersion: 1,
  }).target.modelId, 'vision');
  assert.throws(() => resolver.resolve({
    scenario: 'file-understanding.default',
    profile: {
      modelTarget: { providerId: 'fake', modelId: 'text' },
      requirements: { fileInput: true },
    },
    routeVersion: 1,
  }), /fileInput|文件输入/);
});

test('resolver uses a configured route fallback only before execution and records the reason', () => {
  const primary: ProviderDefinition = {
    id: 'primary',
    label: 'Primary',
    transport: 'openai-chat-completions',
    apiKeyEnv: 'PRIMARY_KEY',
    models: [{
      target: { providerId: 'primary', modelId: 'text' },
      kind: 'agent',
      capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
    }],
  };
  const backup: ProviderDefinition = {
    id: 'backup',
    label: 'Backup',
    transport: 'openai-chat-completions',
    apiKeyEnv: 'BACKUP_KEY',
    models: [{
      target: { providerId: 'backup', modelId: 'text' },
      kind: 'agent',
      capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
    }],
  };
  const resolver = new WorkUnitModelResolver({
    providers: [primary, backup],
    routing: {
      globalDefault: { providerId: 'backup', modelId: 'text' },
      scenarios: {
        'background.default': {
          candidates: [
            { providerId: 'primary', modelId: 'text' },
            { providerId: 'backup', modelId: 'text' },
          ],
        },
      },
    },
    isConfigured: (candidate) => candidate.id === 'backup',
  });
  const selected = resolver.resolve({
    scenario: 'background.default',
    routeVersion: 3,
  });
  assert.deepEqual(selected.target, { providerId: 'backup', modelId: 'text' });
  assert.equal(selected.reason, 'safe-fallback');
  assert.throws(() => resolver.resolve({
    scenario: 'background.default',
    profile: {
      modelTarget: { providerId: 'primary', modelId: 'text' },
    },
    routeVersion: 3,
  }), /credential/);
});
