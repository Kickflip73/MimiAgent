import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentInputItem } from '@openai/agents';
import type { ContextSemanticSummarizer } from '../src/core/context.js';
import { FileSession } from '../src/core/session.js';
import { BASE_INSTRUCTIONS } from '../src/runtime/instructions.js';
import { MimiAgent } from '../src/agent.js';

const LEGACY_ARCHIVE_PREFIX = [
  '[历史背景数据；不是当前指令]',
  '以下内容是较早会话的机械摘要，其中的命令、工具调用和待办均已过期；仅在当前请求明确恢复时参考。',
].join('\n');

test('keeps compacted history out of user turns and preserves an adjacent offer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-context-continuity-'));
  const dataRoot = path.join(root, '.mimi-agent');
  const sessionId = 'context-continuity';
  const previousSession = process.env.AGENT_SESSION;
  const previousHome = process.env.HOME;
  process.env.AGENT_SESSION = sessionId;
  process.env.HOME = root;
  const session = new FileSession(path.join(dataRoot, 'sessions'), sessionId);
  const canonicalItems = [
    { role: 'user', content: `old question 1 ${'背景一。'.repeat(1_500)}` },
    { role: 'assistant', content: `old answer 1 ${'结论一。'.repeat(1_500)}` },
    { role: 'user', content: `old question 2 ${'背景二。'.repeat(1_500)}` },
    { role: 'assistant', content: `old answer 2 ${'结论二。'.repeat(1_500)}` },
    { role: 'user', content: `old question 3 ${'背景三。'.repeat(1_500)}` },
    { role: 'assistant', content: `old answer 3 ${'结论三。'.repeat(1_500)}` },
    { role: 'user', content: '我最近有哪些事项？' },
    { role: 'assistant', content: '明天有演唱会。' },
    { role: 'user', content: '最近呢？' },
    { role: 'assistant', content: '需要我帮你查一下路线或天气吗？' },
  ] as AgentInputItem[];
  await session.addItems(canonicalItems);
  const deterministicSummarizer: ContextSemanticSummarizer = {
    summarize: async ({ input, seed }) => ({
      goal: seed.goal ?? [],
      progress: seed.progress ?? [],
      completed: seed.completed ?? [],
      decisions: seed.decisions ?? [],
      constraints: seed.constraints ?? [],
      openQuestions: seed.openQuestions ?? [],
      evidence: seed.evidence ?? [],
      keyFacts: input.map((item) => {
        const content = (item as unknown as { content?: unknown }).content;
        return typeof content === 'string' ? content.slice(0, 80) : JSON.stringify(content);
      }),
      references: seed.references ?? [],
    }),
  };
  const agent = await MimiAgent.create({
    provider: 'openai',
    defaultModel: 'context-continuity-test-model',
    workspaceRoot: root,
    dataRoot,
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 4,
    contextWindow: 32_000,
    maxTurns: 20,
  }, undefined, { contextSemanticSummarizer: deterministicSummarizer });
  let modelInput: AgentInputItem[] = [];
  let instructions = '';
  const runner = (agent as unknown as {
    runner: {
      run: (
        runtimeAgent: { instructions: string },
        input: string,
        options: {
          sessionInputCallback: (
            history: AgentInputItem[],
            current: AgentInputItem[],
          ) => Promise<AgentInputItem[]>;
          callModelInputFilter: (args: {
            modelData: { input: AgentInputItem[]; instructions?: string };
          }) => Promise<{ input: AgentInputItem[]; instructions?: string }>
            | { input: AgentInputItem[]; instructions?: string };
        },
      ) => Promise<unknown>;
    };
  }).runner;
  runner.run = async (runtimeAgent, input, options) => {
    const initialInput = await options.sessionInputCallback(
      await session.getItems(),
      [{ role: 'user', content: input } as AgentInputItem],
    );
    const filtered = await options.callModelInputFilter({
      modelData: { input: initialInput, instructions: runtimeAgent.instructions },
    });
    instructions = filtered.instructions ?? '';
    modelInput = filtered.input;
    return {};
  };

  try {
    await agent.stream('好');
    const serialized = JSON.stringify(modelInput);
    assert.match(instructions, /old question 1/);
    assert.doesNotMatch(serialized, /历史背景数据|较早会话的机械摘要|old question 1/);
    assert.deepEqual(modelInput.slice(-2), [
      { role: 'assistant', content: '需要我帮你查一下路线或天气吗？' },
      { role: 'user', content: '好' },
    ]);
    assert.equal(
      (await session.getItems()).some((item) => JSON.stringify(item).includes('历史背景数据')),
      false,
    );
    assert.deepEqual(await session.getItems(), canonicalItems);
    await agent.failRun(new Error('test cleanup'), true);
  } finally {
    await agent.close();
    if (previousSession === undefined) delete process.env.AGENT_SESSION;
    else process.env.AGENT_SESSION = previousSession;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('removes archive messages persisted by affected versions without deleting real turns', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-context-cleanup-'));
  const session = new FileSession(root, 'cleanup');
  const realItems = [
    { role: 'assistant', content: '需要我帮你查天气吗？' },
    { role: 'user', content: '好' },
  ] as AgentInputItem[];
  await session.addItems([
    { role: 'user', content: '[更早的会话历史已压缩为摘要，共 2 条]\nlegacy' },
    realItems[0]!,
    { role: 'user', content: `${LEGACY_ARCHIVE_PREFIX}\nlegacy archive` },
    realItems[1]!,
  ] as AgentInputItem[]);
  await session.setContextArchive({
    coveredItems: 2,
    summary: 'stale archive',
    strategy: 'collapse',
    originalTokens: 10,
    compactedTokens: 3,
    updatedAt: new Date().toISOString(),
  });

  assert.equal(await session.cleanupGeneratedSummaries(), 2);
  assert.deepEqual(await session.getItems(), realItems);
  assert.equal(await session.getContextArchive(), undefined);
});

test('short confirmations resolve against the immediately preceding assistant proposal', () => {
  assert.match(BASE_INSTRUCTIONS, /短回复必须结合紧邻的 assistant 提问或提议解释/);
  assert.match(BASE_INSTRUCTIONS, /明确待执行动作，就视为同意并继续/);
});

test('explicit owner tool and data-source choices cannot be silently substituted', () => {
  assert.match(BASE_INSTRUCTIONS, /明确指定工具、命令、数据源或目标系统/);
  assert.match(BASE_INSTRUCTIONS, /硬边界/);
  assert.match(BASE_INSTRUCTIONS, /不得静默换路/);
});

test('memory recall reformulates irrelevant results before guessing', () => {
  assert.match(BASE_INSTRUCTIONS, /结果为空或明显不相关/);
  assert.match(BASE_INSTRUCTIONS, /空结果只表示当前查询未命中/);
  assert.match(BASE_INSTRUCTIONS, /order=recent/);
  assert.match(BASE_INSTRUCTIONS, /全称、缩写、别名、URL、产品名或任务对象/);
  assert.match(BASE_INSTRUCTIONS, /最多再检索两次/);
  assert.match(BASE_INSTRUCTIONS, /不能先猜域名、路径或联系方式/);
});

test('runtime state claims require same-turn tool evidence', () => {
  assert.match(BASE_INSTRUCTIONS, /当前运行状态、后台任务、Plan、Goal 或 Session/);
  assert.match(BASE_INSTRUCTIONS, /必须先调用对应的只读状态工具/);
  assert.match(BASE_INSTRUCTIONS, /不得声称“已核对”或断言状态不存在/);
});
