import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { AgentInputItem } from '@openai/agents';
import type { AppConfig } from '../src/config.js';
import { requireProviderApiKey } from '../src/runtime/bootstrap.js';
import {
  createModel,
  normalizeModelInput,
  resolveModelProfile,
} from '../src/runtime/model.js';
import { createTools } from '../src/tools.js';

const contractSchema = z.object({
  schemaVersion: z.literal(1),
  providers: z.array(z.object({
    provider: z.enum(['openai', 'deepseek', 'openai-compatible']),
    apiKeyEnvironment: z.enum(['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'MIMI_PROVIDER_API_KEY']),
    defaultModel: z.string().min(1),
    transport: z.enum(['responses', 'chat_completions']),
    profile: z.object({
      contextWindow: z.number().int().positive(),
      outputReserve: z.number().int().positive(),
      supportsImageInput: z.boolean(),
    }).strict(),
    messageIds: z.object({
      nativePrefix: z.string().min(1),
      preserveNative: z.boolean(),
      preserveForeign: z.boolean(),
    }).strict(),
  }).strict()).length(3),
}).strict();

const canarySchema = z.object({
  schemaVersion: z.literal(1),
  cases: z.array(z.object({
    provider: z.enum(['openai', 'deepseek']),
    apiKeyEnvironment: z.enum(['OPENAI_API_KEY', 'DEEPSEEK_API_KEY']),
    input: z.string().min(1),
    expectedTools: z.array(z.string().min(1)).min(1),
    expectedOutput: z.string().min(1),
  }).strict()).length(2),
}).strict();

function config(provider: AppConfig['provider']): AppConfig {
  return {
    provider,
    ...(provider === 'openai-compatible' ? {
      providerBaseUrl: 'https://provider.example/v1',
      defaultModel: 'provider-model',
    } : {}),
    workspaceRoot: '/tmp/provider-contract-workspace',
    dataRoot: '/tmp/provider-contract-data',
    daemonDataRoot: '/tmp/provider-contract-daemon',
    skillsRoot: '/tmp/provider-contract-skills',
    mcpConfig: '/tmp/provider-contract-mcp.json',
    historyLimit: 40,
    maxTurns: 200,
    securityProfile: 'safe',
    permissionMode: 'read-only',
  };
}

test('built-in and OpenAI-compatible providers obey the checked-in provider contract fixture', async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const fixture = contractSchema.parse(JSON.parse(await readFile(
    path.join(directory, '../evals/provider-contracts.json'),
    'utf8',
  )) as unknown);
  assert.deepEqual(
    fixture.providers.map((entry) => entry.provider).sort(),
    ['deepseek', 'openai', 'openai-compatible'],
  );

  const saved = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    MIMI_PROVIDER_API_KEY: process.env.MIMI_PROVIDER_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
  };
  delete process.env.OPENAI_MODEL;
  delete process.env.DEEPSEEK_MODEL;
  try {
    for (const contract of fixture.providers) {
      const providerConfig = config(contract.provider);
      process.env[contract.apiKeyEnvironment] = 'fixture-key';
      assert.doesNotThrow(() => requireProviderApiKey(providerConfig));
      const runtime = createModel(providerConfig);
      assert.equal(runtime.name, contract.defaultModel);
      assert.deepEqual(runtime.profile, contract.profile);
      assert.deepEqual(resolveModelProfile(providerConfig, contract.defaultModel), contract.profile);
      assert.equal(
        typeof runtime.model === 'string' ? 'responses' : 'chat_completions',
        contract.transport,
      );
      const tools = createTools(process.cwd(), contract.provider === 'openai');
      assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
      for (const name of ['http_get', 'http_request']) {
        const selected = tools.find((tool) => tool.name === name) as { parameters?: unknown } | undefined;
        assert.ok(selected);
        const serialized = JSON.stringify(selected.parameters);
        assert.doesNotMatch(serialized, /"format":"uri"|"propertyNames"/);
      }

      const nativeId = `${contract.messageIds.nativePrefix}_fixture`;
      const foreignId = 'foreign-provider-id';
      const input = [
        { type: 'message', id: nativeId, role: 'assistant', content: 'native' },
        { type: 'message', id: foreignId, role: 'assistant', content: 'foreign' },
      ] as unknown as AgentInputItem[];
      const normalized = normalizeModelInput(contract.provider, input) as unknown as Array<Record<string, unknown>>;
      assert.equal('id' in normalized[0]!, contract.messageIds.preserveNative);
      assert.equal('id' in normalized[1]!, contract.messageIds.preserveForeign);

      delete process.env[contract.apiKeyEnvironment];
      assert.throws(() => requireProviderApiKey(providerConfig), new RegExp(contract.apiKeyEnvironment));
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('real Provider canary stays aligned with the offline provider contract', async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const [contract, canary] = await Promise.all([
    readFile(path.join(directory, '../evals/provider-contracts.json'), 'utf8')
      .then((value) => contractSchema.parse(JSON.parse(value) as unknown)),
    readFile(path.join(directory, '../evals/provider-canary.json'), 'utf8')
      .then((value) => canarySchema.parse(JSON.parse(value) as unknown)),
  ]);
  assert.deepEqual(
    canary.cases.map(({ provider, apiKeyEnvironment }) => ({ provider, apiKeyEnvironment })),
    contract.providers
      .filter(({ provider }) => provider !== 'openai-compatible')
      .map(({ provider, apiKeyEnvironment }) => ({ provider, apiKeyEnvironment })),
  );
  for (const item of canary.cases) {
    assert.deepEqual(item.expectedTools, ['calculate']);
    assert.match(item.expectedOutput, /^CANARY_OK=\d+$/);
  }
});

test('OpenAI-compatible model construction fails closed without endpoint or model', () => {
  const missingEndpoint = config('openai-compatible');
  delete missingEndpoint.providerBaseUrl;
  assert.throws(() => createModel(missingEndpoint), /MIMI_PROVIDER_BASE_URL/);
  const missingModel = config('openai-compatible');
  delete missingModel.defaultModel;
  assert.throws(() => createModel(missingModel), /MIMI_MODEL/);
});

test('Chat Completions history removes orphan reasoning without breaking tool-call replay', () => {
  const orphanReasoning = {
    type: 'reasoning',
    content: [],
    rawContent: [{ type: 'reasoning_text', text: '已经完成思考。' }],
  };
  const toolReasoning = {
    type: 'reasoning',
    content: [],
    rawContent: [{ type: 'reasoning_text', text: '需要调用工具。' }],
  };
  const functionCall = {
    type: 'function_call',
    callId: 'call_1',
    name: 'inspect',
    arguments: '{}',
    providerData: { reasoning_content: '需要调用工具。' },
  };
  const items = [
    { role: 'user', content: '第一问' },
    orphanReasoning,
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '第一答' }],
    },
    { role: 'user', content: '第二问' },
    toolReasoning,
    functionCall,
    {
      type: 'function_call_result',
      callId: 'call_1',
      name: 'inspect',
      output: '{}',
    },
  ] as unknown as AgentInputItem[];

  for (const provider of ['deepseek', 'openai-compatible', 'openai-chat-completions'] as const) {
    const normalized = normalizeModelInput(provider, items);
    assert.equal(normalized.includes(orphanReasoning as never), false);
    assert.equal(normalized.includes(toolReasoning as never), true);
    assert.equal(normalized.includes(functionCall as never), true);
  }
  assert.equal(normalizeModelInput('google-generate-content', items), items);
});
