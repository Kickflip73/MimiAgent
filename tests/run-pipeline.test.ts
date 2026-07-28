import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { AgentInputItem } from '@openai/agents';
import type { Tool } from '@openai/agents';
import { ContextManager } from '../src/core/context.js';
import {
  CapabilityResolver,
  renderEffectiveCapabilitySnapshot,
} from '../src/runtime/pipeline/capability-resolver.js';
import { ContextAssembler } from '../src/runtime/pipeline/context-assembler.js';
import { AgentRequestFactory } from '../src/runtime/pipeline/request-factory.js';
import { captureRunScope } from '../src/runtime/pipeline/run-scope.js';
import { RunStateLoader } from '../src/runtime/pipeline/state-loader.js';
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
    permissionMode: 'trusted',
    securityProfile: 'workstation',
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

test('captures an immutable run scope before delayed pipeline work', () => {
  const captured = scope();
  assert.equal(captured.profileId, 'owner');
  assert.equal(captured.executionKey, 'event-1');
  assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured.cause));
  assert.throws(() => {
    (captured as { sessionId: string }).sessionId = 'other';
  }, TypeError);
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
    manifest.sections.reduce((total, section) => total + section.estimatedTokens, 0),
    manifest.estimatedInputTokens,
  );
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
    developmentTask: true,
    expectedArtifactCompletion: false,
    defaultComputerAccess: 'background',
  });
  assert.equal(owner.canReadLocal, true);
  assert.equal(owner.canInitializeProjectGuidance, true);
  assert.equal(owner.computerAccess, 'none');
  assert.equal(owner.completionToolsAllowed, true);

  const restricted = resolver.resolve({
    scope: scope(),
    policy: {
      allowedCapabilities: ['delivery-control'],
      allowedTools: ['finish_mimi_silently'],
      allowSessionContext: false,
    },
    developmentTask: true,
    expectedArtifactCompletion: false,
  });
  assert.deepEqual(restricted, {
    canReadLocal: false,
    canReadMemory: false,
    canReadState: false,
    canReadSessionContext: false,
    canInitializeProjectGuidance: false,
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
    'trusted',
    'workstation',
    {
      allowedCapabilities: ['read'],
      allowSideEffects: false,
    },
  );
  assert.deepEqual(prepared.map((item) => item.name), ['read_file', 'delegate_research']);
  const snapshot = builder.snapshot({
    runId: 'run-1',
    policyRevision: 'guarded:v1',
    tools: prepared,
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

test('capability snapshot is deterministic and distinguishes readiness terminology', () => {
  const builder = new ToolSetBuilder();
  const tool = (name: string) => ({ name }) as Tool;
  const input = {
    runId: 'run-fixed',
    policyRevision: 'guarded:v1',
    tools: [tool('b'), tool('a'), tool('a')],
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
      operations: [{
        capability: 'desktop.items.open-visible',
        action: 'open_visible',
        effect: 'write' as const,
      }],
      safeFallback: 'none' as const,
    }],
  };
  const first = builder.snapshot(input);
  const second = builder.snapshot({ ...input, tools: [...input.tools].reverse() });
  assert.equal(first.snapshotDigest, second.snapshotDigest);
  assert.equal(first.toolSetDigest, second.toolSetDigest);
  assert.deepEqual(first.tools, ['a', 'b']);
  assert.equal(first.items.find((item) => item.kind === 'connector')?.freshness, 'unknown');
  const rendered = renderEffectiveCapabilitySnapshot(first);
  assert.match(rendered, /desktop\.items\.open-visible/);
  assert.match(rendered, /open_visible/);
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

test('Workstation retains sandboxed shell and excludes external or GUI transactions', () => {
  const tool = (name: string) => ({ name }) as Tool;
  assert.deepEqual(
    new ToolSetBuilder().scoped(
      [tool('run_shell'), tool('connector_action'), tool('computer_act')],
      'trusted',
      'workstation',
      undefined,
      true,
    )
      .map((item) => item.name),
    ['run_shell'],
  );
});

test('tool selection is independent from shell command strings', () => {
  const tool = (name: string) => ({ name }) as Tool;
  const builder = new ToolSetBuilder();
  const selected = () => builder.scoped(
    [tool('run_shell'), tool('connector_action')],
    'trusted',
    'workstation',
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
    loadPlan: denied,
    loadGoal: denied,
    loadTeamSummary: denied,
    loadHistory: denied,
    loadSoul: denied,
    loadProjectGuidance: denied,
    loadArchive: denied,
    loadActiveSkills: denied,
  });
  const state = await loader.load({
    canReadLocal: false,
    canReadMemory: false,
    canReadState: false,
    canReadSessionContext: false,
    canInitializeProjectGuidance: false,
    completionToolsAllowed: false,
    computerAccess: 'none',
  }, true);
  assert.deepEqual(state.memories, []);
  assert.deepEqual(state.history, []);
  assert.ok(Object.isFrozen(state));
});

test('request factory freezes the model-facing tool order and output cap', () => {
  const request = new AgentRequestFactory().create({
    model: 'gpt-test',
    instructions: 'system',
    tools: [{ name: 'read_file' } as Tool, { name: 'delegate_research' } as Tool],
    mcpServers: [],
    outputReserve: 8_000,
    focusedOutputLimit: 4_096,
  });
  assert.equal(request.maxTokens, 4_096);
  assert.deepEqual(request.toolNames, ['read_file', 'delegate_research']);
  assert.ok(Object.isFrozen(request.toolNames));
});
