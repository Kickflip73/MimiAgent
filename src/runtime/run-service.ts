import type { AgentInputItem, RunStreamEvent } from '@openai/agents';
import type { ModelProvider } from '../config.js';
import type { RunFinalizationRecord } from '../core/run-finalization.js';
import { attachRunFinalization } from '../core/run-finalization.js';
import type { RuntimeEffect } from './control.js';
import type { RuntimeEvent } from './hooks.js';
import type {
  CompletionDeliveryDisposition,
  ContextUsageSnapshot,
  MimiAgent,
  MimiRunOptions,
} from './mimi-agent.js';
import { assertRunCanComplete, isRunInterrupted, isTerminalRunInterruption } from './run-outcome.js';
import { projectRunStreamEvent } from './stream-projection.js';
import {
  classifyProviderFault,
  ProviderCircuitBreaker,
  ProviderFailoverCoordinator,
  type ProviderCandidate,
  type ProviderHealthSnapshot,
} from './provider-reliability.js';

export interface AgentRunRequest {
  input: string;
  modelInput?: AgentInputItem[];
  signal?: AbortSignal;
  options?: MimiRunOptions;
}

export type ProviderReliabilityKeyResolver = (
  request: AgentRunRequest,
) => string | Promise<string>;

export interface AgentRunResult {
  answer: string;
  effects: RuntimeEffect[];
  /**
   * Present for MimiAgent executions. Optional only for compatibility with
   * third-party HostedRunExecutor implementations.
   */
  finalization?: RunFinalizationRecord;
  usage?: ContextUsageSnapshot;
  delivery?: CompletionDeliveryDisposition;
}

export interface AgentRunObserver {
  onStart?: (input: string) => void | Promise<void>;
  onStreamEvent?: (event: RunStreamEvent) => void | Promise<void>;
  onRuntimeEvent?: (event: RuntimeEvent) => void | Promise<void>;
  onComplete?: (result: AgentRunResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}

export interface ProviderBackupRoute {
  id: string;
  provider: 'openai' | 'deepseek';
  model?: string;
}

export function providerBackupRouteFromEnvironment(
  primaryProvider: ModelProvider,
  environment: NodeJS.ProcessEnv = process.env,
): ProviderBackupRoute | undefined {
  const value = environment.MIMI_BACKUP_PROVIDER?.trim();
  if (!value) return undefined;
  if (value !== 'openai' && value !== 'deepseek') {
    throw new Error('MIMI_BACKUP_PROVIDER 只能是 openai 或 deepseek');
  }
  if (value === primaryProvider) {
    throw new Error('Backup Provider 必须不同于 Primary Provider');
  }
  const credentialName = value === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY';
  if (!environment[credentialName]?.trim()) {
    throw new Error(`Backup Provider 缺少 ${credentialName}`);
  }
  const model = environment.MIMI_BACKUP_MODEL?.trim();
  if (model && (model.length > 200 || !/^[A-Za-z0-9._:/-]+$/.test(model))) {
    throw new Error('MIMI_BACKUP_MODEL 格式无效');
  }
  return {
    id: `${value}:${model ?? 'default'}`,
    provider: value,
    ...(model ? { model } : {}),
  };
}

type RunStream = Awaited<ReturnType<MimiAgent['stream']>>;

function usageFrom(stream: RunStream | undefined): ContextUsageSnapshot | undefined {
  if (!stream) return undefined;
  const last = stream.rawResponses.at(-1)?.usage;
  const total = stream.runContext.usage;
  const usage = {
    lastRequestInputTokens: last?.inputTokens || undefined,
    lastRequestOutputTokens: last?.outputTokens || undefined,
    runInputTokens: total.inputTokens || undefined,
    runOutputTokens: total.outputTokens || undefined,
    runTotalTokens: total.totalTokens || undefined,
  };
  return Object.values(usage).some((value) => typeof value === 'number' && value > 0) ? usage : undefined;
}

function progressFrom(event: RunStreamEvent): Record<string, unknown> | undefined {
  const projection = projectRunStreamEvent(event);
  if (projection?.kind !== 'status') return undefined;
  const raw = event.type === 'run_item_stream_event'
    ? event.item.rawItem as unknown as { callId?: string; call_id?: string } : undefined;
  return {
    ...((raw?.callId ?? raw?.call_id) ? { callId: raw?.callId ?? raw?.call_id } : {}),
    kind: projection.kind,
    tone: projection.tone,
    title: projection.title,
    ...(event.type === 'run_item_stream_event' && event.name === 'tool_called'
      ? { detail: projection.detail }
      : {}),
    next: projection.next,
  };
}

async function observe<T>(callback: ((value: T) => void | Promise<void>) | undefined, value: T): Promise<void> {
  if (!callback) return;
  try {
    await callback(value);
  } catch {
    // Presentation and telemetry observers must not corrupt durable run state.
  }
}

export class AgentRunService {
  private readonly providerReliability: ProviderCircuitBreaker;
  private readonly providerId: string;
  private readonly providerIdForRun?: ProviderReliabilityKeyResolver;
  private lastProviderId: string;
  private readonly backupProvider?: ProviderBackupRoute;
  private readonly providerFailover: ProviderFailoverCoordinator;

  constructor(
    private readonly agent: MimiAgent,
    options: {
      providerId?: string;
      providerIdForRun?: ProviderReliabilityKeyResolver;
      providerReliability?: ProviderCircuitBreaker;
      backupProvider?: ProviderBackupRoute;
    } = {},
  ) {
    this.providerId = options.providerId ?? 'configured';
    this.providerIdForRun = options.providerIdForRun;
    this.lastProviderId = this.providerId;
    this.providerReliability = options.providerReliability ?? new ProviderCircuitBreaker();
    this.backupProvider = options.backupProvider;
    this.providerFailover = new ProviderFailoverCoordinator(this.providerReliability);
  }

  providerHealth(): ProviderHealthSnapshot {
    return this.providerReliability.health(this.lastProviderId);
  }

  providerHealthRoutes(): ProviderHealthSnapshot[] {
    const routes = [this.lastProviderId, ...(this.backupProvider ? [this.backupProvider.id] : [])];
    return routes.map((providerId) => this.providerReliability.health(providerId));
  }

  async execute(request: AgentRunRequest, observer: AgentRunObserver = {}): Promise<AgentRunResult> {
    const startedAt = performance.now();
    const phases: Record<string, number> = {};
    let timingSessionId: string | undefined;
    let stream: RunStream | undefined;
    let streamedAnswer = '';
    let interruptedAnswer = '';
    let selectedProvider = this.lastProviderId;
    let traceRunId: string | undefined;
    let reasoning = '', reasoningStartedAt: string | undefined;
    let afterAnswer = -1, answerBoundary = true;
    let reasoningTruncated = false, reasoningBudget = 256_000;
    const flushReasoning = async (): Promise<void> => {
      if (!reasoning || !traceRunId) return;
      const observation = { runId: traceRunId, afterAnswer, text: reasoning, startedAt: reasoningStartedAt,
        endedAt: new Date().toISOString(), truncated: reasoningTruncated };
      reasoning = ''; reasoningStartedAt = undefined; reasoningTruncated = false;
      // One durable entry per reasoning phase, never one Session write per delta.
      await this.agent.recordEvent('reasoning', observation, traceRunId).catch(() => undefined);
    };
    const stopRuntimeEvents = this.agent.onRuntimeEvent((event) => {
      if (event.type === 'run_start') {
        traceRunId = this.agent.activeRunId;
        timingSessionId = event.sessionId;
      }
      return observe(observer.onRuntimeEvent, this.agent.redactActiveRunData?.(event) ?? event);
    });
    await observe(observer.onStart, request.input);
    try {
      const providerId = this.providerIdForRun
        ? await this.providerIdForRun(request)
        : this.providerId;
      this.lastProviderId = providerId;
      selectedProvider = providerId;
      const candidates: ProviderCandidate[] = [
        { id: providerId, role: 'primary' },
        ...(this.backupProvider
          ? [{ id: this.backupProvider.id, role: 'backup' as const }]
          : []),
      ];
      const acquired = await this.providerFailover.execute(
        candidates,
        (candidate) => this.agent.stream(
          request.modelInput ?? request.input,
          request.signal,
          candidate.role === 'backup' && this.backupProvider
            ? {
                ...request.options,
                providerRoute: {
                  provider: this.backupProvider.provider,
                  ...(this.backupProvider.model ? { model: this.backupProvider.model } : {}),
                },
              }
            : request.options,
        ),
        {
          // The SDK streaming handle is returned before model events or tools
          // can execute. Once acquired, this service never switches Provider.
          sideEffectsStarted: () => false,
          deferSuccess: true,
        },
      );
      selectedProvider = acquired.provider;
      stream = acquired.value;
      traceRunId = this.agent.activeRunId;
      timingSessionId = this.agent.currentSessionId;
      phases.prepareMs = performance.now() - startedAt;
      for await (const event of stream) {
        const projection = projectRunStreamEvent(event);
        if (projection?.kind === 'answer' && phases.firstAnswerMs === undefined) phases.firstAnswerMs = performance.now() - startedAt;
        const answerDelta = projection?.kind === 'answer' ? projection.text : '';
        streamedAnswer += answerDelta;
        const safeEvent = this.agent.redactActiveRunData?.(event) ?? event;
        const hiddenCandidate = this.agent.completionGateRequired
          && event.type === 'raw_model_stream_event'
          && event.data.type === 'output_text_delta';
        // Exact-value redaction cannot safely reconstruct a credential split
        // across Provider text or reasoning deltas. Suppress every raw model
        // stream event for an ephemeral-sensitive Run and expose only the
        // redacted final answer plus non-model status events.
        const sensitiveModelStream = this.agent.activeRunHasEphemeralSensitiveAccess
          && event.type === 'raw_model_stream_event';
        if (!sensitiveModelStream && projection?.kind === 'reasoning' && traceRunId) {
          reasoningStartedAt ??= new Date().toISOString();
          const available = Math.max(0, Math.min(64_000 - reasoning.length, reasoningBudget));
          const piece = projection.text.slice(0, available);
          reasoning += piece; reasoningBudget -= piece.length;
          reasoningTruncated ||= piece.length < projection.text.length;
        } else if (projection && projection.kind !== 'reasoning') {
          await flushReasoning();
        }
        if (!hiddenCandidate && !sensitiveModelStream) {
          if (projection?.kind === 'answer') {
            if (answerBoundary) afterAnswer += 1;
            answerBoundary = false;
          } else if (projection) answerBoundary = true;
          interruptedAnswer += answerDelta;
          await observe(observer.onStreamEvent, safeEvent);
        }
        const progress = progressFrom(safeEvent);
        if (progress) await this.agent.recordEvent('status', {...progress, afterAnswer});
      }
      await flushReasoning();
      await stream.completed;
      assertRunCanComplete(stream, request.signal);
      this.providerReliability.success(selectedProvider);
      const finalOutput = stream.finalOutput;
      const rawAnswer = (typeof finalOutput === 'string'
        ? finalOutput
        : finalOutput === undefined ? streamedAnswer : JSON.stringify(finalOutput)).slice(0, 20_000);
      const answer = this.agent.redactActiveRunText?.(rawAnswer) ?? rawAnswer;
      const usage = usageFrom(stream);
      phases.streamMs = performance.now() - startedAt - (phases.prepareMs ?? 0);
      const commitStartedAt = performance.now();
      const committed = await this.agent.completeRun(answer, usage);
      phases.commitMs = performance.now() - commitStartedAt;
      const result = {
        answer: committed.answer,
        effects: committed.effects,
        finalization: committed.finalization,
        usage,
        delivery: await request.options?.completionDelivery?.(),
      } satisfies AgentRunResult;
      await observe(observer.onComplete, result);
      return result;
    } catch (error) {
      traceRunId ??= this.agent.activeRunId;
      timingSessionId ??= this.agent.currentSessionId;
      if (phases.prepareMs === undefined) phases.prepareMs = performance.now() - startedAt;
      else phases.streamMs = performance.now() - startedAt - phases.prepareMs;
      await flushReasoning();
      if (request.signal?.aborted || isRunInterrupted(error, request.signal)) {
        this.providerReliability.cancel(selectedProvider);
      } else if (stream && classifyProviderFault(error).kind !== 'other') {
        this.providerReliability.failure(selectedProvider, error);
      }
      const safeError = this.agent.redactActiveRunError?.(error) ?? error;
      const terminalReason = request.signal?.aborted
        && isTerminalRunInterruption(request.signal.reason)
        ? request.signal.reason
        : undefined;
      const failureCommitStartedAt = performance.now();
      const commitFailure = this.agent.failRun(
        isTerminalRunInterruption(error)
          ? safeError
          : terminalReason
            ? this.agent.redactActiveRunError?.(terminalReason) ?? terminalReason
            : safeError,
        Boolean(stream) || isRunInterrupted(error, request.signal),
        usageFrom(stream),
        interruptedAnswer,
      );
      const failureFinalization = stream
        ? await commitFailure
        : await commitFailure.catch(() => undefined);
      phases.commitMs = performance.now() - failureCommitStartedAt;
      const terminalError = failureFinalization
        ? attachRunFinalization(safeError, failureFinalization)
        : safeError;
      await observe(observer.onError, terminalError);
      throw terminalError;
    } finally {
      stopRuntimeEvents();
      phases.totalMs = performance.now() - startedAt;
      if (traceRunId && timingSessionId) {
        await this.agent.recordRunTiming?.(timingSessionId, traceRunId, phases).catch(() => undefined);
      }
    }
  }
}
