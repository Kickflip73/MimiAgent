import type { AgentInputItem, RunStreamEvent } from '@openai/agents';
import type { ModelProvider } from '../config.js';
import type { RuntimeEffect } from './control.js';
import type { RuntimeEvent } from './hooks.js';
import type {
  CompletionDeliveryDisposition,
  ContextUsageSnapshot,
  MimiAgent,
  MimiRunOptions,
} from './mimi-agent.js';
import { assertRunCanComplete, isRunInterrupted, isTerminalRunInterruption } from './run-outcome.js';
import { RunCommitCoordinator } from './pipeline/run-commit-coordinator.js';
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

export interface AgentRunResult {
  answer: string;
  effects: RuntimeEffect[];
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

function answerDelta(event: RunStreamEvent): string {
  return event.type === 'raw_model_stream_event'
    && event.data.type === 'output_text_delta'
    ? event.data.delta
    : '';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function progressFrom(event: RunStreamEvent): Record<string, unknown> | undefined {
  if (event.type === 'agent_updated_stream_event') {
    return { kind: 'status', tone: 'agent', title: event.agent.name, next: 'Agent 工作中' };
  }
  if (event.type !== 'run_item_stream_event') return undefined;
  const raw = record(record(event.item)?.rawItem);
  if (event.name === 'tool_called') {
    const name = typeof raw?.name === 'string' ? raw.name : 'unknown';
    return {
      kind: 'status',
      tone: 'tool',
      title: name,
      detail: typeof raw?.arguments === 'string' ? raw.arguments.slice(0, 1_000) : raw?.arguments,
      next: `正在执行 ${name}`,
    };
  }
  if (event.name === 'tool_output') {
    const name = typeof raw?.name === 'string' ? raw.name : 'tool';
    return { kind: 'status', tone: 'success', title: name, next: '模型继续思考' };
  }
  return undefined;
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
  private readonly commits: RunCommitCoordinator;
  private readonly providerReliability: ProviderCircuitBreaker;
  private readonly providerId: string;
  private readonly backupProvider?: ProviderBackupRoute;
  private readonly providerFailover: ProviderFailoverCoordinator;

  constructor(
    private readonly agent: MimiAgent,
    options: {
      providerId?: string;
      providerReliability?: ProviderCircuitBreaker;
      backupProvider?: ProviderBackupRoute;
    } = {},
  ) {
    this.providerId = options.providerId ?? 'configured';
    this.providerReliability = options.providerReliability ?? new ProviderCircuitBreaker();
    this.backupProvider = options.backupProvider;
    this.providerFailover = new ProviderFailoverCoordinator(this.providerReliability);
    this.commits = new RunCommitCoordinator({
      complete: (answer, usage) => this.agent.completeRun(answer, usage),
      fail: (error, interrupted, usage) => this.agent.failRun(error, interrupted, usage),
    });
  }

  providerHealth(): ProviderHealthSnapshot {
    return this.providerReliability.health(this.providerId);
  }

  providerHealthRoutes(): ProviderHealthSnapshot[] {
    return [
      this.providerReliability.health(this.providerId),
      ...(this.backupProvider
        ? [this.providerReliability.health(this.backupProvider.id)]
        : []),
    ];
  }

  async execute(request: AgentRunRequest, observer: AgentRunObserver = {}): Promise<AgentRunResult> {
    let stream: RunStream | undefined;
    let streamedAnswer = '';
    let selectedProvider = this.providerId;
    let streamAcquired = false;
    const stopRuntimeEvents = this.agent.onRuntimeEvent((event) => observe(
      observer.onRuntimeEvent,
      this.agent.redactActiveRunData?.(event) ?? event,
    ));
    await observe(observer.onStart, request.input);
    try {
      const candidates: ProviderCandidate[] = [
        { id: this.providerId, role: 'primary' },
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
      streamAcquired = true;
      for await (const event of stream) {
        streamedAnswer += answerDelta(event);
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
        if (!hiddenCandidate && !sensitiveModelStream) {
          await observe(observer.onStreamEvent, safeEvent);
        }
        const progress = progressFrom(safeEvent);
        if (progress) await this.agent.recordEvent('status', progress);
      }
      await stream.completed;
      assertRunCanComplete(stream, request.signal);
      this.providerReliability.success(selectedProvider);
      const finalOutput = stream.finalOutput;
      const rawAnswer = (typeof finalOutput === 'string'
        ? finalOutput
        : finalOutput === undefined ? streamedAnswer : JSON.stringify(finalOutput)).slice(0, 20_000);
      const answer = this.agent.redactActiveRunText?.(rawAnswer) ?? rawAnswer;
      const usage = usageFrom(stream);
      const effects = await this.commits.complete({ answer, usage });
      const committedAnswer = this.agent.completedRunAnswer ?? answer;
      const result = {
        answer: committedAnswer,
        effects,
        usage,
        delivery: await request.options?.completionDelivery?.(),
      } satisfies AgentRunResult;
      await observe(observer.onComplete, result);
      return result;
    } catch (error) {
      if (streamAcquired && classifyProviderFault(error).kind !== 'other') {
        this.providerReliability.failure(selectedProvider, error);
      }
      const safeError = this.agent.redactActiveRunError?.(error) ?? error;
      const terminalReason = request.signal?.aborted
        && isTerminalRunInterruption(request.signal.reason)
        ? request.signal.reason
        : undefined;
      const commitFailure = this.commits.fail({
        error: isTerminalRunInterruption(error)
          ? safeError
          : terminalReason
            ? this.agent.redactActiveRunError?.(terminalReason) ?? terminalReason
            : safeError,
        interrupted: isRunInterrupted(error, request.signal),
        usage: usageFrom(stream),
      });
      if (streamAcquired) await commitFailure;
      else await commitFailure.catch(() => undefined);
      await observe(observer.onError, safeError);
      throw safeError;
    } finally {
      stopRuntimeEvents();
    }
  }
}
