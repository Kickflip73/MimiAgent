import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentInputItem } from '@openai/agents';
import type { AppConfig } from '../src/config.js';
import { FileSession } from '../src/core/session.js';
import { MimiAgent } from '../src/runtime/mimi-agent.js';
import { ModelConfigStore, type ModelsConfig } from '../src/runtime/model-config.js';

async function fakeGoogle(label: string, beforeResponse?: () => Promise<void>) {
  const requests: Array<{ apiKey?: string; path?: string; body: string }> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', async () => {
      requests.push({
        apiKey: request.headers['x-goog-api-key'] as string | undefined,
        path: request.url,
        body,
      });
      await beforeResponse?.();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        responseId: `${label}-${requests.length}`,
        candidates: [{ content: { parts: [{ text: `${label}-answer` }] } }],
        usageMetadata: {
          promptTokenCount: 3,
          candidatesTokenCount: 2,
          totalTokenCount: 5,
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

test('two Sessions in one process persist independent exact Provider targets without restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-model-sessions-'));
  const leftEndpoint = await fakeGoogle('left');
  const rightEndpoint = await fakeGoogle('right');
  const modelsFile = path.join(root, 'models.json');
  const models: ModelsConfig = {
    version: 1,
    routeVersion: 4,
    providers: [
      {
        id: 'left',
        label: 'Left',
        transport: 'google-generate-content',
        baseUrl: leftEndpoint.baseUrl,
        apiKeyEnv: 'MIMI_TEST_LEFT_KEY',
        models: [{
          target: { providerId: 'left', modelId: 'left-model' },
          kind: 'agent',
          capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
        }],
      },
      {
        id: 'right',
        label: 'Right',
        transport: 'google-generate-content',
        baseUrl: rightEndpoint.baseUrl,
        apiKeyEnv: 'MIMI_TEST_RIGHT_KEY',
        models: [{
          target: { providerId: 'right', modelId: 'right-model' },
          kind: 'agent',
          capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
        }],
      },
    ],
    routing: {
      globalDefault: { providerId: 'left', modelId: 'left-model' },
      scenarios: {},
    },
  };
  await new ModelConfigStore(modelsFile).write(models);
  const config: AppConfig = {
    provider: 'openai-compatible',
    providerBaseUrl: 'http://127.0.0.1:1/v1',
    defaultModel: 'left-model',
    modelsConfig: modelsFile,
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: null,
    securityProfile: 'safe',
    permissionMode: 'read-only',
  };
  const saved = {
    left: process.env.MIMI_TEST_LEFT_KEY,
    right: process.env.MIMI_TEST_RIGHT_KEY,
  };
  process.env.MIMI_TEST_LEFT_KEY = 'left-secret';
  process.env.MIMI_TEST_RIGHT_KEY = 'right-secret';
  let left: MimiAgent | undefined;
  let right: MimiAgent | undefined;
  try {
    const pid = process.pid;
    [left, right] = await Promise.all([
      MimiAgent.create(config, 'session-a'),
      MimiAgent.create(config, 'session-b'),
    ]);
    await Promise.all([
      left.switchModelTarget({ providerId: 'left', modelId: 'left-model' }),
      right.switchModelTarget({ providerId: 'right', modelId: 'right-model' }),
    ]);
    const [leftRun, rightRun] = await Promise.all([
      left.stream('left session request'),
      right.stream('right session request'),
    ]);
    await Promise.all([leftRun.completed, rightRun.completed]);
    await Promise.all([
      left.completeRun('left-answer'),
      right.completeRun('right-answer'),
    ]);
    const [leftSnapshot, rightSnapshot] = await Promise.all([
      left.sessionSnapshot(),
      right.sessionSnapshot(),
    ]);
    assert.equal(process.pid, pid);
    assert.deepEqual(leftSnapshot.runtime.modelTarget, {
      providerId: 'left',
      modelId: 'left-model',
    });
    assert.deepEqual(rightSnapshot.runtime.modelTarget, {
      providerId: 'right',
      modelId: 'right-model',
    });
    assert.equal(leftEndpoint.requests.length, 1);
    assert.equal(rightEndpoint.requests.length, 1);
    assert.equal(leftEndpoint.requests[0]?.apiKey, 'left-secret');
    assert.equal(rightEndpoint.requests[0]?.apiKey, 'right-secret');
    assert.match(leftEndpoint.requests[0]!.path!, /left-model:generateContent$/);
    assert.match(rightEndpoint.requests[0]!.path!, /right-model:generateContent$/);
    assert.doesNotMatch(JSON.stringify(leftEndpoint.requests), /right-secret/);
    assert.doesNotMatch(JSON.stringify(rightEndpoint.requests), /left-secret/);
    const trace = await readFile(path.join(config.dataRoot, 'traces', 'session-a.jsonl'), 'utf8');
    assert.match(trace, /"type":"model_binding_event"/);
    assert.match(trace, /"providerId":"left","modelId":"left-model"/);

    const protocolPair = [
      {
        type: 'function_call',
        callId: 'portable-call',
        name: 'read_file',
        arguments: '{}',
      },
      {
        type: 'function_call_result',
        callId: 'portable-call',
        name: 'read_file',
        output: 'portable-result',
      },
    ] as AgentInputItem[];
    await new FileSession(
      path.join(config.dataRoot, 'sessions'),
      'session-a',
    ).addItems(protocolPair);
    await Promise.all([left.close(), right.close()]);
    left = undefined;
    right = undefined;
    [left, right] = await Promise.all([
      MimiAgent.create(config, 'session-a'),
      MimiAgent.create(config, 'session-b'),
    ]);
    const [reopenedLeft, reopenedRight] = await Promise.all([
      left.sessionSnapshot(),
      right.sessionSnapshot(),
    ]);
    assert.deepEqual(reopenedLeft.runtime.modelTarget, {
      providerId: 'left',
      modelId: 'left-model',
    });
    assert.deepEqual(reopenedRight.runtime.modelTarget, {
      providerId: 'right',
      modelId: 'right-model',
    });
    assert.deepEqual(reopenedLeft.items.slice(-2), protocolPair);
  } finally {
    await Promise.all([left?.close(), right?.close()]);
    await Promise.all([leftEndpoint.close(), rightEndpoint.close()]);
    if (saved.left === undefined) delete process.env.MIMI_TEST_LEFT_KEY;
    else process.env.MIMI_TEST_LEFT_KEY = saved.left;
    if (saved.right === undefined) delete process.env.MIMI_TEST_RIGHT_KEY;
    else process.env.MIMI_TEST_RIGHT_KEY = saved.right;
  }
});

test('changing the Session target during a Run affects only the next Run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-model-run-freeze-'));
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let observeFirst!: () => void;
  const firstObserved = new Promise<void>((resolve) => { observeFirst = resolve; });
  const leftEndpoint = await fakeGoogle('left', async () => {
    observeFirst();
    await firstReleased;
  });
  const rightEndpoint = await fakeGoogle('right');
  const modelsFile = path.join(root, 'models.json');
  await new ModelConfigStore(modelsFile).write({
    version: 1,
    routeVersion: 2,
    providers: [
      {
        id: 'left',
        label: 'Left',
        transport: 'google-generate-content',
        baseUrl: leftEndpoint.baseUrl,
        apiKeyEnv: 'MIMI_TEST_LEFT_KEY',
        models: [{
          target: { providerId: 'left', modelId: 'left-model' },
          kind: 'agent',
          capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
        }],
      },
      {
        id: 'right',
        label: 'Right',
        transport: 'google-generate-content',
        baseUrl: rightEndpoint.baseUrl,
        apiKeyEnv: 'MIMI_TEST_RIGHT_KEY',
        models: [{
          target: { providerId: 'right', modelId: 'right-model' },
          kind: 'agent',
          capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
        }],
      },
    ],
    routing: {
      globalDefault: { providerId: 'left', modelId: 'left-model' },
      scenarios: {},
    },
  });
  const saved = {
    left: process.env.MIMI_TEST_LEFT_KEY,
    right: process.env.MIMI_TEST_RIGHT_KEY,
  };
  process.env.MIMI_TEST_LEFT_KEY = 'left-secret';
  process.env.MIMI_TEST_RIGHT_KEY = 'right-secret';
  const agent = await MimiAgent.create({
    provider: 'openai-compatible',
    providerBaseUrl: leftEndpoint.baseUrl,
    defaultModel: 'left-model',
    modelsConfig: modelsFile,
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: null,
    securityProfile: 'safe',
    permissionMode: 'read-only',
  }, 'frozen');
  try {
    const first = await agent.stream('first');
    await firstObserved;
    assert.deepEqual(await agent.modelControl({
      action: 'use',
      target: { providerId: 'right', modelId: 'right-model' },
    }), {
      target: { providerId: 'right', modelId: 'right-model' },
      effective: 'next_run',
      daemonRestarted: false,
    });
    releaseFirst();
    await first.completed;
    await agent.completeRun('left-answer');
    const second = await agent.stream('second');
    await second.completed;
    await agent.completeRun('right-answer');
    assert.equal(leftEndpoint.requests.length, 1);
    assert.equal(rightEndpoint.requests.length, 1);
    assert.match(leftEndpoint.requests[0]!.path!, /left-model:generateContent$/);
    assert.match(rightEndpoint.requests[0]!.path!, /right-model:generateContent$/);
    assert.deepEqual(await agent.modelControl({
      action: 'route',
      scenario: 'team.hard',
      target: { providerId: 'right', modelId: 'right-model' },
    }), {
      scenario: 'team.hard',
      route: { providerId: 'right', modelId: 'right-model' },
      routeVersion: 3,
      daemonRestarted: false,
    });
    assert.deepEqual(
      (await new ModelConfigStore(modelsFile).read()).routing.scenarios['team.hard'],
      { target: { providerId: 'right', modelId: 'right-model' } },
    );
    assert.deepEqual(await agent.modelControl({ action: 'auto' }), {
      effective: 'next_run',
      daemonRestarted: false,
    });
  } finally {
    releaseFirst();
    await agent.close();
    await Promise.all([leftEndpoint.close(), rightEndpoint.close()]);
    if (saved.left === undefined) delete process.env.MIMI_TEST_LEFT_KEY;
    else process.env.MIMI_TEST_LEFT_KEY = saved.left;
    if (saved.right === undefined) delete process.env.MIMI_TEST_RIGHT_KEY;
    else process.env.MIMI_TEST_RIGHT_KEY = saved.right;
  }
});

test('a background worker preserves the Supervisor-frozen binding reason in its Run receipt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-model-worker-binding-'));
  const endpoint = await fakeGoogle('worker');
  const models: ModelsConfig = {
    version: 1,
    routeVersion: 9,
    providers: [{
      id: 'worker-provider',
      label: 'Worker Provider',
      transport: 'google-generate-content',
      baseUrl: endpoint.baseUrl,
      apiKeyEnv: 'MIMI_TEST_WORKER_KEY',
      models: [{
        target: { providerId: 'worker-provider', modelId: 'worker-model' },
        kind: 'agent',
        capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
      }],
    }],
    routing: {
      globalDefault: { providerId: 'worker-provider', modelId: 'worker-model' },
      scenarios: {},
    },
  };
  const binding = {
    target: { providerId: 'worker-provider', modelId: 'worker-model' },
    kind: 'agent' as const,
    reasoning: 'high' as const,
    scenario: 'background.default',
    reason: 'scenario-route' as const,
    routeVersion: 9,
  };
  const previous = process.env.MIMI_TEST_WORKER_KEY;
  process.env.MIMI_TEST_WORKER_KEY = 'worker-secret';
  const config: AppConfig = {
    provider: 'openai-compatible',
    providerBaseUrl: endpoint.baseUrl,
    defaultModel: 'worker-model',
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: null,
    securityProfile: 'safe',
    permissionMode: 'read-only',
  };
  const agent = await MimiAgent.create(config, 'worker-session', {
    modelConfiguration: models,
    modelBinding: binding,
  });
  try {
    const run = await agent.stream('background request', undefined, {
      scenario: 'background.default',
    });
    await run.completed;
    await agent.completeRun('worker-answer');
    const trace = await readFile(
      path.join(config.dataRoot, 'traces', 'worker-session.jsonl'),
      'utf8',
    );
    assert.match(trace, /"reason":"scenario-route"/);
    assert.match(trace, /"routeVersion":9/);
    assert.match(trace, /"reasoning":"high"/);
  } finally {
    await agent.close();
    await endpoint.close();
    if (previous === undefined) delete process.env.MIMI_TEST_WORKER_KEY;
    else process.env.MIMI_TEST_WORKER_KEY = previous;
  }
});
