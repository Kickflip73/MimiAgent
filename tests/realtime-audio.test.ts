import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ProviderDefinition } from '../src/core/model-routing.js';
import { MimiHost } from '../src/runtime/mimi-host.js';
import { ModelGateway } from '../src/runtime/model-gateway.js';
import { parseModelsConfig } from '../src/runtime/model-config.js';
import {
  RealtimeAudioController,
  type CanonicalRealtimeTurnInput,
} from '../src/runtime/realtime-audio-controller.js';
import {
  REALTIME_PCM16_FORMAT,
  RealtimeAudioTransport,
  RealtimeDeadlineExceededError,
  assertOpenAIRealtimeAudioRoute,
  createOpenAIRealtimeWebSocketClient,
  type BoundRealtimeConnectOptions,
  type RealtimeAudioFailure,
  type RealtimeDeadline,
  type RealtimeDeadlineClock,
  type RealtimePcm16Frame,
  type RealtimePcmSink,
  type RealtimePcmSource,
  type RealtimePortEvent,
  type RealtimeWebSocketClient,
} from '../src/runtime/realtime-audio-transport.js';
import { WorkUnitModelResolver } from '../src/runtime/work-unit-model-resolver.js';

class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

interface ControlledDeadline {
  label: string;
  afterMs: number;
  active: boolean;
  reject: (error: unknown) => void;
}

class ControlledClock implements RealtimeDeadlineClock {
  readonly entries: ControlledDeadline[] = [];

  deadline(label: string, afterMs: number): RealtimeDeadline {
    let reject!: (error: unknown) => void;
    const entry: ControlledDeadline = { label, afterMs, active: true, reject: (error) => reject(error) };
    const expired = new Promise<never>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    this.entries.push(entry);
    return {
      expired,
      cancel: () => {
        entry.active = false;
      },
    };
  }

  expire(label: string): void {
    const entry = this.entries.find((candidate) => candidate.active && candidate.label === label);
    if (!entry) throw new Error(`no active deadline: ${label}`);
    entry.active = false;
    entry.reject(new RealtimeDeadlineExceededError(entry.label, entry.afterMs));
  }

  active(label: string): number {
    return this.entries.filter((entry) => entry.active && entry.label === label).length;
  }
}

class FakeRealtimeClient implements RealtimeWebSocketClient {
  status: RealtimeWebSocketClient['status'] = 'disconnected';
  readonly audio: ArrayBuffer[] = [];
  readonly commits: boolean[] = [];
  readonly events: Array<Parameters<RealtimeWebSocketClient['sendEvent']>[0]> = [];
  readonly connectOptions: BoundRealtimeConnectOptions[] = [];
  readonly listeners = new Set<(event: RealtimePortEvent) => void>();
  closeCalls = 0;
  connectCalls = 0;
  connectBehavior: (() => Promise<void>) | undefined;
  readonly connectStarted = new Deferred<void>();
  readonly closeRequested = new Deferred<void>();

  constructor(private readonly autoDisconnect = true) {}

  async connect(options: BoundRealtimeConnectOptions): Promise<void> {
    this.connectCalls += 1;
    this.connectOptions.push(structuredClone(options));
    this.status = 'connecting';
    this.connectStarted.resolve();
    await this.connectBehavior?.();
    this.status = 'connected';
  }

  sendAudio(audio: ArrayBuffer, options?: { commit?: boolean }): void {
    this.audio.push(audio);
    this.commits.push(options?.commit === true);
  }

  sendEvent(event: Parameters<RealtimeWebSocketClient['sendEvent']>[0]): void {
    this.events.push(structuredClone(event));
  }

  close(): void {
    this.closeCalls += 1;
    this.closeRequested.resolve();
    if (this.autoDisconnect) this.acknowledgeDisconnected();
    else if (this.status !== 'disconnected') this.status = 'disconnecting';
  }

  subscribe(listener: (event: RealtimePortEvent) => void): () => void {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  emit(event: RealtimePortEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  acknowledgeDisconnected(): void {
    this.status = 'disconnected';
    this.emit({ type: 'disconnected' });
  }
}

class FakeSource implements RealtimePcmSource {
  starts = 0;
  stops = 0;
  readonly enabled: boolean[] = [];
  startBehavior: (() => Promise<void>) | undefined;
  stopBehavior: (() => Promise<void>) | undefined;
  readonly captureBehaviors: Array<() => Promise<void>> = [];
  readonly startCalled = new Deferred<void>();
  private onFrame: ((frame: RealtimePcm16Frame) => void) | undefined;

  async start(onFrame: (frame: RealtimePcm16Frame) => void): Promise<void> {
    this.starts += 1;
    this.onFrame = onFrame;
    this.startCalled.resolve();
    await this.startBehavior?.();
  }

  async setCaptureEnabled(enabled: boolean): Promise<void> {
    this.enabled.push(enabled);
    await this.captureBehaviors.shift()?.();
  }

  async stop(): Promise<void> {
    this.stops += 1;
    await this.stopBehavior?.();
  }

  emit(frame: RealtimePcm16Frame): void {
    if (!this.onFrame) throw new Error('source not started');
    this.onFrame(frame);
  }
}

class FakeSink implements RealtimePcmSink {
  starts = 0;
  stops = 0;
  clears = 0;
  playedMs = 0;
  readonly frames: RealtimePcm16Frame[] = [];
  startBehavior: (() => Promise<void>) | undefined;
  stopBehavior: (() => Promise<void>) | undefined;
  readonly startCalled = new Deferred<void>();

  async start(): Promise<void> {
    this.starts += 1;
    this.startCalled.resolve();
    await this.startBehavior?.();
  }

  write(frame: RealtimePcm16Frame): void {
    this.frames.push(frame);
  }

  clear(): number {
    this.clears += 1;
    return this.playedMs;
  }

  async stop(): Promise<void> {
    this.stops += 1;
    await this.stopBehavior?.();
  }
}

function frame(fill = 0): RealtimePcm16Frame {
  return {
    data: new Uint8Array(REALTIME_PCM16_FORMAT.bytesPerFrame).fill(fill),
    sampleFormat: 'pcm16',
    sampleRateHz: REALTIME_PCM16_FORMAT.sampleRateHz,
    channels: REALTIME_PCM16_FORMAT.channels,
    durationMs: REALTIME_PCM16_FORMAT.frameDurationMs,
  };
}

function voiceProvider(): ProviderDefinition {
  return {
    id: 'openai-main',
    label: 'OpenAI',
    transport: 'openai-responses',
    realtimeTransport: 'openai-realtime-websocket',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: [
      {
        target: { providerId: 'openai-main', modelId: 'text' },
        kind: 'agent',
        capabilities: { imageInput: true, imageOutput: false, toolCalling: true },
      },
      {
        target: { providerId: 'openai-main', modelId: 'gpt-realtime' },
        kind: 'realtime',
        capabilities: {
          imageInput: true,
          imageOutput: false,
          toolCalling: false,
          audioInput: true,
          audioOutput: true,
          realtimeAudio: true,
        },
      },
    ],
  };
}

function route() {
  const provider = voiceProvider();
  return assertOpenAIRealtimeAudioRoute(provider, provider.models[1]!);
}

function flattenErrorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.flatMap((current) => flattenErrorMessages(current))];
  }
  return [error instanceof Error ? error.message : String(error)];
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test('SDK uses only agents/realtime and constructor URL/model overrides fail before SDK creation', async () => {
  const packageMetadata = JSON.parse(await readFile(
    new URL('../node_modules/@openai/agents/package.json', import.meta.url),
    'utf8',
  )) as { version?: string; exports?: Record<string, unknown> };
  assert.equal(packageMetadata.version, '0.13.2');
  assert.ok(packageMetadata.exports?.['./realtime']);
  const sdk = await import('@openai/agents/realtime');
  assert.equal(typeof sdk.OpenAIRealtimeWebSocket, 'function');
  const provider = voiceProvider();
  const registration = provider.models[1]!;
  const client = createOpenAIRealtimeWebSocketClient(provider, registration);
  assert.equal(client.status, 'disconnected');
  client.close();
  assert.throws(() => createOpenAIRealtimeWebSocketClient(provider, registration, {
    url: 'wss://evil.example.test',
  } as never), /cannot override.*URL|blocked before network/);
  assert.throws(() => createOpenAIRealtimeWebSocketClient(provider, registration, {
    model: 'attacker-model',
  } as never), /cannot override.*model|blocked before network/);

  const source = await readFile(
    new URL('../src/runtime/realtime-audio-transport.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /from '@openai\/agents\/realtime'/);
  assert.doesNotMatch(source, /from '@openai\/agents-realtime'/);
  assert.doesNotMatch(source, /import[\s\S]{0,160}\bRealtimeSession\b/);
});

test('legacy capabilities default false and realtime-only models are excluded from ordinary Agent routes', () => {
  const parsed = parseModelsConfig({
    version: 1,
    routeVersion: 1,
    providers: [{
      id: 'legacy',
      label: 'Legacy',
      transport: 'openai-chat-completions',
      baseUrl: 'https://example.test',
      apiKeyEnv: 'LEGACY_KEY',
      models: [{
        target: { providerId: 'legacy', modelId: 'text' },
        kind: 'agent',
        capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
      }],
    }],
    routing: { globalDefault: { providerId: 'legacy', modelId: 'text' }, scenarios: {} },
  });
  assert.deepEqual(parsed.providers[0]!.models[0]!.capabilities, {
    imageInput: false,
    imageOutput: false,
    toolCalling: true,
    fileInput: false,
    audioInput: false,
    audioOutput: false,
    videoInput: false,
    realtimeAudio: false,
  });

  const provider = voiceProvider();
  const resolver = new WorkUnitModelResolver({
    providers: [provider],
    routing: {
      globalDefault: { providerId: provider.id, modelId: 'gpt-realtime' },
      scenarios: {
        'conversation.default': {
          candidates: [
            { providerId: provider.id, modelId: 'gpt-realtime' },
            { providerId: provider.id, modelId: 'text' },
          ],
        },
        'voice.realtime': {
          candidates: [
            { providerId: provider.id, modelId: 'text' },
            { providerId: provider.id, modelId: 'gpt-realtime' },
          ],
        },
      },
    },
  });
  assert.equal(resolver.resolve({ scenario: 'conversation.default', routeVersion: 1 }).target.modelId, 'text');
  assert.equal(resolver.resolve({
    scenario: 'voice.realtime',
    profile: { requirements: { realtimeAudio: true } },
    routeVersion: 1,
  }).target.modelId, 'gpt-realtime');
  assert.throws(() => resolver.resolve({
    scenario: 'conversation.default',
    profile: { modelTarget: { providerId: provider.id, modelId: 'gpt-realtime' } },
    routeVersion: 1,
  }), /Agent Runtime|硬能力/);
  assert.throws(() => new ModelGateway({
    providers: [provider],
    environment: { OPENAI_API_KEY: 'test-only' },
  }).createAgentRuntime(provider.models[1]!.target), /不是 Agent|kind|Runtime/);
  assert.throws(() => parseModelsConfig({
    version: 1,
    routeVersion: 1,
    providers: [{
      ...provider,
      models: [{ ...provider.models[1], kind: 'agent' }],
    }],
    routing: { globalDefault: provider.models[1]!.target, scenarios: {} },
  }), /realtime kind/);
});

test('connect binds the registered model and forces transcription-only VAD before network', async () => {
  const client = new FakeRealtimeClient();
  const transport = new RealtimeAudioTransport(route(), client, new FakeSource(), new FakeSink());
  await transport.connect({ apiKey: 'ephemeral-test-key' });
  assert.equal(client.connectCalls, 1);
  assert.equal(client.connectOptions[0]!.model, 'gpt-realtime');
  const session = client.connectOptions[0]!.initialSessionConfig as {
    model?: string;
    tools?: unknown[];
    toolChoice?: string;
    outputModalities?: string[];
    audio?: {
      input?: { format?: unknown; turnDetection?: Record<string, unknown> };
      output?: unknown;
    };
  };
  assert.equal(session.model, 'gpt-realtime');
  assert.deepEqual(session.tools, []);
  assert.equal(session.toolChoice, 'none');
  assert.deepEqual(session.outputModalities, ['text']);
  assert.deepEqual(session.audio?.input?.format, { type: 'audio/pcm', rate: 24_000 });
  assert.equal(session.audio?.input?.turnDetection?.createResponse, false);
  assert.equal(session.audio?.input?.turnDetection?.interruptResponse, false);
  assert.equal(session.audio?.output, null);
  await transport.stop();

  const maliciousClient = new FakeRealtimeClient();
  const malicious = new RealtimeAudioTransport(route(), maliciousClient, new FakeSource(), new FakeSink());
  await assert.rejects(malicious.connect({
    apiKey: 'ephemeral-test-key',
    url: 'wss://evil.example.test',
  } as never), /cannot override.*URL|blocked before network/);
  await assert.rejects(malicious.connect({
    apiKey: 'ephemeral-test-key',
    model: 'attacker-model',
  } as never), /cannot override.*model|blocked before network/);
  await assert.rejects(malicious.connect({
    apiKey: 'ephemeral-test-key',
    initialSessionConfig: { model: 'attacker-model' },
  }), /initialSessionConfig cannot override.*model|blocked before network/);
  await assert.rejects(malicious.connect({
    apiKey: 'ephemeral-test-key',
    initialSessionConfig: {
      outputModalities: ['audio'],
      audio: { output: { voice: 'alloy' } },
    },
  }), /output audio is disabled|blocked before network/);
  await assert.rejects(malicious.connect({
    apiKey: 'ephemeral-test-key',
    initialSessionConfig: {
      audio: { input: { turnDetection: { createResponse: true } } },
    },
  }), /cannot create a second provider response|blocked before network/);
  await assert.rejects(malicious.connect({
    apiKey: 'ephemeral-test-key',
    initialSessionConfig: { tools: [{ type: 'function' }] as never },
  }), /cannot own tools|blocked before network/);
  assert.equal(maliciousClient.connectCalls, 0);
});

test('connect timeout uses a controlled deadline and bounded fail-safe release', async () => {
  const clock = new ControlledClock();
  const client = new FakeRealtimeClient();
  const gate = new Deferred<void>();
  client.connectBehavior = () => gate.promise;
  const source = new FakeSource();
  const sink = new FakeSink();
  const failures: RealtimeAudioFailure[] = [];
  const transport = new RealtimeAudioTransport(route(), client, source, sink, {
    clock,
    onFailure: (failure) => failures.push(failure),
  });
  const connecting = transport.connect({ apiKey: 'ephemeral-test-key' });
  await client.connectStarted.promise;
  clock.expire('connect');
  await assert.rejects(connecting, /connect.*deadline|exceeded/i);
  assert.equal(client.closeCalls, 1);
  assert.equal(transport.snapshot().state, 'stopped');
  assert.equal(failures.length, 1);
  gate.resolve();
});

test('input is fixed 20ms PCM and capture disable commits only after device acknowledgement', async () => {
  const client = new FakeRealtimeClient();
  client.status = 'connected';
  const source = new FakeSource();
  const sink = new FakeSink();
  const transport = new RealtimeAudioTransport(route(), client, source, sink);
  await transport.start();
  const valid = frame(7);
  transport.sendInputFrame(valid, { commit: true });
  valid.data.fill(9);
  assert.equal(new Uint8Array(client.audio[0]!)[0], 7);
  for (const invalid of [
    { ...frame(), data: new Uint8Array(48_000) },
    { ...frame(), data: new Uint8Array(120_000) },
    { ...frame(), sampleRateHz: 16_000 },
    { ...frame(), channels: 2 },
  ]) assert.throws(() => transport.sendInputFrame(invalid), /only 20ms mono PCM16/);

  const disableGate = new Deferred<void>();
  source.captureBehaviors.push(() => disableGate.promise);
  const disabling = transport.setCaptureEnabled(false);
  await tick();
  assert.equal(transport.snapshot().captureEnabled, true, 'state waits for device acknowledgement');
  assert.throws(() => transport.sendInputFrame(frame()), /locally disabled/);
  disableGate.resolve();
  await disabling;
  assert.equal(transport.snapshot().captureEnabled, false);
  await transport.setCaptureEnabled(true);
  source.emit(frame(3));
  assert.equal(client.audio.length, 2);
  await transport.stop();
});

test('capture disable failure performs fail-safe stop and preserves the device error', async () => {
  const client = new FakeRealtimeClient();
  client.status = 'connected';
  const source = new FakeSource();
  const sink = new FakeSink();
  const deviceError = new Error('local capture mute failed');
  const transport = new RealtimeAudioTransport(route(), client, source, sink);
  await transport.start();
  source.captureBehaviors.push(
    async () => { throw deviceError; },
    async () => {},
  );
  await assert.rejects(transport.setCaptureEnabled(false), /local capture mute failed/);
  assert.equal(source.stops, 1);
  assert.equal(sink.stops, 1);
  assert.equal(client.closeCalls, 1);
  assert.equal(transport.snapshot().state, 'stopped');
});

test('arbitrary output deltas are reframed, same response begin is idempotent, and terminal acks are generation-safe', async () => {
  const client = new FakeRealtimeClient();
  client.status = 'connected';
  const sink = new FakeSink();
  const transport = new RealtimeAudioTransport(route(), client, new FakeSource(), sink);
  await transport.start();
  const first = transport.beginResponse('response-1');
  transport.writeOutputAudioDelta('response-1', new Uint8Array(500), {
    itemId: 'item-1', contentIndex: 0,
  });
  const repeated = transport.beginResponse('response-1');
  assert.deepEqual(repeated, first);
  assert.equal(transport.snapshot().outputRemainderBytes, 500);
  transport.writeOutputAudioDelta('response-1', new Uint8Array(700), {
    itemId: 'item-1', contentIndex: 0,
  });
  assert.equal(sink.frames.length, 1);
  assert.equal(transport.snapshot().outputRemainderBytes, 240);
  assert.throws(
    () => transport.finishPlayback(first.responseId, first.generation),
    /before audio_done/,
  );
  const done = transport.markOutputGenerationDone('response-1');
  assert.equal(sink.frames.length, 2, 'audio_done pads and flushes the final partial PCM frame');
  const afterDone = transport.beginResponse('response-1');
  assert.deepEqual(afterDone, done);
  assert.equal(transport.snapshot().outputStarted, true);
  assert.equal(transport.snapshot().outputGenerationDone, true);
  assert.equal(transport.finishPlayback(done.responseId, done.generation), true);
  assert.equal(transport.finishPlayback(done.responseId, done.generation), false);

  const reused = transport.beginResponse('response-1');
  assert.ok(reused.generation > done.generation);
  transport.markOutputGenerationDone('response-1');
  assert.equal(transport.finishPlayback(done.responseId, done.generation), false);
  assert.equal(transport.snapshot().activeResponseGeneration, reused.generation);
  assert.equal(transport.finishPlayback(reused.responseId, reused.generation), true);
  await transport.stop();
});

test('barge-in truncates with sink-reported playedMs instead of SDK wall clock', async () => {
  const client = new FakeRealtimeClient();
  client.status = 'connected';
  const sink = new FakeSink();
  sink.playedMs = 37;
  const transport = new RealtimeAudioTransport(route(), client, new FakeSource(), sink);
  await transport.start();
  transport.beginResponse('before-audio');
  transport.interruptForBargeIn();
  assert.deepEqual(client.events, [{ type: 'response.cancel', response_id: 'before-audio' }]);

  transport.beginResponse('with-audio');
  transport.writeOutputAudioDelta('with-audio', new Uint8Array(1_920), {
    itemId: 'assistant-item', contentIndex: 2,
  });
  transport.interruptForBargeIn();
  assert.deepEqual(client.events.slice(-2), [
    { type: 'response.cancel', response_id: 'with-audio' },
    {
      type: 'conversation.item.truncate',
      item_id: 'assistant-item',
      content_index: 2,
      audio_end_ms: 37,
    },
  ]);
  await transport.stop();
});

test('stop closes WebSocket first, bounds every release step, unsubscribes, and cannot hang', async () => {
  const clock = new ControlledClock();
  const client = new FakeRealtimeClient(false);
  client.status = 'connected';
  const source = new FakeSource();
  const sink = new FakeSink();
  const disableGate = new Deferred<void>();
  const sourceStopGate = new Deferred<void>();
  const sinkStopGate = new Deferred<void>();
  source.captureBehaviors.push(() => disableGate.promise);
  source.stopBehavior = () => sourceStopGate.promise;
  sink.stopBehavior = () => sinkStopGate.promise;
  const transport = new RealtimeAudioTransport(route(), client, source, sink, { clock });
  await transport.start();

  const stopping = transport.stop();
  assert.equal(client.closeCalls, 1, 'WebSocket close starts before local release settles');
  await tick();
  clock.expire('source-disable');
  await tick();
  clock.expire('source-stop');
  clock.expire('sink-stop');
  clock.expire('websocket-disconnect');
  let releaseError: unknown;
  try {
    await stopping;
  } catch (error) {
    releaseError = error;
  }
  assert.ok(releaseError instanceof AggregateError);
  const messages = flattenErrorMessages(releaseError).join('\n');
  assert.match(messages, /source-disable/);
  assert.match(messages, /source-stop/);
  assert.match(messages, /sink-stop/);
  assert.match(messages, /websocket-disconnect/);
  assert.equal(transport.snapshot().state, 'failed');
  assert.equal(client.listeners.size, 0, 'deadline cleanup removes lifecycle and WS wait listeners');
  disableGate.resolve();
  sourceStopGate.resolve();
  sinkStopGate.resolve();
});

test('unexpected disconnect triggers exactly one observable release and does not swallow capture errors', async () => {
  const client = new FakeRealtimeClient();
  client.status = 'connected';
  const source = new FakeSource();
  const sink = new FakeSink();
  const failures: RealtimeAudioFailure[] = [];
  const failureObserved = new Deferred<void>();
  const transport = new RealtimeAudioTransport(route(), client, source, sink, {
    onFailure: (failure) => {
      failures.push(failure);
      failureObserved.resolve();
    },
  });
  await transport.start();
  source.captureBehaviors.push(async () => { throw new Error('disconnect mute failed'); });
  client.acknowledgeDisconnected();
  client.emit({ type: 'disconnected' });
  await failureObserved.promise;
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.phase, 'disconnect');
  assert.match(flattenErrorMessages(failures[0]!.error).join('\n'), /disconnect mute failed/);
  assert.equal(transport.snapshot().state, 'failed');
  assert.equal(client.listeners.size, 0);
});

test('stop cancels a pending sink startup, waits startup finally, and late resolution never starts source', async () => {
  const client = new FakeRealtimeClient();
  client.status = 'connected';
  const source = new FakeSource();
  const sink = new FakeSink();
  const sinkStartGate = new Deferred<void>();
  sink.startBehavior = () => sinkStartGate.promise;
  const transport = new RealtimeAudioTransport(route(), client, source, sink);
  const starting = transport.start();
  const startRejected = assert.rejects(starting, /startup was cancelled/);
  await sink.startCalled.promise;
  await transport.stop();
  await startRejected;
  assert.equal(source.starts, 0);
  assert.equal(transport.snapshot().state, 'stopped');

  sinkStartGate.resolve();
  await tick();
  assert.equal(source.starts, 0, 'late sink acquisition cannot advance startup epoch');
  assert.equal(sink.stops, 2, 'late-acquired sink receives a second bounded cleanup');
});

test('controller sends only finalized transcripts through canonical Mimi and speaks exactly its answer', async () => {
  const client = new FakeRealtimeClient();
  client.status = 'connected';
  const sink = new FakeSink();
  const transport = new RealtimeAudioTransport(route(), client, new FakeSource(), sink);
  await transport.start();
  const submitted: CanonicalRealtimeTurnInput[] = [];
  const assistant: string[] = [];
  const heard: string[] = [];
  const cancelled: Error[] = [];
  const bargeInPlayedMs: number[] = [];
  const controller = new RealtimeAudioController(client, transport, {
    submitStableTurn: async (input) => {
      submitted.push(input);
      return { assistantText: `canonical:${input.transcript}` };
    },
    cancelActiveTurn: (reason) => {
      if (reason) cancelled.push(reason);
    },
  }, {
    speak: async (text) => {
      heard.push(text);
    },
    interrupt: () => 17,
  }, {
    onAssistantText: (result) => {
      assistant.push(result.assistantText);
    },
    onBargeIn: (playedMs) => {
      bargeInPlayedMs.push(playedMs);
    },
  });
  controller.start();
  client.emit({ type: 'final_transcript', itemId: 'user-item', transcript: '  hello voice  ' });
  client.emit({ type: 'final_transcript', itemId: 'user-item', transcript: 'hello voice' });
  await controller.drainTurns();
  assert.deepEqual(submitted, [{
    turnId: 'user-item', transcript: 'hello voice', source: 'realtime-asr',
  }]);
  assert.deepEqual(assistant, ['canonical:hello voice']);
  assert.deepEqual(heard, assistant, 'the text heard through Mimi TTS is the canonical Session answer');
  assert.equal(sink.frames.length, 0, 'Realtime provider output audio is never played');
  client.emit({ type: 'speech_started' });
  await controller.drainTurns();
  assert.equal(cancelled.length, 1);
  assert.deepEqual(bargeInPlayedMs, [17]);
  await controller.submitTextFallback('fallback-item', 'typed instead');
  assert.equal(submitted[1]!.source, 'text-fallback');
  assert.equal(heard[1], 'canonical:typed instead');
  await controller.stop();
});

test('controller fails closed before playing unexpected provider audio', async () => {
  const client = new FakeRealtimeClient();
  client.status = 'connected';
  const sink = new FakeSink();
  const transport = new RealtimeAudioTransport(route(), client, new FakeSource(), sink);
  await transport.start();
  const errors: unknown[] = [];
  const controller = new RealtimeAudioController(client, transport, {
    submitStableTurn: async () => ({ assistantText: 'canonical only' }),
  }, {
    speak: async () => {},
    interrupt: () => 0,
  }, {
    onError: (error) => {
      errors.push(error);
    },
  });
  controller.start();
  client.emit({
    type: 'audio', responseId: 'forbidden', data: new Uint8Array(960).buffer,
    itemId: 'provider-item', contentIndex: 0,
  });
  await controller.stop();
  assert.equal(sink.frames.length, 0);
  assert.match(String(errors[0]), /transcription-only.*provider audio/);
});

test('MimiHost realtime runner reaches the canonical Session execute path with a durable turn key', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const cancellations: Array<{ executionId: string; reason?: Error }> = [];
  const executeGate = new Deferred<void>();
  const fakeHost = {
    execute: async (request: Record<string, unknown>) => {
      calls.push(request);
      await executeGate.promise;
      return { answer: 'canonical answer', effects: [] };
    },
    cancel: (executionId: string, reason?: Error) => {
      cancellations.push({ executionId, reason });
      return { state: 'cancelled' };
    },
  } as unknown as MimiHost;
  const runner = MimiHost.prototype.realtimeTurnRunner.call(fakeHost, 'owner-session', '/tmp/workspace');
  const running = runner.submitStableTurn({
    turnId: 'provider-item-1',
    transcript: 'stable words only',
    source: 'realtime-asr',
  });
  await tick();
  await runner.cancelActiveTurn?.(new Error('barge in'));
  executeGate.resolve();
  const result = await running;
  assert.equal(result.assistantText, 'canonical answer');
  const request = calls[0] as {
    executionId: string;
    sessionId: string;
    input: string;
    options: { executionKey: string; retainExecutionLedger: boolean; scenario: string };
  };
  assert.equal(request.sessionId, 'owner-session');
  assert.ok(request.executionId);
  assert.equal(request.input, 'stable words only');
  assert.equal(request.options.executionKey, 'realtime:owner-session:provider-item-1');
  assert.equal(request.options.retainExecutionLedger, true);
  assert.equal(request.options.scenario, 'conversation.default');
  assert.equal(cancellations[0]!.executionId, request.executionId);
  assert.match(cancellations[0]!.reason?.message ?? '', /barge in/);
});
