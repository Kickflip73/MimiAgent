import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import OpenAI from 'openai';
import { OpenAIChatCompletionsModel } from '@openai/agents-openai';
import { withTrace, type AgentInputItem } from '@openai/agents';
import { FileSession } from '../src/core/session.js';
import { runInputBoundary, sessionWithoutDerivedItems, withRunInputBoundary } from '../src/core/context-turn-boundary.js';
import { normalizeChatCompletionsInput } from '../src/runtime/providers/openai-compatible-model.js';
import { MimiAgent } from '../src/runtime/mimi-agent.js';
import { tool } from '../src/tool-factory.js';
import { z } from 'zod';

test('stopping retains bounded execution facts across restart without making the old task resumable', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-stopped-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = new FileSession(root, 'test');
  await session.beginRun('old task', 'old', undefined, true);
  await session.addItems([{ role: 'user', content: 'old task' }]);
  const manifest = Array.from({ length: 40 }, (_, i) => ({ runId: 'old', toolName: 'run_shell', callId: `call-${i}`, status: 'uncertain' as const, argumentsDigest: 'a'.repeat(64) }));
  await session.rollbackRunItems('old');
  assert.equal(await session.clearRunCheckpoint('stale'), false);
  await session.clearRunCheckpoint('old', { runId: 'old', answerDigest: 'b'.repeat(64), outcome: 'uncertain', evidenceRefs: [], toolManifest: manifest });
  const restarted = new FileSession(root, 'test');
  assert.equal(await restarted.getCheckpoint(), undefined);
  const facts = await restarted.getLastStoppedRun();
  assert.equal(facts?.outcome, 'uncertain');
  assert.equal(facts?.toolManifest.length, 32);
  assert.equal(facts?.omittedTools, 8);
  assert.equal((await restarted.getItems()).length, 1);
  await restarted.addItems([{ role: 'user', content: 'new task' }, { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done' }] }]);
  assert.equal(await restarted.getLastStoppedRun(), undefined); // No indefinite stale injection.
  await restarted.clearSession();
  assert.equal((await restarted.readSnapshot())?.lastStoppedRun, undefined);
});

test('fresh and resumed input have distinct host boundaries and keep call/result pairs intact', () => {
  const input = [{ role: 'user', content: 'old' },
    { type: 'function_call', callId: 'one', name: 'write_file', arguments: '{}' },
    { type: 'function_call_result', callId: 'one', output: 'written' },
    { role: 'user', content: 'new' }] as AgentInputItem[];
  const fresh = withRunInputBoundary(input, runInputBoundary(false));
  assert.deepEqual(fresh.slice(0, 3), input.slice(0, 3));
  assert.equal((fresh[3] as { role: string }).role, 'system');
  assert.equal(fresh[4], input[3]);
  assert.equal(input.length, 4);
  assert.match(JSON.stringify(fresh[3]), /starts a new turn/);
  assert.match(JSON.stringify(runInputBoundary(true)), /explicitly resumes\/retries/);
  assert.doesNotMatch(JSON.stringify(runInputBoundary(true)), /starts a new turn/);
});

test('per-run persistence guard removes cloned/repeated derived records but preserves real user and assistant messages', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-projection-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonical = new FileSession(root, 'guard');
  const boundary = runInputBoundary(false);
  const real = [
    { role: 'user', content: (boundary as { content: string }).content },
    { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'A real answer' }] },
  ] as AgentInputItem[];
  await canonical.addItems([real[1]!]);
  const sdk = sessionWithoutDerivedItems(canonical, [boundary]);
  await sdk.addItems([structuredClone(boundary), real[0]!, structuredClone(boundary)]);
  await sdk.addItems([structuredClone(boundary)]); // Retry/cached projection.
  assert.deepEqual(await sdk.getItems(), [real[1], real[0]]);
  assert.equal(await sdk.getSessionId(), 'guard');
});

test('real Chat Completions SDK request separates stopped user history from the new owner message', async () => {
  let body: { messages: Array<{ role: string; content: unknown }> } | undefined;
  const client = new OpenAI({ apiKey: 'fixture', baseURL: 'http://fixture.invalid/v1', fetch: async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: 'response', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { 'content-type': 'application/json' } });
  } });
  const canonical = [{ role: 'user', content: 'run long task' }, { role: 'user', content: 'only reply OK' }] as AgentInputItem[];
  const model = new OpenAIChatCompletionsModel(client, 'fixture');
  await withTrace('turn-boundary-fixture', () => model.getResponse({ input: normalizeChatCompletionsInput(withRunInputBoundary(canonical, runInputBoundary(false))), modelSettings: {}, tools: [], handoffs: [], outputType: 'text', tracing: false }));
  assert.deepEqual(body?.messages.map(message => message.role), ['user', 'system', 'user']);
  assert.equal(body?.messages[0]?.content, 'run long task');
  assert.equal(body?.messages[2]?.content, 'only reply OK');
  assert.equal(canonical.length, 2);
});

test('full runtime pipeline sends stopped history and new input as separate wire messages', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-turn-wire-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousFetch = globalThis.fetch;
  const previousHome = process.env.HOME;
  const previousKey = process.env.MIMI_PROVIDER_API_KEY;
  process.env.HOME = root;
  process.env.MIMI_PROVIDER_API_KEY = 'fixture';
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'wire-fixture', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-pro', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    if (bodies.length === 1) return new Response(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'fixture_check', arguments: '{}' } }] }, 'tool_calls') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    return new Response(chunk({ role: 'assistant', content: 'QUEUE_OK' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  let agent: MimiAgent | undefined;
  try {
    const dataRoot = path.join(root, 'data');
    const session = new FileSession(path.join(dataRoot, 'sessions'), 'wire');
    await session.addItems([{ role: 'user', content: 'Compute 43*47' }, { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '2021' }] }]);
    await session.beginRun('OLD_STOP: run a long shell task', 'old-run', undefined, true);
    await session.addItems([{ role: 'user', content: 'OLD_STOP: run a long shell task' }]);
    await session.rollbackRunItems('old-run');
    await session.clearRunCheckpoint('old-run', { runId: 'old-run', answerDigest: 'a'.repeat(64), outcome: 'uncertain', evidenceRefs: [], toolManifest: [{ runId: 'old-run', toolName: 'run_shell', callId: 'shell', status: 'started', argumentsDigest: 'b'.repeat(64) }] });
    agent = await MimiAgent.create({ provider: 'openai-compatible', providerBaseUrl: 'http://fixture.invalid/v1', defaultModel: 'deepseek-v4-pro', workspaceRoot: root, dataRoot, skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'), historyLimit: 40, maxTurns: 5 }, 'wire', { enableMcp: false });
    const run = await agent.stream('NEW_QUEUE: only reply QUEUE_OK', undefined, {
      providerRoute: { provider: 'openai-compatible', model: 'deepseek-v4-pro' },
      hostTools: [tool({ name: 'fixture_check', description: 'Isolated test observation.', parameters: z.object({}), execute: async () => 'fixture observation' })],
    });
    for await (const _event of run) { /* Drain the real SDK stream. */ }
    await run.completed;
    assert.equal(bodies.length, 2);
    const messages = bodies[0]!.messages;
    assert.deepEqual(messages.slice(-4).map(message => message.role), ['user', 'assistant', 'system', 'user']);
    assert.equal(messages.at(-4)?.content, 'OLD_STOP: run a long shell task');
    assert.equal(messages.at(-1)?.content, 'NEW_QUEUE: only reply QUEUE_OK');
    assert.match(String(messages.at(-2)?.content), /preceding run was stopped \(uncertain\)/);
    assert.match(String(messages.at(-2)?.content), /run_shell/);
    // Providers may extract/hoist system messages before converting to their
    // native chat template. The stopped turn must remain structurally closed.
    const withoutSystem = messages.filter(message => message.role !== 'system');
    assert.deepEqual(withoutSystem.slice(-3).map(message => message.role), ['user', 'assistant', 'user']);
    assert.match(JSON.stringify(withoutSystem.at(-2)?.content), /Host execution ended: uncertain/);
    assert.match(JSON.stringify(withoutSystem.at(-2)?.content), /runtime-generated observation, not a model answer/);
    assert.match(JSON.stringify(withoutSystem.at(-2)?.content), /run_shell/);
    const userMessages = messages.filter(message => message.role === 'user');
    assert.equal(userMessages.length, 3);
    assert.ok(userMessages.every(message => !(String(message.content).includes('OLD_STOP') && String(message.content).includes('NEW_QUEUE'))));
    assert.equal(bodies[1]!.messages.filter(message => message.role === 'user' && message.content === 'NEW_QUEUE: only reply QUEUE_OK').length, 1);
    assert.equal(bodies[1]!.messages.filter(message => message.role === 'assistant' && JSON.stringify(message.content).includes('Host execution ended')).length, 1);
    assert.ok((await session.getItems()).every(item => (item as { role?: string }).role !== 'system'));
    assert.doesNotMatch(JSON.stringify(await session.getItems()), /Host execution ended|Host current-turn boundary/);
    assert.deepEqual((await session.getItems()).filter(item => (item as { role?: string }).role === 'user').map(item => (item as { content: unknown }).content), ['Compute 43*47', 'OLD_STOP: run a long shell task', 'NEW_QUEUE: only reply QUEUE_OK']);
    assert.equal((await session.getItems()).filter(item => item.type === 'function_call').length, 1);
    assert.equal((await session.getItems()).filter(item => item.type === 'function_call_result').length, 1);
    await agent.completeRun('QUEUE_OK');
  } finally {
    await agent?.close();
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousKey === undefined) delete process.env.MIMI_PROVIDER_API_KEY; else process.env.MIMI_PROVIDER_API_KEY = previousKey;
  }
});
