import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext, Usage, type Model } from '@openai/agents';
import { FileSession } from '../src/core/session.js';
import { TeamTaskStore } from '../src/core/team.js';
import type { ProviderDefinition, RunModelBinding } from '../src/core/model-routing.js';
import { runTeamWave } from '../src/extensions/team.js';
import { createSubAgentTools } from '../src/extensions/subagents.js';
import { ModelGateway } from '../src/runtime/model-gateway.js';
import { MediaArtifactStore } from '../src/runtime/media-artifact-store.js';
import { createMediaTools, MediaRuntime } from '../src/runtime/media-runtime.js';
import { WorkUnitModelResolver } from '../src/runtime/work-unit-model-resolver.js';

const provider: ProviderDefinition = {
  id: 'fake',
  label: 'Fake',
  transport: 'openai-chat-completions',
  baseUrl: 'http://127.0.0.1:1/v1',
  apiKeyEnv: 'FAKE_KEY',
  models: [
    {
      target: { providerId: 'fake', modelId: 'simple' },
      kind: 'agent',
      capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
    },
    {
      target: { providerId: 'fake', modelId: 'hard' },
      kind: 'agent',
      capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
    },
  ],
};

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

async function mediaAuthority(root: string, runId: string) {
  const session = new FileSession(path.join(root, 'sessions'), 'media-session');
  await session.ensure();
  await session.beginRun('generate image', runId, 'media-owner');
  return {
    artifacts: new MediaArtifactStore(path.join(root, 'attachments')),
    session,
    runId,
    sessionId: 'media-session',
    profileId: 'owner',
    trust: 'owner' as const,
  };
}

function finalTextModel(text: string, onReasoning?: (effort: unknown) => void): Model {
  return {
    async getResponse(request) {
      onReasoning?.(request.modelSettings.reasoning?.effort);
      return {
        usage: new Usage(),
        output: [{
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text }],
        }],
      };
    },
    async *getStreamedResponse() {
      throw new Error('streaming is not used by delegated tools');
    },
  };
}

test('one Team wave freezes a different ModelTarget for each task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-team-models-'));
  const store = new TeamTaskStore(path.join(root, 'teams.json'), 'team-session');
  await store.set([
    {
      id: 'simple-task',
      description: 'simple',
      role: 'explorer',
      dependencies: [],
      paths: [],
      complexity: 'simple',
      modelRequirements: { reasoning: 'off' },
      modelTarget: { providerId: 'fake', modelId: 'simple' },
      routeVersion: 9,
    },
    {
      id: 'hard-task',
      description: 'hard',
      role: 'reviewer',
      dependencies: [],
      paths: [],
      complexity: 'hard',
      modelRequirements: { reasoning: 'high' },
      modelTarget: { providerId: 'fake', modelId: 'hard' },
      routeVersion: 9,
    },
  ]);
  const resolver = new WorkUnitModelResolver({
    providers: [provider],
    routing: {
      globalDefault: { providerId: 'fake', modelId: 'simple' },
      scenarios: {},
    },
  });
  const bindings: RunModelBinding[] = [];
  const selected: string[] = [];
  const reasoning: unknown[] = [];
  const results = await runTeamWave({
    store,
    model: 'unused',
    tools: [],
    workspaceRoot: root,
    bindingForTask: (task) => resolver.resolve({
      scenario: `team.${task.complexity}`,
      profile: {
        complexity: task.complexity,
        modelTarget: task.modelTarget,
        requirements: { toolCalling: true },
      },
      routeVersion: task.routeVersion!,
    }),
    onModelBinding: (_task, binding) => {
      bindings.push(binding);
    },
    modelForTask: (task) => {
      selected.push(`${task.modelTarget?.providerId}/${task.modelTarget?.modelId}`);
      return finalTextModel(
        'worker complete\n[[MIMI_TEAM_WORKER_COMPLETE]]',
        (effort) => { reasoning.push(effort); },
      );
    },
  }, ['simple-task', 'hard-task']);
  assert.deepEqual(results.map((item) => item.status), ['completed', 'completed']);
  assert.deepEqual(new Set(selected), new Set(['fake/simple', 'fake/hard']));
  assert.deepEqual(new Set(bindings.map((item) => `${item.target.providerId}/${item.target.modelId}`)),
    new Set(['fake/simple', 'fake/hard']));
  assert.deepEqual(new Set(bindings.map((item) => item.routeVersion)), new Set([9]));
  assert.deepEqual(
    new Set(results.map((item) => `${item.modelBinding?.target.providerId}/${item.modelBinding?.target.modelId}`)),
    new Set(['fake/simple', 'fake/hard']),
  );
  assert.deepEqual(results.map((item) => item.usage?.cost), ['unknown', 'unknown']);
  assert.deepEqual(results.map((item) => item.cost), ['unknown', 'unknown']);
  assert.deepEqual(new Set(reasoning), new Set(['none', 'high']));
});

test('Team start freezes every task against one route snapshot before workers launch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-team-route-snapshot-'));
  const store = new TeamTaskStore(path.join(root, 'teams.json'), 'team-session');
  await store.set([
    {
      id: 'simple-task',
      description: 'simple',
      role: 'explorer',
      dependencies: [],
      paths: [],
      complexity: 'simple',
    },
    {
      id: 'hard-task',
      description: 'hard',
      role: 'reviewer',
      dependencies: [],
      paths: [],
      complexity: 'hard',
    },
  ]);
  let routeVersion = 11;
  let hardTarget = 'hard';
  let workerStarted = false;
  const results = await runTeamWave({
    store,
    model: 'unused',
    tools: [],
    workspaceRoot: root,
    freezeTask: (task) => {
      assert.equal(workerStarted, false);
      return {
        ...task,
        modelTarget: {
          providerId: 'fake',
          modelId: task.complexity === 'hard' ? hardTarget : 'simple',
        },
        routeVersion,
      };
    },
    bindingForTask: (task) => {
      workerStarted = true;
      if (!task.modelTarget || !task.routeVersion) throw new Error('Team route 未在启动时冻结');
      routeVersion = 12;
      hardTarget = 'simple';
      return {
        target: { ...task.modelTarget },
        kind: 'agent',
        reasoning: 'auto',
        scenario: `team.${task.complexity}`,
        complexity: task.complexity,
        reason: 'explicit-work-unit',
        routeVersion: task.routeVersion,
      };
    },
    runWorker: async (task) => `${task.id} complete`,
  }, ['simple-task', 'hard-task']);
  assert.deepEqual(results.map((item) => item.status), ['completed', 'completed']);
  const frozen = await store.list();
  assert.deepEqual(frozen.map((task) => ({
    id: task.id,
    target: task.modelTarget?.modelId,
    routeVersion: task.routeVersion,
  })), [
    { id: 'simple-task', target: 'simple', routeVersion: 11 },
    { id: 'hard-task', target: 'hard', routeVersion: 11 },
  ]);
});

test('Media WorkUnit sends generation only to an imageOutput model', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-routing-'));
  const authority = await mediaAuthority(root, 'run-routing');
  const requests: Array<{ path?: string; body: string }> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ path: request.url, body });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const models: ProviderDefinition = {
    id: 'media',
    label: 'Media',
    transport: 'openai-responses',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKeyEnv: 'MEDIA_KEY',
    models: [
      {
        target: { providerId: 'media', modelId: 'vision-only' },
        kind: 'agent',
        capabilities: { imageInput: true, imageOutput: false, toolCalling: true },
      },
      {
        target: { providerId: 'media', modelId: 'image-output' },
        kind: 'image-generation',
        capabilities: { imageInput: false, imageOutput: true, toolCalling: false },
      },
    ],
  };
  try {
    const gateway = new ModelGateway({
      providers: [models],
      environment: { MEDIA_KEY: 'media-secret' },
    });
    const resolver = new WorkUnitModelResolver({
      providers: [models],
      routing: {
        globalDefault: { providerId: 'media', modelId: 'vision-only' },
        scenarios: {
          'image-generation.default': {
            candidates: [{ providerId: 'media', modelId: 'image-output' }],
          },
        },
      },
    });
    const result = await new MediaRuntime(gateway, resolver, () => authority).run({
      prompt: 'draw a red square',
      routeVersion: 3,
    });
    assert.equal(result.binding.target.modelId, 'image-output');
    assert.equal(result.cost, 'unknown');
    assert.equal(result.artifact.sha256, createHash('sha256').update(png).digest('hex'));
    assert.equal(result.evidence.ref, (await authority.session.listMediaEvidence(10))[0]?.id);
    assert.doesNotMatch(JSON.stringify(result), /data:|iVBOR/u);
    assert.deepEqual(requests.map((item) => item.path), ['/v1/images/generations']);
    assert.match(requests[0]!.body, /"model":"image-output"/);
    await assert.rejects(new MediaRuntime(gateway, resolver, () => authority).run({
      prompt: 'wrong',
      modelTarget: { providerId: 'media', modelId: 'vision-only' },
      routeVersion: 3,
    }), /imageOutput|生图/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test('MimiAgent media tool creates a Media WorkUnit and blocks before Provider without a compatible target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-tool-'));
  const authority = await mediaAuthority(root, 'run-tool');
  const requests: Array<{ path?: string; body: string }> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ path: request.url, body });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const mediaProvider: ProviderDefinition = {
    id: 'media',
    label: 'Media',
    transport: 'openai-responses',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKeyEnv: 'MEDIA_KEY',
    models: [{
      target: { providerId: 'media', modelId: 'image-output' },
      kind: 'image-generation',
      capabilities: { imageInput: false, imageOutput: true, toolCalling: false },
    }],
  };
  try {
    const gateway = new ModelGateway({
      providers: [mediaProvider],
      environment: { MEDIA_KEY: 'media-secret' },
    });
    const resolver = new WorkUnitModelResolver({
      providers: [mediaProvider],
      routing: {
        globalDefault: { providerId: 'media', modelId: 'image-output' },
        scenarios: {},
      },
    });
    const media = new MediaRuntime(gateway, resolver, () => authority);
    const tool = createMediaTools({
      runtime: () => media,
      routeVersion: () => 4,
    }).find((item) => item.name === 'generate_image');
    assert.ok(tool && 'invoke' in tool);
    const result = await tool.invoke(
      new RunContext({}),
      JSON.stringify({ prompt: 'draw a blue circle' }),
      { toolCall: { callId: 'call-media-generate' } } as never,
    ) as unknown as {
      kind: string;
      binding: RunModelBinding;
      artifact: { ref: string; sha256: string };
      evidence: { ref: string };
    };
    assert.equal(result.kind, 'media');
    assert.equal(result.binding.kind, 'image-generation');
    assert.equal(result.binding.routeVersion, 4);
    assert.match(result.artifact.ref, /^media-artifact:sha256:/u);
    assert.match(result.evidence.ref, /^media-evidence:sha256:/u);
    assert.doesNotMatch(JSON.stringify(result), /iVBOR|data:/u);
    assert.equal(requests.length, 1);

    const agentOnly: ProviderDefinition = {
      ...provider,
      models: [provider.models[0]!],
    };
    const blockedGateway = new ModelGateway({
      providers: [agentOnly],
      environment: { FAKE_KEY: 'fake-secret' },
    });
    const blockedResolver = new WorkUnitModelResolver({
      providers: [agentOnly],
      routing: {
        globalDefault: { providerId: 'fake', modelId: 'simple' },
        scenarios: {},
      },
    });
    const blockedTool = createMediaTools({
      runtime: () => new MediaRuntime(blockedGateway, blockedResolver, () => authority),
      routeVersion: () => 5,
    }).find((item) => item.name === 'generate_image');
    assert.ok(blockedTool && 'invoke' in blockedTool);
    const blocked = await blockedTool.invoke(
      new RunContext({}),
      JSON.stringify({ prompt: 'must block' }),
      { toolCall: { callId: 'call-media-blocked' } } as never,
    );
    assert.match(String(blocked), /没有兼容模型|imageOutput|生图/);
    assert.equal(requests.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test('the same SubAgent role resolves a fresh model for each delegation', async () => {
  const selected: string[] = [];
  const bindings: string[] = [];
  const reasoning: unknown[] = [];
  const tools = createSubAgentTools({
    mode: 'general',
    model: finalTextModel('fallback'),
    tools: [],
    modelForDelegation: (_role, profile) => {
      const modelId = profile.modelTarget?.modelId ?? 'fallback';
      selected.push(modelId);
      return finalTextModel(modelId, (effort) => { reasoning.push(effort); });
    },
    bindingForDelegation: (_role, profile) => ({
      target: profile.modelTarget!,
      kind: 'agent',
      reasoning: profile.requirements?.reasoning ?? 'auto',
      scenario: 'subagent.researcher',
      complexity: profile.complexity,
      reason: 'explicit-work-unit',
      routeVersion: 5,
    }),
    onModelBinding: (_role, binding) => {
      bindings.push(binding.target.modelId);
    },
  });
  const research = tools.find((item) => item.name === 'delegate_research');
  if (!research || !('invoke' in research)) throw new Error('delegate_research 不可调用');
  const first = await research.invoke(new RunContext({}), JSON.stringify({
    input: 'first',
    requirements: { reasoning: 'high' },
    modelTarget: { providerId: 'fake', modelId: 'simple' },
  }));
  const second = await research.invoke(new RunContext({}), JSON.stringify({
    input: 'second',
    modelTarget: { providerId: 'fake', modelId: 'hard' },
  }));
  assert.match(String(first), /simple/);
  assert.match(String(second), /hard/);
  assert.equal(JSON.parse(String(first)).usage.cost, 'unknown');
  assert.equal(JSON.parse(String(second)).modelBinding.target.modelId, 'hard');
  assert.deepEqual(selected, ['simple', 'hard']);
  assert.deepEqual(bindings, ['simple', 'hard']);
  assert.deepEqual(reasoning, ['high', undefined]);
});
