import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Usage, type AgentInputItem, type Model } from '@openai/agents';
import { ContextManager, ContextProtocolBudgetError, estimateTokens, type ContextSemanticSummarizer, type ContextSemanticSummaryRequest } from '../src/core/context.js';
import { contextArtifactPage } from '../src/core/context-artifact.js';
import { FileSession } from '../src/core/session.js';
import { ModelContextSemanticSummarizer } from '../src/runtime/context-semantic-summarizer.js';

const batch = (id: number, output: unknown): AgentInputItem[] => [
  { type: 'function_call', callId: `c-${id}`, name: 'read_file', arguments: '{}' },
  { type: 'function_call_result', callId: `c-${id}`, output },
] as AgentInputItem[];
const emptySnapshot = { goal: [], progress: [], completed: [], decisions: [], constraints: [], openQuestions: [], evidence: [], keyFacts: [], references: [] };

test('first result above the old 8k threshold preserves arbitrary facts and exact dotted paths', () => {
  const output = `HEAD /tmp/v1.4.2/.config\n${'x'.repeat(18000)}\nMIDDLE=7600\n${'y'.repeat(18000)}\nTAIL=1.5%`;
  const input = [{ role: 'user', content: 'Analyze this' }, ...batch(1, output)] as AgentInputItem[];
  assert.ok(estimateTokens(output) > 8000);
  const view = new ContextManager().modelContextView(input, '', 100_000);
  assert.deepEqual(view.input, input);
});

test('huge original output round trips every character through bounded pages; new pages survive model projection', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-page-')); t.after(() => rm(root, { recursive: true, force: true }));
  const session = new FileSession(root, 'pages'); const run = await session.beginRun('inspect', 'run-pages');
  const source = JSON.stringify({ path: '/tmp/v1.4.2/.config', head: 'FIRST', body: '数据🙂'.repeat(30000), tail: 'TAIL=7600' });
  const input = [{ role: 'user', content: 'inspect' }, ...batch(1, source)] as AgentInputItem[];
  await session.addItems(input);
  const artifacts = await session.registerContextToolArtifacts(input, run.runId);
  assert.equal(artifacts[0]!.toolName, 'read_file'); // SDK outputs need not repeat the tool name.
  const manager = new ContextManager(100, 1_048_576);
  const view = manager.modelContextView(input, '', 900_000, { toolArtifacts: artifacts });
  const preview = JSON.parse((view.input[2] as { output: string }).output);
  assert.equal(preview.truncated, true); assert.equal(preview.ref, artifacts[0]!.ref);
  assert.ok(!view.consumedArtifactRefs.includes(artifacts[0]!.ref));
  let offset = 0, reconstructed = '';
  while (offset < source.length) {
    const page = await session.readContextToolArtifact(artifacts[0]!.ref, run.runId, [], { offset, limit: 24000 });
    if (page.mimiStatus) assert.fail(page.message);
    assert.ok(String(page.output).length <= 24000);
    const pageInput = [...input, { type: 'function_call', callId: 'page', name: 'read_context_artifact', arguments: '{}' },
      { type: 'function_call_result', callId: 'page', output: JSON.stringify(page) }] as AgentInputItem[];
    const pageArtifacts = await session.registerContextToolArtifacts(pageInput, run.runId);
    const pageView = manager.modelContextView(pageInput, '', 25_000, { toolArtifacts: pageArtifacts });
    assert.deepEqual(pageView.input.at(-1), pageInput.at(-1));
    reconstructed += String(page.output); offset = page.nextOffset ?? source.length;
  }
  assert.equal(reconstructed, source);
  assert.deepEqual(await session.getItems(), input);
});

test('oversize results without a readable artifact fail closed instead of silently losing content', () => {
  const input = [{ role: 'user', content: 'read' }, ...batch(1, 'secret fact\n' + 'x'.repeat(40000))] as AgentInputItem[];
  assert.throws(() => new ContextManager().modelContextView(input, '', 2000), ContextProtocolBudgetError);
});

test('paging validates limits, preserves exact JSON and makes progress across surrogate pairs', () => {
  assert.throws(() => contextArtifactPage('x', -1), RangeError);
  assert.throws(() => contextArtifactPage('x', 0, 24001), RangeError);
  assert.throws(() => contextArtifactPage('x', 0, 0), RangeError);
  assert.deepEqual(contextArtifactPage({ count: 1 }).output, { count: 1 });
  assert.equal(contextArtifactPage('🙂x', 0, 1).nextOffset, 2);
  assert.equal(contextArtifactPage('🙂x', 2, 1).output, 'x');
});

test('one user long task compacts completed parallel batches, retains latest evidence and user constraints', async () => {
  const manager = new ContextManager(200, 1_048_576);
  const user = { role: 'user', content: 'Budget 7600; no automatic playback; never replay uncertain effects.' } as AgentInputItem;
  const input = [user];
  for (let i = 0; i < 12; i++) {
    input.push(...batch(i, JSON.stringify({ index: i, effect: i === 0 ? 'uncertain' : 'read', body: 'x'.repeat(20000) })));
  }
  const original = JSON.stringify(input);
  const requests: ContextSemanticSummaryRequest[] = [];
  const summarizer: ContextSemanticSummarizer = { summarize: async (request) => {
    requests.push(request); return { ...emptySnapshot, completed: ['Evidence read'], constraints: ['Never replay uncertain effects'], keyFacts: ['Budget 7600'] };
  } };
  const snapshot = await manager.prepareSemanticSnapshot(input, summarizer);
  assert.equal(snapshot.coveredItems, 19); // user + 9 complete tool batches
  assert.ok(requests[0]!.input.length > 0);
  const view = manager.modelContextView(input, '', 900000, { semanticSnapshot: snapshot, workingSetBudgetTokens: 64000 });
  assert.ok(view.records.some((record) => record.strategy === 'semantic-summary'));
  assert.deepEqual(view.input[0], user);
  assert.deepEqual(view.input.slice(1), input.slice(19));
  assert.match(view.instructions!, /uncertain/);
  assert.equal(JSON.stringify(input), original);
  const persisted = { ...snapshot, runId: 'run', updatedAt: new Date(0).toISOString() };
  const next = [...input, ...batch(12, 'next evidence')];
  await manager.prepareSemanticSnapshot(next, summarizer, { persistedSnapshot: persisted });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]!.input, input.slice(19, 21)); // incremental, not the whole prefix again
  assert.equal(requests[1]!.previous?.coveredItems, 19);
  const followup = [...input, { role: 'user', content: 'Now summarize the result' }] as AgentInputItem[];
  const nextView = manager.modelContextView(followup, '', 900000, { persistedSnapshot: persisted, workingSetBudgetTokens: 64000 });
  assert.equal(nextView.snapshot?.coveredItems, snapshot.coveredItems);
  assert.deepEqual(nextView.input.at(-1), followup.at(-1));
});

test('pending parallel calls are never split by the semantic prefix', async () => {
  const manager = new ContextManager();
  const input = [{ role: 'user', content: 'do work' }] as AgentInputItem[];
  for (let i = 0; i < 6; i++) {
    const left = batch(i * 2, `result ${i}-left`), right = batch(i * 2 + 1, `result ${i}-right`);
    input.push(left[0]!, right[0]!, left[1]!, right[1]!);
  }
  input.push({ type: 'function_call', name: 'read_file', callId: 'pending', arguments: '{}' } as AgentInputItem);
  const snapshot = await manager.prepareSemanticSnapshot(input, { summarize: async () => emptySnapshot });
  const tail = input.slice(snapshot.coveredItems);
  assert.equal((tail.at(-1) as { callId: string }).callId, 'pending');
  assert.equal(snapshot.coveredItems, 13); // three complete pairs of parallel calls
  let calls = 0;
  await manager.prepareSemanticSnapshot([{ role: 'user', content: 'short' }], { summarize: async () => { calls++; return emptySnapshot; } });
  assert.equal(calls, 0);
});

test('semantic model receives run cancellation and a bounded timeout signal', async () => {
  const abort = new AbortController();
  const model = { getResponse: async (request: { signal: AbortSignal }) => {
    assert.ok(request.signal); abort.abort(new Error('stop fixture')); request.signal.throwIfAborted();
  } } as unknown as Model;
  await assert.rejects(new ModelContextSemanticSummarizer(model).summarize({
    input: [], seed: {}, maxSnapshotTokens: 2000, signal: abort.signal,
  }), /stop fixture/);
});

test('a digest-valid snapshot cannot split a tool call from its result', async () => {
  const manager = new ContextManager(100, 1_048_576);
  const input = [{ role: 'user', content: 'work' }] as AgentInputItem[];
  for (let i = 0; i < 8; i++) input.push(...batch(i, 'x'.repeat(32000)));
  const invalid = { ...emptySnapshot, coveredItems: 2,
    sourceDigest: `sha256:${createHash('sha256').update(JSON.stringify(input.slice(0, 2))).digest('hex')}`,
    runId: 'run', updatedAt: new Date(0).toISOString() };
  const view = manager.modelContextView(input, '', 900000, { persistedSnapshot: invalid, workingSetBudgetTokens: 64000 });
  assert.equal(view.snapshot, undefined);
  assert.deepEqual(view.input, input);
  let previous: unknown = 'not-called';
  await manager.prepareSemanticSnapshot(input, { summarize: async (request) => { previous = request.previous; return emptySnapshot; } }, { persistedSnapshot: invalid });
  assert.equal(previous, undefined);
});

test('a failed semantic summary does not block every third tool round again', async (t) => {
  const { MimiAgent } = await import('../src/agent.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-summary-breaker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let attempts = 0;
  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: root, dataRoot: path.join(root, '.mimi-agent'),
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    contextWindow: 1_048_576, historyLimit: 100, maxTurns: null,
  }, 'summary-breaker', { contextSemanticSummarizer: { summarize: async () => {
    attempts++; throw new Error('summary deadline exceeded');
  } } });
  t.after(() => agent.close());
  const host = agent as unknown as { runner: { run: (...args: any[]) => Promise<unknown> } };
  const input = [{role:'user',content:'保留原始任务和所有证据'}] as AgentInputItem[];
  for(let i=0;i<8;i++) input.push(...batch(i,'x'.repeat(32_000)));
  host.runner.run = async (_runtime, _input, options) => {
    await options.session.addItems(input);
    for(let i=0;i<10;i++) {
      const view = await options.callModelInputFilter({modelData:{input,instructions:''}});
      assert.equal(createHash('sha256').update(JSON.stringify(view.input.filter((item: { role?: string }) => item.role !== 'system'))).digest('hex'),
        createHash('sha256').update(JSON.stringify(input)).digest('hex')); // Derived turn boundary is not canonical evidence.
    }
    return {};
  };
  for (let turn = 1; turn <= 2; turn++) {
    await agent.stream('保留原始任务和所有证据');
    await agent.failRun(new Error('fixture cleanup'), true);
    assert.equal(attempts, turn); // A new run can retry; the failed run cannot retry-storm.
  }
});


test('semantic extraction disables deliberation, bounds output and preserves structured facts', async () => {
  const snapshot = { ...emptySnapshot, constraints: ['Never replay uncertain writes'], keyFacts: ['Limit=7600'], references: ['artifact://a'] };
  const model = { getResponse: async (request: any) => {
    assert.deepEqual(request.modelSettings, { maxTokens: 3000, reasoning: { effort: 'none' } });
    assert.deepEqual(request.tools, []);
    return { usage: new Usage({ requests: 1 }), output: [{ content: [{ type: 'output_text', text: JSON.stringify(snapshot) }] }] };
  } } as unknown as Model;
  const summarizer = new ModelContextSemanticSummarizer(model);
  assert.deepEqual(await summarizer.summarize({ input: [], seed: {}, maxSnapshotTokens: 6000 }), snapshot);
  assert.equal(summarizer.drainUsages().length, 1);
  assert.equal(summarizer.drainUsages().length, 0);
});

test('Host cancellation finishes semantic extraction even when the provider ignores its signal', async () => {
  const abort = new AbortController();
  let finish!: (value: unknown) => void;
  const model = { getResponse: () => new Promise((resolve) => { finish = resolve; }) } as unknown as Model;
  const summarizer = new ModelContextSemanticSummarizer(model);
  const pending = summarizer.summarize({ input: [], seed: {}, maxSnapshotTokens: 2000, signal: abort.signal });
  abort.abort(new Error('stop uncooperative provider'));
  await assert.rejects(pending, /stop uncooperative provider/);
  finish({ usage: new Usage({ requests: 1 }), output: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(summarizer.drainUsages(), []); // A late response cannot become the next run's snapshot/usage.
});

test('a failed semantic request still counts against the configured model-call limit', async (t) => {
  const { MimiAgent } = await import('../src/agent.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-summary-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let attempts = 0;
  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: root, dataRoot: path.join(root, '.mimi-agent'),
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    contextWindow: 1_048_576, historyLimit: 100, maxTurns: 1,
  }, 'summary-limit', { contextSemanticSummarizer: { summarize: async () => {
    attempts++; throw new Error('summary deadline exceeded');
  } } });
  t.after(() => agent.close());
  const input = [{ role: 'user', content: 'Keep evidence' }] as AgentInputItem[];
  for (let i = 0; i < 8; i++) input.push(...batch(i, 'x'.repeat(32_000)));
  const host = agent as unknown as { runner: { run: (...args: any[]) => Promise<unknown> }; session: FileSession };
  host.runner.run = async (_runtime, _input, options) => {
    await options.session.addItems(input);
    await options.callModelInputFilter({ modelData: { input, instructions: '' } });
    assert.fail('A failed auxiliary request cannot bypass the operator limit');
  };
  await assert.rejects(agent.stream('Keep evidence'), /达到操作员配置的 1 次模型调用上限/);
  assert.equal(attempts, 1);
  assert.deepEqual(await host.session.getItems(), input);
});

for (const scenario of [
  { name: 'successful semantic preparation does not repeat on each small tool exchange before compaction', outputChars: 8000, instructionTokens: 32000, expected: 1 },
  { name: 'small compressible prefixes do not start an expensive semantic request', outputChars: 300, instructionTokens: 46000, expected: 0 },
]) test(scenario.name, async (t) => {
  const { MimiAgent } = await import('../src/agent.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-summary-growth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let attempts = 0;
  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: root, dataRoot: path.join(root, '.mimi-agent'),
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    contextWindow: 1_048_576, historyLimit: 100, maxTurns: null,
  }, 'summary-growth', { contextSemanticSummarizer: { summarize: async () => {
    attempts++; return { ...emptySnapshot, progress: ['Read-only fixture results recorded'] };
  } } });
  t.after(() => agent.close());
  const input = [{ role: 'user', content: 'Keep evidence' }] as AgentInputItem[];
  for (let i = 0; i < 8; i++) input.push(...batch(i, 'x'.repeat(scenario.outputChars)));
  const instructions = 'i'.repeat(scenario.instructionTokens * 4);
  const host = agent as unknown as { runner: { run: (...args: any[]) => Promise<unknown> } };
  host.runner.run = async (_runtime, _input, options) => {
    await options.session.addItems(input);
    for (let i = 8; i < 16; i++) {
      await options.callModelInputFilter({ modelData: { input, instructions } });
      input.push(...batch(i, 'x'.repeat(300)));
    }
    return {};
  };
  await agent.stream('Keep evidence');
  await agent.failRun(new Error('fixture cleanup'), true);
  assert.equal(attempts, scenario.expected);
});
