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

test('timing records preparation, answer, stream and commit separately on success and failure', async () => {
  for (const fail of [false, true]) {
    const fixture = fakeAgent(false, fail);
    const timings: Record<string, number>[] = [];
    Object.assign(fixture.agent, {
      currentSessionId: 'session-fixture',
      recordRunTiming: async (sessionId: string, runId: string, value: Record<string, number>) => {
        assert.equal(sessionId, 'session-fixture'); assert.equal(runId, 'run-fixture'); timings.push(value);
      },
    });
    const running = new AgentRunService(fixture.agent).execute({input:'fixture'});
    if (fail) await assert.rejects(running); else await running;
    assert.equal(timings.length, 1);
    assert.ok(timings[0]!.prepareMs! >= 0);
    assert.ok(timings[0]!.streamMs! >= 0);
    assert.ok(timings[0]!.commitMs! >= 0);
    assert.ok(timings[0]!.totalMs! >= timings[0]!.prepareMs!);
  }
});


test('preparation failure retains timing identity after pipeline releases active run', async () => {
  const { agent } = fakeAgent();
  let listener: (event: import('../src/runtime/hooks.js').RuntimeEvent) => unknown = () => undefined;
  const timings: unknown[] = [];
  Object.assign(agent, {
    currentSessionId: 'session-fixture',
    onRuntimeEvent: (callback: typeof listener) => { listener = callback; return () => undefined; },
    stream: async () => {
      await listener({type:'run_start',sessionId:'session-fixture',input:'test'});
      Object.assign(agent,{activeRunId:undefined});
      throw new Error('preparation fixture');
    },
    recordRunTiming: async (sessionId: string, runId: string, phases: Record<string,number>) => {
      assert.equal(sessionId,'session-fixture'); assert.equal(runId,'run-fixture');
      assert.ok(phases.prepareMs! >= 0); timings.push(phases);
    },
  });
  await assert.rejects(new AgentRunService(agent).execute({input:'test'}),/preparation fixture/);
  assert.equal(timings.length,1);
});
