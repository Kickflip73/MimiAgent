import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Agent, Runner, tool, type Model } from '@openai/agents';
import { z } from 'zod';
import { ModelGateway } from '../src/runtime/model-gateway.js';
import { normalizeModelInput } from '../src/runtime/model.js';

async function fakeNative(
  protocol: 'anthropic' | 'google',
): Promise<{
  baseUrl: string;
  requests: Array<{ path?: string; headers: http.IncomingHttpHeaders; body: string }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ path?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ path: request.url, headers: request.headers, body });
      response.writeHead(200, { 'content-type': 'application/json', 'x-request-id': `${protocol}-request` });
      response.end(protocol === 'anthropic'
        ? JSON.stringify({
            id: 'anthropic-response',
            content: [{ type: 'text', text: 'anthropic-ok' }],
            usage: { input_tokens: 3, output_tokens: 2 },
          })
        : JSON.stringify({
            responseId: 'google-response',
            candidates: [{ content: { parts: [{ text: 'google-ok' }] } }],
            usageMetadata: {
              promptTokenCount: 4,
              candidatesTokenCount: 2,
              totalTokenCount: 6,
            },
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

async function fakeNativeToolLoop(
  protocol: 'anthropic' | 'google',
): Promise<{
  baseUrl: string;
  requests: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { 'content-type': 'application/json' });
      const firstRequest = requests.length === 1;
      if (protocol === 'anthropic') {
        response.end(JSON.stringify({
          id: `anthropic-${requests.length}`,
          content: firstRequest
            ? [{ type: 'tool_use', id: 'native-tool-call', name: 'inspect_fixture', input: {} }]
            : [{ type: 'text', text: 'anthropic-finished' }],
          usage: { input_tokens: 3, output_tokens: 2 },
        }));
        return;
      }
      response.end(JSON.stringify({
        responseId: `google-${requests.length}`,
        candidates: [{
          content: {
            parts: firstRequest
              ? [{ functionCall: { name: 'inspect_fixture', args: {} } }]
              : [{ text: 'google-finished' }],
          },
        }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
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

test('Anthropic and Gemini adapters use distinct native protocols behind one Model contract', async () => {
  const anthropic = await fakeNative('anthropic');
  const google = await fakeNative('google');
  try {
    const gateway = new ModelGateway({
      providers: [
        {
          id: 'claude',
          label: 'Claude',
          transport: 'anthropic-messages',
          baseUrl: anthropic.baseUrl,
          apiKeyEnv: 'CLAUDE_KEY',
          models: [{
            target: { providerId: 'claude', modelId: 'claude-test' },
            kind: 'agent',
            capabilities: { imageInput: true, imageOutput: false, toolCalling: true },
            reasoning: { high: 'adaptive', supportsOff: true },
          }],
        },
        {
          id: 'gemini',
          label: 'Gemini',
          transport: 'google-generate-content',
          baseUrl: google.baseUrl,
          apiKeyEnv: 'GEMINI_KEY',
          models: [{
            target: { providerId: 'gemini', modelId: 'gemini-test' },
            kind: 'agent',
            capabilities: { imageInput: true, imageOutput: false, toolCalling: true },
          }],
        },
      ],
      environment: { CLAUDE_KEY: 'claude-secret', GEMINI_KEY: 'gemini-secret' },
    });
    const request = {
      input: [{
        role: 'user' as const,
        content: [
          { type: 'input_text' as const, text: 'describe this image' },
          {
            type: 'input_image' as const,
            image: 'data:image/png;base64,aW1hZ2UtYnl0ZXM=',
            detail: 'auto' as const,
          },
        ],
      }],
      modelSettings: {},
      tools: [],
      outputType: 'text' as const,
      handoffs: [],
      tracing: false as const,
    };
    const [claude, gemini] = await Promise.all([
      (gateway.createAgentRuntime(
        { providerId: 'claude', modelId: 'claude-test' },
        'high',
      ).model as Model).getResponse(request),
      (gateway.createAgentRuntime(
        { providerId: 'gemini', modelId: 'gemini-test' },
        'off',
      ).model as Model).getResponse(request),
    ]);
    assert.equal(claude.responseId, 'anthropic-response');
    assert.equal(gemini.responseId, 'google-response');
    assert.equal(anthropic.requests[0]?.path, '/v1/messages');
    assert.equal(anthropic.requests[0]?.headers['x-api-key'], 'claude-secret');
    assert.match(anthropic.requests[0]!.body, /"thinking":\{"type":"adaptive"/);
    assert.match(anthropic.requests[0]!.body, /"output_config":\{"effort":"high"/);
    assert.deepEqual(
      (JSON.parse(anthropic.requests[0]!.body) as {
        messages: Array<{ content: unknown }>;
      }).messages[0]?.content,
      [
        { type: 'text', text: 'describe this image' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'aW1hZ2UtYnl0ZXM=',
          },
        },
      ],
    );
    assert.equal(google.requests[0]?.path, '/v1/models/gemini-test:generateContent');
    assert.equal(google.requests[0]?.headers['x-goog-api-key'], 'gemini-secret');
    assert.match(google.requests[0]!.body, /"thinkingBudget":0/);
    assert.deepEqual(
      (JSON.parse(google.requests[0]!.body) as {
        contents: Array<{ parts: unknown }>;
      }).contents[0]?.parts,
      [
        { text: 'describe this image' },
        {
          inlineData: {
            mimeType: 'image/png',
            data: 'aW1hZ2UtYnl0ZXM=',
          },
        },
      ],
    );
    assert.doesNotMatch(JSON.stringify(anthropic.requests), /gemini-secret/);
    assert.doesNotMatch(JSON.stringify(google.requests), /claude-secret/);
  } finally {
    await Promise.all([anthropic.close(), google.close()]);
  }
});

test('native adapters preserve the real SDK tool result in the second Runner request', async () => {
  for (const protocol of ['anthropic', 'google'] as const) {
    const server = await fakeNativeToolLoop(protocol);
    try {
      const providerId = `${protocol}-tool-loop`;
      const apiKeyEnv = `${protocol.toUpperCase()}_TOOL_LOOP_KEY`;
      const gateway = new ModelGateway({
        providers: [{
          id: providerId,
          label: `${protocol} tool loop`,
          transport: protocol === 'anthropic' ? 'anthropic-messages' : 'google-generate-content',
          baseUrl: server.baseUrl,
          apiKeyEnv,
          models: [{
            target: { providerId, modelId: `${protocol}-model` },
            kind: 'agent',
            capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
          }],
        }],
        environment: { [apiKeyEnv]: 'fixture-secret' },
      });
      let executions = 0;
      const agent = new Agent({
        name: `${protocol} runner fixture`,
        model: gateway.createAgentRuntime({
          providerId,
          modelId: `${protocol}-model`,
        }).model,
        tools: [tool({
          name: 'inspect_fixture',
          description: 'Return a structured fixture result.',
          parameters: z.object({}),
          execute: async () => ({ marker: 'TOOL_RESULT_VISIBLE', executions: ++executions }),
        })],
      });

      const result = await new Runner({ tracingDisabled: true }).run(agent, 'inspect', { maxTurns: 3 });

      assert.equal(result.finalOutput, `${protocol}-finished`);
      assert.equal(executions, 1);
      assert.equal(server.requests.length, 2);
      const replay = JSON.stringify(server.requests[1]);
      assert.match(replay, /TOOL_RESULT_VISIBLE/);
    } finally {
      await server.close();
    }
  }
});

test('Claude high reasoning uses a legal manual budget and rejects unknown capability before fetch', async () => {
  const anthropic = await fakeNative('anthropic');
  try {
    const gateway = new ModelGateway({
      providers: [{
        id: 'claude',
        label: 'Claude',
        transport: 'anthropic-messages',
        baseUrl: anthropic.baseUrl,
        apiKeyEnv: 'CLAUDE_KEY',
        models: [
          {
            target: { providerId: 'claude', modelId: 'claude-manual' },
            kind: 'agent',
            capabilities: { imageInput: true, imageOutput: false, toolCalling: true },
            reasoning: { high: 'manual', supportsOff: true },
          },
          {
            target: { providerId: 'claude', modelId: 'claude-unknown' },
            kind: 'agent',
            capabilities: { imageInput: true, imageOutput: false, toolCalling: true },
          },
        ],
      }],
      environment: { CLAUDE_KEY: 'claude-secret' },
    });
    const request = {
      input: 'reason carefully',
      modelSettings: {},
      tools: [],
      outputType: 'text' as const,
      handoffs: [],
      tracing: false as const,
    };
    await (gateway.createAgentRuntime(
      { providerId: 'claude', modelId: 'claude-manual' },
      'high',
    ).model as Model).getResponse(request);
    const manual = JSON.parse(anthropic.requests[0]!.body) as {
      max_tokens: number;
      thinking: { type: string; budget_tokens: number };
    };
    assert.equal(manual.max_tokens, 4_096);
    assert.equal(manual.thinking.type, 'enabled');
    assert.ok(manual.thinking.budget_tokens >= 1_024);
    assert.ok(manual.thinking.budget_tokens < manual.max_tokens);
    assert.throws(() => gateway.createAgentRuntime(
      { providerId: 'claude', modelId: 'claude-unknown' },
      'high',
    ), /reasoning=high|推理能力未知|未注册/);
    assert.equal(anthropic.requests.length, 1);
  } finally {
    await anthropic.close();
  }
});

test('history normalization follows the exact target transport instead of legacy Provider config', () => {
  const items = [{
    type: 'message',
    id: 'foreign-provider-id',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'portable' }],
  }] as never[];
  assert.equal(normalizeModelInput('google-generate-content', items), items);
  const responses = normalizeModelInput(
    'openai-responses',
    items,
  ) as unknown as Array<Record<string, unknown>>;
  assert.equal('id' in responses[0]!, false);
});
