import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentInputItem } from '@openai/agents';
import {
  ContextManager,
  ContextProtocolBudgetError,
  estimateTokens,
  type ContextSemanticSummarizer,
  type WorkSnapshotContent,
} from '../src/core/context.js';
import { FileSession } from '../src/core/session.js';
import type { ContextToolArtifact } from '../src/core/session.js';
import { MimiAgent } from '../src/agent.js';

function historyWithFiveTurns(): AgentInputItem[] {
  return [
    { role: 'user', content: '目标：交付 opaque task-ALPHA_9284。约束：不得重放 uncertain 动作。' },
    { role: 'assistant', content: '决策：使用派生 Context View。证据 Artifact trace-KEEP_7731。' },
    { role: 'user', content: '进度：已经完成基线。未决问题：embedding 是否可用？' },
    { role: 'assistant', content: '已完成：54 条测试通过。' },
    { role: 'assistant', content: '普通背景材料。'.repeat(500) },
    { role: 'user', content: '第三近用户回合必须逐字一致。' },
    { role: 'assistant', content: '保留。' },
    { role: 'user', content: '第二近用户回合必须逐字一致。' },
    { role: 'assistant', content: '保留。' },
    { role: 'user', content: '最近用户回合必须逐字一致。' },
  ] as unknown as AgentInputItem[];
}

function assertNoOrphanToolUnits(items: AgentInputItem[]): void {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const item of items) {
    const value = item as unknown as Record<string, unknown>;
    if (value.type === 'function_call') calls.add(String(value.callId));
    if (value.type === 'function_call_result') results.add(String(value.callId));
  }
  assert.deepEqual([...calls].sort(), [...results].sort());
}

function fakeSummarizer(
  content: Partial<WorkSnapshotContent>,
): ContextSemanticSummarizer {
  return {
    summarize: async ({ seed }) => ({
      goal: content.goal ?? seed.goal ?? [],
      progress: content.progress ?? seed.progress ?? [],
      completed: content.completed ?? seed.completed ?? [],
      decisions: content.decisions ?? seed.decisions ?? [],
      constraints: content.constraints ?? seed.constraints ?? [],
      openQuestions: content.openQuestions ?? seed.openQuestions ?? [],
      evidence: content.evidence ?? seed.evidence ?? [],
      keyFacts: content.keyFacts ?? seed.keyFacts ?? [],
      references: content.references ?? seed.references ?? [],
    }),
  };
}

test('takes a work snapshot at 70% and semantically compresses only at 80%', async () => {
  const manager = new ContextManager(100, 128_000);
  const history = historyWithFiveTurns();
  const snapshot = await manager.prepareSemanticSnapshot(history, fakeSummarizer({
    goal: ['交付 opaque task-ALPHA_9284'],
    decisions: ['使用派生 Context View'],
    constraints: ['不得重放 uncertain 动作'],
    evidence: ['Artifact trace-KEEP_7731'],
    keyFacts: ['embedding availability remains open'],
  }));
  const raw = estimateTokens(history);
  const at79 = manager.modelContextView(history, '', raw / 0.79, { semanticSnapshot: snapshot });
  assert.ok(at79.snapshot);
  assert.deepEqual(at79.input, history);
  assert.equal(at79.records.length, 0);

  const at80 = manager.modelContextView(history, '', raw / 0.8, { semanticSnapshot: snapshot });
  assert.ok(at80.records.some((record) => record.strategy === 'semantic-summary'));
  assert.match(at80.instructions ?? '', /task-ALPHA_9284/);
  assert.match(at80.instructions ?? '', /trace-KEEP_7731/);
  assert.match(at80.instructions ?? '', /不得重放 uncertain/);
  assert.deepEqual(
    at80.input.filter((item) => 'role' in item && item.role === 'user').map((item) => item.content),
    [
      '第三近用户回合必须逐字一致。',
      '第二近用户回合必须逐字一致。',
      '最近用户回合必须逐字一致。',
    ],
  );
  assert.deepEqual(history, historyWithFiveTurns());
});

test('keeps every model request bounded without orphaning 30 tool protocol units', () => {
  const manager = new ContextManager(200, 128_000);
  const history: AgentInputItem[] = [{ role: 'user', content: '分析 30 个结果' }];
  for (let index = 0; index < 30; index += 1) {
    history.push(
      {
        type: 'function_call',
        name: 'read_artifact',
        callId: `call-${index}`,
        arguments: JSON.stringify({ artifactId: `artifact-${index}` }),
      } as AgentInputItem,
      {
        type: 'function_call_result',
        name: 'read_artifact',
        callId: `call-${index}`,
        output: JSON.stringify({
          artifactId: `artifact-${index}`,
          status: 'ok',
          rows: Array.from({ length: 200 }, (_, row) => ({ row, value: `result-${index}-${row}` })),
        }),
      } as AgentInputItem,
    );
  }
  const raw = JSON.stringify(history);
  for (let request = 0; request < 5; request += 1) {
    const view = manager.modelContextView(history, 'base', 8_000);
    assert.ok(view.effectiveTokens <= 8_000);
    assertNoOrphanToolUnits(view.input);
    assert.match(JSON.stringify(view.input), /call-29/);
    assert.match(JSON.stringify(view.input), /tool-result:sha256:/);
    assert.doesNotMatch(JSON.stringify(view.input), /result-29-199/);
    assert.ok(view.records.some((record) => record.strategy === 'tool-result-summary'));
  }
  assert.equal(JSON.stringify(history), raw);
});

test('fails closed when even the semantic view cannot fit the current protocol budget', () => {
  const manager = new ContextManager(40, 128_000);
  const input = [
    { role: 'user', content: `目标：${'不可拆分'.repeat(5_000)}` },
  ] as AgentInputItem[];
  assert.throws(
    () => manager.modelContextView(input, 'base', 1_000),
    (error: unknown) => error instanceof ContextProtocolBudgetError
      && /canonical Session 已保留/.test(error.message),
  );
  assert.match(String((input[0] as unknown as { content: string }).content), /目标：/);
});

test('safely checkpoints at the configured model-call limit without dropping protocol units', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-context-run-limit-'));
  const dataRoot = path.join(root, '.mimi-agent');
  const agent = await MimiAgent.create({
    provider: 'openai',
    workspaceRoot: root,
    dataRoot,
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    contextWindow: 128_000,
    maxTurns: 2,
    maxRunInputTokens: 500_000,
  }, 'limited');
  const session = (agent as unknown as { session: FileSession }).session;
  const runner = (agent as unknown as {
    runner: {
      run: (
        runtimeAgent: { instructions: string },
        input: string,
        options: {
          session: FileSession;
          sessionInputCallback: (
            history: AgentInputItem[],
            current: AgentInputItem[],
          ) => Promise<AgentInputItem[]>;
          callModelInputFilter: (args: {
            modelData: { input: AgentInputItem[]; instructions?: string };
          }) => Promise<{ input: AgentInputItem[]; instructions?: string }>;
        },
      ) => Promise<unknown>;
    };
  }).runner;
  runner.run = async (runtimeAgent, input, options) => {
    const pair = [
      { type: 'function_call', name: 'read_file', callId: 'stable-call', arguments: '{}' },
      {
        type: 'function_call_result',
        name: 'read_file',
        callId: 'stable-call',
        output: 'verified result',
      },
    ] as AgentInputItem[];
    await options.session.addItems([
      { role: 'user', content: input } as AgentInputItem,
      ...pair,
    ]);
    const modelInput = await options.sessionInputCallback(
      await options.session.getItems(),
      [],
    );
    await options.callModelInputFilter({
      modelData: { input: modelInput, instructions: runtimeAgent.instructions },
    });
    await options.callModelInputFilter({
      modelData: { input: modelInput, instructions: runtimeAgent.instructions },
    });
    await options.callModelInputFilter({
      modelData: { input: modelInput, instructions: runtimeAgent.instructions },
    });
    return {};
  };

  try {
    await assert.rejects(agent.stream('bounded work'), /达到 2 次模型调用上限/);
    const checkpoint = await session.getCheckpoint();
    assert.equal(checkpoint?.status, 'interrupted');
    assert.match(checkpoint?.error ?? '', /达到 2 次模型调用上限/);
    assertNoOrphanToolUnits(await session.getItems());
  } finally {
    await agent.close();
  }
});

test('safely checkpoints before cumulative model input exceeds the configured limit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-context-input-limit-'));
  const dataRoot = path.join(root, '.mimi-agent');
  const agent = await MimiAgent.create({
    provider: 'openai',
    workspaceRoot: root,
    dataRoot,
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    contextWindow: 128_000,
    maxTurns: 32,
    maxRunInputTokens: 100,
  }, 'input-limited');
  const session = (agent as unknown as { session: FileSession }).session;
  const runner = (agent as unknown as {
    runner: {
      run: (
        runtimeAgent: { instructions: string },
        input: string,
        options: {
          session: FileSession;
          sessionInputCallback: (
            history: AgentInputItem[],
            current: AgentInputItem[],
          ) => Promise<AgentInputItem[]>;
          callModelInputFilter: (args: {
            modelData: { input: AgentInputItem[]; instructions?: string };
          }) => Promise<{ input: AgentInputItem[]; instructions?: string }>;
        },
      ) => Promise<unknown>;
    };
  }).runner;
  runner.run = async (runtimeAgent, input, options) => {
    await options.session.addItems([{ role: 'user', content: input } as AgentInputItem]);
    const modelInput = await options.sessionInputCallback(
      await options.session.getItems(),
      [],
    );
    await options.callModelInputFilter({
      modelData: { input: modelInput, instructions: runtimeAgent.instructions },
    });
    return {};
  };

  try {
    await assert.rejects(agent.stream('bounded work'), /累计模型输入估算 \d+ tokens 超过 100 上限/);
    const checkpoint = await session.getCheckpoint();
    assert.equal(checkpoint?.status, 'interrupted');
    assert.match(checkpoint?.error ?? '', /累计模型输入估算 \d+ tokens 超过 100 上限/);
  } finally {
    await agent.close();
  }
});

test('synthetic tool long run reduces cumulative model input by at least 70%', () => {
  const manager = new ContextManager(200, 128_000);
  const history: AgentInputItem[] = [{ role: 'user', content: '长跑读取并核对全部 artifacts' }];
  let legacyCumulative = 0;
  let boundedCumulative = 0;
  for (let index = 0; index < 30; index += 1) {
    history.push(
      {
        type: 'function_call',
        name: 'read_artifact',
        callId: `long-call-${index}`,
        arguments: JSON.stringify({ artifactId: `long-artifact-${index}` }),
      } as AgentInputItem,
      {
        type: 'function_call_result',
        name: 'read_artifact',
        callId: `long-call-${index}`,
        output: JSON.stringify({
          artifactId: `long-artifact-${index}`,
          status: 'verified',
          evidence: 'x'.repeat(12_000),
        }),
      } as AgentInputItem,
    );
    legacyCumulative += estimateTokens(history);
    boundedCumulative += manager.modelContextView(history, 'base', 8_000).effectiveTokens;
  }
  const reduction = 1 - boundedCumulative / legacyCumulative;
  assert.ok(reduction >= 0.7, `expected >=70% reduction, got ${(reduction * 100).toFixed(2)}%`);
});

test('real 1M view consumes each tool result once and stays below the 500K run cap', () => {
  const manager = new ContextManager(200, 1_048_576);
  const capacity = 962_068;
  const history: AgentInputItem[] = [
    { role: 'user', content: '目标：核对 OTLP；约束：保留 opaque-ABC_7788。' },
    { role: 'assistant', content: '关键事实：OTLP端口4317，TLS服务名telemetry-prod。' } as unknown as AgentInputItem,
  ];
  const consumed = new Set<string>();
  const artifacts: ContextToolArtifact[] = [];
  let legacyCumulative = 0;
  let boundedCumulative = 0;
  for (let index = 0; index < 30; index += 1) {
    const output = JSON.stringify({
      artifactId: `artifact-${index}`,
      status: 'verified',
      evidence: 'x'.repeat(12_000),
    });
    history.push(
      {
        type: 'function_call',
        name: 'read_artifact',
        callId: `million-call-${index}`,
        arguments: JSON.stringify({ artifactId: `artifact-${index}` }),
      } as AgentInputItem,
      {
        type: 'function_call_result',
        name: 'read_artifact',
        callId: `million-call-${index}`,
        output,
      } as AgentInputItem,
    );
    artifacts.push({
      ref: `context-artifact:00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      callId: `million-call-${index}`,
      toolName: 'read_artifact',
      outputDigest: `sha256:${createHash('sha256').update(JSON.stringify(output)).digest('hex')}`,
      runId: 'million-run',
      createdAt: '2026-07-30T00:00:00.000Z',
    });
    legacyCumulative += estimateTokens(history);
    const view = manager.modelContextView(history, 'base', capacity, {
      consumedArtifactRefs: consumed,
      toolArtifacts: artifacts,
    });
    boundedCumulative += view.effectiveTokens;
    view.consumedArtifactRefs.forEach((ref) => consumed.add(ref));
    assert.ok(view.effectiveTokens <= capacity);
    assertNoOrphanToolUnits(view.input);
    assert.match(JSON.stringify(view.input), new RegExp(`million-call-${index}`));
  }
  assert.ok(boundedCumulative < 500_000);
  assert.ok(1 - boundedCumulative / legacyCumulative >= 0.7);
});

test('80% dialogue snapshot preserves arbitrary facts without keyword routing', async () => {
  const manager = new ContextManager(200, 1_048_576);
  const history = [
    { role: 'user', content: '执行 opaque-ABC_7788。' },
    { role: 'assistant', content: 'OTLP端口4317。TLS服务名telemetry-prod。' },
    { role: 'assistant', content: '普通背景。'.repeat(600) },
    { role: 'user', content: '第三近用户原文。' },
    { role: 'assistant', content: '确认三。' },
    { role: 'user', content: '第二近用户原文。' },
    { role: 'assistant', content: '确认二。' },
    { role: 'user', content: '最近用户原文。' },
  ] as AgentInputItem[];
  const snapshot = await manager.prepareSemanticSnapshot(history, fakeSummarizer({
    goal: ['执行 opaque-ABC_7788'],
    keyFacts: ['OTLP端口4317', 'TLS服务名telemetry-prod'],
  }));
  const view = manager.modelContextView(history, 'base', estimateTokens(history) / 0.8, {
    semanticSnapshot: snapshot,
  });
  const serialized = JSON.stringify(view);
  assert.match(serialized, /4317/);
  assert.match(serialized, /telemetry-prod/);
  assert.match(serialized, /opaque-ABC_7788/);
  assert.deepEqual(
    view.input.filter((item) => 'role' in item && item.role === 'user').map((item) => item.content),
    ['第三近用户原文。', '第二近用户原文。', '最近用户原文。'],
  );
});

test('real 1M thresholds accept long logs and more than 128 independent facts through semantic seam', async () => {
  const manager = new ContextManager(500, 1_048_576);
  const capacity = 962_068;
  const longHistory: AgentInputItem[] = [];
  for (let index = 0; index < 108; index += 1) {
    longHistory.push({
      role: index % 2 ? 'assistant' : 'user',
      content: `${index === 0 ? 'opaque-LONG_4317 telemetry-prod\n' : ''}`
        + `LOG ${index}\n`
        + 'const diagnostic = await inspect();\n'.repeat(675),
    } as unknown as AgentInputItem);
  }
  const longCanonical = JSON.stringify(longHistory);
  const longRaw = estimateTokens(longHistory);
  assert.ok(longRaw / capacity >= 0.701 && longRaw / capacity < 0.8);
  const longSnapshot = await manager.prepareSemanticSnapshot(longHistory, fakeSummarizer({
    goal: ['diagnose telemetry ingestion'],
    constraints: ['do not replay uncertain operations'],
    keyFacts: ['OTLP port is 4317', 'TLS service is telemetry-prod'],
  }));
  const at70 = manager.modelContextView(longHistory, '', capacity, {
    semanticSnapshot: longSnapshot,
  });
  assert.ok(at70.snapshot);
  assert.equal(at70.records.some((record) => record.strategy === 'semantic-summary'), false);
  assert.match(JSON.stringify(at70.snapshot), /opaque-LONG_4317/);
  assert.equal(JSON.stringify(longHistory), longCanonical);

  const facts = Array.from({ length: 140 }, (_, index) =>
    `FACT_${String(index).padStart(3, '0')}=value-${index}; opaque-FACT_${String(index).padStart(3, '0')}`);
  const factHistory: AgentInputItem[] = facts.flatMap((fact, index) => [
    { role: 'user', content: `Record ${fact}` } as AgentInputItem,
    { role: 'assistant', content: `Confirmed ${fact}` } as unknown as AgentInputItem,
  ]);
  factHistory.push(
    {
      type: 'function_call',
      name: 'read_log',
      callId: 'call-pad-80',
      arguments: '{}',
    } as AgentInputItem,
    {
      type: 'function_call_result',
      name: 'read_log',
      callId: 'call-pad-80',
      output: 'x'.repeat(3_100_000),
    } as AgentInputItem,
  );
  const factCanonical = JSON.stringify(factHistory);
  assert.ok(estimateTokens(factHistory) / capacity >= 0.8);
  const factSnapshot = await manager.prepareSemanticSnapshot(factHistory, fakeSummarizer({
    goal: ['preserve all independently relevant facts'],
    keyFacts: facts,
  }));
  const at80 = manager.modelContextView(factHistory, '', capacity, {
    semanticSnapshot: factSnapshot,
  });
  assert.ok(at80.records.some((record) => record.strategy === 'semantic-summary'));
  assert.match(at80.instructions ?? '', /FACT_000=value-0/);
  assert.match(at80.instructions ?? '', /FACT_139=value-139/);
  assert.match(at80.instructions ?? '', /opaque-FACT_139/);
  assert.deepEqual(
    at80.input.filter((item) => 'role' in item && item.role === 'user').map((item) => item.content),
    factHistory.filter((item) => 'role' in item && item.role === 'user').slice(-3).map((item) => item.content),
  );
  assertNoOrphanToolUnits(at80.input);
  assert.equal(JSON.stringify(factHistory), factCanonical);
});

test('persists the 70% work snapshot and binds artifact reads to Session and Run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-context-artifact-'));
  const session = new FileSession(root, 'owner');
  const run = await session.beginRun('work', 'run-owner');
  const result = {
    type: 'function_call_result',
    name: 'read_artifact',
    callId: 'artifact-call',
    status: 'completed',
    output: JSON.stringify({ port: 4317, service: 'telemetry-prod', body: 'x'.repeat(4_000) }),
  } as unknown as AgentInputItem;
  const canonical = [
    { role: 'user', content: '执行 opaque-ABC_7788' },
    { type: 'function_call', name: 'read_artifact', callId: 'artifact-call', arguments: '{}' },
    result,
  ] as AgentInputItem[];
  await session.addItems(canonical);
  const artifacts = await session.registerContextToolArtifacts(canonical, run.runId);
  assert.equal(artifacts.length, 1);
  const manager = new ContextManager(40, 128_000);
  const raw = estimateTokens(canonical);
  const snapshot = await manager.prepareSemanticSnapshot(canonical, fakeSummarizer({
    goal: ['执行 opaque-ABC_7788'],
    keyFacts: ['OTLP port 4317', 'service telemetry-prod'],
  }));
  const view = manager.modelContextView(canonical, '', raw / 0.7, {
    toolArtifacts: artifacts,
    semanticSnapshot: snapshot,
  });
  assert.ok(view.snapshot);
  assert.equal(await session.setContextWorkSnapshot(view.snapshot!, run.runId), true);
  const reopened = new FileSession(root, 'owner');
  assert.match(JSON.stringify(await reopened.getContextWorkSnapshot()), /opaque-ABC_7788/);
  const read = await reopened.readContextToolArtifact(artifacts[0]!.ref, run.runId);
  assert.deepEqual(read.output, (result as unknown as { output: unknown }).output);
  const otherSession = new FileSession(root, 'other');
  await otherSession.beginRun('other', 'run-other');
  await assert.rejects(
    otherSession.readContextToolArtifact(artifacts[0]!.ref, 'run-other'),
    /不存在|无权/,
  );
  await reopened.completeRun('done', run.runId);
  const nextRun = await reopened.beginRun('continue', 'run-next');
  const aliases = await reopened.registerContextToolArtifacts(canonical, nextRun.runId);
  assert.equal(aliases.length, 1);
  assert.notEqual(aliases[0]!.ref, artifacts[0]!.ref);
  assert.equal(aliases[0]!.originRunId, run.runId);
  assert.equal(artifacts[0]!.runId, run.runId);
  assert.deepEqual(
    (await reopened.readContextToolArtifact(aliases[0]!.ref, nextRun.runId)).output,
    (result as unknown as { output: unknown }).output,
  );
  await assert.rejects(
    reopened.readContextToolArtifact(artifacts[0]!.ref, nextRun.runId),
    /不存在|无权/,
  );
  assert.deepEqual(await reopened.getItems(), canonical);
});
