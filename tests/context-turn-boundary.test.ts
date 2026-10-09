import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import OpenAI from 'openai';
import { OpenAIChatCompletionsModel } from '@openai/agents-openai';
import { withTrace, type AgentInputItem } from '@openai/agents';
import { FileSession } from '../src/core/session.js';
import { runInputBoundary, withRunInputBoundary } from '../src/core/context-turn-boundary.js';
import { normalizeChatCompletionsInput } from '../src/runtime/providers/openai-compatible-model.js';

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
