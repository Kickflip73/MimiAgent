import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { withTrace, type Model, type ModelRequest } from '@openai/agents';
import type { ModelCapabilities, ProviderDefinition } from '../src/core/model-routing.js';
import { MimiAgent } from '../src/runtime/mimi-agent.js';
import { legacyModelConfiguration } from '../src/runtime/model-config.js';
import { ModelGateway } from '../src/runtime/model-gateway.js';
import {
  WorkUnitModelResolver,
  type ResolveWorkUnitModelInput,
} from '../src/runtime/work-unit-model-resolver.js';

const FILE_DATA = 'data:text/plain;base64,aGVsbG8=';

function capabilities(fileInput: boolean): ModelCapabilities {
  return {
    imageInput: false,
    imageOutput: false,
    toolCalling: true,
    fileInput,
  };
}

function fileRequest(file = FILE_DATA): ModelRequest {
  return {
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: 'Summarize this file.' },
        { type: 'input_file', file, filename: 'notes.txt' },
      ],
    }],
    modelSettings: {},
    tools: [],
    outputType: 'text',
    handoffs: [],
    tracing: false,
  };
}

async function fixtureServer(): Promise<{
  baseUrl: string;
  requests: Array<{ path: string; body: Record<string, unknown> }>;
  close(): Promise<void>;
}> {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = http.createServer((request, response) => {
    let source = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { source += chunk; });
    request.on('end', () => {
      const path = request.url ?? '';
      requests.push({ path, body: source ? JSON.parse(source) as Record<string, unknown> : {} });
      response.writeHead(200, { 'content-type': 'application/json' });
      if (path.endsWith('/responses')) {
        response.end(JSON.stringify({
          id: 'response-file',
          object: 'response',
          created_at: 1,
          status: 'completed',
          error: null,
          incomplete_details: null,
          instructions: null,
          max_output_tokens: null,
          model: 'responses-files',
          output: [{
            id: 'message-file',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'responses-ok', annotations: [], logprobs: [] }],
          }],
          parallel_tool_calls: true,
          previous_response_id: null,
          reasoning: { effort: null, summary: null },
          store: false,
          temperature: 1,
          text: { format: { type: 'text' } },
          tool_choice: 'auto',
          tools: [],
          top_p: 1,
          truncation: 'disabled',
          usage: {
            input_tokens: 3,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 2,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 5,
          },
          metadata: {},
        }));
        return;
      }
      response.end(JSON.stringify({
        id: 'chat-file',
        object: 'chat.completion',
        created: 1,
        model: 'chat-files',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'chat-ok', refusal: null },
        }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

function providers(baseUrl: string): ProviderDefinition[] {
  return [
    {
      id: 'responses',
      label: 'Responses',
      transport: 'openai-responses',
      baseUrl,
      apiKeyEnv: 'RESPONSES_KEY',
      models: [
        {
          target: { providerId: 'responses', modelId: 'responses-files' },
          kind: 'agent',
          capabilities: capabilities(true),
        },
        {
          target: { providerId: 'responses', modelId: 'responses-no-files' },
          kind: 'agent',
          capabilities: capabilities(false),
        },
      ],
    },
    {
      id: 'chat',
      label: 'Chat',
      transport: 'openai-chat-completions',
      baseUrl,
      apiKeyEnv: 'CHAT_KEY',
      models: [
        {
          target: { providerId: 'chat', modelId: 'chat-files' },
          kind: 'agent',
          capabilities: capabilities(true),
        },
        {
          target: { providerId: 'chat', modelId: 'chat-no-files' },
          kind: 'agent',
          capabilities: capabilities(false),
        },
      ],
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      transport: 'anthropic-messages',
      baseUrl,
      apiKeyEnv: 'ANTHROPIC_KEY',
      models: [{
        target: { providerId: 'anthropic', modelId: 'claude-files' },
        kind: 'agent',
        capabilities: capabilities(true),
      }],
    },
    {
      id: 'google',
      label: 'Google',
      transport: 'google-generate-content',
      baseUrl,
      apiKeyEnv: 'GOOGLE_KEY',
      models: [{
        target: { providerId: 'google', modelId: 'gemini-files' },
        kind: 'agent',
        capabilities: capabilities(true),
      }],
    },
  ];
}

test('all adapters reject undeclared or unimplemented file input before any network call', async () => {
  const fixture = await fixtureServer();
  try {
    const gateway = new ModelGateway({
      providers: providers(fixture.baseUrl),
      environment: {
        RESPONSES_KEY: 'test',
        CHAT_KEY: 'test',
        ANTHROPIC_KEY: 'test',
        GOOGLE_KEY: 'test',
      },
    });
    const targets = [
      { providerId: 'responses', modelId: 'responses-no-files', pattern: /未声明 fileInput/ },
      { providerId: 'chat', modelId: 'chat-no-files', pattern: /未声明 fileInput/ },
      { providerId: 'anthropic', modelId: 'claude-files', pattern: /尚未实现 fileInput/ },
      { providerId: 'google', modelId: 'gemini-files', pattern: /尚未实现 fileInput/ },
    ] as const;
    for (const target of targets) {
      const model = gateway.createAgentRuntime(target).model as Model;
      await assert.rejects(model.getResponse(fileRequest()), target.pattern);
    }
    const stream = (gateway.createAgentRuntime({
      providerId: 'chat', modelId: 'chat-no-files',
    }).model as Model).getStreamedResponse(fileRequest());
    await assert.rejects(async () => {
      for await (const _event of stream) {
        assert.fail('unsupported file input cannot emit a stream event');
      }
    }, /未声明 fileInput/);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test('audited Responses and Chat adapters serialize declared inline files explicitly', async () => {
  const fixture = await fixtureServer();
  try {
    const gateway = new ModelGateway({
      providers: providers(fixture.baseUrl),
      environment: { RESPONSES_KEY: 'test', CHAT_KEY: 'test' },
    });
    const responsesModel = gateway.createAgentRuntime({
      providerId: 'responses', modelId: 'responses-files',
    }).model as Model;
    const chatModel = gateway.createAgentRuntime({
      providerId: 'chat', modelId: 'chat-files',
    }).model as Model;
    await withTrace('responses-file-input-test', () => responsesModel.getResponse(fileRequest()));
    await withTrace('chat-file-input-test', () => chatModel.getResponse(fileRequest()));

    const responses = fixture.requests.find((request) => request.path.endsWith('/responses'))!;
    const responseInput = responses.body.input as Array<{ content: Array<Record<string, unknown>> }>;
    assert.deepEqual(responseInput[0]!.content[1], {
      type: 'input_file',
      file_data: FILE_DATA,
      filename: 'notes.txt',
    });
    const chat = fixture.requests.find((request) => request.path.endsWith('/chat/completions'))!;
    const messages = chat.body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    assert.deepEqual(messages[0]!.content[1], {
      type: 'file',
      file: { file_data: FILE_DATA, filename: 'notes.txt' },
    });
  } finally {
    await fixture.close();
  }
});

test('declared file models still reject non-staged URLs before network', async () => {
  const fixture = await fixtureServer();
  try {
    const gateway = new ModelGateway({
      providers: providers(fixture.baseUrl),
      environment: { RESPONSES_KEY: 'test' },
    });
    const model = gateway.createAgentRuntime({
      providerId: 'responses', modelId: 'responses-files',
    }).model as Model;
    await assert.rejects(model.getResponse(fileRequest('https://private.example/file')), /base64 data URL/);
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test('standard OpenAI install scans input_file into a hard requirement before model selection', () => {
  const config = legacyModelConfiguration({
    MIMI_MODEL_PROVIDER: 'openai',
    OPENAI_MODEL: 'gpt-5.4-mini',
  });
  const resolver = new WorkUnitModelResolver({
    providers: config.providers,
    routing: config.routing,
  });
  let selectedInput: ResolveWorkUnitModelInput | undefined;
  const gateway = new ModelGateway({
    providers: config.providers,
    environment: { OPENAI_API_KEY: 'test' },
  });
  const fakeAgent = {
    fixedModelBinding: undefined,
    components: {
      modelResolver: {
        resolve: (input: ResolveWorkUnitModelInput) => {
          selectedInput = input;
          return resolver.resolve(input);
        },
      },
      modelGateway: gateway,
      modelConfig: config,
    },
  } as unknown as MimiAgent;
  const binding = MimiAgent.prototype.resolveRunModelBinding.call(
    fakeAgent,
    fileRequest().input,
    undefined,
    {},
  );
  assert.equal(selectedInput?.profile?.requirements?.fileInput, true);
  assert.deepEqual(binding.target, { providerId: 'openai-main', modelId: 'gpt-5.4-mini' });
  assert.equal(config.providers[0]!.models[0]!.capabilities.fileInput, true);
  const providerRouteBinding = MimiAgent.prototype.resolveProviderRouteBinding.call(
    fakeAgent,
    { provider: 'openai', model: 'gpt-5.4-mini' },
    { fileInput: true, toolCalling: true },
    'conversation.default',
  );
  assert.deepEqual(providerRouteBinding.target, {
    providerId: 'openai-main', modelId: 'gpt-5.4-mini',
  });
  assert.equal(providerRouteBinding.reason, 'safe-fallback');
  assert.throws(
    () => MimiAgent.prototype.resolveProviderRouteBinding.call(
      fakeAgent,
      {
        provider: 'deepseek',
        model: 'gpt-5.4-mini',
        exactBinding: providerRouteBinding,
      },
      { fileInput: true, toolCalling: true },
      'conversation.default',
    ),
    /exact binding Provider 不一致/u,
  );
  assert.throws(
    () => MimiAgent.prototype.resolveProviderRouteBinding.call(
      fakeAgent,
      { provider: 'openai', model: 'unregistered-vision-claim' },
      { imageInput: true, toolCalling: true },
      'conversation.default',
    ),
    /未在当前 registry 精确注册/u,
  );
});
