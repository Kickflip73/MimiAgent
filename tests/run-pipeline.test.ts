import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  RunContext,
  tool as sdkTool,
  type AgentInputItem,
  type MCPServer,
  type Tool,
} from '@openai/agents';
import { z } from 'zod';
import { ContextManager } from '../src/core/context.js';
import { ExecutionLedger } from '../src/core/execution-ledger.js';
import { materializeMcpTools } from '../src/runtime/mcp-ledger.js';
import {
  CapabilityResolver,
  renderEffectiveCapabilitySnapshot,
} from '../src/runtime/pipeline/capability-resolver.js';
import { ContextAssembler } from '../src/runtime/pipeline/context-assembler.js';
import { HostCapabilityRegistry } from '../src/runtime/pipeline/capability-registry.js';
import { AgentRequestFactory } from '../src/runtime/pipeline/request-factory.js';
import { captureRunScope } from '../src/runtime/pipeline/run-scope.js';
import { RunStateLoader } from '../src/runtime/pipeline/state-loader.js';
import { RunFactCollector } from '../src/runtime/pipeline/run-fact-collector.js';
import { toolsForSecurity } from '../src/runtime/tool-policy.js';
import {
  ToolSetBuilder,
  withoutPersonalMessageDesktopFallback,
  withoutPersonalMessageFallbackHistory,
} from '../src/runtime/pipeline/tool-set-builder.js';

function scope() {
  return captureRunScope({
    sessionId: 'session-1',
    workspaceRoot: '/workspace',
    provider: 'openai',
    model: 'gpt-test',
    mode: 'general',
    input: 'inspect',
    options: {
      executionKey: 'event-1',
      cause: {
        eventId: 'event-1',
        profileId: 'owner',
        source: 'local-cli',
        trust: 'owner',
      },
    },
  });
}

const workspaceAccess = {
  workspaceWrite: true,
  computer: false,
  mcp: false,
  ephemeralSensitiveModelAccess: false,
  policyRevision: 'workspace',
};
const fullOwnerAccess = {
  ...workspaceAccess,
  computer: true,
  mcp: true,
  ephemeralSensitiveModelAccess: true,
  policyRevision: 'trusted',
};

test('captures an immutable run scope before delayed pipeline work', () => {
  const captured = scope();
  assert.equal(captured.profileId, 'owner');
  assert.equal(captured.executionKey, 'event-1');
  assert.equal('permissionMode' in captured, false);
  assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured.cause));
  assert.throws(() => {
    (captured as { sessionId: string }).sessionId = 'other';
  }, TypeError);
});

test('run fact collector captures read success, structured rejection, and thrown failure once', async () => {
  const collector = new RunFactCollector();
  const tools = collector.wrap([
    sdkTool({
      name: 'read_file',
      description: 'read',
      parameters: z.object({ path: z.string() }),
      execute: async () => ({ content: 'bounded' }),
    }),
    sdkTool({
      name: 'connector_action',
      description: 'reject',
      parameters: z.object({}),
      execute: async () => ({
        mimiStatus: 'tool_input_rejected',
        code: 'target_required',
        message: 'target required',
      }),
    }),
    {
      name: 'run_shell',
      invoke: async () => { throw new Error('exit 2'); },
    } as unknown as Tool,
  ]);
  const invoke = async (index: number, input: string, callId: string) => {
    const selected = tools[index];
    assert.ok(selected && 'invoke' in selected);
    return selected.invoke(
      new RunContext({}),
      input,
      { toolCall: { callId } } as never,
    );
  };
  await invoke(0, '{"path":"README.md"}', 'read-1');
  await invoke(1, '{}', 'reject-1');
  await assert.rejects(invoke(2, '{}', 'shell-1'), /exit 2/);

  const calls = collector.calls('owner', 'run-facts');
  assert.deepEqual(calls.map(({ toolName, callId, status }) => ({ toolName, callId, status })), [
    { toolName: 'read_file', callId: 'read-1', status: 'succeeded' },
    { toolName: 'connector_action', callId: 'reject-1', status: 'failed' },
    { toolName: 'run_shell', callId: 'shell-1', status: 'failed' },
  ]);
  assert.equal(calls[1]?.error, 'target required');
  assert.equal(calls[2]?.error, 'exit 2');
});

test('context assembler accounts for every request section without prompt copies', () => {
  const manager = new ContextManager(40, 8_000, 0.55, 1_000);
  const budget = manager.requestBudget([{ name: 'read_file', parameters: { type: 'object' } }]);
  const instructions = manager.buildInstructionsResult({
    baseInstructions: 'base',
    historySummary: '',
    skillCatalog: '',
    memories: [],
    plan: [],
  }, 1_000);
  const currentInput = [{ role: 'user', content: 'inspect' } as AgentInputItem];
  const effective = manager.effectiveHistoryResult([], currentInput, undefined, 1_000);
  const manifest = new ContextAssembler().manifest({
    scope: scope(),
    budget,
    instructions,
    effective,
    archiveInput: [],
    currentInput,
    toolCount: 1,
  });

  assert.equal(manifest.availableInputBudget, budget.inputBudget);
  assert.equal(
    manifest.sections
      .filter((section) => section.id !== 'protocol-reserve')
      .reduce((total, section) => total + section.estimatedTokens, 0),
    manifest.estimatedInputTokens,
  );
  assert.ok((manifest.sections.find((section) => section.id === 'protocol-reserve')?.estimatedTokens ?? 0) > 0);
  assert.deepEqual(
    manifest.sections.slice(-2).map((section) => section.id),
    ['tool-schemas', 'protocol-reserve'],
  );
  assert.equal(JSON.stringify(manifest).includes('inspect'), false);
});

test('capability resolver preserves provenance, mode, and completion boundaries', () => {
  const resolver = new CapabilityResolver();
  const owner = resolver.resolve({
    scope: scope(),
    runtimeAccess: workspaceAccess,
    defaultComputerAccess: 'background',
  });
  assert.equal(owner.canReadLocal, true);
  assert.equal(owner.computerAccess, 'none');
  assert.equal(owner.completionToolsAllowed, true);

  const fullOwnerScope = captureRunScope({
    sessionId: 'owner-session',
    workspaceRoot: '/workspace',
    provider: 'openai',
    model: 'gpt-test',
    mode: 'general',
    input: 'inspect',
    options: {
      cause: {
        eventId: 'owner-event',
        source: 'local-cli',
        trust: 'owner',
      },
    },
  });
  assert.equal(resolver.resolve({
    scope: fullOwnerScope,
    runtimeAccess: fullOwnerAccess,
    defaultComputerAccess: 'background',
  }).computerAccess, 'background');
  assert.equal(resolver.resolve({
    scope: fullOwnerScope,
    runtimeAccess: fullOwnerAccess,
    requestedComputerAccess: 'observe',
    defaultComputerAccess: 'background',
  }).computerAccess, 'observe');

  const restricted = resolver.resolve({
    scope: scope(),
    runtimeAccess: workspaceAccess,
    policy: {
      allowedCapabilities: ['delivery-control'],
      allowedTools: ['finish_mimi_silently'],
      allowSessionContext: false,
    },
  });
  assert.deepEqual(restricted, {
    canReadLocal: false,
    canReadMemory: false,
    canReadState: false,
    canReadSessionContext: false,
    completionToolsAllowed: false,
    computerAccess: 'none',
  });
});

test('tool set builder keeps mode and run-policy filtering in one stage', () => {
  const tool = (name: string) => ({ name }) as Tool;
  const builder = new ToolSetBuilder();
  const prepared = builder.final(
    'plan',
    [tool('read_file'), tool('write_file')],
    [tool('run_team')],
    [tool('delegate_research')],
    {
      allowedCapabilities: ['read'],
      allowSideEffects: false,
    },
  );
  assert.deepEqual(prepared.map((item) => item.name), ['read_file', 'delegate_research']);
  const snapshot = new HostCapabilityRegistry(prepared).snapshot({
    runId: 'run-1',
    policyRevision: 'guarded:v1',
    modelTools: prepared,
    skills: ['reviewer', 'researcher', 'reviewer'],
    observedAt: '2026-07-27T00:00:00.000Z',
  });
  assert.deepEqual(snapshot.tools, ['delegate_research', 'read_file']);
  assert.deepEqual(snapshot.skills, ['researcher', 'reviewer']);
  assert.equal(
    snapshot.toolSetDigest,
    `sha256:${createHash('sha256').update(JSON.stringify(snapshot.tools)).digest('hex')}`,
  );
  assert.match(snapshot.snapshotDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(
    snapshot.items.filter((item) => item.kind === 'skill').map((item) => item.id),
    snapshot.skills,
  );
  assert.equal(snapshot.items.find((item) => item.id === 'read_file')?.availability, 'available');
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.items));
});

test('direct tools stay out of the gateway while deferred families remain invokable', async () => {
  const builder = new ToolSetBuilder();
  const make = (name: string, value: string, description = `${name} description`) => sdkTool({
    name,
    description,
    parameters: z.object({}),
    execute: async () => value,
  });
  const authorized = [
    make('web_search', 'web-ok'),
    make('memory_read', 'memory-ok'),
    make('list_sessions', 'session-list-ok', '列出 MimiAgent 持久会话的 ID、时间和轮数。'),
    make('get_session_history', 'session-history-ok', '读取当前 Session 最近的原始历史条目。'),
    make('computer_observe', 'computer-ok'),
    make('computer_act', 'computer-act-ok'),
    make('browser_open', 'browser-open-ok'),
    make('browser_observe', 'browser-ok'),
    make('browser_act', 'browser-act-ok'),
    make('browser_wait', 'browser-wait-ok'),
    make('browser_assert', 'browser-assert-ok'),
    make('browser_close', 'browser-close-ok'),
    make('show_goal', 'goal-ok'),
    make('list_skills', 'skill-ok'),
    make('custom_mcp_lookup', 'mcp-ok'),
    make('send_owner_message', 'owner-message-ok'),
  ];
  const registry = new HostCapabilityRegistry(authorized);
  const classified = builder.classify([...registry.authorizedTools()]);
  const gateway = registry.gatewayTools(classified.deferred);
  const modelFacing = builder.sdkTools(classified, gateway);
  assert.ok(modelFacing.some((candidate) => candidate.name === 'inspect_capabilities'));
  assert.ok(modelFacing.some((candidate) => candidate.name === 'invoke_capability'));
  assert.ok(modelFacing.some((candidate) => candidate.name === 'computer_observe'));
  assert.ok(modelFacing.some((candidate) => candidate.name === 'computer_act'));
  assert.ok(modelFacing.some((candidate) => candidate.name === 'browser_open'));
  assert.ok(modelFacing.some((candidate) => candidate.name === 'browser_observe'));
  assert.ok(modelFacing.some((candidate) => candidate.name === 'browser_act'));
  assert.ok(modelFacing.some((candidate) => candidate.name === 'browser_wait'));
  assert.ok(modelFacing.some((candidate) => candidate.name === 'browser_assert'));
  assert.ok(modelFacing.some((candidate) => candidate.name === 'browser_close'));
  assert.ok(modelFacing.some((candidate) => candidate.name === 'list_sessions'));
  assert.ok(modelFacing.some((candidate) => candidate.name === 'get_session_history'));
  assert.equal(modelFacing.some((candidate) => candidate.name === 'inspect_mimi_capabilities'), false);
  assert.equal(modelFacing.some((candidate) => candidate.name === 'invoke_runtime_capability'), false);
  assert.equal(modelFacing.some((candidate) => candidate.name === 'connector_capability'), false);
  assert.equal(modelFacing.some((candidate) => candidate.name === 'send_owner_message'), false);
  assert.equal(modelFacing.some((candidate) => candidate.name === 'web_search'), false);
  const inspect = gateway.find((candidate) => candidate.name === 'inspect_capabilities') as Tool & {
    invoke: (context: RunContext<unknown>, input: string, details: unknown) => Promise<unknown>;
  };
  const invoke = gateway.find((candidate) => candidate.name === 'invoke_capability') as Tool & {
    invoke: (context: RunContext<unknown>, input: string, details: unknown) => Promise<unknown>;
  };
  const context = new RunContext({});
  const naturalSessionQuery = await inspect.invoke(
    context,
    JSON.stringify({ query: '会话 历史 Session 列表 搜索 读取' }),
    {},
  ) as { capabilities: Array<{ name: string }> };
  assert.deepEqual(naturalSessionQuery.capabilities, []);
  assert.match(String(await inspect.invoke(
    context,
    JSON.stringify({ name: 'computer_observe' }),
    {},
  )), /不是 deferred capability/);
  assert.match(String(await inspect.invoke(
    context,
    JSON.stringify({ name: 'browser_open' }),
    {},
  )), /不是 deferred capability/);
  for (const [source, name, result] of [
    ['builtin', 'web_search', 'web-ok'],
    ['memory', 'memory_read', 'memory-ok'],
    ['goal', 'show_goal', 'goal-ok'],
    ['skill', 'list_skills', 'skill-ok'],
    ['mcp', 'custom_mcp_lookup', 'mcp-ok'],
    ['connector', 'send_owner_message', 'owner-message-ok'],
  ]) {
    const catalog = await inspect.invoke(context, JSON.stringify({ name }), {});
    assert.match(JSON.stringify(catalog), new RegExp(`"source":"${source}"`));
    assert.equal(
      await invoke.invoke(context, JSON.stringify({ name, argumentsJson: '{}' }), {}),
      result,
    );
  }
  assert.match(
    String(await invoke.invoke(
      context,
      JSON.stringify({ name: 'not_authorized', argumentsJson: '{}' }),
      {},
    )),
    /未授权/,
  );
});

test('capability registry caches identical discovery without a loop guard', async () => {
  const builder = new ToolSetBuilder();
  const hidden = sdkTool({
    name: 'web_search',
    description: 'search',
    parameters: z.object({}),
    execute: async () => 'ok',
  });
  const inspect = new HostCapabilityRegistry([hidden]).gatewayTools([hidden]).find(
    (candidate) => candidate.name === 'inspect_capabilities',
  ) as Tool & {
    invoke: (context: RunContext<unknown>, input: string, details: unknown) => Promise<unknown>;
  };
  const context = new RunContext({});
  const input = JSON.stringify({ query: 'browser' });
  const first = await inspect.invoke(context, input, {});
  assert.deepEqual(await inspect.invoke(context, input, {}), first);
  assert.deepEqual(await inspect.invoke(context, input, {}), first);
  assert.doesNotMatch(JSON.stringify(first), /discovery_loop|重复.*能力目录/);
});

test('runtime capability query searches connector actions through the formal catalog', async () => {
  const builder = new ToolSetBuilder();
  const catalog = [
    {
      query: 'render_document',
      connector: 'document-worker',
      action: 'render_document',
      capability: 'documents.render',
    },
    {
      query: 'audio.transcribe',
      connector: 'speech-worker',
      action: 'transcribe',
      capability: 'audio.transcribe',
    },
  ];
  const inspectConnector = sdkTool({
    name: 'inspect_mimi_capabilities',
    description: '读取 Connector 目录。',
    parameters: z.object({ query: z.string().optional() }),
    execute: async ({ query }) => {
      const matched = catalog.find((candidate) => candidate.query === query);
      return {
        filterMatched: Boolean(matched),
        actions: matched ? 1 : 0,
        connectors: matched ? [{
          id: matched.connector,
          actions: [{
            name: matched.action,
            capability: matched.capability,
            effect: 'write',
          }],
        }] : [],
      };
    },
  });
  const invokeConnector = sdkTool({
    name: 'connector_capability',
    description: '调用当前目录中的一项 Connector 业务能力。',
    parameters: z.object({
      capability: z.string(),
      action: z.string(),
      target: z.string(),
      payloadJson: z.string(),
    }),
    execute: async ({ action }) => `${action}-ok`,
  });
  const gateway = new HostCapabilityRegistry(
    [inspectConnector, invokeConnector],
    {
      inspectConnector: async ({ query }) => {
        const matched = catalog.find((candidate) => candidate.query === query);
        return {
          filterMatched: Boolean(matched),
          actions: matched ? 1 : 0,
          connectors: matched ? [{
            id: matched.connector,
            actions: [{
              name: matched.action,
              capability: matched.capability,
              effect: 'write',
            }],
          }] : [],
        };
      },
    },
  ).gatewayTools([invokeConnector]);
  const inspect = gateway.find((candidate) => candidate.name === 'inspect_capabilities') as Tool & {
    invoke: (context: RunContext<unknown>, input: string, details: unknown) => Promise<unknown>;
  };
  const invoke = gateway.find((candidate) => candidate.name === 'invoke_capability') as Tool & {
    invoke: (context: RunContext<unknown>, input: string, details: unknown) => Promise<unknown>;
  };
  const context = new RunContext({});

  for (const expected of catalog) {
    const found = await inspect.invoke(
      context,
      JSON.stringify({ source: 'connector', query: expected.query }),
      {},
    ) as {
      matchedCount: number;
      capabilities: Array<{ name: string; parameters?: unknown }>;
      connectorCatalog: { connectors: Array<{ actions: Array<{ name: string; capability: string }> }> };
    };
    assert.equal(found.matchedCount, 1);
    assert.equal(found.capabilities[0]?.name, 'connector_capability');
    assert.ok(found.capabilities[0]?.parameters);
    assert.equal(found.connectorCatalog.connectors[0]?.actions[0]?.name, expected.action);
    assert.equal(found.connectorCatalog.connectors[0]?.actions[0]?.capability, expected.capability);
    assert.equal(
      await invoke.invoke(context, JSON.stringify({
        name: 'connector_capability',
        argumentsJson: JSON.stringify({
          capability: expected.capability,
          action: expected.action,
          target: 'example-target',
          payloadJson: '{}',
        }),
      }), {}),
      `${expected.action}-ok`,
    );
  }
  assert.match(
    String(await invoke.invoke(context, JSON.stringify({
      name: 'connector_capability',
      argumentsJson: JSON.stringify({
        capability: 'desktop.keyboard.write',
        action: 'send_keys',
        target: 'org.example.App',
        payloadJson: '{}',
      }),
    }), {})),
    /Connector action 尚未通过能力目录精确发现/,
  );

  const absent = await inspect.invoke(
    context,
    JSON.stringify({ source: 'connector', query: 'missing' }),
    {},
  ) as { matchedCount: number; connectorCatalog: { filterMatched: boolean } };
  assert.equal(absent.matchedCount, 0);
  assert.equal(absent.connectorCatalog.filterMatched, false);

  const disabledInspector = sdkTool({
    name: 'inspect_mimi_capabilities',
    description: '读取 Connector 目录。',
    parameters: z.object({ query: z.string().optional() }),
    execute: async () => ({
      filterMatched: true,
      actions: 0,
      connectors: [{ id: 'disabled-connector', actions: [] }],
    }),
  });
  const disabledGateway = new HostCapabilityRegistry(
    [disabledInspector, invokeConnector],
    {
      inspectConnector: async () => ({
        filterMatched: true,
        actions: 0,
        connectors: [{ id: 'disabled-connector', actions: [] }],
      }),
    },
  ).gatewayTools([invokeConnector]);
  const inspectDisabled = disabledGateway.find(
    (candidate) => candidate.name === 'inspect_capabilities',
  ) as Tool & {
    invoke: (context: RunContext<unknown>, input: string, details: unknown) => Promise<unknown>;
  };
  const disabled = await inspectDisabled.invoke(
    context,
    JSON.stringify({ source: 'connector', query: 'disabled-connector' }),
    {},
  ) as { matchedCount: number };
  assert.equal(disabled.matchedCount, 0);
});

test('progressive snapshot indexes every hidden capability family without disclosing schemas', () => {
  const builder = new ToolSetBuilder();
  const make = (name: string, description = `SECRET_DESCRIPTION_${name}`) => sdkTool({
    name,
    description,
    parameters: z.object({ secret: z.string().optional() }),
    execute: async () => name,
  });
  const visible = [
    make('inspect_capabilities'),
    make('invoke_capability'),
  ];
  const hidden = [
    make('http_request'),
    make('computer_observe'),
    make('memory_read'),
    make('show_goal'),
    make('use_skill'),
    make('send_owner_message'),
    ...Array.from({ length: 20 }, (_, index) => make(`mcp_fixture__action_${String(index).padStart(2, '0')}`)),
  ];
  const snapshot = new HostCapabilityRegistry([...visible, ...hidden]).snapshot({
    runId: 'progressive-index',
    policyRevision: 'full-owner:general',
    modelTools: visible,
    observedAt: '2026-07-30T00:00:00.000Z',
  });

  assert.equal(snapshot.hiddenToolCount, hidden.length);
  assert.deepEqual(
    snapshot.hiddenTools.map((group) => ({
      source: group.source,
      count: group.count,
      truncated: group.truncated,
    })),
    [
      { source: 'builtin', count: 1, truncated: false },
      { source: 'computer', count: 1, truncated: false },
      { source: 'connector', count: 1, truncated: false },
      { source: 'goal', count: 1, truncated: false },
      { source: 'mcp', count: 20, truncated: true },
      { source: 'memory', count: 1, truncated: false },
      { source: 'skill', count: 1, truncated: false },
    ],
  );
  assert.deepEqual(
    snapshot.hiddenTools.find((group) => group.source === 'connector')?.names,
    ['send_owner_message'],
  );
  assert.equal(snapshot.hiddenTools.find((group) => group.source === 'mcp')?.names.length, 12);
  const rendered = renderEffectiveCapabilitySnapshot(snapshot);
  assert.match(rendered, /send_owner_message/);
  assert.match(rendered, /inspect_capabilities/);
  assert.match(rendered, /Connector 摘要只含公开 action/);
  assert.doesNotMatch(rendered, /SECRET_DESCRIPTION|secret/);
});

test('real MCP tools are host-materialized behind the gateway with exact schema and ledger semantics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-progressive-mcp-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  let authorizations = 0;
  const definitions = Array.from({ length: 50 }, (_, index) => ({
    name: `action_${index}`,
    description: `MCP action ${index} ${'schema '.repeat(30)}`,
    inputSchema: {
      type: 'object' as const,
      properties: { value: { type: 'string', description: `value ${index}` } },
      required: ['value'],
      additionalProperties: false,
    },
  }));
  const server = {
    name: 'fake',
    cacheToolsList: false,
    connect: async () => undefined,
    close: async () => undefined,
    listTools: async () => definitions,
    callTool: async (name: string, args: Record<string, unknown> | null) => ([{
      type: 'text',
      text: JSON.stringify({ name, args, execution: ++executions }),
    }]),
    invalidateToolsCache: async () => undefined,
  } as MCPServer;
  const mcpTools = await materializeMcpTools({
    servers: [server],
    ledger,
    currentRun: () => ({
      sessionId: 'owner',
      runId: 'event:mcp',
      semanticCallIds: true,
      authorizeSideEffect: async () => { authorizations += 1; },
    }),
    model: 'gpt-test',
    reservedTools: [],
  });
  assert.equal(mcpTools.length, 50);
  assert.equal(mcpTools[0]!.name, 'mcp_fake__action_0');
  assert.deepEqual(
    (mcpTools[0] as unknown as { parameters: unknown }).parameters,
    definitions[0]!.inputSchema,
  );

  const builder = new ToolSetBuilder();
  const registry = new HostCapabilityRegistry(mcpTools);
  const classified = builder.classify([...registry.authorizedTools()]);
  const gateway = registry.gatewayTools(classified.deferred);
  const modelFacing = builder.sdkTools(classified, gateway);
  const request = new AgentRequestFactory().create({
    model: 'gpt-test',
    instructions: 'system',
    tools: modelFacing,
    outputReserve: 8_000,
  });
  const finalTools = await request.agent.getAllTools(new RunContext({}));
  assert.deepEqual(finalTools.map((candidate) => candidate.name), [
    'inspect_capabilities',
    'invoke_capability',
  ]);
  assert.equal(finalTools.some((candidate) => candidate.name.startsWith('mcp_fake__')), false);

  const inspect = gateway.find((candidate) => candidate.name === 'inspect_capabilities') as Tool & {
    invoke: (context: RunContext<unknown>, input: string, details: unknown) => Promise<unknown>;
  };
  const invoke = gateway.find((candidate) => candidate.name === 'invoke_capability') as Tool & {
    invoke: (context: RunContext<unknown>, input: string, details: unknown) => Promise<unknown>;
  };
  const context = new RunContext({});
  const catalog = await inspect.invoke(
    context,
    JSON.stringify({ name: 'mcp_fake__action_7' }),
    {},
  );
  assert.match(JSON.stringify(catalog), /"source":"mcp"/);
  assert.match(JSON.stringify(catalog), /"value"/);
  const args = JSON.stringify({
    name: 'mcp_fake__action_7',
    argumentsJson: JSON.stringify({ value: 'once' }),
  });
  await invoke.invoke(context, args, {});
  await invoke.invoke(context, args, {});
  assert.equal(executions, 1);
  assert.equal(authorizations, 1);
  assert.match(
    String(await invoke.invoke(
      context,
      JSON.stringify({ name: 'mcp_fake__unknown', argumentsJson: '{}' }),
      {},
    )),
    /未授权/,
  );

  const serialized = finalTools.map((candidate) => {
    const value = candidate as unknown as Record<string, unknown>;
    return {
      name: candidate.name,
      description: value.description,
      parameters: value.parameters,
    };
  });
  const budget = new ContextManager(40, 128_000).requestBudget(serialized);
  assert.equal(budget.toolSchemaTokens, new ContextManager().requestBudget(serialized).toolSchemaTokens);
  assert.equal(request.toolNames.length, finalTools.length);
});

test('capability snapshot is deterministic and distinguishes readiness terminology', () => {
  const builder = new ToolSetBuilder();
  const tool = (name: string) => ({ name }) as Tool;
  const input = {
    runId: 'run-fixed',
    policyRevision: 'guarded:v1',
    tools: [tool('b'), tool('a'), tool('a')],
    authorizedTools: [tool('b'), tool('a'), tool('hidden-host-tool')],
    skills: ['skill-b', 'skill-a'],
    observedAt: '2026-07-27T00:00:00.000Z',
    items: [{
      id: 'personal-qq',
      kind: 'connector' as const,
      availability: 'unavailable' as const,
      readiness: 'unavailable' as const,
      freshness: 'unknown' as const,
      coverage: 'bounded' as const,
      permissionSource: 'connector-manager',
      capabilities: ['desktop.items.open-visible'],
      actionCount: 1,
      safeFallback: 'none' as const,
    }],
  };
  const registry = new HostCapabilityRegistry(input.authorizedTools);
  const first = registry.snapshot({
    runId: input.runId,
    policyRevision: input.policyRevision,
    modelTools: input.tools,
    skills: input.skills,
    observedAt: input.observedAt,
    items: input.items,
  });
  const second = registry.snapshot({
    runId: input.runId,
    policyRevision: input.policyRevision,
    modelTools: [...input.tools].reverse(),
    skills: input.skills,
    observedAt: input.observedAt,
    items: input.items,
  });
  assert.equal(first.snapshotDigest, second.snapshotDigest);
  assert.equal(first.toolSetDigest, second.toolSetDigest);
  assert.deepEqual(first.tools, ['a', 'b']);
  assert.equal(first.hiddenToolCount, 1);
  assert.deepEqual(first.hiddenTools[0]?.names, ['hidden-host-tool']);
  assert.equal(first.items.find((item) => item.kind === 'connector')?.freshness, 'unknown');
  const rendered = renderEffectiveCapabilitySnapshot(first);
  assert.match(rendered, /desktop\.items\.open-visible/);
  assert.match(rendered, /"actionCount":1/);
  assert.doesNotMatch(rendered, /open_visible/);
  assert.doesNotMatch(rendered, /"tools":/);
});

test('structured personal message scope excludes desktop fallback tools', () => {
  const tool = (name: string) => ({ name }) as Tool;
  const prepared = withoutPersonalMessageDesktopFallback([
    tool('inspect_mimi_capabilities'),
    tool('connector_action'),
    tool('run_shell'),
    tool('computer_observe'),
    tool('mcp_cua_driver__list_windows'),
    tool('mcp_browser__page_text'),
    tool('list_mcp_resources'),
    tool('reload_mcp'),
  ]);
  assert.deepEqual(prepared.map((item) => item.name), [
    'inspect_mimi_capabilities',
    'connector_action',
  ]);
});

test('personal message model surface contains only its frozen business route', () => {
  const tool = (name: string) => ({ name }) as Tool;
  const classified = new ToolSetBuilder().classify([
    tool('get_personal_message_context'),
    tool('send_personal_message'),
  ], undefined, [
    'get_personal_message_context',
    'send_personal_message',
  ]);
  assert.deepEqual(
    new ToolSetBuilder().sdkTools(classified, []).map((candidate) => candidate.name),
    ['get_personal_message_context', 'send_personal_message'],
  );
});

test('Workstation retains sandboxed shell and excludes external or GUI transactions', () => {
  const tool = (name: string) => ({ name }) as Tool;
  assert.deepEqual(
    new ToolSetBuilder().scoped(
      toolsForSecurity('workstation', [tool('run_shell'), tool('connector_action'), tool('computer_act')]),
      undefined,
      true,
    )
      .map((item) => item.name),
    ['run_shell'],
  );
});

test('Safe filters dynamically-added memory, plan, and team write tools', () => {
  const tool = (name: string) => ({ name }) as Tool;
  assert.deepEqual(
    toolsForSecurity('safe', [
      tool('memory_read'),
      tool('remember'),
      tool('show_plan'),
      tool('update_plan'),
      tool('delegate_research'),
      tool('run_team'),
    ]).map((item) => item.name),
    ['memory_read', 'show_plan', 'delegate_research'],
  );
});

test('tool selection is independent from shell command strings', () => {
  const tool = (name: string) => ({ name }) as Tool;
  const builder = new ToolSetBuilder();
  const selected = () => builder.scoped(
    toolsForSecurity('workstation', [tool('run_shell'), tool('connector_action')]),
    undefined,
    true,
  ).map((item) => item.name);
  assert.deepEqual(selected(), ['run_shell']);
  assert.deepEqual(selected(), ['run_shell']);
});

test('personal message history excludes completed desktop fallback turns', () => {
  const items = [
    { role: 'user', content: '旧的大象查询' },
    { type: 'function_call', name: 'mcp_cua_driver__list_windows', callId: 'old-call', arguments: '{}' },
    {
      type: 'function_call_result',
      name: 'mcp_cua_driver__list_windows',
      callId: 'old-call',
      output: { type: 'text', text: 'old desktop data' },
    },
    { role: 'assistant', content: '旧桌面结果' },
    { role: 'user', content: '检查待处理的大象消息' },
  ] as AgentInputItem[];
  assert.deepEqual(withoutPersonalMessageFallbackHistory(items), [
    { role: 'user', content: '检查待处理的大象消息' },
  ]);

  const activeTurn = [
    { role: 'user', content: '检查待处理的大象消息' },
    { type: 'function_call', name: 'mcp_cua_driver__list_windows', callId: 'active-call', arguments: '{}' },
    {
      type: 'function_call_result',
      name: 'mcp_cua_driver__list_windows',
      callId: 'active-call',
      output: { type: 'text', text: 'Tool not found' },
    },
  ] as AgentInputItem[];
  assert.deepEqual(withoutPersonalMessageFallbackHistory(activeTurn), activeTurn);
});

test('state loader skips every unauthorized source', async () => {
  const denied = () => Promise.reject(new Error('unauthorized loader was called'));
  const loader = new RunStateLoader({
    hotProfile: denied,
    searchMemories: denied,
    loadPersonalContextCandidates: denied,
    loadPlan: denied,
    loadGoal: denied,
    loadTeamSummary: denied,
    loadHistory: denied,
    loadSoul: denied,
    loadPreferences: denied,
    loadProjectGuidance: denied,
    loadArchive: denied,
    loadActiveSkills: denied,
  });
  const state = await loader.load({
    canReadLocal: false,
    canReadMemory: false,
    canReadState: false,
    canReadSessionContext: false,
    completionToolsAllowed: false,
    computerAccess: 'none',
  });
  assert.deepEqual(state.memories, []);
  assert.deepEqual(state.history, []);
  assert.ok(Object.isFrozen(state));
});

test('state loader can inject direct-owner Soul and preferences without granting local file access', async () => {
  const denied = () => Promise.reject(new Error('unauthorized loader was called'));
  const soul = {
    files: [],
    instructions: 'Mimi identity',
  };
  const preferences = {
    files: [],
    instructions: 'owner behavior preferences',
  };
  const loader = new RunStateLoader({
    hotProfile: denied,
    searchMemories: denied,
    loadPersonalContextCandidates: denied,
    loadPlan: denied,
    loadGoal: denied,
    loadTeamSummary: denied,
    loadHistory: denied,
    loadSoul: async () => soul,
    loadPreferences: async () => preferences,
    loadProjectGuidance: denied,
    loadArchive: denied,
    loadActiveSkills: denied,
  });
  const state = await loader.load({
    canReadLocal: false,
    canReadMemory: false,
    canReadState: false,
    canReadSessionContext: false,
    completionToolsAllowed: false,
    computerAccess: 'none',
  }, { loadOwnerSoul: true, loadOwnerPreferences: true });
  assert.equal(state.soul.instructions, soul.instructions);
  assert.equal(state.preferences.instructions, preferences.instructions);
  assert.equal(state.projectGuidance.instructions, '');
});

test('state loader never injects hot profiles and budgets Personal Context instead of fixing card count', async () => {
  let hotProfileCalls = 0;
  const relations = ['today-focus', 'commitment', 'waiting-on', 'project-risk'] as const;
  const memories = Array.from({ length: 4 }, (_, index) => ({
    ref: { scope: 'private' as const, profileId: 'owner', id: `memory-${index}` },
    title: `memory-${index}`,
    summary: `summary-${index}`,
    kind: 'fact' as const,
    status: 'active' as const,
    confidence: 'source-grounded' as const,
    score: 1,
    sourceRefs: [],
    documentType: 'wiki' as const,
    layer: 'L1' as const,
    facets: {
      kind: 'fact' as const,
      entities: [],
      relations: [{
        kind: relations[index]!,
        target: { scope: 'private' as const, profileId: 'owner', id: `target-${index}` },
      }],
      time: { occurredAt: new Date().toISOString(), validFrom: null, validUntil: null },
      sources: [],
    },
    derivedFrom: [],
  }));
  const queryOnlyMemory = {
    ...memories[0]!,
    ref: { scope: 'private' as const, profileId: 'owner', id: 'query-only' },
    title: 'query-only',
    summary: 'A directly relevant query result.',
  };
  const loader = new RunStateLoader({
    hotProfile: async () => {
      hotProfileCalls += 1;
      throw new Error('hot profiles must not be loaded');
    },
    searchMemories: async () => [memories[1]!, queryOnlyMemory],
    loadPersonalContextCandidates: async () => memories,
    loadPlan: async () => [],
    loadGoal: async () => undefined,
    loadTeamSummary: async () => '',
    loadHistory: async () => [],
    loadSoul: async () => ({ files: [], instructions: '' }),
    loadPreferences: async () => ({ files: [], instructions: '' }),
    loadProjectGuidance: async () => ({ files: [], instructions: '' }),
    loadArchive: async () => undefined,
    loadActiveSkills: async () => [],
  });
  const state = await loader.load({
    canReadLocal: true,
    canReadMemory: true,
    canReadState: true,
    canReadSessionContext: true,
    completionToolsAllowed: true,
    computerAccess: 'none',
  });
  assert.equal(hotProfileCalls, 0);
  assert.equal(state.memories.length, 5);
  assert.equal(state.memories.filter((item) => item.ref.id === 'memory-1').length, 1);
  assert.equal(state.memories[0]?.ref.id, 'query-only');
  assert.equal(state.memories[0]?.summary, 'A directly relevant query result.');
  assert.equal(state.personalContext.layer, 'L3');
  assert.equal(state.personalContext.complete, true);
  assert.equal(state.personalContext.status, 'complete');
  assert.ok(state.personalContext.estimatedTokens <= 900);
  assert.match(state.memories.find((item) => item.ref.id === 'memory-0')!.summary, /^\[today-focus\]/);
});

test('request factory freezes the model-facing tool order and output cap', () => {
  const request = new AgentRequestFactory().create({
    model: 'gpt-test',
    instructions: 'system',
    tools: [{ name: 'read_file' } as Tool, { name: 'delegate_research' } as Tool],
    outputReserve: 8_000,
    focusedOutputLimit: 4_096,
  });
  assert.equal(request.maxTokens, 4_096);
  assert.deepEqual(request.toolNames, ['read_file', 'delegate_research']);
  assert.ok(Object.isFrozen(request.toolNames));
});

test('request factory maps the provider-neutral reasoning intent into SDK settings', () => {
  const create = (reasoning: 'off' | 'auto' | 'high') => new AgentRequestFactory().create({
    model: 'gpt-test',
    instructions: 'system',
    tools: [],
    outputReserve: 8_000,
    reasoning,
  }).agent.modelSettings.reasoning?.effort;
  assert.equal(create('off'), 'none');
  assert.equal(create('auto'), undefined);
  assert.equal(create('high'), 'high');
});
