import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MimiAgent } from '../src/agent.js';
import { CommandHandler } from '../src/commands.js';
import { SECURITY_PROFILES, type SecurityProfile } from '../src/config.js';
import { AGENT_MODES } from '../src/runtime/instructions.js';
import type { MemoryRef } from '../src/core/memory.js';
import { runProviderRegistryCommand } from '../src/provider-config.js';

function fakeAgent(): MimiAgent {
  return {
    currentSessionId: 'demo',
    runtimeInfo: async () => ({
      provider: 'deepseek',
      model: 'deepseek-chat',
      mode: { id: 'general', label: '通用', description: '大多数任务', instruction: '' },
      sessionId: 'demo',
      sessionTitle: '讨论 MimiAgent',
      workspaceRoot: '/tmp/demo',
      maxTurns: 200,
      permissionMode: 'trusted',
      securityProfile: {
        id: 'full-owner',
        label: 'Full Owner',
        permissionMode: 'trusted',
        shell: true,
        ephemeralSensitiveModelAccess: true,
        externalTransactions: true,
        computerUse: false,
        trustedWorkspaceMcp: false,
      },
      computer: { configured: false },
      skillCount: 2,
      memoryCount: 1,
      mcpServers: [],
      guidanceFiles: [{ scope: 'project', path: '/tmp/demo/AGENTS.md', truncated: false }],
      team: { total: 0, pending: 0, running: 0, completed: 0, failed: 0 },
    }),
    listSessions: async () => ['demo'],
    listSessionSummaries: async () => [{
      id: 'demo',
      title: '讨论 MimiAgent',
      preview: '增加交互能力',
      updatedAt: new Date().toISOString(),
      turns: 2,
      recoverable: false,
    }],
    switchSession: async () => undefined,
    history: async () => [],
    clearSession: async () => undefined,
    listSkills: async () => [{
      name: 'review',
      description: 'Review code',
      root: '/tmp/review',
      file: '/tmp/review/SKILL.md',
      source: { id: 'project-native', scope: 'project', root: '/tmp', precedence: 1 },
      contentHash: 'a'.repeat(64),
      active: false,
      stale: false,
      available: true,
      unavailableReasons: [],
      missingTools: [],
    }],
    activeSkills: async () => [],
    deactivateSkill: async () => false,
    reloadSkills: async () => ({ skills: [{ name: 'review', description: 'Review code' }], warnings: [] }),
    memoryList: async () => [{
      ref: { scope: 'private', id: 'm1', profileId: 'owner' }, title: 'Stack', summary: 'uses TS',
      kind: 'fact', status: 'active', confidence: 'user-confirmed', score: 1, sourceRefs: [], documentType: 'wiki',
    }],
    memorySearch: async () => [],
    memoryRead: async () => ({
      ref: { scope: 'private', id: 'm1', profileId: 'owner' },
      metadata: { schemaVersion: 1, id: 'm1', title: 'Stack', kind: 'fact', scope: 'private', profileId: 'owner', status: 'active', confidence: 'user-confirmed', aliases: [], tags: [], sourceRefs: [], validFrom: null, validUntil: null, supersedes: [], createdAt: '', updatedAt: '' },
      body: 'uses TS', digest: 'sha256:test',
    }),
    memoryForget: async (ref: MemoryRef) => ({ ref, forgotten: true, timestamp: '' }),
    memoryIngest: async () => ({ id: 'r1', operation: 'ingest', status: 'applied', digest: 'd', pageRefs: [] }),
    memoryCaptureRound: async () => ({ id: 'capture-1', operation: 'capture', status: 'applied', digest: 'd', pageRefs: [] }),
    memoryLint: async () => ({ valid: true, checked: 1, issues: [] }),
    memoryRefresh: async () => [],
    memoryConflicts: async () => [],
    memoryAudit: async () => [{ id: 1, operation: 'capture', reasonCode: 'test', createdAt: '' }],
    memoryMaintain: async () => ({ created: [] }),
    memoryReindex: async () => ({ pages: 1, privatePages: 1, workspacePages: 0, conflicted: 0, stale: 0, fts5: true, degraded: false }),
    memoryStatus: async () => ({ pages: 1, privatePages: 1, workspacePages: 0, conflicted: 0, stale: 0, fts5: true, degraded: false }),
    currentPlan: async () => [{ id: '1', description: 'test', status: 'running' }],
    currentTeam: async () => [],
    currentGoal: async () => ({ objective: 'ship MimiAgent', status: 'active', createdAt: '', updatedAt: '' }),
    setGoal: async (objective: string) => ({ objective, status: 'active', createdAt: '', updatedAt: '' }),
    resumePrompt: async () => 'resume goal',
    availableModels: () => ['deepseek-chat', 'deepseek-reasoner'],
    modelControl: async (request: { action: string }) => {
      if (request.action === 'list') {
        return ['deepseek-chat', 'deepseek-reasoner'].map((model) => ({
          target: { providerId: 'deepseek', modelId: model },
          kind: 'agent',
          capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
          provider: { id: 'deepseek', label: 'DeepSeek', transport: 'openai-chat-completions' },
        }));
      }
      if (request.action === 'current') {
        return { next: { target: { providerId: 'deepseek', modelId: 'deepseek-chat' } } };
      }
      return { effective: 'next_run', daemonRestarted: false };
    },
    switchModel: () => undefined,
    contextInfo: async () => ({
      historyItems: 4,
      historyLimit: 40,
      estimatedTokens: 1_200,
      contextWindow: 128_000,
      lastRequestInputTokens: 25_600,
      sections: [
        { id: 'base-instructions', estimatedTokens: 6_400, truncated: false },
        { id: 'recent-history', estimatedTokens: 12_800, truncated: false },
        { id: 'current-input', estimatedTokens: 3_200, truncated: false },
        { id: 'tool-schemas', estimatedTokens: 3_200, truncated: false },
        { id: 'protocol-reserve', estimatedTokens: 2_560, truncated: false },
      ],
      memories: 1,
      planSteps: 1,
      goal: 'active',
    }),
    compactContext: async () => ({
      changed: true,
      archive: { coveredItems: 8, summary: 'summary', strategy: 'full', originalTokens: 2000, compactedTokens: 200, updatedAt: '' },
      message: '已归档 8 个历史条目。',
    }),
    availableModes: () => [
      { id: 'general', label: '通用', description: '大多数任务' },
      { id: 'ultra', label: 'Ultra Team', description: '大型任务' },
    ],
    switchMode: () => undefined,
    switchSecurityProfile: () => undefined,
    toolNames: ['read_file', 'run_shell'],
    mcpServerNames: [],
    mcpStatuses: () => [],
    reloadMcp: async () => [],
    guidanceInfo: async () => ({
      files: [{ scope: 'project', path: '/tmp/demo/AGENTS.md', content: 'Run tests.', truncated: false }],
      instructions: 'Run tests.',
    }),
  } as unknown as MimiAgent;
}

test('provider registry add/set/list/test manages models.json without secrets or restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-provider-registry-'));
  const modelsFile = path.join(root, 'models.json');
  const environment = { TEST_PROVIDER_KEY: '' };
  await assert.rejects(
    runProviderRegistryCommand([
      'add', 'invalid', '--label', 'Invalid', '--transport', 'google-generate-content',
      '--api-key-env', 'TEST_PROVIDER_KEY', '--model', 'missing-url',
    ], modelsFile, environment),
    /需要显式 --base-url/,
  );
  await assert.rejects(
    runProviderRegistryCommand([
      'add', 'invalid', '--label', 'Invalid', '--transport', 'google-generate-content',
      '--base-url', 'file:///tmp/provider', '--api-key-env', 'TEST_PROVIDER_KEY',
      '--model', 'bad-url',
    ], modelsFile, environment),
    /必须使用 http 或 https/,
  );
  await assert.rejects(
    runProviderRegistryCommand([
      'add', 'invalid', '--label', 'Invalid', '--transport', 'google-generate-content',
      '--base-url', 'https://example.com', '--api-key-env', 'not-an-env',
      '--model', 'bad-env',
    ], modelsFile, environment),
    /必须是环境变量名/,
  );
  assert.deepEqual(await runProviderRegistryCommand([
    'add',
    'test-provider',
    '--label', 'Test Provider',
    '--transport', 'google-generate-content',
    '--base-url', 'https://generativelanguage.googleapis.com/v1beta',
    '--api-key-env', 'TEST_PROVIDER_KEY',
    '--model', 'gemini-explicit',
    '--kind', 'agent',
    '--image-input', 'true',
    '--image-output', 'false',
    '--tool-calling', 'true',
    '--context-window', '100000',
  ], modelsFile, environment), {
    action: 'added',
    target: { providerId: 'test-provider', modelId: 'gemini-explicit' },
    routeVersion: 1,
    daemonRestarted: false,
  });
  const contents = await readFile(modelsFile, 'utf8');
  assert.match(contents, /"apiKeyEnv": "TEST_PROVIDER_KEY"/);
  assert.doesNotMatch(contents, /fixture-secret|apiKey":/);
  assert.deepEqual(await runProviderRegistryCommand([
    'add',
    'test-provider/gemini-second',
    '--tool-calling', 'true',
  ], modelsFile, environment), {
    action: 'added',
    target: { providerId: 'test-provider', modelId: 'gemini-second' },
    routeVersion: 2,
    daemonRestarted: false,
  });
  await assert.rejects(
    runProviderRegistryCommand([
      'add',
      'test-provider',
      '--label', 'Test Provider',
      '--transport', 'google-generate-content',
      '--base-url', 'https://generativelanguage.googleapis.com/v1beta',
      '--api-key-env', 'TEST_PROVIDER_KEY',
      '--model', 'gemini-explicit',
    ], modelsFile, environment),
    /已注册/,
  );

  const listed = await runProviderRegistryCommand(
    ['list'],
    modelsFile,
    environment,
  ) as {
    providers: Array<{ id: string; configured: boolean }>;
  };
  assert.deepEqual(listed.providers.map((provider) => ({
    id: provider.id,
    configured: provider.configured,
  })), [{ id: 'test-provider', configured: false }]);

  assert.deepEqual(await runProviderRegistryCommand([
    'set',
    'test-provider/gemini-explicit',
  ], modelsFile, environment), {
    action: 'set',
    target: { providerId: 'test-provider', modelId: 'gemini-explicit' },
    routeVersion: 3,
    daemonRestarted: false,
  });
  const tested = await runProviderRegistryCommand([
    'test',
    'test-provider/gemini-explicit',
  ], modelsFile, environment) as { status: string; error?: string };
  assert.equal(tested.status, 'unconfigured');
  assert.match(tested.error ?? '', /TEST_PROVIDER_KEY/);
});

test('handles status and high-frequency inspection commands', async () => {
  const output: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(' '));
  const handler = new CommandHandler(fakeAgent(), async () => undefined);

  try {
    assert.equal(await handler.execute('/status'), 'handled');
    assert.equal(await handler.execute('/security'), 'handled');
    assert.equal(await handler.execute('/skills'), 'handled');
    assert.equal(await handler.execute('/memory list'), 'handled');
    assert.equal(await handler.execute('/memory capture'), 'handled');
    assert.equal(await handler.execute('/memory audit'), 'handled');
    assert.equal(await handler.execute('/memory maintain'), 'handled');
    assert.equal(await handler.execute('/memory refresh'), 'handled');
    assert.equal(await handler.execute('/plan'), 'handled');
    assert.equal(await handler.execute('/team'), 'handled');
    assert.equal(await handler.execute('/instructions'), 'handled');
    assert.match(output.join('\n'), /deepseek-chat/);
    assert.match(output.join('\n'), /Shell 可用/);
    assert.match(output.join('\n'), /Full Owner \(full-owner\/trusted\)/);
    assert.match(output.join('\n'), /当前能力.*Computer Use 未配置/);
    assert.match(output.join('\n'), /本轮敏感值可发模型 Provider/);
    assert.match(output.join('\n'), /Computer  未配置/);
    assert.match(output.join('\n'), /Skills\s+2/);
    assert.match(output.join('\n'), /本机认证 Owner 默认直接工作/);
    assert.match(output.join('\n'), /Review code/);
    assert.match(output.join('\n'), /uses TS/);
    assert.match(output.join('\n'), /running/);
    assert.match(output.join('\n'), /AGENTS\.md/);
  } finally {
    console.log = original;
  }
});

test('lists and deactivates only the current Session active Skills', async () => {
  const output: string[] = [];
  const original = console.log;
  const agent = fakeAgent();
  let deactivated = '';
  agent.activeSkills = async () => [{
    name: 'review',
    sourceId: 'project-native',
    file: '/tmp/review/SKILL.md',
    contentHash: 'a'.repeat(64),
    activatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stale: false,
  }];
  agent.deactivateSkill = async (name) => {
    deactivated = name;
    return true;
  };
  console.log = (...args: unknown[]) => output.push(args.join(' '));
  try {
    const handler = new CommandHandler(agent, async () => undefined);
    assert.equal(await handler.execute('/skills active'), 'handled');
    assert.equal(await handler.execute('/skills deactivate review'), 'handled');
    assert.equal(deactivated, 'review');
    assert.match(output.join('\n'), /review: project-native \[active\]/);
    assert.match(output.join('\n'), /已停用 Skill：review/);
  } finally {
    console.log = original;
  }
});

test('status reports the effective Plan restriction instead of claiming Shell is available', async () => {
  const output: string[] = [];
  const originalLog = console.log;
  const agent = fakeAgent();
  const runtimeInfo = agent.runtimeInfo.bind(agent);
  agent.runtimeInfo = async () => ({
    ...await runtimeInfo(),
    mode: AGENT_MODES.find((mode) => mode.id === 'plan')!,
  });
  console.log = (...args: unknown[]) => output.push(args.join(' '));
  try {
    assert.equal(await new CommandHandler(agent, async () => undefined).execute('/status'), 'handled');
    assert.match(output.join('\n'), /Shell 关闭/);
    assert.doesNotMatch(output.join('\n'), /Shell 可用/);
  } finally {
    console.log = originalLog;
  }
});

test('passes command cancellation to memory ingest', async () => {
  const agent = fakeAgent();
  let received: AbortSignal | undefined;
  agent.memoryIngest = async (_target: string, signal?: AbortSignal) => {
    received = signal;
    signal?.throwIfAborted();
    return { id: 'r', operation: 'ingest', status: 'applied', digest: 'd', pageRefs: [] };
  };
  const controller = new AbortController();
  controller.abort(new Error('stop index'));
  const handler = new CommandHandler(agent, async () => undefined, { write: () => undefined });

  await assert.rejects(handler.execute('/memory ingest knowledge/source.md', controller.signal), /stop index/);
  assert.equal(received, controller.signal);
});

test('retries the previous user input without sending slash commands to the model', async () => {
  const tasks: string[] = [];
  const original = console.log;
  console.log = () => undefined;
  const handler = new CommandHandler(fakeAgent(), async (input) => {
    tasks.push(input);
  });
  handler.remember('hello');

  try {
    assert.equal(await handler.execute('/retry'), 'handled');
    assert.deepEqual(tasks, ['hello']);
    assert.equal(await handler.execute('normal input'), 'pass');
    assert.equal(await handler.execute('/exit'), 'exit');
  } finally {
    console.log = original;
  }
});

test('keeps retry input isolated by session', async () => {
  const tasks: string[] = [];
  const messages: string[] = [];
  const agent = fakeAgent();
  const mutable = agent as unknown as { currentSessionId: string };
  const handler = new CommandHandler(agent, async (input) => { tasks.push(input); }, {
    write: (text) => messages.push(text),
  });

  mutable.currentSessionId = 'first';
  handler.remember('first message');
  mutable.currentSessionId = 'second';
  assert.equal(await handler.execute('/retry'), 'handled');
  assert.match(messages.at(-1) ?? '', /当前对话没有/);
  handler.remember('second message');
  await handler.execute('/retry');
  mutable.currentSessionId = 'first';
  await handler.execute('/retry');

  assert.deepEqual(tasks, ['second message', 'first message']);
});

test('selects sessions and restores their persisted transcript', async () => {
  const switched: string[] = [];
  let restores = 0;
  const agent = fakeAgent() as MimiAgent & { switchSession: (id: string) => Promise<void> };
  agent.switchSession = async (id) => { switched.push(id); };
  const handler = new CommandHandler(agent, async () => undefined, {
    restoreSession: () => { restores += 1; },
    selectSession: async () => 'demo',
  });

  assert.equal(await handler.execute('/sessions'), 'handled');
  assert.deepEqual(switched, ['demo']);
  assert.equal(restores, 1);

  assert.equal(await handler.execute('/switch archived'), 'handled');
  assert.deepEqual(switched, ['demo', 'archived']);
  assert.equal(restores, 2);
});

test('selects a model and exposes common runtime inspection commands', async () => {
  const switched: unknown[] = [];
  const output: string[] = [];
  const agent = fakeAgent();
  const baseModelControl = agent.modelControl.bind(agent);
  agent.modelControl = async (request) => {
    if ((request as { action?: unknown }).action === 'use') switched.push(request);
    return baseModelControl(request);
  };
  const handler = new CommandHandler(agent, async () => undefined, {
    write: (text) => output.push(text),
    selectModel: async () => ({
      provider: 'deepseek',
      providerLabel: 'DeepSeek',
      model: 'deepseek-reasoner',
    }),
  });

  assert.equal(await handler.execute('/model'), 'handled');
  assert.equal(await handler.execute('/context'), 'handled');
  assert.equal(await handler.execute('/compact'), 'handled');
  assert.equal(await handler.execute('/tools'), 'handled');
  assert.equal(await handler.execute('/mcp'), 'handled');
  assert.deepEqual(switched, [{
    action: 'use',
    target: { providerId: 'deepseek', modelId: 'deepseek-reasoner' },
  }]);
  assert.match(output.join('\n'), /当前上下文 26k\/128k（20%）/);
  assert.match(output.join('\n'), /最近对话：~13k（50%）/);
  assert.match(output.join('\n'), /基础指令：~6\.4k（25%）/);
  assert.doesNotMatch(output.join('\n'), /actual|已压缩|protocol reserve/);
  assert.match(output.join('\n'), /已归档 8 个历史条目/);
  assert.match(output.join('\n'), /run_shell/);
  assert.match(output.join('\n'), /MCP 未配置/);
});

test('lists models from every configured Provider and switches across Providers', async () => {
  const agent = fakeAgent();
  const baseRuntimeInfo = agent.runtimeInfo.bind(agent);
  agent.runtimeInfo = async () => ({
    ...await baseRuntimeInfo(),
    configuredProviders: [
      {
        id: 'deepseek',
        label: 'DeepSeek',
        model: 'deepseek-v4-pro',
        models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
      },
      {
        id: 'openai-compatible',
        label: 'OpenAI Compatible',
        model: 'kimi-k3',
        models: ['kimi-k3'],
      },
    ],
  });
  let choices: string[] = [];
  const providerSwitches: Array<{ provider: string; model: string }> = [];
  const localSwitches: string[] = [];
  const modelControlCalls: unknown[] = [];
  agent.modelControl = async (request) => {
    const action = (request as { action?: unknown }).action;
    if (action === 'list') {
      return [
        {
          target: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
          kind: 'agent',
          provider: { label: 'DeepSeek' },
        },
        {
          target: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
          kind: 'agent',
          provider: { label: 'DeepSeek' },
        },
        {
          target: { providerId: 'openai-compatible', modelId: 'kimi-k3' },
          kind: 'agent',
          provider: { label: 'OpenAI Compatible' },
        },
      ];
    }
    if (action === 'current') {
      return { next: { target: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' } } };
    }
    modelControlCalls.push(request);
    return { effective: 'next_run', daemonRestarted: false };
  };
  agent.switchModel = async (model) => { localSwitches.push(model); };
  const handler = new CommandHandler(agent, async () => undefined, {
    write: () => undefined,
    selectModel: async (models) => {
      choices = models.map((choice) => `${choice.provider}:${choice.model}`);
      return models.find((choice) => choice.model === 'kimi-k3');
    },
    switchProvider: async (provider, model) => {
      providerSwitches.push({ provider, model });
    },
  });

  assert.equal(await handler.execute('/model'), 'handled');
  assert.deepEqual(choices, [
    'deepseek:deepseek-v4-pro',
    'deepseek:deepseek-v4-flash',
    'openai-compatible:kimi-k3',
  ]);
  assert.deepEqual(localSwitches, []);
  assert.deepEqual(providerSwitches, []);
  assert.deepEqual(modelControlCalls, [{
    action: 'use',
    target: { providerId: 'openai-compatible', modelId: 'kimi-k3' },
  }]);
});

test('keeps the selected Provider when duplicate model ids exist', async () => {
  const agent = fakeAgent();
  const baseRuntimeInfo = agent.runtimeInfo.bind(agent);
  agent.runtimeInfo = async () => ({
    ...await baseRuntimeInfo(),
    provider: 'openai-compatible',
    model: 'deepseek-v4-pro',
    configuredProviders: [
      {
        id: 'deepseek',
        label: 'DeepSeek',
        model: 'deepseek-v4-pro',
        models: ['deepseek-v4-pro'],
      },
      {
        id: 'openai-compatible',
        label: 'OpenAI Compatible',
        model: 'deepseek-v4-pro',
        models: ['deepseek-v4-pro'],
      },
    ],
  });
  const calls: unknown[] = [];
  agent.modelControl = async (request) => {
    const action = (request as { action?: unknown }).action;
    if (action === 'list') {
      return [
        {
          target: { providerId: 'friday', modelId: 'deepseek-v4-pro' },
          kind: 'agent',
          provider: { label: 'Friday DeepSeek V4 Pro' },
        },
        {
          target: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
          kind: 'agent',
          provider: { label: 'DeepSeek' },
        },
      ];
    }
    if (action === 'current') {
      return { next: { target: { providerId: 'friday', modelId: 'deepseek-v4-pro' } } };
    }
    calls.push(request);
    return { effective: 'next_run', daemonRestarted: false };
  };
  agent.switchModel = async () => {
    throw new Error('legacy model switch must not run');
  };
  const output: string[] = [];
  const handler = new CommandHandler(agent, async () => undefined, {
    write: (text) => output.push(text),
    selectModel: async (models) => models.find((choice) =>
      choice.provider === 'friday' && choice.model === 'deepseek-v4-pro'),
  });

  assert.equal(await handler.execute('/model'), 'handled');
  assert.deepEqual(calls, [{
    action: 'use',
    target: { providerId: 'friday', modelId: 'deepseek-v4-pro' },
  }]);
  assert.match(output.join('\n'), /已切换模型：deepseek-v4-pro（friday）/);
});

test('supports structured multi-Provider model slash commands without restarting the Daemon', async () => {
  const agent = fakeAgent();
  const calls: unknown[] = [];
  (agent as unknown as {
    modelControl: (request: unknown) => Promise<unknown>;
  }).modelControl = async (request) => {
    calls.push(request);
    return { request, daemonRestarted: false };
  };
  const output: string[] = [];
  const handler = new CommandHandler(agent, async () => undefined, {
    write: (text) => output.push(text),
  });

  assert.equal(await handler.execute('/models'), 'handled');
  assert.equal(await handler.execute('/model current'), 'handled');
  assert.equal(await handler.execute('/model inspect left/model-a'), 'handled');
  assert.equal(await handler.execute('/model use right/model-b'), 'handled');
  assert.equal(await handler.execute('/model auto'), 'handled');
  assert.equal(await handler.execute('/model routes'), 'handled');
  assert.equal(await handler.execute('/model route team.hard right/model-b'), 'handled');
  assert.equal(await handler.execute('/model route team.simple auto'), 'handled');
  assert.equal(await handler.execute('/model doctor'), 'handled');
  assert.equal(await handler.execute('/model doctor left/model-a'), 'handled');

  assert.deepEqual(calls, [
    { action: 'list' },
    { action: 'current' },
    { action: 'inspect', target: { providerId: 'left', modelId: 'model-a' } },
    { action: 'use', target: { providerId: 'right', modelId: 'model-b' } },
    { action: 'auto' },
    { action: 'routes' },
    {
      action: 'route',
      scenario: 'team.hard',
      target: { providerId: 'right', modelId: 'model-b' },
    },
    { action: 'route', scenario: 'team.simple', routeAuto: true },
    { action: 'doctor' },
    { action: 'doctor', target: { providerId: 'left', modelId: 'model-a' } },
  ]);
  assert.match(output.join('\n'), /daemonRestarted/);
});

test('allows runtime commands before the draft Session receives its first message', async () => {
  const switched: unknown[] = [];
  const modes: string[] = [];
  const profiles: string[] = [];
  const output: string[] = [];
  const agent = fakeAgent();
  const baseRuntimeInfo = agent.runtimeInfo.bind(agent);
  let activeProfile: SecurityProfile = 'full-owner';
  Object.defineProperty(agent, 'sessionReady', { value: false });
  agent.runtimeInfo = async () => ({
    ...await baseRuntimeInfo(),
    permissionMode: SECURITY_PROFILES[activeProfile].permissionMode,
    securityProfile: {
      ...SECURITY_PROFILES[activeProfile],
      computerUse: false,
      trustedWorkspaceMcp: false,
    },
  });
  const baseModelControl = agent.modelControl.bind(agent);
  agent.modelControl = async (request) => {
    if ((request as { action?: unknown }).action === 'use') switched.push(request);
    return baseModelControl(request);
  };
  agent.switchMode = async (mode) => { modes.push(mode); };
  agent.switchSecurityProfile = async (profile) => {
    profiles.push(profile);
    activeProfile = profile as SecurityProfile;
  };
  const handler = new CommandHandler(agent, async () => undefined, {
    write: (text) => output.push(text),
    selectModel: async () => ({
      provider: 'deepseek',
      providerLabel: 'DeepSeek',
      model: 'gpt-5-mini',
    }),
  });

  assert.equal(await handler.execute('/status'), 'handled');
  assert.equal(await handler.execute('/model'), 'handled');
  assert.equal(await handler.execute('/mode ultra'), 'handled');
  assert.equal(await handler.execute('/security workstation'), 'handled');
  assert.deepEqual(switched, [{
    action: 'use',
    target: { providerId: 'deepseek', modelId: 'gpt-5-mini' },
  }]);
  assert.deepEqual(modes, ['ultra']);
  assert.deepEqual(profiles, ['workstation']);
  assert.match(output.join('\n'), /模型\s+deepseek/);
  assert.match(output.join('\n'), /已切换模型：gpt-5-mini/);
  assert.match(output.join('\n'), /已切换模式：Ultra Team/);
  assert.match(output.join('\n'), /Workstation/);
});

test('selects a preset Agent mode', async () => {
  const switched: string[] = [];
  const agent = fakeAgent() as MimiAgent & { switchMode: (mode: string) => void };
  agent.switchMode = async (mode) => { switched.push(mode); };
  const handler = new CommandHandler(agent, async () => undefined, {
    write: () => undefined,
    selectMode: async () => 'ultra',
  });

  assert.equal(await handler.execute('/mode'), 'handled');
  assert.deepEqual(switched, ['ultra']);
});

test('selects a runtime security profile with arrows or an explicit argument', async () => {
  const selectedProfiles: string[][] = [];
  let active: SecurityProfile = 'full-owner';
  const agent = fakeAgent();
  const runtimeInfo = agent.runtimeInfo.bind(agent);
  agent.runtimeInfo = async () => ({
    ...await runtimeInfo(),
    permissionMode: SECURITY_PROFILES[active].permissionMode,
    securityProfile: {
      ...SECURITY_PROFILES[active],
      computerUse: false,
      trustedWorkspaceMcp: false,
    },
  });
  agent.switchSecurityProfile = async (profile) => {
    if (!(profile in SECURITY_PROFILES)) throw new Error(`未知安全档位：${profile}`);
    active = profile as SecurityProfile;
  };
  const output: string[] = [];
  const handler = new CommandHandler(agent, async () => undefined, {
    write: (text) => output.push(text),
    selectSecurityProfile: async (profiles, current) => {
      selectedProfiles.push(profiles.map((profile) => profile.id));
      assert.equal(current, 'full-owner');
      return 'workstation';
    },
  });

  assert.equal(await handler.execute('/security'), 'handled');
  assert.equal(active, 'workstation');
  assert.deepEqual(selectedProfiles, [['safe', 'workstation', 'full-owner']]);
  assert.match(output.join('\n'), /Workstation \(workstation\/workspace\).*重启后恢复启动配置/);
  assert.match(output.join('\n'), /敏感值不会发送给模型 Provider/);

  assert.equal(await handler.execute('/security full-owner'), 'handled');
  assert.equal(active, 'full-owner');
  assert.match(output.join('\n'), /Full Owner \(full-owner\/trusted\).*重启后恢复启动配置/);
  await assert.rejects(handler.execute('/security unsafe'), /未知安全档位/);
});

test('switches terminal output detail level', async () => {
  let current: 'answer' | 'thinking' | 'tools' | 'trace' = 'tools';
  const handler = new CommandHandler(fakeAgent(), async () => undefined, {
    write: () => undefined,
    getOutputLevel: () => current,
    setOutputLevel: (level) => { current = level; },
    selectOutputLevel: async () => 'trace',
  });

  assert.equal(await handler.execute('/output'), 'handled');
  assert.equal(current, 'trace');
  await assert.rejects(handler.execute('/output everything'), /未知输出等级/);
});

test('sets and resumes a durable goal', async () => {
  const tasks: string[] = [];
  const options: unknown[] = [];
  const output: string[] = [];
  const handler = new CommandHandler(fakeAgent(), async (input, _signal, runOptions) => {
    tasks.push(input);
    options.push(runOptions);
  }, {
    write: (text) => output.push(text),
  });

  assert.equal(await handler.execute('/goal 发布 MimiAgent'), 'handled');
  assert.equal(await handler.execute('/resume'), 'handled');
  assert.deepEqual(tasks, ['resume goal']);
  assert.deepEqual(options, [{ resumeState: true }]);
  assert.match(output.join('\n'), /发布 MimiAgent/);
});

test('passes personal-message confirmation as structured command metadata', async () => {
  const calls: Array<{ input: string; options: unknown }> = [];
  const handler = new CommandHandler(fakeAgent(), async (input, _signal, options) => {
    calls.push({ input, options });
  }, { write: () => undefined });

  assert.equal(await handler.execute('/confirm-send 唯一确认文本'), 'handled');
  assert.deepEqual(calls, [{
    input: '发送 owner 已通过结构化命令确认的个人消息。',
    options: { approvedPersonalMessageText: '唯一确认文本' },
  }]);
  await assert.rejects(handler.execute('/confirm-send'), /\/confirm-send <text>/);
});

test('lists, inspects, and cancels durable background tasks from the shared CLI', async () => {
  const taskId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const output: string[] = [];
  const calls: Array<{ operation: string; value?: unknown }> = [];
  const task = {
    taskId,
    status: 'running',
    objective: '构建大型游戏项目',
    strategy: 'team',
    workspaceAccess: 'write' as const,
    sessionId: `mimi-task-${taskId}`,
    originSessionId: 'demo',
    depth: 1,
    attempts: 1,
    createdAt: '2026-07-16T01:00:00.000Z',
    updatedAt: '2026-07-16T01:05:00.000Z',
    result: { progress: '已完成基础场景' },
    worker: {
      pid: 4821,
      workerId: 'task-worker-1',
      spawnedAt: '2026-07-16T01:00:01.000Z',
      heartbeatAt: '2026-07-16T01:05:01.000Z',
    },
    recentEvents: [
      {
        sequence: 4,
        kind: 'plan',
        steps: [
          { description: '创建基础场景', status: 'completed' },
          { description: '实现战斗系统', status: 'running' },
        ],
      },
      { sequence: 5, kind: 'status', title: 'run_shell', next: '正在执行 run_shell' },
    ],
  };
  const agent = Object.assign(fakeAgent(), {
    listBackgroundTasks: async (limit?: number) => {
      calls.push({ operation: 'list', value: limit });
      return [task];
    },
    inspectBackgroundTask: async (id: string) => {
      calls.push({ operation: 'inspect', value: id });
      return task;
    },
    cancelBackgroundTask: async (id: string, reason?: string) => {
      calls.push({ operation: 'cancel', value: { id, reason } });
      return { state: 'cancelled' as const };
    },
    pauseBackgroundTask: async (id: string, reason?: string) => {
      calls.push({ operation: 'pause', value: { id, reason } });
      return { state: 'paused' as const };
    },
    resumeBackgroundTask: async (id: string, context?: string) => {
      calls.push({ operation: 'resume', value: { id, context } });
      return { state: 'resumed' as const };
    },
  });
  const handler = new CommandHandler(agent, async () => undefined, {
    write: (text) => output.push(text),
  });

  assert.equal(await handler.execute('/tasks 5'), 'handled');
  assert.equal(await handler.execute(`/task ${taskId}`), 'handled');
  assert.equal(await handler.execute(`/task pause ${taskId}`), 'handled');
  assert.equal(await handler.execute(`/task resume ${taskId} dependency is ready`), 'handled');
  assert.equal(await handler.execute(`/task cancel ${taskId} owner changed direction`), 'handled');

  assert.deepEqual(calls, [
    { operation: 'list', value: 5 },
    { operation: 'inspect', value: taskId },
    { operation: 'pause', value: { id: taskId, reason: undefined } },
    { operation: 'resume', value: { id: taskId, context: 'dependency is ready' } },
    { operation: 'cancel', value: { id: taskId, reason: 'owner changed direction' } },
  ]);
  assert.match(output[0] ?? '', /\[运行中\].*构建大型游戏项目/);
  assert.match(output[1] ?? '', /任务会话.*mimi-task/);
  assert.match(output[1] ?? '', /工作进程.*4821/);
  assert.match(output[1] ?? '', /工作区.*可写（独占）/);
  assert.match(output[1] ?? '', /计划进度.*1\/2.*实现战斗系统/);
  assert.match(output[1] ?? '', /当前动作.*正在执行 run_shell/);
  assert.match(output[1] ?? '', /已完成基础场景/);
  assert.match(output[2] ?? '', /已暂停/);
  assert.match(output[3] ?? '', /重新排队/);
  assert.match(output[4] ?? '', /已请求取消/);
});

test('running background task pause reports the safe-point request instead of claiming completion', async () => {
  const output: string[] = [];
  const handler = new CommandHandler(Object.assign(fakeAgent(), {
    pauseBackgroundTask: async () => ({ state: 'pause_requested' as const }),
  }), async () => undefined, { write: (text) => output.push(text) });

  assert.equal(await handler.execute('/task pause task-running'), 'handled');
  assert.match(output[0] ?? '', /安全点暂停/);
});

test('background task commands reject ambiguous input before calling the daemon', async () => {
  const handler = new CommandHandler(fakeAgent(), async () => undefined, { write: () => undefined });
  await assert.rejects(handler.execute('/tasks 0'), /\/tasks \[1-50\]/);
  await assert.rejects(handler.execute('/task'), /\/task <task-id>/);
  await assert.rejects(handler.execute('/task cancel'), /\/task cancel <task-id>/);
  await assert.rejects(handler.execute('/task pause'), /\/task pause <task-id>/);
  await assert.rejects(handler.execute('/task resume'), /\/task resume <task-id>/);
});
