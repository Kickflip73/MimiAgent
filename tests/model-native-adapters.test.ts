import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Model } from '@openai/agents';
import { ModelGateway } from '../src/runtime/model-gateway.js';

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
      input: 'hello',
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
    assert.match(anthropic.requests[0]!.body, /"thinking":\{"type":"enabled"/);
    assert.equal(google.requests[0]?.path, '/v1/models/gemini-test:generateContent');
    assert.equal(google.requests[0]?.headers['x-goog-api-key'], 'gemini-secret');
    assert.match(google.requests[0]!.body, /"thinkingBudget":0/);
    assert.doesNotMatch(JSON.stringify(anthropic.requests), /gemini-secret/);
    assert.doesNotMatch(JSON.stringify(google.requests), /claude-secret/);
  } finally {
    await Promise.all([anthropic.close(), google.close()]);
  }
});
