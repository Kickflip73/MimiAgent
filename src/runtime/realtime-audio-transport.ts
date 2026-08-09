import {
  OpenAIRealtimeWebSocket,
  type OpenAIRealtimeWebSocketOptions,
  type RealtimeClientMessage,
  type RealtimeTransportLayerConnectOptions,
  type TransportError,
  type TransportEvent,
  type TransportLayerAudio,
  type TransportLayerResponseCompleted,
  type TransportLayerResponseStarted,
} from '@openai/agents/realtime';
import type { ModelRegistration, ProviderDefinition } from '../core/model-routing.js';

export const REALTIME_PCM16_FORMAT = Object.freeze({
  sampleFormat: 'pcm16' as const,
  sampleRateHz: 24_000,
  channels: 1,
  frameDurationMs: 20,
  bytesPerFrame: 960,
});

export interface RealtimePcm16Frame {
  data: Uint8Array;
  sampleFormat: 'pcm16';
  sampleRateHz: number;
  channels: number;
  durationMs: number;
}

export interface RealtimePcmSource {
  start(onFrame: (frame: RealtimePcm16Frame) => void): Promise<void>;
  setCaptureEnabled(enabled: boolean): Promise<void>;
  stop(): Promise<void>;
}

export interface RealtimePcmSink {
  start(): Promise<void>;
  write(frame: RealtimePcm16Frame): void;
  /** Stops queued playback and returns the actual device-played duration. */
  clear(): number;
  stop(): Promise<void>;
}

export type RealtimeConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'disconnected';

export type SafeOpenAIRealtimeWebSocketOptions = Omit<
  OpenAIRealtimeWebSocketOptions,
  'model' | 'url'
> & { model?: never; url?: never };

export type SafeRealtimeConnectOptions = Omit<
  RealtimeTransportLayerConnectOptions,
  'model' | 'url'
> & { model?: never; url?: never };

export interface BoundRealtimeConnectOptions extends Omit<
  RealtimeTransportLayerConnectOptions,
  'model' | 'url'
> {
  model: string;
  url?: never;
}

export type RealtimePortEvent =
  | {
      type: 'audio';
      responseId: string;
      data: ArrayBuffer;
      itemId?: string;
      contentIndex?: number;
    }
  | { type: 'turn_started'; responseId: string }
  | { type: 'turn_done'; responseId: string; assistantText?: string }
  | { type: 'audio_done' }
  | { type: 'audio_interrupted' }
  | { type: 'speech_started' }
  | { type: 'final_transcript'; itemId: string; transcript: string }
  | { type: 'error'; error: unknown }
  | { type: 'disconnected' };

/**
 * Narrow raw-transport port. It intentionally exposes neither RealtimeSession nor mute():
 * Mimi owns the canonical Agent/Session loop and its PCM devices.
 */
export interface RealtimeWebSocketClient {
  readonly status: RealtimeConnectionStatus;
  connect(options: BoundRealtimeConnectOptions): Promise<void>;
  sendAudio(audio: ArrayBuffer, options?: { commit?: boolean }): void;
  sendEvent(event: RealtimeClientMessage): void;
  close(): void;
  subscribe(listener: (event: RealtimePortEvent) => void): () => void;
}

export interface RealtimeAudioRoute {
  providerId: string;
  modelId: string;
  transport: 'openai-realtime-websocket';
}

export interface RealtimeResponseRef {
  responseId: string;
  generation: number;
}

export interface RealtimeAudioTransportSnapshot {
  state: 'idle' | 'connecting' | 'starting' | 'active' | 'stopping' | 'stopped' | 'failed';
  captureEnabled: boolean;
  activeResponseId?: string;
  activeResponseGeneration?: number;
  outputStarted: boolean;
  outputGenerationDone: boolean;
  outputRemainderBytes: number;
}

export interface RealtimeAudioFailure {
  phase: 'connect' | 'startup' | 'capture' | 'disconnect' | 'release' | 'transport';
  error: unknown;
}

export interface RealtimeDeadline {
  expired: Promise<never>;
  cancel(): void;
}

export interface RealtimeDeadlineClock {
  deadline(label: string, afterMs: number): RealtimeDeadline;
}

export interface RealtimeAudioDeadlines {
  connectMs: number;
  startStepMs: number;
  captureControlMs: number;
  startupReleaseMs: number;
  sourceDisableMs: number;
  sourceStopMs: number;
  sinkStopMs: number;
  websocketDisconnectMs: number;
  lateCleanupMs: number;
}

export interface RealtimeAudioTransportOptions {
  clock?: RealtimeDeadlineClock;
  deadlines?: Partial<RealtimeAudioDeadlines>;
  onFailure?: (failure: RealtimeAudioFailure) => void;
}

interface ActiveResponse {
  id: string;
  generation: number;
  itemId?: string;
  contentIndex?: number;
  outputStarted: boolean;
  generationDone: boolean;
  outputDurationMs: number;
  remainder: Uint8Array;
}

interface StartAttempt {
  epoch: number;
  cancelled: boolean;
  cancel: () => void;
  cancellation: Promise<never>;
  finished: Promise<void>;
  finish: () => void;
}

const DEFAULT_DEADLINES: RealtimeAudioDeadlines = Object.freeze({
  connectMs: 15_000,
  startStepMs: 10_000,
  captureControlMs: 5_000,
  startupReleaseMs: 5_000,
  sourceDisableMs: 5_000,
  sourceStopMs: 10_000,
  sinkStopMs: 10_000,
  websocketDisconnectMs: 10_000,
  lateCleanupMs: 10_000,
});

export class RealtimeDeadlineExceededError extends Error {
  constructor(readonly label: string, readonly afterMs: number) {
    super(`Realtime ${label} exceeded ${afterMs}ms deadline`);
    this.name = 'RealtimeDeadlineExceededError';
  }
}

class SystemDeadlineClock implements RealtimeDeadlineClock {
  deadline(label: string, afterMs: number): RealtimeDeadline {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RealtimeDeadlineExceededError(label, afterMs)), afterMs);
      timer.unref?.();
    });
    return {
      expired,
      cancel: () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
      },
    };
  }
}

class StartCancelledError extends Error {
  constructor() {
    super('Realtime startup was cancelled');
    this.name = 'StartCancelledError';
  }
}

function blocked(message: string): Error {
  return new Error(`Realtime audio blocked before network request: ${message}`);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function responseIdFrom(value: unknown): string | undefined {
  const event = record(value);
  const response = record(event?.response);
  const providerData = record(event?.providerData);
  return nonEmptyString(response?.id)
    ?? nonEmptyString(event?.response_id)
    ?? nonEmptyString(providerData?.response_id)
    ?? nonEmptyString(record(providerData?.response)?.id);
}

function assistantTextFrom(value: unknown): string | undefined {
  const response = record(record(value)?.response) ?? record(value);
  const output = Array.isArray(response?.output) ? response.output : [];
  const pieces: string[] = [];
  for (const item of output) {
    const content = Array.isArray(record(item)?.content) ? record(item)!.content as unknown[] : [];
    for (const part of content) {
      const current = record(part);
      const text = nonEmptyString(current?.text) ?? nonEmptyString(current?.transcript);
      if (text) pieces.push(text);
    }
  }
  return pieces.length ? pieces.join('\n') : undefined;
}

function assertNoEndpointOrModelOverride(value: unknown, boundary: string): void {
  const options = record(value);
  if (!options) return;
  if (Object.hasOwn(options, 'url')) throw blocked(`${boundary} cannot override the official WebSocket URL`);
  if (Object.hasOwn(options, 'model')) throw blocked(`${boundary} cannot override the registered model`);
}

function transcriptionOnlySessionConfig(
  value: RealtimeTransportLayerConnectOptions['initialSessionConfig'],
  modelId: string,
): NonNullable<RealtimeTransportLayerConnectOptions['initialSessionConfig']> {
  const config = record(value) ?? {};
  if (Object.hasOwn(config, 'model')) {
    throw blocked('initialSessionConfig cannot override the registered model');
  }
  const modalities = Array.isArray(config.outputModalities)
    ? config.outputModalities
    : Array.isArray(config.modalities) ? config.modalities : [];
  const audio = record(config.audio);
  const audioInput = record(audio?.input);
  const audioOutput = audio?.output;
  const turnDetection = record(audioInput?.turnDetection) ?? record(config.turnDetection) ?? {};
  if (modalities.includes('audio')
    || (audio && Object.hasOwn(audio, 'output') && audioOutput !== null && audioOutput !== undefined)
    || Object.hasOwn(config, 'voice')
    || Object.hasOwn(config, 'outputAudioFormat')) {
    throw blocked('provider output audio is disabled; Mimi-owned TTS is the sole speech output');
  }
  if (turnDetection.createResponse === true || turnDetection.create_response === true) {
    throw blocked('Realtime VAD cannot create a second provider response');
  }
  if ((Array.isArray(config.tools) && config.tools.length > 0)
    || (config.toolChoice !== undefined && config.toolChoice !== 'none')) {
    throw blocked('Realtime transcription cannot own tools or an Agent loop');
  }
  const {
    createResponse: _createResponse,
    create_response: _createResponseLegacy,
    interruptResponse: _interruptResponse,
    interrupt_response: _interruptResponseLegacy,
    ...safeTurnDetection
  } = turnDetection;
  return {
    model: modelId,
    instructions: 'Transcribe user speech and detect completed turns. Do not answer.',
    toolChoice: 'none',
    tools: [],
    parallelToolCalls: false,
    outputModalities: ['text'],
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: REALTIME_PCM16_FORMAT.sampleRateHz },
        transcription: audioInput?.transcription === null
          ? { model: 'gpt-4o-mini-transcribe' }
          : (audioInput?.transcription as Record<string, unknown> | undefined)
            ?? { model: 'gpt-4o-mini-transcribe' },
        ...(audioInput && Object.hasOwn(audioInput, 'noiseReduction')
          ? { noiseReduction: audioInput.noiseReduction as Record<string, unknown> | null }
          : {}),
        turnDetection: {
          ...safeTurnDetection,
          type: nonEmptyString(safeTurnDetection.type) ?? 'server_vad',
          createResponse: false,
          interruptResponse: false,
        },
      },
      output: null,
    },
  } as NonNullable<RealtimeTransportLayerConnectOptions['initialSessionConfig']>;
}

function validatedDeadlines(input: Partial<RealtimeAudioDeadlines> | undefined): RealtimeAudioDeadlines {
  const deadlines = { ...DEFAULT_DEADLINES, ...input };
  for (const [name, value] of Object.entries(deadlines)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
      throw new Error(`Realtime deadline ${name} must be an integer between 1 and 120000ms`);
    }
  }
  return deadlines;
}

async function withinDeadline<T>(
  clock: RealtimeDeadlineClock,
  label: string,
  afterMs: number,
  operation: () => Promise<T>,
  cancellation?: Promise<never>,
): Promise<T> {
  const deadline = clock.deadline(label, afterMs);
  let pending: Promise<T>;
  try {
    pending = Promise.resolve(operation());
  } catch (error) {
    deadline.cancel();
    throw error;
  }
  try {
    return await Promise.race([
      pending,
      deadline.expired,
      ...(cancellation ? [cancellation] : []),
    ]);
  } finally {
    deadline.cancel();
  }
}

export function assertOpenAIRealtimeAudioRoute(
  provider: ProviderDefinition,
  registration: ModelRegistration,
): RealtimeAudioRoute {
  if (registration.target.providerId !== provider.id) {
    throw blocked('model target does not belong to its Provider');
  }
  if (provider.realtimeTransport !== 'openai-realtime-websocket'
    || provider.transport !== 'openai-responses'
    || provider.baseUrl !== undefined) {
    throw blocked('only an explicitly declared official OpenAI Realtime WebSocket route is eligible');
  }
  if (registration.kind !== 'realtime'
    || registration.capabilities.realtimeAudio !== true
    || registration.capabilities.audioInput !== true
    || registration.capabilities.audioOutput !== true) {
    throw blocked('model lacks realtime kind plus realtimeAudio, audioInput, or audioOutput capability');
  }
  return Object.freeze({
    providerId: provider.id,
    modelId: registration.target.modelId,
    transport: provider.realtimeTransport,
  });
}

export function createOpenAIRealtimeWebSocketClient(
  provider: ProviderDefinition,
  registration: ModelRegistration,
  options: SafeOpenAIRealtimeWebSocketOptions = {},
): RealtimeWebSocketClient {
  const route = assertOpenAIRealtimeAudioRoute(provider, registration);
  assertNoEndpointOrModelOverride(options, 'constructor');
  const transport = new OpenAIRealtimeWebSocket({ ...options, model: route.modelId });
  return {
    get status() {
      return transport.status;
    },
    connect: (connectOptions) => {
      const raw = connectOptions as unknown;
      const provided = record(raw);
      if (provided && Object.hasOwn(provided, 'url')) {
        throw blocked('connect cannot override the official WebSocket URL');
      }
      if (connectOptions.model !== route.modelId) {
        throw blocked('connect model does not match the registered realtime target');
      }
      const { model: _ignored, ...safe } = connectOptions;
      return transport.connect({ ...safe, model: route.modelId });
    },
    sendAudio: (audio, sendOptions) => transport.sendAudio(audio, sendOptions),
    sendEvent: (event) => transport.sendEvent(event),
    close: () => transport.close(),
    subscribe: (listener) => {
      const latestAudioMetadata = new Map<string, { itemId: string; contentIndex: number }>();
      const rawListener = (event: TransportEvent) => {
        const current = record(event);
        if (current?.type === 'response.output_audio.delta') {
          const responseId = nonEmptyString(current.response_id);
          const itemId = nonEmptyString(current.item_id);
          const contentIndex = current.content_index;
          if (responseId && itemId && Number.isSafeInteger(contentIndex)) {
            latestAudioMetadata.set(responseId, { itemId, contentIndex: Number(contentIndex) });
          }
        } else if (current?.type === 'conversation.item.input_audio_transcription.completed') {
          const itemId = nonEmptyString(current.item_id);
          const transcript = nonEmptyString(current.transcript);
          if (itemId && transcript) listener({ type: 'final_transcript', itemId, transcript });
        } else if (current?.type === 'input_audio_buffer.speech_started') {
          listener({ type: 'speech_started' });
        } else if (current?.type === 'response.created') {
          const responseId = nonEmptyString(record(current.response)?.id);
          if (responseId) listener({ type: 'turn_started', responseId });
        }
      };
      const audioListener = (event: TransportLayerAudio) => {
        const metadata = latestAudioMetadata.get(event.responseId);
        listener({
          type: 'audio',
          responseId: event.responseId,
          data: event.data,
          ...(metadata ?? {}),
        });
      };
      const turnStartedListener = (event: TransportLayerResponseStarted) => {
        const responseId = responseIdFrom(event);
        if (responseId) listener({ type: 'turn_started', responseId });
      };
      const turnDoneListener = (event: TransportLayerResponseCompleted) => {
        const responseId = responseIdFrom(event);
        if (!responseId) return;
        const assistantText = assistantTextFrom(event);
        listener({ type: 'turn_done', responseId, ...(assistantText ? { assistantText } : {}) });
      };
      const errorListener = (event: TransportError) => listener({ type: 'error', error: event.error });
      const audioDoneListener = () => listener({ type: 'audio_done' });
      const interruptedListener = () => listener({ type: 'audio_interrupted' });
      const disconnectedListener = () => listener({ type: 'disconnected' });
      transport.on('*', rawListener);
      transport.on('audio', audioListener);
      transport.on('turn_started', turnStartedListener);
      transport.on('turn_done', turnDoneListener);
      transport.on('audio_done', audioDoneListener);
      transport.on('audio_interrupted', interruptedListener);
      transport.on('error', errorListener);
      transport.on('disconnected', disconnectedListener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        transport.off('*', rawListener);
        transport.off('audio', audioListener);
        transport.off('turn_started', turnStartedListener);
        transport.off('turn_done', turnDoneListener);
        transport.off('audio_done', audioDoneListener);
        transport.off('audio_interrupted', interruptedListener);
        transport.off('error', errorListener);
        transport.off('disconnected', disconnectedListener);
        latestAudioMetadata.clear();
      };
    },
  };
}

function validateFrame(frame: RealtimePcm16Frame): void {
  if (!(frame.data instanceof Uint8Array)) throw new TypeError('Realtime frame data must be Uint8Array');
  if (frame.sampleFormat !== REALTIME_PCM16_FORMAT.sampleFormat
    || frame.sampleRateHz !== REALTIME_PCM16_FORMAT.sampleRateHz
    || frame.channels !== REALTIME_PCM16_FORMAT.channels
    || frame.durationMs !== REALTIME_PCM16_FORMAT.frameDurationMs
    || frame.data.byteLength !== REALTIME_PCM16_FORMAT.bytesPerFrame) {
    throw new Error('Realtime audio accepts only 20ms mono PCM16 at 24kHz (exactly 960 bytes per frame)');
  }
}

function pcmFrame(data: Uint8Array): RealtimePcm16Frame {
  return {
    data: Uint8Array.from(data),
    sampleFormat: REALTIME_PCM16_FORMAT.sampleFormat,
    sampleRateHz: REALTIME_PCM16_FORMAT.sampleRateHz,
    channels: REALTIME_PCM16_FORMAT.channels,
    durationMs: REALTIME_PCM16_FORMAT.frameDurationMs,
  };
}

function playedDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('Realtime sink returned invalid playedMs');
  return Math.floor(value);
}

export class RealtimeAudioTransport {
  private stateValue: RealtimeAudioTransportSnapshot['state'] = 'idle';
  private captureEnabled = false;
  private acceptingInput = false;
  private activeResponse: ActiveResponse | undefined;
  private responseGeneration = 0;
  private readonly terminalResponses = new Set<string>();
  private readonly terminalOrder: string[] = [];
  private stopPromise: Promise<void> | undefined;
  private startAttempt: StartAttempt | undefined;
  private lifecycleUnsubscribe: (() => void) | undefined;
  private failureValue: RealtimeAudioFailure | undefined;
  private failureNotified = false;
  private epoch = 0;
  private readonly clock: RealtimeDeadlineClock;
  private readonly deadlines: RealtimeAudioDeadlines;

  constructor(
    readonly route: RealtimeAudioRoute,
    private readonly client: RealtimeWebSocketClient,
    private readonly source: RealtimePcmSource,
    private readonly sink: RealtimePcmSink,
    private readonly options: RealtimeAudioTransportOptions = {},
  ) {
    if (route.transport !== 'openai-realtime-websocket') throw blocked('invalid realtime route');
    this.clock = options.clock ?? new SystemDeadlineClock();
    this.deadlines = validatedDeadlines(options.deadlines);
  }

  snapshot(): RealtimeAudioTransportSnapshot {
    return Object.freeze({
      state: this.stateValue,
      captureEnabled: this.captureEnabled,
      ...(this.activeResponse ? {
        activeResponseId: this.activeResponse.id,
        activeResponseGeneration: this.activeResponse.generation,
      } : {}),
      outputStarted: this.activeResponse?.outputStarted ?? false,
      outputGenerationDone: this.activeResponse?.generationDone ?? false,
      outputRemainderBytes: this.activeResponse?.remainder.byteLength ?? 0,
    });
  }

  lastFailure(): RealtimeAudioFailure | undefined {
    return this.failureValue ? Object.freeze({ ...this.failureValue }) : undefined;
  }

  async connect(options: SafeRealtimeConnectOptions): Promise<void> {
    assertNoEndpointOrModelOverride(options, 'connect');
    const initialSessionConfig = transcriptionOnlySessionConfig(
      options.initialSessionConfig,
      this.route.modelId,
    );
    if (this.stateValue !== 'idle') throw new Error(`Realtime audio cannot connect from ${this.stateValue}`);
    if (this.connectionStatus() === 'connected') return;
    this.ensureLifecycleSubscription();
    this.stateValue = 'connecting';
    try {
      await withinDeadline(
        this.clock,
        'connect',
        this.deadlines.connectMs,
        () => this.client.connect({
          ...options,
          model: this.route.modelId,
          initialSessionConfig,
        }),
      );
      const connectedStatus = this.connectionStatus();
      if (connectedStatus !== 'connected') throw blocked(`transport is ${connectedStatus} after connect`);
      this.stateValue = 'idle';
    } catch (error) {
      let releaseError: unknown;
      try {
        await this.stop();
      } catch (caught) {
        releaseError = caught;
      }
      const failure = releaseError
        ? new AggregateError([error, releaseError], 'Realtime connect and cleanup failed')
        : error;
      this.publishFailure('connect', failure);
      throw failure;
    }
  }

  async start(): Promise<void> {
    if (this.stateValue !== 'idle') throw new Error(`Realtime audio cannot start from ${this.stateValue}`);
    if (this.client.status !== 'connected') throw blocked(`transport is ${this.client.status}`);
    this.ensureLifecycleSubscription();
    const attempt = this.createStartAttempt();
    this.startAttempt = attempt;
    this.stateValue = 'starting';
    try {
      await this.runStartup(attempt);
    } catch (error) {
      if (error instanceof StartCancelledError) throw error;
      let releaseError: unknown;
      try {
        await this.stop();
      } catch (caught) {
        releaseError = caught;
      }
      const failure = releaseError
        ? new AggregateError([error, releaseError], 'Realtime startup and cleanup failed')
        : error;
      this.publishFailure('startup', failure);
      throw failure;
    }
  }

  async setCaptureEnabled(enabled: boolean): Promise<void> {
    if (this.stateValue !== 'active') {
      throw new Error(`Realtime capture cannot change from ${this.stateValue}`);
    }
    if (enabled && this.client.status !== 'connected') throw blocked(`transport is ${this.client.status}`);
    if (enabled === this.captureEnabled) return;
    this.acceptingInput = false;
    try {
      await withinDeadline(
        this.clock,
        enabled ? 'capture-enable' : 'capture-disable',
        this.deadlines.captureControlMs,
        () => this.source.setCaptureEnabled(enabled),
      );
      this.captureEnabled = enabled;
      this.acceptingInput = enabled;
    } catch (error) {
      let releaseError: unknown;
      try {
        await this.stop();
      } catch (caught) {
        releaseError = caught;
      }
      const failure = releaseError
        ? new AggregateError([error, releaseError], 'Realtime capture control failed; fail-safe stop was incomplete')
        : error;
      this.publishFailure('capture', failure);
      throw failure;
    }
  }

  sendInputFrame(frame: RealtimePcm16Frame, options: { commit?: boolean } = {}): void {
    this.assertActiveForAudio('input');
    if (!this.captureEnabled || !this.acceptingInput) throw new Error('Realtime capture is locally disabled');
    validateFrame(frame);
    const copy = Uint8Array.from(frame.data);
    this.client.sendAudio(copy.buffer, { commit: options.commit === true });
  }

  beginResponse(responseId: string): RealtimeResponseRef {
    this.assertActiveForAudio('response');
    const id = responseId.trim();
    if (!id || id.length > 200) throw new Error('Realtime response id is invalid');
    if (this.activeResponse) {
      if (this.activeResponse.id !== id) {
        throw new Error(`Realtime response ${this.activeResponse.id} is still active`);
      }
      return Object.freeze({ responseId: id, generation: this.activeResponse.generation });
    }
    const generation = ++this.responseGeneration;
    this.activeResponse = {
      id,
      generation,
      outputStarted: false,
      generationDone: false,
      outputDurationMs: 0,
      remainder: new Uint8Array(0),
    };
    return Object.freeze({ responseId: id, generation });
  }

  writeOutputAudioDelta(
    responseId: string,
    data: ArrayBuffer | Uint8Array,
    metadata: { itemId?: string; contentIndex?: number } = {},
  ): RealtimeResponseRef {
    this.assertActiveForAudio('output');
    const ref = this.beginResponse(responseId);
    const response = this.activeResponse!;
    if (metadata.itemId) response.itemId = metadata.itemId;
    if (metadata.contentIndex !== undefined) response.contentIndex = metadata.contentIndex;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let offset = 0;
    if (response.remainder.byteLength) {
      const needed = REALTIME_PCM16_FORMAT.bytesPerFrame - response.remainder.byteLength;
      const taken = Math.min(needed, bytes.byteLength);
      const combined = new Uint8Array(response.remainder.byteLength + taken);
      combined.set(response.remainder);
      combined.set(bytes.subarray(0, taken), response.remainder.byteLength);
      response.remainder = combined;
      offset = taken;
      if (response.remainder.byteLength === REALTIME_PCM16_FORMAT.bytesPerFrame) {
        this.writeCompleteOutputFrame(response, response.remainder);
        response.remainder = new Uint8Array(0);
      }
    }
    while (offset + REALTIME_PCM16_FORMAT.bytesPerFrame <= bytes.byteLength) {
      this.writeCompleteOutputFrame(
        response,
        bytes.subarray(offset, offset + REALTIME_PCM16_FORMAT.bytesPerFrame),
      );
      offset += REALTIME_PCM16_FORMAT.bytesPerFrame;
    }
    if (offset < bytes.byteLength) response.remainder = Uint8Array.from(bytes.subarray(offset));
    return ref;
  }

  writeOutputFrame(
    responseId: string,
    frame: RealtimePcm16Frame,
    metadata: { itemId?: string; contentIndex?: number } = {},
  ): RealtimeResponseRef {
    validateFrame(frame);
    return this.writeOutputAudioDelta(responseId, frame.data, metadata);
  }

  markOutputGenerationDone(responseId: string): RealtimeResponseRef {
    const response = this.activeResponse;
    if (!response || response.id !== responseId) {
      throw new Error(`Realtime audio_done does not match active response ${responseId}`);
    }
    if (!response.generationDone && response.remainder.byteLength) {
      const padded = new Uint8Array(REALTIME_PCM16_FORMAT.bytesPerFrame);
      padded.set(response.remainder);
      this.writeCompleteOutputFrame(response, padded);
      response.remainder = new Uint8Array(0);
    }
    response.generationDone = true;
    return Object.freeze({ responseId, generation: response.generation });
  }

  finishPlayback(responseId: string, generation: number): boolean {
    const key = this.responseKey(responseId, generation);
    if (this.terminalResponses.has(key)) return false;
    const response = this.activeResponse;
    if (!response || response.id !== responseId || response.generation !== generation) return false;
    if (!response.generationDone) throw new Error('Realtime playback cannot finish before audio_done');
    this.markTerminal(response);
    this.activeResponse = undefined;
    return true;
  }

  interruptForBargeIn(): void {
    this.assertActiveForAudio('barge-in');
    const errors: unknown[] = [];
    let playedMs: number | undefined;
    try {
      playedMs = playedDuration(this.sink.clear());
    } catch (error) {
      errors.push(error);
    }
    try {
      this.cancelActiveResponse(playedMs);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, 'Realtime barge-in was incomplete');
  }

  handleAudioInterrupted(): void {
    let error: unknown;
    try {
      playedDuration(this.sink.clear());
    } catch (caught) {
      error = caught;
    }
    const response = this.activeResponse;
    if (response) this.markTerminal(response);
    this.activeResponse = undefined;
    if (error) throw error;
  }

  fail(error: unknown): void {
    if (this.stateValue === 'stopping' || this.stateValue === 'stopped' || this.stateValue === 'failed') return;
    const release = this.stop();
    void release.then(
      () => this.publishFailure('transport', error),
      (releaseError) => this.publishFailure(
        'transport',
        new AggregateError([error, releaseError], 'Realtime transport failure release was incomplete'),
      ),
    );
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.stateValue === 'stopped') return Promise.resolve();
    this.stopPromise = this.release();
    return this.stopPromise;
  }

  private createStartAttempt(): StartAttempt {
    let cancel!: () => void;
    let finish!: () => void;
    const attempt: StartAttempt = {
      epoch: ++this.epoch,
      cancelled: false,
      cancellation: new Promise<never>((_resolve, reject) => {
        cancel = () => {
          if (attempt.cancelled) return;
          attempt.cancelled = true;
          reject(new StartCancelledError());
        };
      }),
      finished: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      cancel: () => cancel(),
      finish: () => finish(),
    };
    return attempt;
  }

  private connectionStatus(): RealtimeConnectionStatus {
    return this.client.status;
  }

  private async runStartup(attempt: StartAttempt): Promise<void> {
    try {
      const sinkStart = Promise.resolve().then(() => this.sink.start());
      this.cleanupLateAcquisition(attempt, sinkStart, 'sink', () => this.sink.stop());
      await withinDeadline(
        this.clock,
        'sink-start',
        this.deadlines.startStepMs,
        () => sinkStart,
        attempt.cancellation,
      );
      this.assertCurrentStartup(attempt);

      const sourceStart = Promise.resolve().then(() => this.source.start((frame) => {
        if (this.startAttempt !== attempt || attempt.cancelled
          || (this.stateValue !== 'starting' && this.stateValue !== 'active')) return;
        this.sendInputFrame(frame);
      }));
      this.cleanupLateAcquisition(attempt, sourceStart, 'source', () => this.source.stop());
      await withinDeadline(
        this.clock,
        'source-start',
        this.deadlines.startStepMs,
        () => sourceStart,
        attempt.cancellation,
      );
      this.assertCurrentStartup(attempt);
      if (this.client.status !== 'connected') throw blocked('transport disconnected during device startup');
      this.captureEnabled = true;
      this.acceptingInput = true;
      this.stateValue = 'active';
    } finally {
      attempt.finish();
    }
  }

  private cleanupLateAcquisition(
    attempt: StartAttempt,
    acquisition: Promise<void>,
    resource: string,
    cleanup: () => Promise<void>,
  ): void {
    void acquisition.then(async () => {
      if (this.startAttempt === attempt && !attempt.cancelled) return;
      try {
        await withinDeadline(
          this.clock,
          `late-${resource}-cleanup`,
          this.deadlines.lateCleanupMs,
          cleanup,
        );
      } catch (error) {
        this.publishFailure('release', error);
      }
    }, (error) => {
      if (attempt.cancelled) return;
      this.publishFailure('startup', error);
    });
  }

  private assertCurrentStartup(attempt: StartAttempt): void {
    if (this.startAttempt !== attempt || attempt.cancelled || this.stateValue !== 'starting') {
      throw new StartCancelledError();
    }
  }

  private assertActiveForAudio(operation: string): void {
    if (this.stateValue !== 'active' && this.stateValue !== 'starting') {
      throw new Error(`Realtime ${operation} rejected while transport is ${this.stateValue}`);
    }
    if (this.client.status !== 'connected') {
      this.handleUnexpectedDisconnect();
      throw blocked(`transport is ${this.client.status}`);
    }
  }

  private ensureLifecycleSubscription(): void {
    if (this.lifecycleUnsubscribe) return;
    this.lifecycleUnsubscribe = this.client.subscribe((event) => {
      if (event.type === 'disconnected') this.handleUnexpectedDisconnect();
    });
  }

  private handleUnexpectedDisconnect(): void {
    if (this.stateValue === 'stopping' || this.stateValue === 'stopped' || this.stateValue === 'failed') return;
    if (this.stateValue !== 'active' && this.stateValue !== 'starting') return;
    this.acceptingInput = false;
    const disconnected = blocked('transport disconnected unexpectedly');
    const release = this.stop();
    void release.then(
      () => this.publishFailure('disconnect', disconnected),
      (releaseError) => this.publishFailure(
        'disconnect',
        new AggregateError([disconnected, releaseError], 'Realtime disconnect release was incomplete'),
      ),
    );
  }

  private writeCompleteOutputFrame(response: ActiveResponse, data: Uint8Array): void {
    if (!response.itemId || response.contentIndex === undefined) {
      throw new Error('Realtime output audio is missing itemId/contentIndex required for exact truncation');
    }
    this.sink.write(pcmFrame(data));
    response.outputStarted = true;
    response.outputDurationMs += REALTIME_PCM16_FORMAT.frameDurationMs;
  }

  private cancelActiveResponse(playedMs: number | undefined): void {
    const response = this.activeResponse;
    if (!response) return;
    this.activeResponse = undefined;
    this.markTerminal(response);
    if (this.client.status !== 'connected') return;
    const errors: unknown[] = [];
    try {
      this.client.sendEvent({ type: 'response.cancel', response_id: response.id });
    } catch (error) {
      errors.push(error);
    }
    if (response.outputStarted) {
      if (playedMs === undefined) {
        errors.push(new Error('Realtime sink did not provide playedMs for truncation'));
      } else if (!response.itemId || response.contentIndex === undefined) {
        errors.push(new Error('Realtime response lacks item metadata for truncation'));
      } else {
        try {
          this.client.sendEvent({
            type: 'conversation.item.truncate',
            item_id: response.itemId,
            content_index: response.contentIndex,
            audio_end_ms: Math.min(playedMs, response.outputDurationMs),
          });
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Realtime response cancellation was incomplete');
  }

  private markTerminal(response: ActiveResponse): void {
    const key = this.responseKey(response.id, response.generation);
    if (this.terminalResponses.has(key)) return;
    this.terminalResponses.add(key);
    this.terminalOrder.push(key);
    while (this.terminalOrder.length > 2_048) {
      const removed = this.terminalOrder.shift();
      if (removed) this.terminalResponses.delete(removed);
    }
  }

  private responseKey(responseId: string, generation: number): string {
    return `${generation}:${responseId}`;
  }

  private async release(): Promise<void> {
    this.stateValue = 'stopping';
    this.acceptingInput = false;
    const attempt = this.startAttempt;
    attempt?.cancel();
    const errors: unknown[] = [];
    let playedMs: number | undefined;
    try {
      playedMs = playedDuration(this.sink.clear());
    } catch (error) {
      errors.push(error);
    }
    try {
      this.cancelActiveResponse(playedMs);
    } catch (error) {
      errors.push(error);
    }

    // close() is intentionally initiated before waiting for any local device release.
    const websocketRelease = this.releaseWebSocket();
    const startupRelease = this.releaseStartup(attempt);
    const sourceRelease = this.releaseSource();
    const sinkRelease = this.releaseSink();
    const releaseErrors = await Promise.all([
      websocketRelease,
      startupRelease,
      sourceRelease,
      sinkRelease,
    ]);
    for (const current of releaseErrors) errors.push(...current);
    this.lifecycleUnsubscribe?.();
    this.lifecycleUnsubscribe = undefined;
    this.activeResponse = undefined;
    if (errors.length) {
      this.stateValue = 'failed';
      throw new AggregateError(errors, 'Realtime audio release was incomplete');
    }
    this.captureEnabled = false;
    this.stateValue = 'stopped';
  }

  private async releaseStartup(attempt: StartAttempt | undefined): Promise<unknown[]> {
    if (!attempt) return [];
    try {
      await withinDeadline(
        this.clock,
        'startup-finally',
        this.deadlines.startupReleaseMs,
        () => attempt.finished,
      );
      return [];
    } catch (error) {
      return [error];
    }
  }

  private async releaseSource(): Promise<unknown[]> {
    const errors: unknown[] = [];
    try {
      await withinDeadline(
        this.clock,
        'source-disable',
        this.deadlines.sourceDisableMs,
        () => this.source.setCaptureEnabled(false),
      );
      this.captureEnabled = false;
    } catch (error) {
      errors.push(error);
    }
    try {
      await withinDeadline(
        this.clock,
        'source-stop',
        this.deadlines.sourceStopMs,
        () => this.source.stop(),
      );
      this.captureEnabled = false;
    } catch (error) {
      errors.push(error);
    }
    return errors;
  }

  private async releaseSink(): Promise<unknown[]> {
    try {
      await withinDeadline(
        this.clock,
        'sink-stop',
        this.deadlines.sinkStopMs,
        () => this.sink.stop(),
      );
      return [];
    } catch (error) {
      return [error];
    }
  }

  private async releaseWebSocket(): Promise<unknown[]> {
    let unsubscribe = () => {};
    let disconnectedResolve!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      disconnectedResolve = resolve;
    });
    if (this.client.status !== 'disconnected') {
      unsubscribe = this.client.subscribe((event) => {
        if (event.type === 'disconnected') disconnectedResolve();
      });
    }
    try {
      this.client.close();
      if (this.client.status === 'disconnected') disconnectedResolve();
    } catch (error) {
      unsubscribe();
      return [error];
    }
    try {
      await withinDeadline(
        this.clock,
        'websocket-disconnect',
        this.deadlines.websocketDisconnectMs,
        () => disconnected,
      );
      return [];
    } catch (error) {
      return [error];
    } finally {
      unsubscribe();
    }
  }

  private publishFailure(phase: RealtimeAudioFailure['phase'], error: unknown): void {
    if (this.failureNotified) return;
    this.failureNotified = true;
    this.failureValue = Object.freeze({ phase, error });
    try {
      this.options.onFailure?.(this.failureValue);
    } catch {
      // The failure remains observable through lastFailure(); an observer cannot corrupt release.
    }
  }
}
