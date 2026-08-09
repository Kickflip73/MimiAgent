import assert from 'node:assert/strict';
import test from 'node:test';
import {
  projectConversationProviderConfig,
  projectConversationProviderConfigJson,
} from '../scripts/conversation-provider-config.js';

function model(providerId: string, modelId: string) {
  return {
    target: { providerId, modelId },
    kind: 'agent',
    capabilities: {
      imageInput: false,
      imageOutput: false,
      toolCalling: true,
    },
    contextWindow: 128_000,
  };
}

function sourceConfig(): Record<string, unknown> {
  return {
    version: 1,
    routeVersion: 7,
    providers: [
      {
        id: 'selected',
        label: 'Selected Provider',
        transport: 'openai-chat-completions',
        baseUrl: 'https://provider.example/v1',
        region: 'test-region',
        apiKeyEnv: 'SELECTED_API_KEY',
        models: [model('selected', 'primary'), model('selected', 'unused')],
      },
      {
        id: 'unused',
        label: 'Unused Provider',
        transport: 'openai-responses',
        apiKeyEnv: 'UNUSED_API_KEY',
        models: [model('unused', 'unused-model')],
      },
    ],
    routing: {
      globalDefault: { providerId: 'selected', modelId: 'primary' },
      scenarios: {
        coding: { target: { providerId: 'unused', modelId: 'unused-model' } },
      },
    },
  };
}

test('formal Provider projection keeps only the global-default Provider and Model', () => {
  const projected = projectConversationProviderConfig(sourceConfig());
  assert.equal(projected.providerId, 'selected');
  assert.equal(projected.modelId, 'primary');
  assert.equal(projected.apiKeyEnv, 'SELECTED_API_KEY');
  assert.equal(projected.config.routeVersion, 7);
  assert.equal(projected.config.providers.length, 1);
  assert.equal(projected.config.providers[0]?.models.length, 1);
  assert.deepEqual(projected.config.routing, {
    globalDefault: { providerId: 'selected', modelId: 'primary' },
    scenarios: {},
  });
  assert.deepEqual(projected.config.providers[0], {
    id: 'selected',
    label: 'Selected Provider',
    transport: 'openai-chat-completions',
    baseUrl: 'https://provider.example/v1',
    region: 'test-region',
    apiKeyEnv: 'SELECTED_API_KEY',
    models: [{
      target: { providerId: 'selected', modelId: 'primary' },
      kind: 'agent',
      capabilities: {
        imageInput: false,
        imageOutput: false,
        toolCalling: true,
        fileInput: false,
        audioInput: false,
        audioOutput: false,
        videoInput: false,
        realtimeAudio: false,
      },
      contextWindow: 128_000,
    }],
  });
  assert.doesNotMatch(projected.contents, /UNUSED_API_KEY|unused-model|coding/u);
  assert.deepEqual(
    projectConversationProviderConfigJson(projected.contents).config,
    projected.config,
  );
});

test('formal Provider projection rejects unknown credential and header fields at every boundary', () => {
  const cases: Array<[string, (value: Record<string, unknown>) => void]> = [
    ['top-level apiKey', (value) => { value.apiKey = 'top-secret'; }],
    ['Provider apiKey', (value) => {
      (value.providers as Array<Record<string, unknown>>)[0]!.apiKey = 'provider-secret';
    }],
    ['Provider headers', (value) => {
      (value.providers as Array<Record<string, unknown>>)[0]!.headers = {
        Authorization: 'Bearer header-secret',
      };
    }],
    ['Model apiKey', (value) => {
      const provider = (value.providers as Array<Record<string, unknown>>)[0]!;
      (provider.models as Array<Record<string, unknown>>)[0]!.apiKey = 'model-secret';
    }],
    ['Model custom header', (value) => {
      const provider = (value.providers as Array<Record<string, unknown>>)[0]!;
      (provider.models as Array<Record<string, unknown>>)[0]!.customHeaders = {
        'x-secret': 'model-header-secret',
      };
    }],
  ];
  for (const [name, mutate] of cases) {
    const value = sourceConfig();
    mutate(value);
    assert.throws(() => projectConversationProviderConfig(value), /unrecognized key/iu, name);
  }
});

test('formal Provider projection rejects userinfo and every non-HTTPS base URL', () => {
  for (const baseUrl of [
    'https://alice:secret@provider.example/v1',
    'http://provider.example/v1',
    'http://localhost:8080/v1',
    'ws://provider.example/v1',
  ]) {
    const value = sourceConfig();
    (value.providers as Array<Record<string, unknown>>)[0]!.baseUrl = baseUrl;
    assert.throws(
      () => projectConversationProviderConfig(value),
      /must (?:use https|not contain userinfo)/u,
      baseUrl,
    );
  }
});

test('formal Provider projection rejects unknown nested capability fields', () => {
  const value = sourceConfig();
  const provider = (value.providers as Array<Record<string, unknown>>)[0]!;
  const selected = (provider.models as Array<Record<string, unknown>>)[0]!;
  (selected.capabilities as Record<string, unknown>).customAudioGateway = true;
  assert.throws(() => projectConversationProviderConfig(value), /unrecognized key/iu);
});
