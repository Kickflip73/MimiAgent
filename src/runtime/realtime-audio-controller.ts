import type {
  RealtimeAudioTransport,
  RealtimePortEvent,
  RealtimeWebSocketClient,
} from './realtime-audio-transport.js';

export interface CanonicalRealtimeTurnInput {
  turnId: string;
  transcript: string;
  source: 'realtime-asr' | 'text-fallback';
}

export interface CanonicalRealtimeTurnResult {
  assistantText: string;
}

export interface RealtimeCanonicalTurnRunner {
  submitStableTurn(input: CanonicalRealtimeTurnInput): Promise<CanonicalRealtimeTurnResult>;
  cancelActiveTurn?(reason?: Error): void | Promise<void>;
}

/** Mimi-owned TTS. Provider Realtime output audio is deliberately never played. */
export interface RealtimeCanonicalSpeechSink {
  speak(text: string, input: CanonicalRealtimeTurnInput): Promise<void>;
  /** Stops local playback and reports actual device-played time for observability. */
  interrupt(): number | Promise<number>;
}

export interface RealtimeAudioControllerCallbacks {
  onStableTranscript?: (input: CanonicalRealtimeTurnInput) => void | Promise<void>;
  onAssistantText?: (
    result: CanonicalRealtimeTurnResult,
    input: CanonicalRealtimeTurnInput,
  ) => void | Promise<void>;
  onBargeIn?: (playedMs: number) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

/**
 * Binds raw Realtime transport events to Mimi's canonical turn runner. Only finalized
 * transcripts enter the main Session actor; provider deltas and PCM never become Session state.
 */
export class RealtimeAudioController {
  private unsubscribe: (() => void) | undefined;
  private turnLane: Promise<void> = Promise.resolve();
  private interruptionLane: Promise<void> = Promise.resolve();
  private readonly turns = new Map<string, Promise<CanonicalRealtimeTurnResult>>();

  constructor(
    private readonly port: Pick<RealtimeWebSocketClient, 'subscribe'>,
    private readonly transport: RealtimeAudioTransport,
    private readonly runner: RealtimeCanonicalTurnRunner,
    private readonly speechSink: RealtimeCanonicalSpeechSink,
    private readonly callbacks: RealtimeAudioControllerCallbacks = {},
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.port.subscribe((event) => this.handleEvent(event));
  }

  submitTextFallback(turnId: string, text: string): Promise<CanonicalRealtimeTurnResult> {
    return this.submitStableTurn({ turnId, transcript: text, source: 'text-fallback' });
  }

  async drainTurns(): Promise<void> {
    await Promise.all([this.turnLane, this.interruptionLane]);
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.transport.stop();
    await Promise.all([this.turnLane, this.interruptionLane]);
  }

  private handleEvent(event: RealtimePortEvent): void {
    try {
      switch (event.type) {
        case 'speech_started':
          this.handleSpeechStarted();
          return;
        case 'final_transcript':
          void this.submitStableTurn({
            turnId: event.itemId,
            transcript: event.transcript,
            source: 'realtime-asr',
          }).catch((error) => this.callbacks.onError?.(error));
          return;
        case 'error':
          this.transport.fail(event.error);
          this.callbacks.onError?.(event.error);
          return;
        case 'disconnected':
          return;
        case 'turn_started':
        case 'audio':
        case 'audio_done':
        case 'audio_interrupted':
        case 'turn_done': {
          const error = new Error(
            `Realtime transcription-only transport rejected provider ${event.type}; canonical Mimi is the sole answer owner`,
          );
          this.transport.fail(error);
          this.callbacks.onError?.(error);
          return;
        }
      }
    } catch (error) {
      this.transport.fail(error);
      this.callbacks.onError?.(error);
    }
  }

  private handleSpeechStarted(): void {
    const task = Promise.allSettled([
      Promise.resolve().then(() => this.speechSink.interrupt()),
      Promise.resolve().then(() => this.runner.cancelActiveTurn?.(
        new Error('Realtime speech_started interrupted the active canonical turn'),
      )),
    ]).then(async ([playback, cancellation]) => {
      const errors: unknown[] = [];
      if (playback.status === 'rejected') errors.push(playback.reason);
      if (cancellation.status === 'rejected') errors.push(cancellation.reason);
      if (errors.length) throw new AggregateError(errors, 'Realtime barge-in was incomplete');
      if (playback.status !== 'fulfilled') return;
      const playedMs = playback.value;
      if (!Number.isFinite(playedMs) || playedMs < 0) {
        throw new Error('Realtime speech sink returned invalid playedMs');
      }
      await this.callbacks.onBargeIn?.(Math.floor(playedMs));
    });
    this.interruptionLane = Promise.all([
      this.interruptionLane.catch(() => undefined),
      task,
    ]).then(() => undefined);
    void task.catch((error) => this.callbacks.onError?.(error));
  }

  private submitStableTurn(input: CanonicalRealtimeTurnInput): Promise<CanonicalRealtimeTurnResult> {
    const turnId = input.turnId.trim();
    const transcript = input.transcript.trim();
    if (!turnId || turnId.length > 200) return Promise.reject(new Error('Realtime turn id is invalid'));
    if (!transcript) return Promise.reject(new Error('Realtime stable transcript is empty'));
    const existing = this.turns.get(turnId);
    if (existing) return existing;
    const normalized = Object.freeze({ ...input, turnId, transcript });
    const task = this.turnLane.then(async () => {
      await this.callbacks.onStableTranscript?.(normalized);
      const result = await this.runner.submitStableTurn(normalized);
      await this.speechSink.speak(result.assistantText, normalized);
      await this.callbacks.onAssistantText?.(result, normalized);
      return result;
    });
    this.turns.set(turnId, task);
    this.turnLane = task.then(() => undefined, () => undefined);
    return task;
  }
}
