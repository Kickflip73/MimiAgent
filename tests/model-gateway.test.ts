import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { Agent, Runner } from '@openai/agents';
import { ModelGateway } from '../src/runtime/model-gateway.js';

async function fakeProvider(label: string) {
  const requests: Array<{ authorization?: string; path?: string }> = [];
  const server = http.createServer((request, response) => {
    requests.push({
      authorization: request.headers.authorization,
      path: request.url,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: label, object: 'model' }));
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

test('gateway keeps endpoint, model and credential isolated across concurrent targets', async () => {
  const left = await fakeProvider('left');
  const right = await fakeProvider('right');
  try {
    const environment = {
      LEFT_KEY: 'left-secret',
      RIGHT_KEY: 'right-secret',
    };
    const gateway = new ModelGateway({
      providers: [
        {
          id: 'left',
          label: 'Left',
          transport: 'openai-chat-completions',
          baseUrl: left.baseUrl,
          apiKeyEnv: 'LEFT_KEY',
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
          baseUrl: right.baseUrl,
          apiKeyEnv: 'RIGHT_KEY',
          models: [{
            target: { providerId: 'right', modelId: 'right-model' },
            kind: 'agent',
            capabilities: { imageInput: true, imageOutput: false, toolCalling: true },
          }],
        },
      ],
      environment,
    });
    const [leftHealth, rightHealth] = await Promise.all([
      gateway.health({ providerId: 'left', modelId: 'left-model' }),
      gateway.health({ providerId: 'right', modelId: 'right-model' }),
    ]);
    assert.equal(leftHealth.status, 'healthy');
    assert.equal(rightHealth.status, 'healthy');
    assert.deepEqual(left.requests, [{
      authorization: 'Bearer left-secret',
      path: '/v1/models',
    }]);
    assert.deepEqual(right.requests, [{
      authorization: 'Bearer right-secret',
      path: '/v1/models',
    }]);
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
});

test('OpenAI-compatible health does not require the optional model-detail endpoint', async () => {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? '');
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [] }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'model detail endpoint is not supported' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    const gateway = new ModelGateway({
      providers: [{
        id: 'compatible',
        label: 'Compatible',
        transport: 'openai-chat-completions',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKeyEnv: 'COMPATIBLE_KEY',
        models: [{
          target: { providerId: 'compatible', modelId: 'compatible-model' },
          kind: 'agent',
          capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
        }],
      }],
      environment: { COMPATIBLE_KEY: 'compatible-secret' },
    });

    assert.equal(
      (await gateway.health({ providerId: 'compatible', modelId: 'compatible-model' })).status,
      'healthy',
    );
    assert.deepEqual(requests, ['/v1/models']);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test('gateway rejects missing credentials, incompatible runtime kind and unknown targets', () => {
  const gateway = new ModelGateway({
    providers: [{
      id: 'image',
      label: 'Image',
      transport: 'openai-responses',
      apiKeyEnv: 'IMAGE_KEY',
      models: [{
        target: { providerId: 'image', modelId: 'image-only' },
        kind: 'image-generation',
        capabilities: { imageInput: false, imageOutput: true, toolCalling: false },
      }],
    }],
    environment: {},
  });
  assert.throws(
    () => gateway.createImageRuntime({ providerId: 'image', modelId: 'image-only' }),
    /IMAGE_KEY/,
  );
  assert.throws(
    () => gateway.createAgentRuntime({ providerId: 'image', modelId: 'image-only' }, 'auto'),
    /Agent|agent/,
  );
  assert.throws(
    () => gateway.inspect({ providerId: 'missing', modelId: 'missing' }),
    /未注册/,
  );
});

test('OpenAI Responses and OpenAI-compatible adapters send distinct native requests', async () => {
  const requests: Array<{
    path?: string;
    authorization?: string;
    body: Record<string, unknown>;
  }> = [];
  const server = http.createServer((request, response) => {
    let source = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { source += chunk; });
    request.on('end', () => {
      const body = JSON.parse(source) as Record<string, unknown>;
      requests.push({
        path: request.url,
        authorization: request.headers.authorization,
        body,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      if (request.url?.endsWith('/responses')) {
        response.end(JSON.stringify({
          id: 'resp-fake',
          object: 'response',
          created_at: 1,
          status: 'completed',
          error: null,
          incomplete_details: null,
          instructions: null,
          max_output_tokens: null,
          model: 'responses-model',
          output: [{
            id: 'msg-fake',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{
              type: 'output_text',
              text: 'responses-ok',
              annotations: [],
              logprobs: [],
            }],
          }],
          parallel_tool_calls: true,
          previous_response_id: null,
          reasoning: { effort: 'high', summary: null },
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
        id: 'chat-fake',
        object: 'chat.completion',
        created: 1,
        model: 'chat-model',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'chat-ok', refusal: null },
        }],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 2,
          total_tokens: 6,
        },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  try {
    const gateway = new ModelGateway({
      providers: [
        {
          id: 'responses',
          label: 'Responses',
          transport: 'openai-responses',
          baseUrl,
          apiKeyEnv: 'RESPONSES_KEY',
          models: [{
            target: { providerId: 'responses', modelId: 'responses-model' },
            kind: 'agent',
            capabilities: { imageInput: true, imageOutput: false, toolCalling: true },
          }],
        },
        {
          id: 'chat',
          label: 'Chat',
          transport: 'openai-chat-completions',
          baseUrl,
          apiKeyEnv: 'CHAT_KEY',
          models: [{
            target: { providerId: 'chat', modelId: 'chat-model' },
            kind: 'agent',
            capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
          }],
        },
      ],
      environment: {
        RESPONSES_KEY: 'responses-secret',
        CHAT_KEY: 'chat-secret',
      },
    });
    const runner = new Runner({ tracingDisabled: true });
    const [responses, chat] = await Promise.all([
      runner.run(new Agent({
        name: 'Responses fixture',
        model: gateway.createAgentRuntime(
          { providerId: 'responses', modelId: 'responses-model' },
          'high',
        ).model,
        modelSettings: { reasoning: { effort: 'high' } },
      }), 'hello', { maxTurns: 1 }),
      runner.run(new Agent({
        name: 'Chat fixture',
        model: gateway.createAgentRuntime(
          { providerId: 'chat', modelId: 'chat-model' },
          'high',
        ).model,
        modelSettings: { reasoning: { effort: 'high' } },
      }), 'hello', { maxTurns: 1 }),
    ]);
    assert.equal(responses.finalOutput, 'responses-ok');
    assert.equal(chat.finalOutput, 'chat-ok');
    assert.deepEqual(requests.map((item) => ({
      path: item.path,
      authorization: item.authorization,
      model: item.body.model,
    })).sort((left, right) => String(left.path).localeCompare(String(right.path))), [
      {
        path: '/v1/chat/completions',
        authorization: 'Bearer chat-secret',
        model: 'chat-model',
      },
      {
        path: '/v1/responses',
        authorization: 'Bearer responses-secret',
        model: 'responses-model',
      },
    ]);
    assert.doesNotMatch(JSON.stringify(requests[0]), /chat-secret.*responses-secret|responses-secret.*chat-secret/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});
