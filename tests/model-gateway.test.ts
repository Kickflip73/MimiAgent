import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { Agent, Runner, type Model, type StreamEvent } from '@openai/agents';
import { ModelGateway } from '../src/runtime/model-gateway.js';

async function fakeProvider(label: string) {
  const requests: Array<{
    authorization?: string;
    body?: Record<string, unknown>;
    method?: string;
    path?: string;
  }> = [];
  const server = http.createServer((request, response) => {
    let source = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { source += chunk; });
    request.on('end', () => {
      requests.push({
        authorization: request.headers.authorization,
        body: source ? JSON.parse(source) as Record<string, unknown> : undefined,
        method: request.method,
        path: request.url,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: label, object: 'chat.completion' }));
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
      body: {
        model: 'left-model',
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 1,
        stream: false,
      },
      method: 'POST',
      path: '/v1/chat/completions',
    }]);
    assert.deepEqual(right.requests, [{
      authorization: 'Bearer right-secret',
      body: {
        model: 'right-model',
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 1,
        stream: false,
      },
      method: 'POST',
      path: '/v1/chat/completions',
    }]);
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
});

test('OpenAI-compatible health probes the target model instead of Provider reachability', async () => {
  const requests: Array<{ body: Record<string, unknown>; path: string }> = [];
  const server = http.createServer((request, response) => {
    let source = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { source += chunk; });
    request.on('end', () => {
      const body = JSON.parse(source) as Record<string, unknown>;
      requests.push({ body, path: request.url ?? '' });
      if (body.model === 'compatible-model') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'chat-health', object: 'chat.completion' }));
        return;
      }
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unknown model' }));
    });
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
        }, {
          target: { providerId: 'compatible', modelId: 'missing-model' },
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
    const missing = await gateway.health({
      providerId: 'compatible',
      modelId: 'missing-model',
    });
    assert.equal(missing.status, 'unhealthy');
    assert.match(missing.error ?? '', /HTTP 400.*unknown model/);
    assert.deepEqual(requests, [{
      path: '/v1/chat/completions',
      body: {
        model: 'compatible-model',
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 1,
        stream: false,
      },
    }, {
      path: '/v1/chat/completions',
      body: {
        model: 'missing-model',
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 1,
        stream: false,
      },
    }]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test('OpenAI-compatible health reports an empty-body gateway rejection', async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(400);
      response.end();
    });
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
          target: { providerId: 'compatible', modelId: 'bad-alias' },
          kind: 'agent',
          capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
        }],
      }],
      environment: { COMPATIBLE_KEY: 'compatible-secret' },
    });

    const result = await gateway.health({
      providerId: 'compatible',
      modelId: 'bad-alias',
    });
    assert.equal(result.status, 'unhealthy');
    assert.match(result.error ?? '', /compatible\/bad-alias: HTTP 400/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test('OpenAI-compatible streaming replays provider reasoning_content with tool calls', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer((request, response) => {
    let source = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { source += chunk; });
    request.on('end', () => {
      const body = JSON.parse(source) as Record<string, unknown>;
      requests.push(body);
      const messages = body.messages as Array<Record<string, unknown>>;
      if (requests.length === 2) {
        const assistant = messages.find((message) => message.role === 'assistant');
        if (assistant?.reasoning_content !== '先检查平台能力。') {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            error: {
              message: 'The `reasoning_content` in the thinking mode must be passed back to the API.',
            },
          }));
          return;
        }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (requests.length === 1) {
        response.write(`data: ${JSON.stringify({
          id: 'reasoning-call',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { reasoning_content: '先检查平台能力。' } }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          id: 'reasoning-call',
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'capability-call',
                type: 'function',
                function: { name: 'inspect_capabilities', arguments: '{}' },
              }],
            },
          }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          id: 'reasoning-call',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        })}\n\n`);
      } else {
        response.write(`data: ${JSON.stringify({
          id: 'final-answer',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: '已核实。' } }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          id: 'final-answer',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    const gateway = new ModelGateway({
      providers: [{
        id: 'reasoner',
        label: 'Reasoning-compatible',
        transport: 'openai-chat-completions',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKeyEnv: 'REASONER_KEY',
        models: [{
          target: { providerId: 'reasoner', modelId: 'reasoner-model' },
          kind: 'agent',
          capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
        }],
      }],
      environment: { REASONER_KEY: 'reasoner-secret' },
    });
    const model = gateway.createAgentRuntime(
      { providerId: 'reasoner', modelId: 'reasoner-model' },
    ).model as Model;
    const request = {
      input: '如何进入沙箱终端？',
      modelSettings: {},
      tools: [],
      outputType: 'text' as const,
      handoffs: [],
      tracing: false as const,
    };
    let firstDone: Extract<StreamEvent, { type: 'response_done' }> | undefined;
    for await (const event of model.getStreamedResponse(request)) {
      if (event.type === 'response_done') firstDone = event;
    }
    assert.ok(firstDone);
    assert.equal(firstDone.response.output[0]?.type, 'reasoning');
    const functionCall = firstDone.response.output.find((item) => item.type === 'function_call');
    assert.ok(functionCall);
    assert.equal(functionCall.providerData?.reasoning_content, '先检查平台能力。');

    let finalText = '';
    for await (const event of model.getStreamedResponse({
      ...request,
      input: [
        { role: 'user', content: '如何进入沙箱终端？' },
        ...firstDone.response.output,
        {
          type: 'function_call_result',
          name: 'inspect_capabilities',
          callId: 'capability-call',
          status: 'completed',
          output: '{}',
        },
      ],
    })) {
      if (event.type === 'output_text_delta') finalText += event.delta;
    }
    assert.equal(finalText, '已核实。');
    const replayedAssistant = (requests[1]!.messages as Array<Record<string, unknown>>)
      .find((message) => message.role === 'assistant');
    assert.equal(replayedAssistant?.reasoning_content, '先检查平台能力。');
    assert.equal('reasoning' in (replayedAssistant ?? {}), false);
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
