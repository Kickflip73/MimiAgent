import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  getAllMcpTools,
  Runner,
  type AgentInputItem,
  type Tool,
} from '@openai/agents';
import {
  preferredEnvironmentValue,
  privateRuntimePaths,
  SECURITY_PROFILES,
  securityProfileSummary,
  type AgentPermissionMode,
  type AppConfig,
  type SecurityProfile,
} from '../config.js';
import {
  ContextManager,
  estimateTokens,
  type ContextManifest,
  type ContextSemanticSummarizer,
  type ContextStats,
  type MimiContextStatus,
} from '../core/context.js';
import { ProjectGuidanceLoader, SoulLoader } from '../core/guidance.js';
import { ExecutionLedger, type ExecutionCallRecord } from '../core/execution-ledger.js';
import type { ActionIntent, OneTimeActionAuthorization } from '../core/action-intent.js';
import {
  type CompletionContract,
  type CompletionReport,
} from '../core/completion.js';
import {
  contentDigest,
  type CaptureInput,
  type MemoryHub,
  type MemoryRef,
  type SourceRef,
} from '../core/memory.js';
import type { PreferenceStore } from '../core/preferences.js';
import { PlanStore, type PlanStep } from '../core/plan.js';
import type { RunFinalizationRecord } from '../core/run-finalization.js';
import type { RunCommitJournal } from '../core/run-commit-journal.js';
import { FileChangeJournal } from '../core/file-change-journal.js';
import {
  defaultTeamTaskComplexity,
  TeamTaskStore,
  type TeamTask,
  type TeamTaskInput,
} from '../core/team.js';
import {
  modelTargetKey,
  runModelBindingSchema,
  type ProviderDefinition,
  type ProviderTransport,
  type ModelTarget,
  type RunModelBinding,
  type WorkUnitModelProfile,
} from '../core/model-routing.js';
import {
  FileSession,
  type RunCheckpoint,
  type SessionPreferences,
  type SessionSummary,
} from '../core/session.js';
import { TraceStore } from '../core/trace.js';
import { MCPManager } from '../extensions/mcp.js';
import { createMemoryTools } from '../extensions/memory/tools.js';
import { SkillLoader } from '../extensions/skills.js';
import { createComputerTools } from '../extensions/computer/tools.js';
import type { ComputerManager } from '../extensions/computer/manager.js';
import { QqPersonalMessageComputerAdapter } from '../extensions/computer/qq-personal-message.js';
import type { ComputerAccess, ComputerTargetSummary } from '../extensions/computer/types.js';
import type { PersonalMessageAuthorization } from '../core/personal-message.js';
import { configuredProviders } from '../provider-config.js';
import { createTools } from '../tools.js';
import { HookBus, type RuntimeHook } from './hooks.js';
import {
  createRuntimeControlTools,
  RUNTIME_OUTPUT_LEVELS,
  type RuntimeAction,
  type RuntimeEffect,
  type RuntimeOutputLevel,
} from './control.js';
import { AGENT_MODES, type AgentMode } from './instructions.js';
import {
  createModel,
  resolveModelProfile,
  type AgentModel,
} from './model.js';
import type { ModelProfile } from './model.js';
import { buildResumePrompt } from './session-state.js';
import {
  toolNamesForMode,
  type RunToolPolicy,
  type ToolCapability,
} from './tool-policy.js';
import { createRuntimeComponents, type RuntimeComponents } from './components.js';
import type { ModelsConfig } from './model-config.js';
import { ModelGateway } from './model-gateway.js';
import { WorkUnitModelResolver } from './work-unit-model-resolver.js';
import type { SessionStatePort } from './state-ports.js';
import { CompletionCoordinator } from './completion-coordinator.js';
import { restrictedShellEnvironment } from './shell-environment.js';
import { RunContextBuilder } from './run-context-builder.js';
import { RuntimeActionCoordinator } from './runtime-action-coordinator.js';
import {
  RuntimeControlCoordinator,
  type RuntimeControlHost,
} from './runtime-control-coordinator.js';
import { createPlanTools } from './plan-tools.js';
import { ContextAssembler } from './pipeline/context-assembler.js';
import {
  CapabilityResolver,
} from './pipeline/capability-resolver.js';
import type {
  EffectiveCapabilityItem,
  EffectiveCapabilitySnapshot,
} from './pipeline/capability-resolver.js';
import type { RunScope } from './pipeline/run-scope.js';
import {
  type CapabilityCatalogAccess,
} from './pipeline/capability-registry.js';
import { ToolSetBuilder } from './pipeline/tool-set-builder.js';
import { AgentRequestFactory } from './pipeline/request-factory.js';
import {
  containsImageInput,
  executeRunPipeline,
  type RunPipelineHost,
} from './pipeline/run-pipeline.js';
import {
  RunCommitCoordinator,
  type RunCommitCoordinatorPort,
} from './pipeline/run-commit-coordinator.js';
import { RunFactCollector } from './pipeline/run-fact-collector.js';
import { PersonalMessageHub, type PersonalMessageScope } from './personal-message-hub.js';
import {
  createMimiPreferenceTools,
} from './preference-tools.js';
import { createModelControlTools } from './model-control-tools.js';
import { createMediaTools, MediaRuntime } from './media-runtime.js';
import { ModelConfigStore } from './model-config.js';
import {
  redactActiveEphemeralData,
  redactActiveEphemeralText,
  type ActiveEphemeralOwnerInput,
  type EphemeralOwnerInputLease,
} from './ephemeral-owner-input.js';

export { AGENT_MODES } from './instructions.js';
export type { AgentMode } from './instructions.js';

export interface ActiveRun {
  scope: RunScope;
  runId: string;
  ownerId: string;
  releaseOwner: () => void;
  sessionId: string;
  session: FileSession;
  input: string;
  options?: MimiRunOptions;
  pendingActions: RuntimeAction[];
  completionRequired: boolean;
  completionContract?: CompletionContract;
  completionReport?: CompletionReport;
  goalCreatedAt?: string;
  requireDurableBlocker: boolean;
  recoveryRunId?: string;
  plans?: PlanStore;
  team?: TeamTaskStore;
  planOwned?: boolean;
  teamOwned?: boolean;
  availableToolNames?: readonly string[];
  capabilitySnapshot?: Readonly<EffectiveCapabilitySnapshot>;
  canReadLocal?: boolean;
  computerAccess: ComputerAccess;
  pendingContextResults: Map<string, AgentInputItem>;
  facts: RunFactCollector;
  ephemeralSensitiveAccess?: ActiveEphemeralOwnerInput;
}

export interface ContextUsageSnapshot {
  lastRequestInputTokens?: number;
  lastRequestOutputTokens?: number;
  runInputTokens?: number;
  runOutputTokens?: number;
  runTotalTokens?: number;
  providerId?: string;
  modelId?: string;
  scenario?: string;
  selectionReason?: RunModelBinding['reason'];
  cost?: 'unknown';
}

export interface CompletedExecutionReceipt {
  runId: string;
  answer: string;
  finalization: RunFinalizationRecord;
  usage?: ContextUsageSnapshot;
  actions?: RuntimeAction[];
  effects?: RuntimeEffect[];
  delivery?: CompletionDeliveryDisposition;
}

export interface CompletionDeliveryDisposition {
  suppressed: true;
  reason?: string;
}

export type RunTrust = 'owner' | 'trusted' | 'external' | 'public' | 'system';

export interface RunCause {
  eventId: string;
  taskId?: string;
  profileId?: string;
  source: string;
  actor?: string;
  conversation?: string;
  trust: RunTrust;
  personId?: string;
  personName?: string;
}

export interface RunPolicy extends RunToolPolicy {
  allowMcp?: boolean;
  allowSessionContext?: boolean;
  computerAccess?: ComputerAccess;
  computerApps?: readonly string[];
}

export interface MimiRunOptions {
  cause?: RunCause;
  policy?: RunPolicy;
  hostInstructions?: string;
  hostTools?: Tool[];
  ephemeralOwnerInput?: EphemeralOwnerInputLease;
  personalConnectorOnly?: boolean;
  executionKey?: string;
  retainExecutionLedger?: boolean;
  authorizeSideEffect?: (toolName: string, argumentsJson: string) => Promise<void>;
  resolveActionAuthorization?: (
    intent: ActionIntent,
    authorizationId: string,
  ) => Promise<OneTimeActionAuthorization | undefined>;
  requireCompletionGate?: boolean;
  completionContract?: CompletionContract;
  resumeState?: boolean;
  computerAccess?: ComputerAccess;
  computerApps?: readonly string[];
  /** @deprecated Legacy Connector app claims no longer filter a whole Computer Run. */
  computerDeniedApps?: readonly string[];
  completionDelivery?: (calls?: readonly ExecutionCallRecord[]) => CompletionDeliveryDisposition | undefined
    | Promise<CompletionDeliveryDisposition | undefined>;
  personalMessage?: PersonalMessageScope;
  capabilityItems?: readonly EffectiveCapabilityItem[];
  capabilityCatalog?: CapabilityCatalogAccess;
  providerRoute?: {
    provider: AppConfig['provider'];
    model?: string;
  };
  modelProfile?: WorkUnitModelProfile;
  scenario?: string;
}

export interface AgentSessionSnapshot {
  sessionId: string;
  summary: SessionSummary;
  items: AgentInputItem[];
  recovery?: RunCheckpoint;
  plan: PlanStep[];
  runtime: {
    provider: string;
    transport?: ProviderTransport;
    model: string;
    modelTarget?: ModelTarget;
    mode: (typeof AGENT_MODES)[number];
    outputLevel: RuntimeOutputLevel;
    permissionMode: AgentPermissionMode;
    securityProfile: ReturnType<typeof securityProfileSummary>;
  };
  context: {
    estimatedTokens: number;
    contextWindow: number;
    status: MimiContextStatus;
  };
}

export interface MimiAgentCreateOptions {
  protectRuntimePathsFromShell?: boolean;
  shellEnvironment?: NodeJS.ProcessEnv;
  shellDetachedProcessGroup?: boolean;
  restrictReadsToWorkspace?: boolean;
  mcpEnvironment?: Readonly<Record<string, string>>;
  enableMcp?: boolean;
  releaseMcpEnvironmentAfterConnect?: boolean;
  modelConfiguration?: ModelsConfig;
  modelBinding?: RunModelBinding;
  contextSemanticSummarizer?: ContextSemanticSummarizer;
}

export const READ_ONLY_EVENT_CAPABILITIES = [
  'delivery-control',
] as const satisfies readonly ToolCapability[];

function initialMode(): AgentMode {
  const value = preferredEnvironmentValue('MIMI_MODE', 'AGENT_MODE');
  return AGENT_MODES.some((item) => item.id === value) ? value as AgentMode : 'general';
}

function initialOutputLevel(): RuntimeOutputLevel {
  const value = preferredEnvironmentValue('MIMI_OUTPUT_LEVEL', 'OUTPUT_LEVEL');
  return RUNTIME_OUTPUT_LEVELS.includes(value as RuntimeOutputLevel) ? value as RuntimeOutputLevel : 'tools';
}

export class MimiAgent {
  private readonly runner: Runner;
  private context: ContextManager;
  private readonly soul: SoulLoader;
  private readonly preferences: PreferenceStore;
  private readonly projectGuidance: ProjectGuidanceLoader;
  private readonly memory: MemoryHub;
  private readonly skills: SkillLoader;
  private readonly plans: PlanStore;
  private readonly team: TeamTaskStore;
  private readonly traces: TraceStore;
  private readonly ledger: ExecutionLedger;
  private readonly runCommits: RunCommitJournal;
  private readonly fileChanges: FileChangeJournal;
  private readonly sessions: SessionStatePort;
  private readonly mcp: MCPManager;
  private readonly computer?: ComputerManager;
  private readonly qqPersonalMessages?: QqPersonalMessageComputerAdapter;
  private readonly hooks = new HookBus();
  private readonly completion: CompletionCoordinator;
  private readonly runCommitCoordinator: RunCommitCoordinator;
  private readonly runtimeControlCoordinator: RuntimeControlCoordinator;
  private readonly runtimeActions: RuntimeActionCoordinator;
  private readonly runContexts: RunContextBuilder;
  private readonly contextAssembler = new ContextAssembler();
  private readonly capabilityResolver = new CapabilityResolver();
  private readonly toolSetBuilder = new ToolSetBuilder();
  private readonly requestFactory = new AgentRequestFactory();
  private modelConfig: ModelsConfig;
  private modelGateway: ModelGateway;
  private modelResolver: WorkUnitModelResolver;
  private readonly fixedModelBinding?: RunModelBinding;
  private readonly legacyModels: boolean;
  private readonly personalMessages = new PersonalMessageHub();
  private readonly localTools: Readonly<Record<SecurityProfile, {
    hosted: Tool[];
    portable: Tool[];
  }>>;
  private readonly extensionTools: Tool[];
  private readonly mcpTools: Tool[];
  private session: FileSession;
  private sessionId: string;
  private mode: AgentMode = initialMode();
  private outputLevel: RuntimeOutputLevel = initialOutputLevel();
  private readonly defaultMode: AgentMode;
  private readonly defaultOutputLevel: RuntimeOutputLevel;
  private defaultModelTarget: ModelTarget;
  private permissionMode: AgentPermissionMode;
  private securityProfile: SecurityProfile;
  private defaultPermissionMode: AgentPermissionMode;
  private defaultSecurityProfile: SecurityProfile;
  private boundSessionActorId?: string;
  private activeRun?: ActiveRun;
  private lastCapabilitySnapshot?: Readonly<EffectiveCapabilitySnapshot>;
  private lastContextTokens = 0;
  private lastContextStats?: ContextStats;
  private lastContextManifest?: ContextManifest;
  private lastCompressionCount = 0;
  private modelProfile: ModelProfile;
  private lastUsage?: ContextUsageSnapshot;
  private lastCommittedAnswer?: string;
  private lastFinalization?: RunFinalizationRecord;
  private lastModelBinding?: RunModelBinding;
  private readonly runtimeRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
  private readonly contextSemanticSummarizer?: ContextSemanticSummarizer;

  private constructor(
    private readonly config: AppConfig,
    components: RuntimeComponents,
    createOptions: MimiAgentCreateOptions = {},
  ) {
    this.modelConfig = components.modelConfig;
    this.modelGateway = components.modelGateway;
    this.modelResolver = components.modelResolver;
    this.fixedModelBinding = createOptions.modelBinding
      ? runModelBindingSchema.parse(structuredClone(createOptions.modelBinding))
      : undefined;
    this.contextSemanticSummarizer = createOptions.contextSemanticSummarizer;
    this.legacyModels = components.legacyModels;
    this.context = components.context;
    this.soul = components.soul;
    this.preferences = components.preferences;
    this.projectGuidance = components.projectGuidance;
    this.memory = components.memory;
    this.skills = components.skills;
    this.plans = components.state.goalsAndPlans.store;
    this.team = components.state.team.store;
    this.traces = components.state.traces;
    this.ledger = components.state.executionLedger.store;
    this.runCommits = components.state.runCommits;
    this.fileChanges = new FileChangeJournal(
      path.join(config.dataRoot, 'file-changes'),
      config.workspaceRoot,
      () => this.activeRun?.options?.executionKey ?? this.activeRun?.runId,
    );
    this.sessions = components.state.sessions;
    this.completion = new CompletionCoordinator(this.ledger);
    this.runtimeActions = new RuntimeActionCoordinator(
      this.ledger,
      (action, originSessionId, executionKey) =>
        this.applyRuntimeAction(action, originSessionId, executionKey),
    );
    this.mcp = components.mcp;
    this.computer = components.computer;
    this.qqPersonalMessages = components.computer
      ? new QqPersonalMessageComputerAdapter(components.computer, config.dataRoot)
      : undefined;
    this.sessionId = components.sessionId;
    this.modelName = components.modelRuntime.name;
    this.modelProfile = components.modelRuntime.profile;
    const initialSecurity = securityProfileSummary(config);
    this.permissionMode = initialSecurity.permissionMode;
    this.securityProfile = initialSecurity.id;
    this.runContexts = new RunContextBuilder(config.workspaceRoot, () => this.sessionId);
    this.defaultMode = this.mode;
    this.defaultOutputLevel = this.outputLevel;
    this.defaultModelTarget = { ...components.modelConfig.routing.globalDefault };
    this.defaultPermissionMode = this.permissionMode;
    this.defaultSecurityProfile = this.securityProfile;
    this.session = this.createSession(this.sessionId);
    this.plans.onChange((sessionId, steps) => this.hooks.emit({ type: 'plan_updated', sessionId, steps }));
    this.runner = new Runner({
      workflowName: 'MimiAgent',
      // Local JSONL traces stay provider-independent and avoid sending tool data elsewhere.
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
      // A provider may occasionally emit a stale or hallucinated tool name. Feed the
      // failure back to the model so it can retry with the advertised tools instead
      // of aborting the entire user run before any tool executes.
      toolNotFoundBehavior: 'return_error_to_model',
    });
    this.runCommitCoordinator = new RunCommitCoordinator(
      this as unknown as RunCommitCoordinatorPort,
    );
    this.runtimeControlCoordinator = new RuntimeControlCoordinator(
      this as unknown as RuntimeControlHost,
    );
    this.hooks.on(async (event) => {
      const traceType = event.type === 'run_start'
        ? 'turn_start'
        : event.type === 'run_end'
          ? 'turn_end'
          : event.type === 'run_error' ? (event.interrupted ? 'turn_interrupted' : 'error') : event.type;
      await this.traces.record(event.sessionId, traceType, event);
    });
    const createLocalTools = (
      access: Parameters<typeof createTools>[3],
      includeOpenAIHostedTools: boolean,
    ) => createTools(
      config.workspaceRoot,
      includeOpenAIHostedTools,
      privateRuntimePaths(config),
      access,
    );
    const baseShellEnvironment = createOptions.shellEnvironment ?? restrictedShellEnvironment(process.env);
    const localToolAccess: Record<SecurityProfile, Parameters<typeof createTools>[3]> = {
      safe: {
        readablePaths: ['.'],
        writablePaths: [],
        allowWrite: false,
        allowShell: false,
        mutationObserver: this.fileChanges,
      },
      workstation: {
        readablePaths: ['.'],
        writablePaths: ['.'],
        allowWrite: true,
        allowShell: true,
        shellEnvironment: baseShellEnvironment,
        shellDetachedProcessGroup: createOptions.shellDetachedProcessGroup,
        // Full-owner sessions may intentionally invoke an activated, owner-installed Skill whose
        // verified CLI transport is CuaDriver (for example qq-messenger-skill). Workstation mode
        // remains unable to reach the Computer backend socket, while full-owner preserves the
        // owner's explicit local-machine authority. GUI routing instructions still prohibit ad-hoc
        // shell automation; this exception only removes the transport-level false negative.
        mutationObserver: this.fileChanges,
      },
      'full-owner': {
        ...(createOptions.restrictReadsToWorkspace ? { readablePaths: ['.'] } : {}),
        allowProtectedPathShellAccess: createOptions.protectRuntimePathsFromShell !== true,
        allowShell: true,
        shellEnvironment: () => ({
          ...baseShellEnvironment,
          ...this.activeRun?.ephemeralSensitiveAccess?.shellEnvironment,
        }),
        shellSensitiveValues: () => Object.values(
          this.activeRun?.ephemeralSensitiveAccess?.shellEnvironment ?? {},
        ),
        shellDetachedProcessGroup: createOptions.shellDetachedProcessGroup,
        ...(config.computer?.backend === 'cua' ? {
          blockedUnixSocketPaths: [
            path.join(os.homedir(), 'Library', 'Caches', 'cua-driver', 'cua-driver.sock'),
          ],
        } : {}),
        mutationObserver: this.fileChanges,
      },
    };
    this.localTools = {
      safe: {
        hosted: createLocalTools(localToolAccess.safe, true),
        portable: createLocalTools(localToolAccess.safe, false),
      },
      workstation: {
        hosted: createLocalTools(localToolAccess.workstation, true),
        portable: createLocalTools(localToolAccess.workstation, false),
      },
      'full-owner': {
        hosted: createLocalTools(localToolAccess['full-owner'], true),
        portable: createLocalTools(localToolAccess['full-owner'], false),
      },
    };
    const computerTools = this.computer ? createComputerTools(this.computer, () => {
      const active = this.activeRun;
      if (!active) return undefined;
      const policy = active.options?.policy;
      const ownerAuthorized = active.scope.securityProfile === 'full-owner'
        && (!active.options?.cause || active.options.cause.trust === 'owner');
      return {
        runId: active.runId,
        access: ownerAuthorized ? active.computerAccess : 'none',
        ...((active.options?.computerApps ?? policy?.computerApps)
          ? { allowedApps: active.options?.computerApps ?? policy?.computerApps }
          : {}),
        supportsImageInput: active.scope.modelBinding
          ? this.modelGateway.inspect(active.scope.modelBinding.target).capabilities.imageInput
          : this.modelProfile.supportsImageInput,
      };
    }) : [];
    this.mcpTools = this.mcp.createTools();
    this.extensionTools = [
      ...computerTools,
      ...this.skills.createTools({
        access: () => ({
          canReadLocal: this.activeRun?.canReadLocal === true,
          availableTools: this.activeRun?.availableToolNames,
        }),
        getBinding: async (name) => (
          await this.activeRun?.session.getActiveSkills()
        )?.find((binding) => binding.name === name),
        activate: async (skill) => {
          const active = this.activeRun;
          if (!active) return 'stale_run';
          return active.session.activateSkill({
            name: skill.name,
            sourceId: skill.source.id,
            file: skill.file,
            contentHash: skill.contentHash,
          }, active.runId);
        },
      }),
      ...createRuntimeControlTools({
        status: (projection) => this.runtimeStatus(projection),
        models: () => this.availableModels(),
        providers: () => configuredProviders(),
        modes: () => this.availableModes(),
        listSessions: async () => (await this.listSessionSummaries()).map(({ id, updatedAt, turns, recoverable }) => ({
          id, updatedAt, turns, recoverable,
        })),
        history: async (limit) => (await (this.activeRun?.session ?? this.session).getItems()).slice(-limit),
        schedule: (action) => {
          if (!this.activeRun) throw new Error('当前没有可绑定的运行，无法调度操作');
          this.activeRun.pendingActions.push(action);
        },
      }).filter((tool) => this.legacyModels
        || (tool.name !== 'switch_model' && tool.name !== 'switch_provider')),
      ...createModelControlTools({
        list: () => this.modelControl({ action: 'list' }),
        inspect: (target) => this.modelControl({ action: 'inspect', target }),
        current: () => this.modelControl({ action: 'current' }),
        setSession: (target) => this.modelControl({ action: 'use', target }),
        clearSession: () => this.modelControl({ action: 'auto' }),
        routes: () => this.modelControl({ action: 'routes' }),
        setRoute: (scenario, route) => this.modelControl(route?.target
          ? {
              action: 'route',
              scenario,
              target: route.target,
              ...(route.maxTurns ? { maxTurns: route.maxTurns } : {}),
              ...(route.maxOutputTokens ? { maxOutputTokens: route.maxOutputTokens } : {}),
            }
          : { action: 'route', scenario, routeAuto: true }),
        doctor: (target) => this.modelControl({ action: 'doctor', ...(target ? { target } : {}) }),
        assertOwner: () => {
          const cause = this.activeRun?.scope.cause;
          if (!this.activeRun || (cause && cause.trust !== 'owner')) {
            throw new Error('模型控制写操作只允许 direct Owner Run');
          }
        },
      }),
      ...createMediaTools({
        runtime: () => new MediaRuntime(this.modelGateway, this.modelResolver),
        routeVersion: () => this.modelConfig.routeVersion,
      }),
      ...createMimiPreferenceTools(this.preferences),
    ];
  }

  private registeredTools(
    profile = this.securityProfile,
    binding = this.activeRun?.scope.modelBinding,
  ): Tool[] {
    const transport = binding
      ? this.providerForTarget(binding.target).transport
      : this.providerForTarget(this.defaultModelTarget).transport;
    return [
      ...(transport === 'openai-responses'
        ? this.localTools[profile].hosted
        : this.localTools[profile].portable),
      ...this.extensionTools,
      ...(profile === 'full-owner' ? this.mcpTools : []),
    ];
  }

  private currentSecuritySummary(
    profile = this.securityProfile,
  ): ReturnType<typeof securityProfileSummary> {
    return securityProfileSummary({
      ...this.config,
      securityProfile: profile,
      permissionMode: SECURITY_PROFILES[profile].permissionMode,
    });
  }

  private modelName: string;

  private providerForTarget(target: ModelTarget): ProviderDefinition {
    const provider = this.modelConfig.providers.find((item) => item.id === target.providerId);
    if (!provider) throw new Error(`模型 Provider 未注册：${target.providerId}`);
    return provider;
  }

  private configuredModelProviders(): Array<{
    id: string;
    label: string;
    model?: string;
    models: string[];
    transport?: ProviderTransport;
    configured?: boolean;
  }> {
    return this.modelConfig.providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      model: provider.models[0]?.target.modelId,
      transport: provider.transport,
      configured: Boolean(process.env[provider.apiKeyEnv]?.trim()),
      models: provider.models.map((registration) => registration.target.modelId),
    }));
  }

  private installModelConfiguration(next: ModelsConfig): void {
    this.modelConfig = structuredClone(next);
    this.modelGateway = new ModelGateway({ providers: this.modelConfig.providers });
    this.modelResolver = new WorkUnitModelResolver({
      providers: this.modelConfig.providers,
      routing: this.modelConfig.routing,
      isConfigured: (provider) => Boolean(process.env[provider.apiKeyEnv]?.trim()),
    });
    this.defaultModelTarget = { ...this.modelConfig.routing.globalDefault };
  }

  private async refreshModelConfiguration(): Promise<void> {
    if (this.legacyModels || this.fixedModelBinding || !this.config.modelsConfig) return;
    const next = await new ModelConfigStore(this.config.modelsConfig).read();
    if (isDeepStrictEqual(next, this.modelConfig)) return;
    this.installModelConfiguration(next);
  }

  private exactRoute(binding: RunModelBinding | undefined): {
    provider: string;
    transport?: ProviderTransport;
  } {
    if (!binding) return { provider: this.config.provider };
    const provider = this.providerForTarget(binding.target);
    return { provider: provider.id, transport: provider.transport };
  }

  private runtimeForBinding(binding: RunModelBinding): {
    model: AgentModel;
    name: string;
    profile: ModelProfile;
  } {
    const runtime = this.legacyModels
      ? undefined
      : this.modelGateway.createAgentRuntime(binding.target, binding.reasoning);
    const profile = resolveModelProfile(this.config, binding.target.modelId);
    const contextWindow = binding.contextWindow ?? profile.contextWindow;
    const outputReserve = binding.maxOutputTokens
      ?? (binding.contextWindow === undefined
        ? profile.outputReserve
        : Math.min(profile.outputReserve, Math.max(256, Math.floor(contextWindow * 0.1))));
    if (outputReserve >= contextWindow) {
      throw new Error(
        `模型请求预算非法：maxOutputTokens=${outputReserve} 必须小于 contextWindow=${contextWindow}`,
      );
    }
    return {
      model: runtime?.model ?? createModel(this.config, binding.target.modelId).model,
      name: binding.target.modelId,
      profile: {
        ...profile,
        contextWindow,
        outputReserve,
        supportsImageInput: runtime
          ? runtime.registration.capabilities.imageInput
          : this.modelGateway.inspect(binding.target).capabilities.imageInput,
      },
    };
  }

  private legacySessionTarget(preferences: SessionPreferences): ModelTarget | undefined {
    if (!preferences.model) return undefined;
    const matches = this.modelConfig.providers.flatMap((provider) =>
      provider.models.filter((registration) => {
        if (registration.target.modelId !== preferences.model) return false;
        if (!preferences.provider) return true;
        if (preferences.provider === 'openai') return provider.transport === 'openai-responses';
        if (preferences.provider === 'deepseek') return provider.id === 'deepseek-main';
        return provider.transport === 'openai-chat-completions' && provider.id !== 'deepseek-main';
      }).map((registration) => registration.target));
    return matches.length === 1 ? { ...matches[0]! } : undefined;
  }

  private targetRuntime(target: ModelTarget): {
    model: AgentModel;
    name: string;
    profile: ModelProfile;
  } {
    const registration = this.modelGateway.inspect(target);
    const binding: RunModelBinding = {
      target,
      kind: registration.kind,
      reasoning: 'auto',
      scenario: 'conversation.default',
      reason: 'session-preference',
      routeVersion: this.modelConfig.routeVersion,
      ...(registration.contextWindow ? { contextWindow: registration.contextWindow } : {}),
    };
    return this.runtimeForBinding(binding);
  }

  private bindingForSubAgent(
    role: 'researcher' | 'reviewer' | 'architect',
    profile: WorkUnitModelProfile,
  ): RunModelBinding {
    return this.modelResolver.resolve({
      scenario: `subagent.${role}`,
      profile,
      routeVersion: this.modelConfig.routeVersion,
    });
  }

  private bindingForTeamTask(task: TeamTask): RunModelBinding {
    const complexity = task.complexity ?? defaultTeamTaskComplexity(task.role);
    return this.modelResolver.resolve({
      scenario: `team.${complexity}`,
      profile: {
        complexity,
        ...(task.modelRequirements ? { requirements: task.modelRequirements } : {}),
        ...(task.modelTarget ? { modelTarget: task.modelTarget } : {}),
      },
      routeVersion: task.routeVersion ?? this.modelConfig.routeVersion,
    });
  }

  private freezeTeamTask(task: TeamTaskInput): TeamTaskInput {
    const complexity = task.complexity ?? defaultTeamTaskComplexity(task.role);
    const binding = this.modelResolver.resolve({
      scenario: `team.${complexity}`,
      profile: {
        complexity,
        ...(task.modelRequirements ? { requirements: task.modelRequirements } : {}),
        ...(task.modelTarget ? { modelTarget: task.modelTarget } : {}),
      },
      routeVersion: this.modelConfig.routeVersion,
    });
    return {
      ...task,
      complexity,
      modelTarget: { ...binding.target },
      routeVersion: binding.routeVersion,
    };
  }

  static async create(
    config: AppConfig,
    sessionId?: string,
    createOptions: MimiAgentCreateOptions = {},
  ): Promise<MimiAgent> {
    const components = await createRuntimeComponents(config, sessionId, {
      mcpEnvironment: createOptions.mcpEnvironment,
      enableMcp: createOptions.enableMcp,
      releaseMcpEnvironmentAfterConnect: createOptions.releaseMcpEnvironmentAfterConnect,
      modelConfiguration: createOptions.modelConfiguration,
    });
    const agent = new MimiAgent(config, components, createOptions);
    await agent.restoreSessionState(components.sessionId);
    return agent;
  }

  async providerReliabilityKey(
    input: string | AgentInputItem[],
    options?: MimiRunOptions,
  ): Promise<string> {
    await this.refreshModelConfiguration();
    if (options?.providerRoute) {
      return `${options.providerRoute.provider}/${options.providerRoute.model ?? 'default'}`;
    }
    const preferences = await this.session.getPreferences();
    return modelTargetKey(this.resolveRunModelBinding(input, options, preferences).target);
  }

  private resolveRunModelBinding(
    input: string | AgentInputItem[],
    options: MimiRunOptions | undefined,
    preferences: SessionPreferences,
  ): RunModelBinding {
    const scenario = options?.scenario
      ?? (options?.cause ? 'background.default' : 'conversation.default');
    return this.fixedModelBinding ?? this.modelResolver.resolve({
      scenario,
      profile: {
        ...options?.modelProfile,
        requirements: {
          ...options?.modelProfile?.requirements,
          ...(containsImageInput(input) ? { imageInput: true } : {}),
          toolCalling: options?.modelProfile?.requirements?.imageOutput ? false : true,
        },
      },
      sessionTarget: preferences.modelTarget ?? this.legacySessionTarget(preferences),
      routeVersion: this.modelConfig.routeVersion,
    });
  }


  async stream(input: string | AgentInputItem[], signal?: AbortSignal, options?: MimiRunOptions) {
    return executeRunPipeline(this as unknown as RunPipelineHost, input, signal, options);
  }

  async switchSession(sessionId: string): Promise<void> {
    if (this.boundSessionActorId && sessionId !== this.boundSessionActorId) {
      throw new Error(`Session actor ${this.boundSessionActorId} 不能切换到 ${sessionId}`);
    }
    if (this.activeRun) throw new Error(`Session ${this.activeRun.sessionId} 仍有任务运行中，不能切换`);
    await this.restoreSessionState(sessionId);
  }

  private async restoreSessionState(sessionId: string): Promise<void> {
    const nextSession = this.createSession(sessionId);
    await nextSession.ensure();
    const preferences = await nextSession.getPreferences();
    const nextMode = AGENT_MODES.some((item) => item.id === preferences.mode)
      ? preferences.mode as AgentMode
      : this.defaultMode;
    const nextOutputLevel = RUNTIME_OUTPUT_LEVELS.includes(preferences.outputLevel as RuntimeOutputLevel)
      ? preferences.outputLevel as RuntimeOutputLevel
      : this.defaultOutputLevel;
    const nextSecurityProfile = this.defaultSecurityProfile;
    const nextPermissionMode = this.defaultPermissionMode;
    const requestedTarget = preferences.modelTarget
      ?? this.legacySessionTarget(preferences)
      ?? this.defaultModelTarget;
    let nextModel;
    try {
      nextModel = this.targetRuntime(requestedTarget);
    } catch {
      nextModel = this.targetRuntime(this.defaultModelTarget);
    }
    const checkpoint = await nextSession.getCheckpoint();
    const recoveredCheckpoint = await nextSession.recoverInterruptedRun(checkpoint?.runId);

    this.sessionId = sessionId;
    this.session = nextSession;
    this.mode = nextMode;
    this.outputLevel = nextOutputLevel;
    this.securityProfile = nextSecurityProfile;
    this.permissionMode = nextPermissionMode;
    this.modelName = nextModel.name;
    this.modelProfile = nextModel.profile;
    this.context = new ContextManager(
      this.config.historyLimit,
      nextModel.profile.contextWindow,
      0.55,
      nextModel.profile.outputReserve,
    );
    this.plans.useSession(sessionId);
    this.team.useSession(sessionId);
    if (recoveredCheckpoint?.status !== 'running') await this.team.recoverExpired(sessionId);
    this.lastContextTokens = 0;
    this.lastContextStats = undefined;
    this.lastContextManifest = undefined;
    this.lastUsage = undefined;
  }

  async listSessions(): Promise<string[]> {
    return FileSession.list(path.join(this.config.dataRoot, 'sessions'));
  }

  async listSessionSummaries() {
    return FileSession.listSummaries(path.join(this.config.dataRoot, 'sessions'));
  }

  async history(): Promise<AgentInputItem[]> {
    return this.session.getItems();
  }

  async sessionSnapshot(sessionId = this.sessionId): Promise<AgentSessionSnapshot> {
    if (!this.activeRun) await this.refreshModelConfiguration();
    const session = this.createSession(sessionId);
    await session.ensure();
    const [items, checkpoint, preferences, summaries, plan] = await Promise.all([
      session.getItems(),
      session.getCheckpoint(),
      session.getPreferences(),
      FileSession.listSummaries(path.join(this.config.dataRoot, 'sessions')),
      new PlanStore(path.join(this.config.dataRoot, 'plans.json'), sessionId).get(),
    ]);
    const mode = AGENT_MODES.find((item) => item.id === preferences.mode)
      ?? AGENT_MODES.find((item) => item.id === this.defaultMode)!;
    const outputLevel = RUNTIME_OUTPUT_LEVELS.includes(preferences.outputLevel as RuntimeOutputLevel)
      ? preferences.outputLevel as RuntimeOutputLevel
      : this.defaultOutputLevel;
    const securityProfile = this.defaultSecurityProfile;
    const permissionMode = this.defaultPermissionMode;
    const requestedTarget = preferences.modelTarget
      ?? this.legacySessionTarget(preferences)
      ?? this.defaultModelTarget;
    let model;
    let actualTarget = requestedTarget;
    try {
      model = this.targetRuntime(requestedTarget);
    } catch {
      actualTarget = this.defaultModelTarget;
      model = this.targetRuntime(actualTarget);
    }
    const summary = summaries.find((item) => item.id === sessionId);
    if (!summary) throw new Error(`Session ${sessionId} 不存在`);

    return {
      sessionId,
      summary,
      items,
      recovery: checkpoint && checkpoint.status !== 'completed' ? checkpoint : undefined,
      plan,
      runtime: {
        provider: actualTarget.providerId,
        transport: this.providerForTarget(actualTarget).transport,
        model: model.name,
        modelTarget: { ...actualTarget },
        mode,
        outputLevel,
        permissionMode,
        securityProfile: this.currentSecuritySummary(securityProfile),
      },
      context: {
        estimatedTokens: this.contextStatusFor(sessionId, items, model.profile.contextWindow).value,
        contextWindow: model.profile.contextWindow,
        status: this.contextStatusFor(sessionId, items, model.profile.contextWindow),
      },
    };
  }

  async clearSession(): Promise<void> {
    if (this.activeRun) throw new Error(`Session ${this.activeRun.sessionId} 仍有任务运行中，不能清空`);
    await this.clearSessionState(this.sessionId, this.session);
  }

  async listSkills() {
    const bindings = await this.session.getActiveSkills();
    return this.skills.list().map((skill) => {
      const binding = bindings.find((candidate) => candidate.name === skill.name);
      const active = Boolean(binding
        && binding.sourceId === skill.source.id
        && binding.file === skill.file
        && binding.contentHash === skill.contentHash);
      const availability = this.skills.evaluateAvailability(this.skills.get(skill.name)!, {
        canReadLocal: true,
        availableTools: this.toolNames,
        ...(binding ? { binding } : {}),
      });
      return {
        ...skill,
        enabled: !this.skills.preference(skill.name).disabled,
        disabledScope: this.skills.preference(skill.name).scope,
        active,
        stale: Boolean(binding && !active),
        available: availability.available,
        unavailableReasons: availability.reasons,
        missingTools: availability.missingTools,
      };
    });
  }

  async activeSkills() {
    const bindings = await this.session.getActiveSkills();
    return bindings.map((binding) => {
      const skill = this.skills.get(binding.name);
      return {
        ...binding,
        stale: !skill
          || skill.source.id !== binding.sourceId
          || skill.file !== binding.file
          || skill.contentHash !== binding.contentHash,
      };
    });
  }

  async deactivateSkill(name: string): Promise<boolean> {
    if (this.activeRun) throw new Error('当前 Session 仍有任务运行中，不能停用 Skill');
    return this.session.deactivateSkill(name);
  }

  async setSkillEnabled(name: string, scope: 'project' | 'user', enabled: boolean): Promise<void> {
    if (this.activeRun) throw new Error('当前 Session 仍有任务运行中，不能修改 Skill 状态');
    await this.skills.setEnabled(name, scope, enabled);
    if (!enabled) await this.session.deactivateSkill(name);
  }

  async reloadSkills() {
    await this.skills.load();
    return {
      skills: this.skills.list(),
      warnings: this.skills.diagnostics(),
      diagnostics: this.skills.diagnosticDetails(),
    };
  }

  listUndoableRuns(limit = 20) {
    return this.fileChanges.list(limit);
  }

  previewUndo(runId: string) {
    return this.fileChanges.preview(runId);
  }

  async undoRun(runId: string) {
    if (this.activeRun) throw new Error('当前 Session 仍有任务运行中，不能撤销文件变更');
    return this.fileChanges.undo(runId);
  }

  async memoryList(scope: 'private' | 'workspace' | 'all' = 'all') {
    return this.memory.list(this.runContexts.forInspection(), { scope });
  }

  async memorySearch(query: string, scope: 'private' | 'workspace' | 'all' = 'all') {
    return this.memory.search(query, this.runContexts.forInspection(), { scope });
  }

  async memoryRead(ref: import('../core/memory.js').MemoryRef) {
    return this.memory.read(ref, this.runContexts.forInspection());
  }

  async memoryForget(ref: import('../core/memory.js').MemoryRef) {
    return this.memory.forget(ref, this.runContexts.forInspection());
  }

  async memoryIngest(target: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return this.memory.ingest(target, this.runContexts.forInspection());
  }

  async memoryCapture(input: CaptureInput, profileId = 'owner') {
    return this.memory.capture(input, this.runContexts.forInspection(profileId, 'memory-maintenance'));
  }

  async memoryMerge(input: Parameters<MemoryHub['merge']>[0], profileId = 'owner') {
    return this.memory.merge(input, this.runContexts.forInspection(profileId, 'memory-maintenance'));
  }

  async memorySupersede(
    ref: MemoryRef,
    replacementRef: MemoryRef | undefined,
    reasonCode: string,
    profileId = 'owner',
  ) {
    return this.memory.supersede(
      ref,
      replacementRef,
      reasonCode,
      this.runContexts.forInspection(profileId, 'memory-maintenance'),
    );
  }

  async memoryAddLinks(ref: MemoryRef, links: string[], reasonCode: string, profileId = 'owner') {
    return this.memory.addLinks(
      ref,
      links,
      reasonCode,
      this.runContexts.forInspection(profileId, 'memory-maintenance'),
    );
  }

  async memoryMove(
    ref: MemoryRef,
    targetScope: 'private' | 'workspace',
    reasonCode: string,
    profileId = 'owner',
  ) {
    return this.memory.move(
      ref,
      targetScope,
      reasonCode,
      this.runContexts.forInspection(profileId, 'memory-maintenance'),
    );
  }

  async memoryCaptureRound(roundRef?: string) {
    const value = roundRef?.trim();
    let title: string;
    let content: string;
    let sourceRefs: SourceRef[];
    if (value) {
      const direct = /^private:(episode_[a-z0-9]+)$/i.exec(value);
      const round = /^([^@]+)@(.+)$/.exec(value);
      const id = direct?.[1] ?? (round
        ? `episode_${createHash('sha256').update(`${round[1]}\0${round[2]}`).digest('hex').slice(0, 24)}`
        : undefined);
      if (!id) throw new Error('RoundRef 必须是 sessionId@runId 或 private:episode_<id>');
      const episode = await this.memory.read(
        { scope: 'private', profileId: 'owner', id },
        { ...this.runContexts.forInspection(), allowEpisodeEvidence: true },
      );
      title = episode.metadata.title;
      content = episode.body;
      sourceRefs = episode.metadata.sourceRefs;
    } else {
      const checkpoint = await this.session.getCheckpoint();
      if (!checkpoint || checkpoint.status !== 'completed' || !checkpoint.answer) {
        throw new Error('当前 Session 没有可 capture 的已完成 round');
      }
      title = checkpoint.input.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Captured round';
      content = `用户：${checkpoint.input}\n\n助手：${checkpoint.answer}`;
      sourceRefs = [{
        type: 'session', id: `${this.sessionId}@${checkpoint.runId}`,
        digest: `sha256:${contentDigest(content)}`, occurredAt: checkpoint.updatedAt, trust: 'owner',
      }];
    }
    return this.memory.capture({
      title, content, sourceRefs, scope: 'private', kind: 'synthesis',
      confidence: 'user-confirmed', reasonCode: 'owner_manual_capture',
    }, this.runContexts.forInspection());
  }

  async memoryReject(sourceRefs: SourceRef[], reasonCode: string, profileId = 'owner') {
    return this.memory.reject(sourceRefs, reasonCode, this.runContexts.forInspection(profileId, 'memory-maintenance'));
  }

  async memoryConflicts(limit = 50) {
    return this.memory.conflicts(this.runContexts.forInspection(), limit);
  }

  async memoryAudit(limit = 50) {
    return this.memory.audit(this.runContexts.forInspection(), limit);
  }

  async memoryLint(profileId = 'owner') {
    return this.memory.lint(this.runContexts.forInspection(profileId, 'memory-lint'));
  }

  async memoryRefresh(limit = 20, profileId = 'owner') {
    return this.memory.refreshStale(limit, this.runContexts.forInspection(profileId, 'memory-maintenance'));
  }

  async memoryReindex() {
    return this.memory.reindex(this.runContexts.forInspection());
  }

  async memoryStatus() {
    return this.memory.status(this.runContexts.forInspection());
  }

  async currentPlan() {
    return this.plans.get();
  }

  async currentGoal() {
    return this.plans.getGoal();
  }

  async currentTeam() {
    return this.team.list();
  }

  async setGoal(objective: string) {
    return this.plans.setGoal(objective);
  }

  async resumePrompt(): Promise<string> {
    const [goal, steps, checkpoint, team, teamTasks] = await Promise.all([
      this.plans.getGoal(),
      this.plans.get(),
      this.session.getCheckpoint(),
      this.team.summary(),
      this.team.list(),
    ]);
    return buildResumePrompt({ goal, steps, checkpoint, teamSummary: team, teamTasks });
  }

  async recoveryInfo(): Promise<RunCheckpoint | undefined> {
    const checkpoint = await this.session.getCheckpoint();
    return checkpoint && checkpoint.status !== 'completed' ? checkpoint : undefined;
  }

  async compactContext() {
    const [history, previous] = await Promise.all([this.session.getItems(), this.session.getContextArchive()]);
    const archive = this.context.compactArchive(history, previous, 'full');
    if (!archive || archive.coveredItems === previous?.coveredItems) {
      return { changed: false, archive: previous, message: '历史不足两轮，无需压缩。' };
    }
    await this.session.setContextArchive(archive);
    this.lastContextTokens = 0;
    this.lastContextStats = undefined;
    this.lastContextManifest = undefined;
    return { changed: true, archive, message: `已归档 ${archive.coveredItems} 个历史条目。` };
  }

  async runtimeInfo() {
    return this.runtimeControlCoordinator.runtimeInfo();
  }

  async runtimeStatus(projection: 'summary' | 'detail' = 'summary') {
    return this.runtimeControlCoordinator.runtimeStatus(projection);
  }

  currentCapabilitySnapshot(): Readonly<EffectiveCapabilitySnapshot> | undefined {
    return this.runtimeControlCoordinator.currentCapabilitySnapshot();
  }

  computerStatus() {
    return this.runtimeControlCoordinator.computerStatus();
  }

  async prepareQqPersonalMessageScope(
    authorization: PersonalMessageAuthorization,
    computerAccess: ComputerAccess | undefined,
    computerApps: readonly string[] | undefined,
    signal?: AbortSignal,
  ): Promise<PersonalMessageScope | undefined> {
    return this.runtimeControlCoordinator.prepareQqPersonalMessageScope(
      authorization,
      computerAccess,
      computerApps,
      signal,
    );
  }

  assertReadOnlyDaemonProbePolicy(hostTools: readonly Tool[]): void {
    this.runtimeControlCoordinator.assertReadOnlyDaemonProbePolicy(hostTools);
  }

  async probeReadOnlyComputerWindow(
    allowedApps: readonly string[],
    deniedApps: readonly string[],
    signal?: AbortSignal,
    expectedTarget?: Pick<ComputerTargetSummary, 'bundleId' | 'pid' | 'windowId'>,
  ) {
    return this.runtimeControlCoordinator.probeReadOnlyComputerWindow(
      allowedApps,
      deniedApps,
      signal,
      expectedTarget,
    );
  }

  async guidanceInfo() {
    return this.runtimeControlCoordinator.guidanceInfo();
  }

  async modelControl(rawRequest: unknown): Promise<unknown> {
    return this.runtimeControlCoordinator.modelControl(rawRequest);
  }

  availableModels(): string[] {
    return this.runtimeControlCoordinator.availableModels();
  }

  async switchModel(modelName: string): Promise<void> {
    return this.runtimeControlCoordinator.switchModel(modelName);
  }

  async switchModelTarget(target: ModelTarget): Promise<void> {
    return this.runtimeControlCoordinator.switchModelTarget(target);
  }

  private assertModelAvailable(modelName: string): void {
    this.runtimeControlCoordinator.assertModelAvailable(modelName);
  }

  availableModes() {
    return this.runtimeControlCoordinator.availableModes();
  }

  async switchMode(mode: string): Promise<void> {
    return this.runtimeControlCoordinator.switchMode(mode);
  }

  async switchSecurityProfile(profile: string): Promise<void> {
    return this.runtimeControlCoordinator.switchSecurityProfile(profile);
  }

  async setOutputLevel(level: RuntimeOutputLevel): Promise<void> {
    return this.runtimeControlCoordinator.setOutputLevel(level);
  }

  async contextInfo() {
    return this.runtimeControlCoordinator.contextInfo();
  }

  get toolNames(): string[] {
    const scoped = [
      ...this.registeredTools(),
      ...createMemoryTools(this.memory, () => this.runContexts.forInspection()),
      ...createPlanTools(this.plans),
    ];
    return toolNamesForMode(this.mode, scoped, this.permissionMode, this.securityProfile);
  }

  async visibleToolNames(hostTools: Tool[] = []): Promise<string[]> {
    const scoped = [
      ...this.registeredTools(),
      ...hostTools,
      ...createMemoryTools(this.memory, () => this.runContexts.forInspection()),
      ...createPlanTools(this.plans),
    ];
    const functionNames = toolNamesForMode(
      this.mode,
      scoped,
      this.permissionMode,
      this.securityProfile,
    );
    if (
      this.mode === 'plan'
      || this.securityProfile !== 'full-owner'
      || this.mcp.servers.length === 0
    ) return functionNames;
    const mcpTools = await getAllMcpTools({
      mcpServers: this.mcp.servers,
      includeServerInToolNames: true,
      reservedToolNames: new Set(functionNames),
    });
    return [...new Set([...functionNames, ...mcpTools.map((tool) => tool.name)])].sort();
  }

  get currentSessionId(): string {
    return this.sessionId;
  }

  /** Permanently pins this mutable runtime to one keyed MimiHost Session actor. */
  bindSessionActor(sessionId: string): void {
    if (this.boundSessionActorId && this.boundSessionActorId !== sessionId) {
      throw new Error(`Session actor 已绑定 ${this.boundSessionActorId}，不能改绑到 ${sessionId}`);
    }
    if (this.sessionId !== sessionId) {
      throw new Error(`Session actor ${sessionId} 与 Runtime 当前 Session ${this.sessionId} 不一致`);
    }
    this.boundSessionActorId = sessionId;
  }

  get mcpServerNames(): string[] {
    return this.mcp.servers.map((server) => server.name);
  }

  mcpStatuses() {
    return this.mcp.statuses();
  }

  async reloadMcp() {
    return this.mcp.reload();
  }

  async recordEvent(type: string, data?: unknown): Promise<void> {
    const run = this.activeRun;
    const sessionId = run?.sessionId ?? this.sessionId;
    const session = run?.session ?? this.session;
    const safeData = redactActiveEphemeralData(data, run?.ephemeralSensitiveAccess);
    if (type === 'status' && safeData && typeof safeData === 'object') {
      const value = safeData as Record<string, unknown>;
      await this.traces.record(sessionId, type, {
        kind: value.kind,
        tone: value.tone,
        title: value.title,
        detail: typeof value.detail === 'string' ? value.detail.slice(0, 1_000) : value.detail,
        next: value.next,
      });
      await session.updateRunProgress(
        typeof value.next === 'string' ? value.next : '执行中',
        [value.title, value.detail].filter((item) => typeof item === 'string' && item).join(' · '),
        run?.runId,
      );
      return;
    }
    await this.traces.record(sessionId, type, safeData);
  }

  onRuntimeEvent(hook: RuntimeHook): () => void {
    return this.hooks.on(hook);
  }

  async completeRun(answer: string, usage?: ContextUsageSnapshot): Promise<RuntimeEffect[]> {
    return this.runCommitCoordinator.complete({ answer, usage });
  }
  get completionGateRequired(): boolean {
    return this.activeRun?.completionRequired === true;
  }

  get completedRunAnswer(): string | undefined {
    return this.lastCommittedAnswer;
  }

  get completedRunFinalization(): RunFinalizationRecord | undefined {
    return this.lastFinalization;
  }

  get activeRunHasEphemeralSensitiveAccess(): boolean {
    return this.activeRun?.ephemeralSensitiveAccess !== undefined;
  }

  redactActiveRunText(value: string): string {
    return redactActiveEphemeralText(value, this.activeRun?.ephemeralSensitiveAccess);
  }

  redactActiveRunData<T>(value: T): T {
    return redactActiveEphemeralData(value, this.activeRun?.ephemeralSensitiveAccess);
  }

  redactActiveRunError(error: unknown): unknown {
    return this.runCommitCoordinator.redactError(error, this.activeRun?.ephemeralSensitiveAccess);
  }

  async failRun(
    error: unknown,
    interrupted = false,
    usage?: ContextUsageSnapshot,
    interruptedAnswer?: string,
  ): Promise<RunFinalizationRecord | undefined> {
    return this.runCommitCoordinator.fail({
      error,
      interrupted,
      usage,
      interruptedAnswer,
    });
  }
  async finalizeExecutionLedger(sessionId: string, executionKey: string): Promise<void> {
    return this.runCommitCoordinator.finalizeExecutionLedger(sessionId, executionKey);
  }

  /**
   * Removes only the completed-run receipt so a paused/blocked durable Event
   * can ask the model for a new turn. Successful side-effect tool entries stay
   * fenced and therefore cannot be silently repeated after resume.
   */
  async reopenExecutionLedger(sessionId: string, executionKey: string): Promise<void> {
    return this.runCommitCoordinator.reopenExecutionLedger(sessionId, executionKey);
  }

  async completedExecution(
    sessionId: string,
    executionKey: string,
  ): Promise<CompletedExecutionReceipt | undefined> {
    return this.runCommitCoordinator.completedExecution(sessionId, executionKey);
  }
  async close(): Promise<void> {
    await Promise.all([this.mcp.close(), this.computer?.close()]);
  }

  private createSession(id: string): FileSession {
    return this.sessions.open(id);
  }

  private createIsolatedSession(id: string): FileSession {
    return this.sessions.open(id, true);
  }

  private createEphemeralRedactingSession(
    session: FileSession,
    access: ActiveEphemeralOwnerInput,
  ): FileSession {
    return new Proxy(session, {
      get(target, property, receiver) {
        if (property === 'addItems') {
          return (items: AgentInputItem[]) =>
            target.addItems(redactActiveEphemeralData(items, access));
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  private async applyRuntimeAction(
    action: RuntimeAction,
    originSessionId: string,
    retainedExecutionKey?: string,
  ): Promise<RuntimeEffect> {
    if (action.type === 'switch_model') {
      this.assertModelAvailable(action.model);
      if (this.sessionId === originSessionId) await this.switchModel(action.model);
      else {
        const runtime = createModel(this.config, action.model);
        await this.createSession(originSessionId).setPreferences({
          provider: this.config.provider,
          model: runtime.name,
        });
      }
      return { type: 'model_changed', model: action.model };
    }
    if (action.type === 'switch_provider') {
      return { type: 'provider_change_requested', provider: action.provider };
    }
    if (action.type === 'switch_mode') {
      if (!AGENT_MODES.some((mode) => mode.id === action.mode)) throw new Error(`未知模式：${action.mode}`);
      if (this.sessionId === originSessionId) await this.switchMode(action.mode);
      else await this.createSession(originSessionId).setPreferences({ mode: action.mode });
      return { type: 'mode_changed', mode: action.mode };
    }
    if (action.type === 'set_output_level') {
      if (this.sessionId === originSessionId) await this.setOutputLevel(action.level);
      else await this.createSession(originSessionId).setPreferences({ outputLevel: action.level });
      return { type: 'output_level_changed', level: action.level };
    }
    if (action.type === 'clear_session') {
      const origin = this.sessionId === originSessionId ? this.session : this.createSession(originSessionId);
      await this.clearSessionState(originSessionId, origin, retainedExecutionKey);
      return { type: 'session_cleared', sessionId: originSessionId };
    }
    if (action.type === 'exit') return { type: 'exit_requested' };
    if (action.type === 'reload_mcp') {
      await this.reloadMcp();
      return { type: 'mcp_reloaded' };
    }
    if (this.boundSessionActorId) await this.createSession(action.sessionId).ensure();
    else await this.switchSession(action.sessionId);
    return { type: 'session_changed', sessionId: action.sessionId };
  }

  private validUsage(
    usage?: ContextUsageSnapshot,
    binding?: RunModelBinding,
  ): ContextUsageSnapshot | undefined {
    if (!usage) return undefined;
    if (!Object.values(usage).some((value) => typeof value === 'number' && value > 0)) return undefined;
    return binding ? {
      ...usage,
      providerId: binding.target.providerId,
      modelId: binding.target.modelId,
      scenario: binding.scenario,
      selectionReason: binding.reason,
      cost: 'unknown',
    } : usage;
  }

  private applyManifestActual(usage?: ContextUsageSnapshot): void {
    if (!this.lastContextManifest || !usage?.lastRequestInputTokens) return;
    const inputTokens = usage.lastRequestInputTokens;
    const outputTokens = usage.lastRequestOutputTokens ?? 0;
    this.lastContextManifest.actual = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      receivedAt: new Date().toISOString(),
    };
  }

  private contextStatusFor(
    sessionId: string,
    items: AgentInputItem[],
    contextWindow: number,
  ): MimiContextStatus {
    const manifest = this.lastContextManifest?.sessionId === sessionId
      ? this.lastContextManifest
      : undefined;
    if (manifest?.actual) {
      return {
        value: manifest.actual.inputTokens,
        source: 'actual',
        contextWindow,
        requestId: manifest.requestId,
        ...(manifest.compression.length
          ? { compressedFrom: Math.max(...manifest.compression.map((record) => record.beforeTokens)) }
          : {}),
      };
    }
    if (manifest) {
      return {
        value: manifest.estimatedInputTokens,
        source: 'estimate',
        contextWindow,
        requestId: manifest.requestId,
        ...(manifest.compression.length
          ? { compressedFrom: Math.max(...manifest.compression.map((record) => record.beforeTokens)) }
          : {}),
      };
    }
    return { value: estimateTokens(items), source: 'raw-history', contextWindow };
  }

  private async clearSessionState(
    sessionId: string,
    session: FileSession,
    retainedExecutionKey?: string,
  ): Promise<void> {
    await session.clearSession(async () => Promise.all([
      this.plans.clear(sessionId),
      this.team.clear(sessionId),
      retainedExecutionKey
        ? this.ledger.clearSessionExcept(sessionId, retainedExecutionKey)
        : this.ledger.clearSession(sessionId),
    ]).then(() => undefined));
  }

}
