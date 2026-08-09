import type { AgentInputItem, RunStreamEvent } from '@openai/agents';
import type { ModelProvider } from '../config.js';
import type { ModelRequirements } from '../core/model-routing.js';
import type { RunFinalizationRecord } from '../core/run-finalization.js';
import { attachRunFinalization } from '../core/run-finalization.js';
import type { RuntimeEffect } from './control.js';
import type { RuntimeEvent } from './hooks.js';
import {
  freezeRunModelRequirements,
  type CompletionDeliveryDisposition,
  type ContextUsageSnapshot,
  type MimiAgent,
  type MimiRunOptions,
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
import { legacyModelConfiguration } from './model-config.js';
import { WorkUnitModelResolver } from './work-unit-model-resolver.js';

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

function backupModel(
  route: ProviderBackupRoute,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return route.model ?? (route.provider === 'deepseek'
    ? environment.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-pro'
    : environment.OPENAI_MODEL?.trim() || 'gpt-5.4-mini');
}

function backupIncompatibility(
  route: ProviderBackupRoute,
  requirements: Readonly<ModelRequirements>,
  scenario: string,
): Error | undefined {
  const model = backupModel(route);
  const configuration = legacyModelConfiguration(route.provider === 'deepseek'
    ? { MIMI_MODEL_PROVIDER: 'deepseek', DEEPSEEK_MODEL: model }
    : { MIMI_MODEL_PROVIDER: 'openai', OPENAI_MODEL: model });
  const provider = configuration.providers[0]!;
  const registration = provider.models[0]!;
  const resolver = new WorkUnitModelResolver({
    providers: [provider],
    routing: {
      globalDefault: registration.target,
      scenarios: {},
    },
  });
  try {
    resolver.resolve({
      scenario,
      profile: {
        modelTarget: registration.target,
        requirements: { ...requirements },
      },
      routeVersion: configuration.routeVersion,
    });
    return undefined;
  } catch (error) {
    return new Error(
      `Backup Provider ${route.id} 与冻结 WorkUnit 硬能力不兼容，已在请求前拒绝`,
      { cause: error },
    );
  }
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
  const configuredModel = environment.MIMI_BACKUP_MODEL?.trim();
  const model = configuredModel || (value === 'deepseek'
    ? environment.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-pro'
    : environment.OPENAI_MODEL?.trim() || 'gpt-5.4-mini');
  if (model.length > 200 || !/^[A-Za-z0-9._:/-]+$/.test(model)) {
    throw new Error('MIMI_BACKUP_MODEL 格式无效');
  }
  return {
    id: `${value}:${model}`,
    provider: value,
    model,
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
  return {
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
    let stream: RunStream | undefined;
    let streamedAnswer = '';
    let interruptedAnswer = '';
    let selectedProvider = this.lastProviderId;
    const stopRuntimeEvents = this.agent.onRuntimeEvent((event) => observe(
      observer.onRuntimeEvent,
      this.agent.redactActiveRunData?.(event) ?? event,
    ));
    await observe(observer.onStart, request.input);
    try {
      const providerId = this.providerIdForRun
        ? await this.providerIdForRun(request)
        : this.providerId;
      this.lastProviderId = providerId;
      selectedProvider = providerId;
      const backupIncompatible = this.backupProvider
        ? backupIncompatibility(
            this.backupProvider,
            freezeRunModelRequirements(
              request.modelInput ?? request.input,
              request.options,
            ),
            request.options?.scenario
              ?? (request.options?.cause ? 'background.default' : 'conversation.default'),
          )
        : undefined;
      const candidates: ProviderCandidate[] = [
        { id: providerId, role: 'primary' },
        ...(this.backupProvider && !backupIncompatible
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
                  model: backupModel(this.backupProvider),
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
      for await (const event of stream) {
        const projection = projectRunStreamEvent(event);
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
        if (!hiddenCandidate && !sensitiveModelStream) {
          interruptedAnswer += answerDelta;
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
      const committed = await this.agent.completeRun(answer, usage);
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
      if (stream && classifyProviderFault(error).kind !== 'other') {
        this.providerReliability.failure(selectedProvider, error);
      }
      const safeError = this.agent.redactActiveRunError?.(error) ?? error;
      const terminalReason = request.signal?.aborted
        && isTerminalRunInterruption(request.signal.reason)
        ? request.signal.reason
        : undefined;
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
      const terminalError = failureFinalization
        ? attachRunFinalization(safeError, failureFinalization)
        : safeError;
      await observe(observer.onError, terminalError);
      throw terminalError;
    } finally {
      stopRuntimeEvents();
    }
  }
}
