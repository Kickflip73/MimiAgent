import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MimiAgent } from '../src/runtime/mimi-agent.js';
import { isTerminalRunInterruption, TerminalRunInterruptedError } from '../src/runtime/run-outcome.js';
import {
  AgentRunService,
  providerBackupRouteFromEnvironment,
} from '../src/runtime/run-service.js';
import { ProviderCircuitBreaker } from '../src/runtime/provider-reliability.js';

test('shared run service owns completion, usage and observer isolation', async () => {
  let completedAnswer = '';
  let stopped = false;
  const stream = {
    rawResponses: [{ usage: { inputTokens: 11, outputTokens: 7 } }],
    runContext: { usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } },
    finalOutput: 'durable answer',
    completed: Promise.resolve(),
    cancelled: false,
    interruptions: [],
    async *[Symbol.asyncIterator]() { /* no streamed deltas */ },
  };
  const agent = {
    onRuntimeEvent: () => () => { stopped = true; },
    stream: async () => stream,
    recordEvent: async () => undefined,
    completeRun: async (answer: string) => { completedAnswer = answer; return []; },
    failRun: async () => assert.fail('successful run must not fail'),
  } as unknown as MimiAgent;
  const result = await new AgentRunService(agent).execute({ input: 'work' }, {
    onComplete: () => { throw new Error('presentation failed'); },
  });
  assert.equal(result.answer, 'durable answer');
  assert.equal(completedAnswer, 'durable answer');
  assert.deepEqual(result.usage, {
    lastRequestInputTokens: 11,
    lastRequestOutputTokens: 7,
    runInputTokens: 12,
    runOutputTokens: 8,
    runTotalTokens: 20,
  });
  assert.equal(stopped, true);
});

test('shared run service streams visible deltas and records bounded progress events', async () => {
  const events = [
    { type: 'agent_updated_stream_event', agent: { name: 'Mimi' } },
    {
      type: 'run_item_stream_event',
      name: 'tool_called',
      item: { rawItem: { name: 'read_file', arguments: '{"path":"README.md"}' } },
    },
    {
      type: 'run_item_stream_event',
      name: 'tool_output',
      item: { rawItem: { name: 'read_file' } },
    },
    { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: 'done' } },
  ];
  const progress: unknown[] = [];
  const observed: unknown[] = [];
  const stream = {
    rawResponses: [],
    runContext: { usage: {} },
    finalOutput: undefined,
    completed: Promise.resolve(),
    cancelled: false,
    interruptions: [],
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
  const agent = {
    onRuntimeEvent: () => () => undefined,
    stream: async () => stream,
    recordEvent: async (_type: string, event: unknown) => { progress.push(event); },
    completeRun: async () => [],
    failRun: async () => assert.fail('visible stream must complete'),
  } as unknown as MimiAgent;

  const result = await new AgentRunService(agent).execute({ input: 'work' }, {
    onStreamEvent: (event) => { observed.push(event); },
  });
  assert.equal(result.answer, 'done');
  assert.equal(observed.length, 4);
  assert.deepEqual(progress, [
    { kind: 'status', tone: 'agent', title: 'Mimi', next: 'Agent 工作中' },
    {
      kind: 'status',
      tone: 'tool',
      title: 'read_file',
      detail: '{"path":"README.md"}',
      next: '正在执行 read_file',
    },
    { kind: 'status', tone: 'success', title: 'read_file', next: '模型继续思考' },
  ]);
});

test('shared run service does not reinterpret model answers with keyword heuristics', async () => {
  const stream = {
    rawResponses: [],
    runContext: { usage: {} },
    finalOutput: 'socket 还没有连上。先试试直接用现有 daemon 调用。',
    completed: Promise.resolve(),
    cancelled: false,
    interruptions: [],
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'run_item_stream_event',
        name: 'tool_output',
        item: { rawItem: { name: 'run_shell' } },
      };
    },
  };
  let completed = false;
  let failed = false;
  const agent = {
    onRuntimeEvent: () => () => undefined,
    stream: async () => stream,
    recordEvent: async () => undefined,
    completeRun: async () => { completed = true; return []; },
    failRun: async () => { failed = true; },
  } as unknown as MimiAgent;

  const result = await new AgentRunService(agent).execute({ input: '查看大象待处理消息' });
  assert.equal(result.answer, 'socket 还没有连上。先试试直接用现有 daemon 调用。');
  assert.equal(completed, true);
  assert.equal(failed, false);
});

test('ephemeral sensitive Runs suppress text streaming and redact final output and tool telemetry', async () => {
  const secret = ['sk', 'RunServiceEphemeralFixture123456'].join('-');
  const redact = (value: string) => value.split(secret).join('[REDACTED:ephemeral-secret]');
  const events = [
    {
      type: 'run_item_stream_event',
      name: 'tool_called',
      item: { rawItem: { name: 'run_shell', arguments: `{"command":"${secret}"}` } },
    },
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'model',
        event: {
          choices: [{ delta: { reasoning_content: secret.slice(0, 12) } }],
        },
      },
    },
    {
      type: 'raw_model_stream_event',
      data: {
        type: 'model',
        event: {
          choices: [{ delta: { reasoning_content: secret.slice(12) } }],
        },
      },
    },
    { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: secret } },
  ];
  const stream = {
    rawResponses: [],
    runContext: { usage: {} },
    finalOutput: `validated ${secret}`,
    completed: Promise.resolve(),
    cancelled: false,
    interruptions: [],
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
  const observed: unknown[] = [];
  const progress: unknown[] = [];
  let completed = '';
  const agent = {
    activeRunHasEphemeralSensitiveAccess: true,
    onRuntimeEvent: () => () => undefined,
    stream: async () => stream,
    redactActiveRunText: redact,
    redactActiveRunData: <T>(value: T): T =>
      JSON.parse(redact(JSON.stringify(value))) as T,
    redactActiveRunError: (error: unknown) =>
      new Error(redact(error instanceof Error ? error.message : String(error))),
    recordEvent: async (_type: string, event: unknown) => { progress.push(event); },
    completeRun: async (answer: string) => { completed = answer; return []; },
    failRun: async () => assert.fail('sensitive output run must complete'),
  } as unknown as MimiAgent;

  const result = await new AgentRunService(agent).execute({ input: 'redacted durable input' }, {
    onStreamEvent: (event) => { observed.push(event); },
  });
  assert.equal(result.answer, 'validated [REDACTED:ephemeral-secret]');
  assert.equal(completed, result.answer);
  assert.equal(observed.length, 1);
  assert.doesNotMatch(JSON.stringify(observed), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(progress), new RegExp(secret));
});

test('Provider failures in an ephemeral sensitive Run are redacted before failure persistence', async () => {
  const secret = ['sk', 'ProviderFailureFixture123456'].join('-');
  const stream = {
    rawResponses: [],
    runContext: { usage: {} },
    finalOutput: undefined,
    completed: Promise.resolve(),
    cancelled: false,
    interruptions: [],
    async *[Symbol.asyncIterator]() {
      throw Object.assign(new Error(`provider rejected ${secret}`), { status: 503 });
    },
  };
  let failed: unknown;
  let observed: unknown;
  const agent = {
    activeRunHasEphemeralSensitiveAccess: true,
    onRuntimeEvent: () => () => undefined,
    stream: async () => stream,
    redactActiveRunText: (value: string) =>
      value.split(secret).join('[REDACTED:ephemeral-secret]'),
    redactActiveRunData: <T>(value: T): T => value,
    redactActiveRunError: (error: unknown) => new Error(
      (error instanceof Error ? error.message : String(error))
        .split(secret).join('[REDACTED:ephemeral-secret]'),
    ),
    failRun: async (error: unknown) => { failed = error; },
  } as unknown as MimiAgent;

  await assert.rejects(
    new AgentRunService(agent).execute({ input: 'redacted durable input' }, {
      onError: (error) => { observed = error; },
    }),
    (error: Error) => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.match(error.message, /REDACTED:ephemeral-secret/);
      return true;
    },
  );
  assert.doesNotMatch(String(failed), new RegExp(secret));
  assert.doesNotMatch(String(observed), new RegExp(secret));
});

test('shared run service records one failed terminal outcome', async () => {
  const failure = new Error('provider unavailable');
  let failed: unknown;
  const agent = {
    onRuntimeEvent: () => () => undefined,
    stream: async () => { throw failure; },
    failRun: async (error: unknown) => { failed = error; },
  } as unknown as MimiAgent;
  await assert.rejects(new AgentRunService(agent).execute({ input: 'work' }), /provider unavailable/);
  assert.equal(failed, failure);
});

test('shared run service opens Provider circuit on 429 and blocks retry storms', async () => {
  const breaker = new ProviderCircuitBreaker({ failureThreshold: 1, openMs: 60_000 });
  let attempts = 0;
  const agent = {
    onRuntimeEvent: () => () => undefined,
    stream: async () => {
      attempts += 1;
      throw Object.assign(new Error('rate limited'), { status: 429 });
    },
    failRun: async () => [],
  } as never;
  const service = new AgentRunService(agent, {
    providerId: 'fixture-provider',
    providerReliability: breaker,
  });
  await assert.rejects(service.execute({ input: 'work' }), /rate limited/);
  await assert.rejects(service.execute({ input: 'work' }), /熔断中/);
  assert.equal(attempts, 1);
  assert.equal(service.providerHealth().state, 'open');
});

test('shared run service uses one configured backup only before a stream starts', async () => {
  const attempts: string[] = [];
  let failed = false;
  const completed: string[] = [];
  const backupStream = {
    rawResponses: [],
    runContext: { usage: {} },
    finalOutput: 'backup answer',
    completed: Promise.resolve(),
    cancelled: false,
    interruptions: [],
    async *[Symbol.asyncIterator]() { /* no events */ },
  };
  const agent = {
    onRuntimeEvent: () => () => undefined,
    stream: async (_input: unknown, _signal: unknown, options: {
      providerRoute?: { provider: string };
    } | undefined) => {
      const provider = options?.providerRoute?.provider ?? 'openai';
      attempts.push(provider);
      if (provider === 'openai') {
        throw Object.assign(new Error('primary rate limited'), { status: 429 });
      }
      return backupStream;
    },
    recordEvent: async () => undefined,
    completeRun: async (answer: string) => {
      completed.push(answer);
      return [];
    },
    failRun: async () => { failed = true; },
  } as unknown as MimiAgent;
  const service = new AgentRunService(agent, {
    providerId: 'openai',
    backupProvider: { id: 'deepseek:backup', provider: 'deepseek' },
  });
  const result = await service.execute({ input: 'work' });
  assert.equal(result.answer, 'backup answer');
  assert.deepEqual(attempts, ['openai', 'deepseek']);
  assert.deepEqual(completed, ['backup answer']);
  assert.equal(failed, false);
  assert.equal(service.providerHealth().state, 'open');
  assert.deepEqual(
    service.providerHealthRoutes().map((health) => [health.provider, health.state]),
    [['openai', 'open'], ['deepseek:backup', 'closed']],
  );
});

test('shared run service never switches Provider after the stream handle exists', async () => {
  let attempts = 0;
  let failures = 0;
  const stream = {
    rawResponses: [],
    runContext: { usage: {} },
    finalOutput: undefined,
    completed: Promise.resolve(),
    cancelled: false,
    interruptions: [],
    async *[Symbol.asyncIterator]() {
      throw Object.assign(new Error('network after streaming began'), { code: 'ECONNRESET' });
    },
  };
  const agent = {
    onRuntimeEvent: () => () => undefined,
    stream: async () => {
      attempts += 1;
      return stream;
    },
    failRun: async () => { failures += 1; },
  } as unknown as MimiAgent;
  await assert.rejects(new AgentRunService(agent, {
    providerId: 'openai',
    backupProvider: { id: 'deepseek:backup', provider: 'deepseek' },
  }).execute({ input: 'work' }), /network after streaming began/);
  assert.equal(attempts, 1);
  assert.equal(failures, 1);
});

test('Provider success is recorded only after the acquired stream finishes normally', async () => {
  const breaker = new ProviderCircuitBreaker({ failureThreshold: 2, openMs: 60_000 });
  breaker.acquire('openai');
  breaker.failure('openai', Object.assign(new Error('first server failure'), { status: 503 }));
  const stream = {
    rawResponses: [],
    runContext: { usage: {} },
    finalOutput: undefined,
    completed: Promise.resolve(),
    cancelled: false,
    interruptions: [],
    async *[Symbol.asyncIterator]() {
      throw Object.assign(new Error('second server failure after handle'), { status: 503 });
    },
  };
  const agent = {
    onRuntimeEvent: () => () => undefined,
    stream: async () => stream,
    failRun: async () => undefined,
  } as unknown as MimiAgent;
  const service = new AgentRunService(agent, {
    providerId: 'openai',
    providerReliability: breaker,
  });

  await assert.rejects(service.execute({ input: 'work' }), /second server failure/);
  assert.equal(service.providerHealth().state, 'open');
  assert.equal(service.providerHealth().failures, 2);
});

test('production backup route configuration is exact and requires its own credential', () => {
  assert.equal(providerBackupRouteFromEnvironment('openai', {}), undefined);
  assert.deepEqual(providerBackupRouteFromEnvironment('openai', {
    MIMI_BACKUP_PROVIDER: 'deepseek',
    MIMI_BACKUP_MODEL: 'deepseek-v4-flash',
    DEEPSEEK_API_KEY: 'fixture-backup-key',
  }), {
    id: 'deepseek:deepseek-v4-flash',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
  });
  assert.throws(
    () => providerBackupRouteFromEnvironment('openai', {
      MIMI_BACKUP_PROVIDER: 'openai',
      OPENAI_API_KEY: 'fixture-key',
    }),
    /必须不同/,
  );
  assert.throws(
    () => providerBackupRouteFromEnvironment('openai', {
      MIMI_BACKUP_PROVIDER: 'deepseek',
    }),
    /DEEPSEEK_API_KEY/,
  );
  assert.throws(
    () => providerBackupRouteFromEnvironment('openai', {
      MIMI_BACKUP_PROVIDER: 'other',
    }),
    /只能是 openai 或 deepseek/,
  );
  assert.throws(
    () => providerBackupRouteFromEnvironment('openai', {
      MIMI_BACKUP_PROVIDER: 'deepseek',
      DEEPSEEK_API_KEY: 'fixture-backup-key',
      MIMI_BACKUP_MODEL: 'invalid model name',
    }),
    /MIMI_BACKUP_MODEL 格式无效/,
  );
  assert.deepEqual(providerBackupRouteFromEnvironment('deepseek', {
    MIMI_BACKUP_PROVIDER: 'openai',
    OPENAI_API_KEY: 'fixture-openai-key',
  }), {
    id: 'openai:default',
    provider: 'openai',
  });
  assert.deepEqual(providerBackupRouteFromEnvironment('openai-compatible', {
    MIMI_BACKUP_PROVIDER: 'openai',
    OPENAI_API_KEY: 'fixture-openai-key',
  }), {
    id: 'openai:default',
    provider: 'openai',
  });
});

test('shared run service preserves a terminal signal when the SDK throws a generic abort error', async () => {
  const controller = new AbortController();
  controller.abort(new TerminalRunInterruptedError('owner cancelled'));
  let failed: unknown;
  let interrupted = false;
  const agent = {
    onRuntimeEvent: () => () => undefined,
    stream: async () => { throw new Error('AbortError'); },
    failRun: async (error: unknown, wasInterrupted: boolean) => {
      failed = error;
      interrupted = wasInterrupted;
    },
  } as unknown as MimiAgent;

  await assert.rejects(
    new AgentRunService(agent).execute({ input: 'work', signal: controller.signal }),
    /AbortError/,
  );
  assert.equal(interrupted, true);
  assert.equal(isTerminalRunInterruption(failed), true);
});

test('shared run service commits visible interrupted output for Session continuity', async () => {
  const controller = new AbortController();
  const cancellation = new TerminalRunInterruptedError('owner cancelled');
  let interruptedAnswer: string | undefined;
  const stream = {
    rawResponses: [],
    runContext: { usage: {} },
    finalOutput: undefined,
    completed: Promise.resolve(),
    cancelled: false,
    interruptions: [],
    async *[Symbol.asyncIterator]() {
      yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: '已经核查到一半' } };
      controller.abort(cancellation);
      throw new Error('AbortError');
    },
  };
  const agent = {
    onRuntimeEvent: () => () => undefined,
    stream: async () => stream,
    recordEvent: async () => undefined,
    failRun: async (
      _error: unknown,
      _interrupted: boolean,
      _usage: unknown,
      visibleAnswer?: string,
    ) => {
      interruptedAnswer = visibleAnswer;
    },
  } as unknown as MimiAgent;

  await assert.rejects(
    new AgentRunService(agent).execute({ input: '继续核查', signal: controller.signal }),
    /AbortError/,
  );
  assert.equal(interruptedAnswer, '已经核查到一半');
});

test('an unfinished Goal completes the Event once with the Host-committed safe answer', async () => {
  const safeAnswer = '长期 Goal 尚未通过验收，已保留当前 Goal 和检查点，不会从头自动重跑。';
  let committedAnswer: string | undefined;
  let failed = false;
  const stream = {
    rawResponses: [],
    runContext: { usage: {} },
    finalOutput: '已经发送成功',
    completed: Promise.resolve(),
    cancelled: false,
    interruptions: [],
    async *[Symbol.asyncIterator]() {
      yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: '已经发送成功' } };
    },
  };
  const streamed: unknown[] = [];
  const agent = {
    completionGateRequired: true,
    onRuntimeEvent: () => () => undefined,
    stream: async () => stream,
    recordEvent: async () => undefined,
    completeRun: async () => { committedAnswer = safeAnswer; return []; },
    get completedRunAnswer() { return committedAnswer; },
    failRun: async () => { failed = true; },
  } as unknown as MimiAgent;

  const result = await new AgentRunService(agent).execute({ input: '继续 Goal' }, {
    onStreamEvent: (event) => { streamed.push(event); },
  });
  assert.equal(result.answer, safeAnswer);
  assert.equal(failed, false);
  assert.deepEqual(streamed, []);
});
