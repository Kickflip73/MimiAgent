import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { Agent, MemorySession, Runner, tool, type Model, type StreamEvent } from '@openai/agents';
import { z } from 'zod';
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
      if (requests.length === 3) {
        const emptyAssistant = messages.find((message) => message.role === 'assistant'
          && (message.content === null || message.content === undefined)
          && (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0));
        const replayedReasoning = messages
          .filter((message) => message.role === 'assistant')
          .map((message) => message.reasoning_content);
        if (emptyAssistant
          || !replayedReasoning.includes('先检查平台能力。')
          || !replayedReasoning.includes('整理最终答复。')) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            error: {
              message: 'Every prior assistant turn must preserve reasoning_content.',
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
      } else if (requests.length === 2) {
        response.write(`data: ${JSON.stringify({
          id: 'final-answer',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { reasoning_content: '整理最终答复。' } }],
        })}\n\n`);
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
      } else {
        response.write(`data: ${JSON.stringify({
          id: 'continued-answer',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: '可以继续。' } }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          id: 'continued-answer',
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
    assert.equal(functionCall.providerData?.reasoning_content, undefined);
    assert.equal(functionCall.providerData?.__mimi_reasoning_content, true);

    let finalText = '';
    let secondDone: Extract<StreamEvent, { type: 'response_done' }> | undefined;
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
      if (event.type === 'response_done') secondDone = event;
    }
    assert.equal(finalText, '已核实。');
    assert.ok(secondDone);
    assert.equal(secondDone.response.output[0]?.type, 'reasoning');
    const replayedAssistant = (requests[1]!.messages as Array<Record<string, unknown>>)
      .find((message) => message.role === 'assistant');
    assert.equal(replayedAssistant?.reasoning_content, '先检查平台能力。');
    assert.equal('reasoning' in (replayedAssistant ?? {}), false);

    let continuedText = '';
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
        ...secondDone.response.output,
        { role: 'user', content: '现在怎么样了？' },
      ],
    })) {
      if (event.type === 'output_text_delta') continuedText += event.delta;
    }
    assert.equal(continuedText, '可以继续。');
    const thirdMessages = requests[2]!.messages as Array<Record<string, unknown>>;
    assert.equal(thirdMessages.some((message) => message.role === 'assistant'
      && (message.content === null || message.content === undefined)
      && (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0)), false);
    assert.deepEqual(
      thirdMessages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.reasoning_content),
      ['先检查平台能力。', '整理最终答复。'],
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test('OpenAI-compatible replay preserves empty reasoning_content in streamed and non-streamed calls', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer((request, response) => {
    let source = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { source += chunk; });
    request.on('end', () => {
      const body = JSON.parse(source) as Record<string, unknown>;
      requests.push(body);
      const messages = body.messages as Array<Record<string, unknown>>;
      const stream = body.stream === true;
      const isReplay = messages.some((message) => message.role === 'tool');
      if (isReplay) {
        const assistant = messages.find((message) => message.role === 'assistant'
          && Array.isArray(message.tool_calls));
        const pollutedContent = Array.isArray(assistant?.content)
          && assistant.content.some((part) => {
            const value = part as Record<string, unknown>;
            return ['role', 'tool_calls', 'reasoning', 'reasoning_content', '__mimi_reasoning_content']
              .some((name) => Object.prototype.hasOwnProperty.call(value, name));
          });
        const pollutedToolCall = Array.isArray(assistant?.tool_calls)
          && assistant.tool_calls.some((call) => {
            const value = call as Record<string, unknown>;
            return ['reasoning', 'reasoning_content', '__mimi_reasoning_content']
              .some((name) => Object.prototype.hasOwnProperty.call(value, name));
          });
        if (!assistant
          || !Object.prototype.hasOwnProperty.call(assistant, 'reasoning_content')
          || assistant.reasoning_content !== ''
          || Object.prototype.hasOwnProperty.call(assistant, 'reasoning')
          || Object.prototype.hasOwnProperty.call(assistant, '__mimi_reasoning_content')
          || (!stream && !JSON.stringify(assistant.content).includes('非流式前言。'))
          || pollutedContent
          || pollutedToolCall) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            error: { message: 'Empty reasoning_content must still be passed back.' },
          }));
          return;
        }
      }
      const message = isReplay
        ? { role: 'assistant', content: stream ? '流式完成。' : '非流式完成。' }
        : {
            role: 'assistant',
            content: stream ? null : '非流式前言。',
            reasoning_content: '',
            tool_calls: [{
              id: stream ? 'stream-empty-call' : 'response-empty-call',
              type: 'function',
              function: { name: 'inspect', arguments: '{}' },
            }],
          };
      if (!stream) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id: isReplay ? 'empty-final' : 'empty-call',
          object: 'chat.completion',
          created: 1,
          model: 'empty-reasoner-model',
          choices: [{
            index: 0,
            finish_reason: isReplay ? 'stop' : 'tool_calls',
            message,
          }],
        }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (isReplay) {
        response.write(`data: ${JSON.stringify({
          id: 'stream-empty-final',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: message.content } }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          id: 'stream-empty-final',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`);
      } else {
        response.write(`data: ${JSON.stringify({
          id: 'stream-empty-call',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { reasoning_content: '' } }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          id: 'stream-empty-call',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { tool_calls: message.tool_calls } }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          id: 'stream-empty-call',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
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
        id: 'empty-reasoner',
        label: 'Empty reasoner',
        transport: 'openai-chat-completions',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKeyEnv: 'EMPTY_REASONER_KEY',
        models: [{
          target: { providerId: 'empty-reasoner', modelId: 'empty-reasoner-model' },
          kind: 'agent',
          capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
        }],
      }],
      environment: { EMPTY_REASONER_KEY: 'empty-reasoner-secret' },
    });
    const model = gateway.createAgentRuntime(
      { providerId: 'empty-reasoner', modelId: 'empty-reasoner-model' },
    ).model;
    const agent = new Agent({
      name: 'Empty reasoning fixture',
      model,
      tools: [tool({
        name: 'inspect',
        description: 'Inspect source.',
        parameters: z.object({}),
        execute: async () => '{}',
      })],
    });

    const responseSession = new MemorySession();
    const responseResult = await new Runner({ tracingDisabled: true }).run(agent, '检查项目', {
      maxTurns: 3,
      session: responseSession,
    });
    assert.equal(responseResult.finalOutput, '非流式完成。');
    const responseReasoning = (await responseSession.getItems())
      .find((item) => item.type === 'reasoning');
    assert.equal(responseReasoning?.rawContent?.[0]?.text, '');

    const streamSession = new MemorySession();
    const streamResult = await new Runner({ tracingDisabled: true }).run(agent, '检查项目', {
      maxTurns: 3,
      session: streamSession,
      stream: true,
    });
    await streamResult.completed;
    assert.equal(streamResult.finalOutput, '流式完成。');
    const streamReasoning = (await streamSession.getItems())
      .find((item) => item.type === 'reasoning');
    assert.equal(streamReasoning?.rawContent?.[0]?.text, '');
    assert.equal(requests.length, 4);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test('OpenAI-compatible streamed runner replays reasoning with assistant preamble and failed parallel tool output', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer((request, response) => {
    let source = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { source += chunk; });
    request.on('end', () => {
      const body = JSON.parse(source) as Record<string, unknown>;
      requests.push(body);
      const messages = body.messages as Array<Record<string, unknown>>;
      const emptyAssistant = messages.find((message) => message.role === 'assistant'
        && (message.content === null || message.content === undefined)
        && (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0));
      if (emptyAssistant) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          error: { message: 'Invalid assistant message: content or tool_calls must be set' },
        }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (requests.length === 1) {
        response.write(`data: ${JSON.stringify({
          id: 'parallel-tools',
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: { reasoning_content: '先检查目录和源码。' },
          }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          id: 'parallel-tools',
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: { content: '我先实际读取项目来确认。' },
          }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          id: 'parallel-tools',
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'list-call',
                type: 'function',
                function: { name: 'list_directory', arguments: '{}' },
              }, {
                index: 1,
                id: 'search-call',
                type: 'function',
                function: { name: 'search_files', arguments: '{}' },
              }],
            },
          }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          id: 'parallel-tools',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        })}\n\n`);
        response.end('data: [DONE]\n\n');
        return;
      }
      response.write(`data: ${JSON.stringify({
        id: 'parallel-tools-final',
        object: 'chat.completion.chunk',
        choices: [{
          index: 0,
          delta: { content: '检查完成。' },
        }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: 'parallel-tools-final',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`);
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
    ).model;
    const agent = new Agent({
      name: 'Parallel tool fixture',
      model,
      tools: [
        tool({
          name: 'list_directory',
          description: 'List a directory.',
          parameters: z.object({}),
          execute: async () => '{"entries":[]}',
        }),
        tool({
          name: 'search_files',
          description: 'Search files.',
          parameters: z.object({}),
          execute: async () => { throw new Error('文件搜索扫描项超过 10000 个'); },
        }),
      ],
    });

    const session = new MemorySession();
    const result = await new Runner({ tracingDisabled: true }).run(agent, '检查项目', {
      maxTurns: 3,
      session,
      stream: true,
    });
    await result.completed;

    assert.equal(result.finalOutput, '检查完成。');
    assert.equal(requests.length, 2);
    const replay = requests[1]!.messages as Array<Record<string, unknown>>;
    assert.equal(replay.some((message) => message.role === 'assistant'
      && (message.content === null || message.content === undefined)
      && (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0)), false);
    const toolCallAssistant = replay.find((message) => message.role === 'assistant'
      && Array.isArray(message.tool_calls));
    assert.equal(toolCallAssistant?.reasoning_content, '先检查目录和源码。');
    assert.equal('reasoning' in (toolCallAssistant ?? {}), false);
    assert.match(JSON.stringify(toolCallAssistant?.content), /我先实际读取项目来确认/);
    assert.equal((toolCallAssistant?.tool_calls as Array<Record<string, unknown>>)
      .some((call) => 'reasoning' in call || 'reasoning_content' in call), false);
    const toolResults = replay.filter((message) => message.role === 'tool');
    assert.deepEqual(
      toolResults.map((message) => message.tool_call_id).sort(),
      ['list-call', 'search-call'],
    );
    assert.match(JSON.stringify(toolResults), /文件搜索扫描项超过 10000 个/);
    const canonicalHistory = await session.getItems();
    assert.equal(canonicalHistory.some((item) => item.type === 'reasoning'), true);
    assert.equal(canonicalHistory.filter((item) => item.type === 'function_call').length, 2);
    assert.equal(canonicalHistory.filter((item) => item.type === 'function_call_result').length, 2);
    assert.equal(canonicalHistory.filter((item) => {
      const value = item as unknown as Record<string, unknown>;
      const providerData = value.providerData as Record<string, unknown> | undefined;
      return providerData?.__mimi_reasoning_content === true;
    }).length, 1);
    assert.equal(JSON.stringify(canonicalHistory).match(/reasoning_content":"先检查目录和源码/g)?.length ?? 0, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test('OpenAI-compatible streamed runner keeps native reasoning attached across an assistant preamble', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer((request, response) => {
    let source = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { source += chunk; });
    request.on('end', () => {
      const body = JSON.parse(source) as Record<string, unknown>;
      requests.push(body);
      const messages = body.messages as Array<Record<string, unknown>>;
      if (requests.length === 1) {
        const switchedHistory = messages.find((message) => message.role === 'assistant'
          && JSON.stringify(message.content).includes('旧 DeepSeek 回答'));
        if (switchedHistory?.reasoning !== '旧 DeepSeek 推理'
          || Object.prototype.hasOwnProperty.call(switchedHistory ?? {}, 'reasoning_content')
          || Object.prototype.hasOwnProperty.call(switchedHistory ?? {}, '__mimi_reasoning_content')) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            error: { message: 'Reasoning marker leaked across compatible Providers.' },
          }));
          return;
        }
      }
      if (requests.length === 2) {
        const toolCallAssistant = messages.find((message) => message.role === 'assistant'
          && Array.isArray(message.tool_calls));
        if (toolCallAssistant?.reasoning !== 'must-replay') {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            error: { message: 'Native reasoning must be passed back with the tool call.' },
          }));
          return;
        }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (requests.length === 1) {
        for (const delta of [
          { reasoning: 'must-replay' },
          { content: '我先读取源码。' },
          {
            tool_calls: [{
              index: 0,
              id: 'inspect-call',
              type: 'function',
              function: { name: 'inspect', arguments: '{}' },
            }],
          },
        ]) {
          response.write(`data: ${JSON.stringify({
            id: 'native-reasoning-call',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta }],
          })}\n\n`);
        }
        response.write(`data: ${JSON.stringify({
          id: 'native-reasoning-call',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        })}\n\n`);
      } else {
        response.write(`data: ${JSON.stringify({
          id: 'native-reasoning-final',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: '检查完成。' } }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          id: 'native-reasoning-final',
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
        id: 'native-reasoner',
        label: 'Native reasoner',
        transport: 'openai-chat-completions',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKeyEnv: 'NATIVE_REASONER_KEY',
        models: [{
          target: { providerId: 'native-reasoner', modelId: 'native-reasoner-model' },
          kind: 'agent',
          capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
        }],
      }],
      environment: { NATIVE_REASONER_KEY: 'native-reasoner-secret' },
    });
    const model = gateway.createAgentRuntime(
      { providerId: 'native-reasoner', modelId: 'native-reasoner-model' },
    ).model;
    const agent = new Agent({
      name: 'Native reasoning fixture',
      model,
      tools: [tool({
        name: 'inspect',
        description: 'Inspect source.',
        parameters: z.object({}),
        execute: async () => '{}',
      })],
    });

    const session = new MemorySession();
    await session.addItems([
      { role: 'user', content: '旧问题' },
      {
        type: 'reasoning',
        content: [],
        rawContent: [{ type: 'reasoning_text', text: '旧 DeepSeek 推理' }],
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '旧 DeepSeek 回答' }],
        providerData: { __mimi_reasoning_content: true },
      },
    ]);
    const result = await new Runner({ tracingDisabled: true }).run(agent, '检查项目', {
      maxTurns: 3,
      session,
      stream: true,
    });
    await result.completed;

    assert.equal(result.finalOutput, '检查完成。');
    assert.equal(requests.length, 2);
    const replay = requests[1]!.messages as Array<Record<string, unknown>>;
    assert.equal(replay.some((message) => message.role === 'assistant'
      && (message.content === null || message.content === undefined)
      && (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0)), false);
    const toolCallAssistant = replay.find((message) => message.role === 'assistant'
      && Array.isArray(message.tool_calls));
    assert.equal(toolCallAssistant?.reasoning, 'must-replay');
    assert.match(JSON.stringify(toolCallAssistant?.content), /我先读取源码/);
    assert.equal(replay.filter((message) => message.role === 'assistant'
      && Array.isArray(message.tool_calls)).length, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test('DeepSeek adapter migrates legacy reasoning-only session turns on the wire', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer((request, response) => {
    let source = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { source += chunk; });
    request.on('end', () => {
      const body = JSON.parse(source) as Record<string, unknown>;
      requests.push(body);
      const messages = body.messages as Array<Record<string, unknown>>;
      const legacyAnswer = messages.find((message) => message.role === 'assistant'
        && JSON.stringify(message.content).includes('旧回答'));
      if (!Array.isArray(body.tools)
        || legacyAnswer?.reasoning_content !== '旧版 DeepSeek 推理'
        || Object.prototype.hasOwnProperty.call(legacyAnswer ?? {}, 'reasoning')) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          error: { message: 'Legacy DeepSeek reasoning_content was not migrated.' },
        }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({
        id: 'legacy-session-final',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: '兼容完成。' } }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: 'legacy-session-final',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    const gateway = new ModelGateway({
      providers: [{
        id: 'deepseek-main',
        label: 'DeepSeek',
        transport: 'openai-chat-completions',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKeyEnv: 'DEEPSEEK_FIXTURE_KEY',
        models: [{
          target: { providerId: 'deepseek-main', modelId: 'prod-reasoner' },
          kind: 'agent',
          capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
        }],
      }],
      environment: { DEEPSEEK_FIXTURE_KEY: 'deepseek-fixture-secret' },
    });
    const model = gateway.createAgentRuntime(
      { providerId: 'deepseek-main', modelId: 'prod-reasoner' },
    ).model as Model;
    let finalText = '';
    for await (const event of model.getStreamedResponse({
      input: [
        { role: 'user', content: '旧问题' },
        {
          type: 'reasoning',
          content: [],
          rawContent: [{ type: 'reasoning_text', text: '旧版 DeepSeek 推理' }],
        },
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: '旧回答' }],
        },
        { role: 'user', content: '继续' },
      ],
      modelSettings: {},
      tools: [tool({
        name: 'inspect',
        description: 'Inspect source.',
        parameters: z.object({}),
        execute: async () => '{}',
      })],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    })) {
      if (event.type === 'output_text_delta') finalText += event.delta;
    }
    assert.equal(finalText, '兼容完成。');
    assert.equal(requests.length, 1);
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
