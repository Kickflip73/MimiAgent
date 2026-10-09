import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MimiAgent } from '../src/runtime/mimi-agent.js';
import { AgentRunService } from '../src/runtime/run-service.js';

function fakeAgent(sensitive = false, fail = false) {
  const recorded: { type: string; data: Record<string, unknown>; owner?: string }[] = [];
  const agent = {
    activeRunId: 'run-fixture', activeRunHasEphemeralSensitiveAccess: sensitive,
    onRuntimeEvent: () => () => undefined,
    stream: async () => ({ rawResponses: [], runContext: { usage: {} }, finalOutput: 'done', completed: Promise.resolve(), cancelled: false, interruptions: [],
      async *[Symbol.asyncIterator]() {
        for (const delta of ['check ', 'evidence']) yield { type: 'raw_model_stream_event', data: { type: 'model', event: { choices: [{ delta: { reasoning_content: delta } }] } } };
        if (fail) throw new Error('cancelled fixture');
        yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'done' } };
      } }),
    recordEvent: async (type: string, data: Record<string, unknown>, owner?: string) => { recorded.push({ type, data, owner }); },
    completeRun: async (answer: string) => ({ answer, effects: [] }),
    failRun: async () => undefined,
  } as unknown as MimiAgent;
  return { agent, recorded };
}

test('reasoning deltas persist once per phase with immutable owner and real observed times', async () => {
  const { agent, recorded } = fakeAgent();
  await new AgentRunService(agent).execute({ input: 'work' });
  assert.equal(recorded.length, 1); assert.equal(recorded[0]!.type, 'reasoning');
  assert.equal(recorded[0]!.data.text, 'check evidence'); assert.equal(recorded[0]!.owner, 'run-fixture');
  assert.ok(Date.parse(String(recorded[0]!.data.startedAt)) <= Date.parse(String(recorded[0]!.data.endedAt)));
});

test('reasoning flushes on interrupted stream but sensitive model text is never persisted', async () => {
  const failed = fakeAgent(false, true);
  await assert.rejects(new AgentRunService(failed.agent).execute({ input: 'work' }), /cancelled fixture/);
  assert.equal(failed.recorded[0]!.data.text, 'check evidence');
  const sensitive = fakeAgent(true);
  await new AgentRunService(sensitive.agent).execute({ input: 'work' });
  assert.deepEqual(sensitive.recorded, []);
});
