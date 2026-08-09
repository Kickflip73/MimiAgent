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
  securityProfileSummary,
  type AppConfig,
} from '../config.js';
import {
  estimateTokens,
  type ContextManifest,
  type ContextSemanticSummarizer,
  type MimiContextStatus,
} from '../core/context.js';
import type { ExecutionCallRecord } from '../core/execution-ledger.js';
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
import type { ContextUsageSnapshot, RunFinalizationRecord } from '../core/run-finalization.js';
import { FileChangeJournal } from '../core/file-change-journal.js';
import {
  defaultTeamTaskComplexity,
  type TeamTask,
  type TeamTaskInput,
} from '../core/team.js';
import {
  modelTargetKey,
  runModelBindingSchema,
  type ModelRequirements,
  type ModelTarget,
  type RunModelBinding,
  type WorkUnitModelProfile,
} from '../core/model-routing.js';
import {
  FileSession,
  type RunCheckpoint,
  type SessionPreferences,
} from '../core/session.js';
import { createMemoryTools } from '../extensions/memory/tools.js';
import { createComputerTools } from '../extensions/computer/tools.js';
import { QqPersonalMessageComputerAdapter } from '../extensions/computer/qq-personal-message.js';
import type { ComputerAccess } from '../extensions/computer/types.js';
import { configuredProviders } from '../provider-config.js';
import { createTools } from '../tools.js';
import { HookBus, type RuntimeHook } from './hooks.js';
import {
  MediaArtifactStore,
  sessionMediaArtifactOwner,
} from './media-artifact-store.js';
import {
  createRuntimeControlTools,
  RUNTIME_OUTPUT_LEVELS,
  type RuntimeAction,
  type RuntimeEffect,
  type RuntimeOutputLevel,
} from './control.js';
import { AGENT_MODES, type AgentMode } from './instructions.js';
import { createModelContext, createModelRuntime } from './model.js';
import { buildResumePrompt } from './session-state.js';
import {
  toolNamesForMode,
  toolsForSecurity,
  type RunToolPolicy,
  type ToolCapability,
} from './tool-policy.js';
import { createModelResolver, createRuntimeComponents, type RuntimeComponents } from './components.js';
import type { ModelsConfig } from './model-config.js';
import { ModelGateway } from './model-gateway.js';
import { CompletionCoordinator } from './completion-coordinator.js';
import { restrictedShellEnvironment } from './shell-environment.js';
import { canAccessRuntimePaths, RunContextBuilder } from './run-context-builder.js';
import { RuntimeActionCoordinator } from './runtime-action-coordinator.js';
import { RuntimeControlCoordinator } from './runtime-control-coordinator.js';
import { createPlanTools } from './plan-tools.js';
import { ContextAssembler } from './pipeline/context-assembler.js';
import {
  CapabilityResolver,
  type RuntimeAccess,
} from './pipeline/capability-resolver.js';
import type {
  EffectiveCapabilityItem,
  EffectiveCapabilitySnapshot,
} from './pipeline/capability-resolver.js';
import type { MediaEvidence } from '../core/media-evidence.js';
import type { RunScope } from './pipeline/run-scope.js';
import {
  type CapabilityCatalogAccess,
} from './pipeline/capability-registry.js';
import { ToolSetBuilder } from './pipeline/tool-set-builder.js';
import { AgentRequestFactory } from './pipeline/request-factory.js';
import {
  containsImageInput,
  executeRunPipeline,
} from './pipeline/run-pipeline.js';
import {
  RunCommitCoordinator,
} from './pipeline/run-commit-coordinator.js';
import { RunFactCollector } from './pipeline/run-fact-collector.js';
import { PersonalMessageHub, type PersonalMessageScope } from './personal-message-hub.js';
import { containsFileInput } from './providers/file-input.js';
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
export type { ContextUsageSnapshot } from '../core/run-finalization.js';

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

export interface CompletionDeliveryDisposition {
  suppressed: true;
  reason?: string;
}

export type RunTrust = 'owner' | 'trusted' | 'external' | 'public' | 'system';

export interface RunCause {
  eventId: string;
  /** Immutable ingress/trigger Event; eventId may be the derived Task identity. */
  sourceEventId?: string;
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
  completionContract?: CompletionContract;
  resumeState?: boolean;
  computerAccess?: ComputerAccess;
  computerApps?: readonly string[];
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
  /** Immutable, ref-only evidence staged before this Run. Raw media never belongs here. */
  mediaEvidence?: readonly MediaEvidence[];
  /** Opaque binding resolved by the daemon; absolute workspace paths never enter Events/Evidence. */
  workspaceId?: string;
}

export function freezeRunModelRequirements(
  input: string | AgentInputItem[],
  options?: MimiRunOptions,
): Readonly<ModelRequirements> {
  return Object.freeze({
    ...options?.modelProfile?.requirements,
    ...(containsImageInput(input) ? { imageInput: true } : {}),
    ...(containsFileInput(input) ? { fileInput: true } : {}),
    toolCalling: options?.modelProfile?.requirements?.imageOutput ? false : true,
  });
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
  readonly runner: Runner;
  readonly components: RuntimeComponents;
  private readonly fileChanges: FileChangeJournal;
  readonly qqPersonalMessages?: QqPersonalMessageComputerAdapter;
  readonly hooks = new HookBus();
  readonly completion: CompletionCoordinator;
  readonly runCommitCoordinator: RunCommitCoordinator;
  private readonly runtimeControlCoordinator: RuntimeControlCoordinator;
  readonly runtimeActions: RuntimeActionCoordinator;
  readonly runContexts: RunContextBuilder;
  readonly contextAssembler = new ContextAssembler();
  readonly capabilityResolver = new CapabilityResolver();
  readonly toolSetBuilder = new ToolSetBuilder();
  readonly requestFactory = new AgentRequestFactory();
  readonly fixedModelBinding?: RunModelBinding;
  readonly personalMessages = new PersonalMessageHub();
  readonly mediaArtifacts: MediaArtifactStore;
  private readonly localTools: Readonly<{ hosted: Tool[]; portable: Tool[] }>;
  private readonly extensionTools: Tool[];
  private readonly mcpTools: Tool[];
  session: FileSession;
  sessionId: string;
  mode: AgentMode = initialMode();
  outputLevel: RuntimeOutputLevel = initialOutputLevel();
  private readonly defaultMode: AgentMode;
  private readonly defaultOutputLevel: RuntimeOutputLevel;
  private get defaultModelTarget() { return this.components.modelConfig.routing.globalDefault; }
  readonly runtimeSecurity: ReturnType<typeof securityProfileSummary>;
  readonly runtimeAccess: Readonly<RuntimeAccess>;
  readonly authorizeTools: (tools: Tool[]) => Tool[];
  private boundSessionActorId?: string;
  activeRun?: ActiveRun;
  lastCapabilitySnapshot?: Readonly<EffectiveCapabilitySnapshot>;
  lastContextManifest?: ContextManifest;
  lastModelBinding?: RunModelBinding;
  readonly runtimeRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
  readonly contextSemanticSummarizer?: ContextSemanticSummarizer;

  private constructor(
    readonly config: AppConfig,
    components: RuntimeComponents,
    createOptions: MimiAgentCreateOptions = {},
  ) {
    this.components = components;
    this.mediaArtifacts = new MediaArtifactStore(path.join(
      path.resolve(config.daemonDataRoot ?? path.join(config.dataRoot, 'mimi')),
      'attachments',
    ));
    this.fixedModelBinding = createOptions.modelBinding
      ? runModelBindingSchema.parse(structuredClone(createOptions.modelBinding))
      : undefined;
    this.contextSemanticSummarizer = createOptions.contextSemanticSummarizer;
    this.fileChanges = new FileChangeJournal(
      path.join(config.dataRoot, 'file-changes'),
      config.workspaceRoot,
      () => this.activeRun?.options?.executionKey ?? this.activeRun?.runId,
    );
    this.completion = new CompletionCoordinator(components.state.executionLedger.store);
    this.runtimeActions = new RuntimeActionCoordinator(
      components.state.executionLedger.store,
      (action, originSessionId, executionKey) =>
        this.applyRuntimeAction(action, originSessionId, executionKey),
    );
    this.qqPersonalMessages = components.computer
      ? new QqPersonalMessageComputerAdapter(components.computer, config.dataRoot)
      : undefined;
    this.sessionId = components.sessionId;
    const initialSecurity = securityProfileSummary(config);
    this.runtimeSecurity = initialSecurity;
    this.runtimeAccess = Object.freeze({
      workspaceWrite: initialSecurity.permissionMode !== 'read-only',
      computer: initialSecurity.id === 'full-owner',
      mcp: initialSecurity.externalTransactions,
      ephemeralSensitiveModelAccess: initialSecurity.ephemeralSensitiveModelAccess,
      policyRevision: initialSecurity.permissionMode,
    });
    this.authorizeTools = (tools) => toolsForSecurity(initialSecurity.id, tools);
    this.runContexts = new RunContextBuilder(config.workspaceRoot, () => this.sessionId);
    this.defaultMode = this.mode;
    this.defaultOutputLevel = this.outputLevel;
    this.session = components.state.sessions.open(this.sessionId);
    components.state.goalsAndPlans.store.onChange(
      (sessionId, steps) => this.hooks.emit({ type: 'plan_updated', sessionId, steps }),
    );
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
    this.runCommitCoordinator = new RunCommitCoordinator(this);
    this.runtimeControlCoordinator = new RuntimeControlCoordinator(this);
    this.hooks.on(async (event) => {
      const traceType = event.type === 'run_start'
        ? 'turn_start'
        : event.type === 'run_end'
          ? 'turn_end'
          : event.type === 'run_error' ? (event.interrupted ? 'turn_interrupted' : 'error') : event.type;
      await components.state.traces.record(event.sessionId, traceType, event);
    });
    const createToolsForAccess = (
      access: Parameters<typeof createTools>[3],
      includeOpenAIHostedTools: boolean,
    ) => createTools(
      config.workspaceRoot,
      includeOpenAIHostedTools,
      privateRuntimePaths(config),
      access,
    );
    const baseShellEnvironment = createOptions.shellEnvironment ?? restrictedShellEnvironment(process.env);
    const localToolAccess: Parameters<typeof createTools>[3] = initialSecurity.id === 'safe'
      ? {
        readablePaths: ['.'],
        writablePaths: [],
        allowWrite: false,
        allowShell: false,
        mutationObserver: this.fileChanges,
      }
      : initialSecurity.id === 'workstation' ? {
        readablePaths: ['.'],
        writablePaths: ['.'],
        allowWrite: true,
        allowShell: true,
        shellEnvironment: baseShellEnvironment,
        shellDetachedProcessGroup: createOptions.shellDetachedProcessGroup,
        mutationObserver: this.fileChanges,
      } : {
        ...(createOptions.restrictReadsToWorkspace ? { readablePaths: ['.'] } : {}),
        allowProtectedPathFileAccess: () => canAccessRuntimePaths(this.activeRun),
        allowProtectedPathShellAccess: createOptions.protectRuntimePathsFromShell !== true && (() => canAccessRuntimePaths(this.activeRun)),
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
      };
    this.localTools = {
      hosted: createToolsForAccess(localToolAccess, true),
      portable: createToolsForAccess(localToolAccess, false),
    };
    const computerTools = components.computer ? createComputerTools(components.computer, () => {
      const active = this.activeRun;
      if (!active) return undefined;
      const policy = active.options?.policy;
      const ownerAuthorized = this.runtimeAccess.computer
        && (!active.options?.cause || active.options.cause.trust === 'owner');
      return {
        runId: active.runId,
        access: ownerAuthorized ? active.computerAccess : 'none',
        ...((active.options?.computerApps ?? policy?.computerApps)
          ? { allowedApps: active.options?.computerApps ?? policy?.computerApps }
          : {}),
        supportsImageInput: active.scope.modelBinding
          ? this.components.modelGateway.inspect(active.scope.modelBinding.target).capabilities.imageInput
          : this.components.modelRuntime.profile.supportsImageInput,
      };
    }) : [];
    this.mcpTools = components.mcp.createTools();
    this.extensionTools = [
      ...computerTools,
      ...components.skills.createTools({
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
      }).filter((tool) => tool.name !== 'switch_model' && tool.name !== 'switch_provider'),
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
        runtime: () => new MediaRuntime(this.components.modelGateway, this.components.modelResolver),
        routeVersion: () => this.components.modelConfig.routeVersion,
      }),
      ...createMimiPreferenceTools(components.preferences),
    ];
  }

  registeredTools(binding = this.activeRun?.scope.modelBinding): Tool[] {
    const transport = binding
      ? this.components.modelGateway.provider(binding.target).transport
      : this.components.modelGateway.provider(this.defaultModelTarget).transport;
    return this.authorizeTools([
      ...(transport === 'openai-responses'
        ? this.localTools.hosted
        : this.localTools.portable),
      ...this.extensionTools,
      ...this.mcpTools,
    ]);
  }

  installModelConfiguration(next: ModelsConfig): void {
    this.components.modelConfig = structuredClone(next);
    this.components.modelGateway = new ModelGateway({ providers: next.providers });
    this.components.modelResolver = createModelResolver(next, true);
  }

  async refreshModelConfiguration(): Promise<void> {
    if (this.fixedModelBinding || !this.config.modelsConfig) return;
    const next = await new ModelConfigStore(this.config.modelsConfig).read();
    if (isDeepStrictEqual(next, this.components.modelConfig)) return;
    this.installModelConfiguration(next);
  }

  runtimeForBinding(binding: RunModelBinding) {
    return createModelRuntime(this.config, this.components.modelGateway, binding);
  }

  targetRuntime(target: ModelTarget) {
    return this.runtimeForBinding(this.components.modelResolver.resolve({
      scenario: 'conversation.default',
      profile: { modelTarget: target },
      routeVersion: this.components.modelConfig.routeVersion,
    }));
  }

  private sessionRuntime(preferences: SessionPreferences) {
    const mode = AGENT_MODES.find((item) => item.id === preferences.mode)
      ?? AGENT_MODES.find((item) => item.id === this.defaultMode)!;
    const outputLevel = RUNTIME_OUTPUT_LEVELS.includes(preferences.outputLevel as RuntimeOutputLevel)
      ? preferences.outputLevel as RuntimeOutputLevel
      : this.defaultOutputLevel;
    const requestedTarget = preferences.modelTarget
      ?? this.components.modelGateway.legacyAgentTarget(preferences.model, preferences.provider)
      ?? this.defaultModelTarget;
    try {
      return { mode, outputLevel, target: requestedTarget, model: this.targetRuntime(requestedTarget) };
    } catch {
      return {
        mode,
        outputLevel,
        target: this.defaultModelTarget,
        model: this.targetRuntime(this.defaultModelTarget),
      };
    }
  }

  bindingForSubAgent(
    role: 'researcher' | 'reviewer' | 'architect',
    profile: WorkUnitModelProfile,
  ): RunModelBinding {
    return this.components.modelResolver.resolve({
      scenario: `subagent.${role}`,
      profile,
      routeVersion: this.components.modelConfig.routeVersion,
    });
  }

  bindingForTeamTask(task: TeamTask | TeamTaskInput): RunModelBinding {
    const complexity = task.complexity ?? defaultTeamTaskComplexity(task.role);
    return this.components.modelResolver.resolve({
      scenario: `team.${complexity}`,
      profile: {
        complexity,
        ...(task.modelRequirements ? { requirements: task.modelRequirements } : {}),
        ...(task.modelTarget ? { modelTarget: task.modelTarget } : {}),
      },
      routeVersion: task.routeVersion ?? this.components.modelConfig.routeVersion,
    });
  }

  freezeTeamTask(task: TeamTaskInput): TeamTaskInput {
    const complexity = task.complexity ?? defaultTeamTaskComplexity(task.role);
    const binding = this.bindingForTeamTask(task);
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

  resolveRunModelBinding(
    input: string | AgentInputItem[],
    options: MimiRunOptions | undefined,
    preferences: SessionPreferences,
  ): RunModelBinding {
    const scenario = options?.scenario
      ?? (options?.cause ? 'background.default' : 'conversation.default');
    const requirements = freezeRunModelRequirements(input, options);
    return this.fixedModelBinding ?? this.components.modelResolver.resolve({
      scenario,
      profile: {
        ...options?.modelProfile,
        requirements,
      },
      sessionTarget: preferences.modelTarget
        ?? this.components.modelGateway.legacyAgentTarget(preferences.model, preferences.provider),
      routeVersion: this.components.modelConfig.routeVersion,
    });
  }

  async stream(input: string | AgentInputItem[], signal?: AbortSignal, options?: MimiRunOptions) {
    return executeRunPipeline(this, input, signal, options);
  }

  async switchSession(sessionId: string): Promise<void> {
    if (this.boundSessionActorId && sessionId !== this.boundSessionActorId) {
      throw new Error(`Session actor ${this.boundSessionActorId} 不能切换到 ${sessionId}`);
    }
    if (this.activeRun) throw new Error(`Session ${this.activeRun.sessionId} 仍有任务运行中，不能切换`);
    await this.restoreSessionState(sessionId);
  }

  private async restoreSessionState(sessionId: string): Promise<void> {
    const nextSession = this.components.state.sessions.open(sessionId);
    await nextSession.ensure();
    await this.mediaArtifacts.reconcileEvidenceOwner(
      sessionMediaArtifactOwner(sessionId),
      await nextSession.listMediaEvidence(1_000),
    );
    const preferences = await nextSession.getPreferences();
    const runtime = this.sessionRuntime(preferences);
    const checkpoint = await nextSession.getCheckpoint();
    const recoveredCheckpoint = await nextSession.recoverInterruptedRun(checkpoint?.runId);

    this.sessionId = sessionId;
    this.session = nextSession;
    this.mode = runtime.mode.id;
    this.outputLevel = runtime.outputLevel;
    this.components.modelRuntime = runtime.model;
    this.components.state.goalsAndPlans.store.useSession(sessionId);
    this.components.state.team.store.useSession(sessionId);
    if (recoveredCheckpoint?.status !== 'running') {
      await this.components.state.team.store.recoverExpired(sessionId);
    }
    this.lastContextManifest = undefined;
  }

  listSessionSummaries = () => FileSession.listSummaries(path.join(this.config.dataRoot, 'sessions'));
  hasSession = (id: string) => FileSession.exists(path.join(this.config.dataRoot, 'sessions'), id);
  history = (): Promise<AgentInputItem[]> => this.session.getItems();

  async sessionSnapshot(sessionId = this.sessionId) {
    if (!this.activeRun) await this.refreshModelConfiguration();
    const session = this.components.state.sessions.open(sessionId);
    await session.ensure();
    const [items, checkpoint, preferences, summary, plan] = await Promise.all([
      session.getItems(),
      session.getCheckpoint(),
      session.getPreferences(),
      session.summary(),
      this.components.state.goalsAndPlans.open(sessionId).get(),
    ]);
    const runtime = this.sessionRuntime(preferences);
    const permissionMode = this.runtimeSecurity.permissionMode;
    if (!summary) throw new Error(`Session ${sessionId} 不存在`);

    return {
      sessionId,
      summary,
      items,
      recovery: checkpoint && checkpoint.status !== 'completed' ? checkpoint : undefined,
      plan,
      runtime: {
        provider: runtime.target.providerId,
        transport: this.components.modelGateway.provider(runtime.target).transport,
        model: runtime.model.name,
        modelTarget: { ...runtime.target },
        mode: runtime.mode,
        outputLevel: runtime.outputLevel,
        permissionMode,
      },
      context: {
        contextWindow: runtime.model.profile.contextWindow,
        status: this.contextStatusFor(sessionId, items, runtime.model.profile.contextWindow),
      },
    };
  }

  async clearSession(): Promise<void> {
    if (this.activeRun) throw new Error(`Session ${this.activeRun.sessionId} 仍有任务运行中，不能清空`);
    await this.clearSessionState(this.sessionId, this.session);
  }

  async listSkills() {
    const bindings = await this.session.getActiveSkills();
    return this.components.skills.list().map((skill) => {
      const binding = bindings.find((candidate) => candidate.name === skill.name);
      const active = Boolean(binding
        && binding.sourceId === skill.source.id
        && binding.file === skill.file
        && binding.contentHash === skill.contentHash);
      const availability = this.components.skills.evaluateAvailability(this.components.skills.get(skill.name)!, {
        canReadLocal: true,
        availableTools: this.toolNames,
        ...(binding ? { binding } : {}),
      });
      return {
        ...skill,
        enabled: !this.components.skills.preference(skill.name).disabled,
        disabledScope: this.components.skills.preference(skill.name).scope,
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
      const skill = this.components.skills.get(binding.name);
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
    await this.components.skills.setEnabled(name, scope, enabled);
    if (!enabled) await this.session.deactivateSkill(name);
  }

  async reloadSkills() {
    await this.components.skills.load();
    return {
      skills: this.components.skills.list(),
      warnings: this.components.skills.diagnostics(),
      diagnostics: this.components.skills.diagnosticDetails(),
    };
  }

  listUndoableRuns = (limit = 20) => this.fileChanges.list(limit);
  previewUndo = (runId: string) => this.fileChanges.preview(runId);

  async undoRun(runId: string) {
    if (this.activeRun) throw new Error('当前 Session 仍有任务运行中，不能撤销文件变更');
    return this.fileChanges.undo(runId);
  }

  memoryList = (scope: 'private' | 'workspace' | 'all' = 'all') =>
    this.components.memory.list(this.runContexts.forInspection(), { scope });
  memorySearch = (query: string, scope: 'private' | 'workspace' | 'all' = 'all') =>
    this.components.memory.search(query, this.runContexts.forInspection(), { scope });
  memoryRead = (ref: import('../core/memory.js').MemoryRef) =>
    this.components.memory.read(ref, this.runContexts.forInspection());
  memoryForget = (ref: import('../core/memory.js').MemoryRef) =>
    this.components.memory.forget(ref, this.runContexts.forInspection());

  async memoryIngest(target: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return this.components.memory.ingest(target, this.runContexts.forInspection());
  }

  memoryCapture = (input: CaptureInput, profileId = 'owner') =>
    this.components.memory.capture(input, this.memoryMaintenanceContext(profileId));
  memoryMerge = (input: Parameters<MemoryHub['merge']>[0], profileId = 'owner') =>
    this.components.memory.merge(input, this.memoryMaintenanceContext(profileId));

  memorySupersede = (
    ref: MemoryRef,
    replacementRef: MemoryRef | undefined,
    reasonCode: string,
    profileId = 'owner',
  ) => this.components.memory.supersede(
    ref, replacementRef, reasonCode, this.memoryMaintenanceContext(profileId),
  );

  memoryAddLinks = (ref: MemoryRef, links: string[], reasonCode: string, profileId = 'owner') =>
    this.components.memory.addLinks(ref, links, reasonCode, this.memoryMaintenanceContext(profileId));

  memoryMove = (
    ref: MemoryRef,
    targetScope: 'private' | 'workspace',
    reasonCode: string,
    profileId = 'owner',
  ) => this.components.memory.move(ref, targetScope, reasonCode, this.memoryMaintenanceContext(profileId));

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
      const episode = await this.components.memory.read(
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
    return this.components.memory.capture({
      title, content, sourceRefs, scope: 'private', kind: 'synthesis',
      confidence: 'user-confirmed', reasonCode: 'owner_manual_capture',
    }, this.runContexts.forInspection());
  }

  memoryReject = (sourceRefs: SourceRef[], reasonCode: string, profileId = 'owner') =>
    this.components.memory.reject(sourceRefs, reasonCode, this.memoryMaintenanceContext(profileId));
  memoryConflicts = (limit = 50) => this.components.memory.conflicts(this.runContexts.forInspection(), limit);
  memoryAudit = (limit = 50) => this.components.memory.audit(this.runContexts.forInspection(), limit);
  memoryLint = (profileId = 'owner') => this.components.memory.lint(
    this.runContexts.forInspection(profileId, 'memory-lint'),
  );
  memoryRefresh = (limit = 20, profileId = 'owner') =>
    this.components.memory.refreshStale(limit, this.memoryMaintenanceContext(profileId));
  memoryReindex = () => this.components.memory.reindex(this.runContexts.forInspection());
  memoryStatus = () => this.components.memory.status(this.runContexts.forInspection());
  currentPlan = () => this.components.state.goalsAndPlans.store.get();
  currentGoal = () => this.components.state.goalsAndPlans.store.getGoal();
  currentTeam = () => this.components.state.team.store.list();
  setGoal = (objective: string) => this.components.state.goalsAndPlans.store.setGoal(objective);

  async resumePrompt(): Promise<string> {
    const [goal, steps, checkpoint, team, teamTasks] = await Promise.all([
      this.components.state.goalsAndPlans.store.getGoal(),
      this.components.state.goalsAndPlans.store.get(),
      this.session.getCheckpoint(),
      this.components.state.team.store.summary(),
      this.components.state.team.store.list(),
    ]);
    return buildResumePrompt({ goal, steps, checkpoint, teamSummary: team, teamTasks });
  }

  async recoveryInfo(): Promise<RunCheckpoint | undefined> {
    const checkpoint = await this.session.getCheckpoint();
    return checkpoint && checkpoint.status !== 'completed' ? checkpoint : undefined;
  }

  async compactContext() {
    const [history, previous] = await Promise.all([this.session.getItems(), this.session.getContextArchive()]);
    const archive = createModelContext(this.config, this.components.modelRuntime.profile)
      .compactArchive(history, previous, 'full');
    if (!archive || archive.coveredItems === previous?.coveredItems) {
      return { changed: false, archive: previous, message: '历史不足两轮，无需压缩。' };
    }
    await this.session.setContextArchive(archive);
    this.lastContextManifest = undefined;
    return { changed: true, archive, message: `已归档 ${archive.coveredItems} 个历史条目。` };
  }

  runtimeInfo = () => this.runtimeControlCoordinator.runtimeInfo();
  runtimeStatus = (projection: 'summary' | 'detail' = 'summary') =>
    this.runtimeControlCoordinator.runtimeStatus(projection);
  currentCapabilitySnapshot = (): Readonly<EffectiveCapabilitySnapshot> | undefined =>
    this.runtimeControlCoordinator.currentCapabilitySnapshot();
  computerStatus = () => this.runtimeControlCoordinator.computerStatus();

  prepareQqPersonalMessageScope = (
    ...args: Parameters<RuntimeControlCoordinator['prepareQqPersonalMessageScope']>
  ) => this.runtimeControlCoordinator.prepareQqPersonalMessageScope(...args);

  assertReadOnlyDaemonProbePolicy(hostTools: readonly Tool[]): void {
    this.runtimeControlCoordinator.assertReadOnlyDaemonProbePolicy(hostTools);
  }

  probeReadOnlyComputerWindow = (
    ...args: Parameters<RuntimeControlCoordinator['probeReadOnlyComputerWindow']>
  ) => this.runtimeControlCoordinator.probeReadOnlyComputerWindow(...args);

  guidanceInfo = () => this.runtimeControlCoordinator.guidanceInfo();
  modelControl = (rawRequest: unknown): Promise<unknown> =>
    this.runtimeControlCoordinator.modelControl(rawRequest);
  availableModels = (): string[] => this.runtimeControlCoordinator.availableModels();
  switchModel = (modelName: string): Promise<void> => this.runtimeControlCoordinator.switchModel(modelName);
  switchModelTarget = (target: ModelTarget): Promise<void> =>
    this.runtimeControlCoordinator.switchModelTarget(target);
  availableModes = () => this.runtimeControlCoordinator.availableModes();
  switchMode = (mode: string): Promise<void> => this.runtimeControlCoordinator.switchMode(mode);
  setOutputLevel = (level: RuntimeOutputLevel): Promise<void> =>
    this.runtimeControlCoordinator.setOutputLevel(level);
  contextInfo = () => this.runtimeControlCoordinator.contextInfo();

  get toolNames(): string[] {
    const scoped = [
      ...this.registeredTools(),
      ...createMemoryTools(this.components.memory, () => this.runContexts.forInspection()),
      ...createPlanTools(this.components.state.goalsAndPlans.store),
    ];
    return toolNamesForMode(this.mode, scoped, this.runtimeSecurity.permissionMode);
  }

  async visibleToolNames(hostTools: Tool[] = []): Promise<string[]> {
    const scoped = [
      ...this.registeredTools(),
      ...hostTools,
      ...createMemoryTools(this.components.memory, () => this.runContexts.forInspection()),
      ...createPlanTools(this.components.state.goalsAndPlans.store),
    ];
    const functionNames = toolNamesForMode(
      this.mode,
      scoped,
      this.runtimeSecurity.permissionMode,
    );
    if (
      this.mode === 'plan'
      || this.runtimeSecurity.permissionMode !== 'trusted'
      || this.components.mcp.servers.length === 0
    ) return functionNames;
    const mcpTools = await getAllMcpTools({
      mcpServers: this.components.mcp.servers,
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

  mcpStatuses = () => this.components.mcp.statuses();
  reloadMcp = () => this.components.mcp.reload();

  async recordEvent(type: string, data?: unknown): Promise<void> {
    const run = this.activeRun;
    const sessionId = run?.sessionId ?? this.sessionId;
    const session = run?.session ?? this.session;
    const safeData = redactActiveEphemeralData(data, run?.ephemeralSensitiveAccess);
    if (type === 'status' && safeData && typeof safeData === 'object') {
      const value = safeData as Record<string, unknown>;
      await this.components.state.traces.record(sessionId, type, {
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
    await this.components.state.traces.record(sessionId, type, safeData);
  }

  onRuntimeEvent = (hook: RuntimeHook): (() => void) => this.hooks.on(hook);
  completeRun = (answer: string, usage?: ContextUsageSnapshot) =>
    this.runCommitCoordinator.complete({ answer, usage });
  get completionGateRequired(): boolean {
    return this.activeRun?.completionRequired === true;
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
  finalizeExecutionLedger = (sessionId: string, executionKey: string): Promise<void> =>
    this.runCommitCoordinator.finalizeExecutionLedger(sessionId, executionKey);

  /**
   * Removes only the completed-run receipt so a paused/blocked durable Event
   * can ask the model for a new turn. Successful side-effect tool entries stay
   * fenced and therefore cannot be silently repeated after resume.
   */
  reopenExecutionLedger = (sessionId: string, executionKey: string): Promise<void> =>
    this.runCommitCoordinator.reopenExecutionLedger(sessionId, executionKey);

  completedExecution = (...args: Parameters<RunCommitCoordinator['completedExecution']>) =>
    this.runCommitCoordinator.completedExecution(...args);
  async close(): Promise<void> {
    await Promise.all([this.components.mcp.close(), this.components.computer?.close()]);
  }

  createEphemeralRedactingSession(
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
      const target = this.components.modelGateway.resolveAgentTarget(action.model);
      if (this.sessionId === originSessionId) await this.switchModelTarget(target);
      else await this.components.state.sessions.open(originSessionId).setPreferences({ modelTarget: target });
      return { type: 'model_changed', model: action.model };
    }
    if (action.type === 'switch_provider') {
      return { type: 'provider_change_requested', provider: action.provider };
    }
    if (action.type === 'switch_mode') {
      if (!AGENT_MODES.some((mode) => mode.id === action.mode)) throw new Error(`未知模式：${action.mode}`);
      if (this.sessionId === originSessionId) await this.switchMode(action.mode);
      else await this.components.state.sessions.open(originSessionId).setPreferences({ mode: action.mode });
      return { type: 'mode_changed', mode: action.mode };
    }
    if (action.type === 'set_output_level') {
      if (this.sessionId === originSessionId) await this.setOutputLevel(action.level);
      else await this.components.state.sessions.open(originSessionId).setPreferences({ outputLevel: action.level });
      return { type: 'output_level_changed', level: action.level };
    }
    if (action.type === 'clear_session') {
      const origin = this.sessionId === originSessionId
        ? this.session
        : this.components.state.sessions.open(originSessionId);
      await this.clearSessionState(originSessionId, origin, retainedExecutionKey);
      return { type: 'session_cleared', sessionId: originSessionId };
    }
    if (action.type === 'exit') return { type: 'exit_requested' };
    if (action.type === 'reload_mcp') {
      await this.reloadMcp();
      return { type: 'mcp_reloaded' };
    }
    if (this.boundSessionActorId) await this.components.state.sessions.open(action.sessionId).ensure();
    else await this.switchSession(action.sessionId);
    return { type: 'session_changed', sessionId: action.sessionId };
  }

  validUsage(
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

  applyManifestActual(usage?: ContextUsageSnapshot): void {
    if (!this.lastContextManifest || !usage?.lastRequestInputTokens) return;
    const inputTokens = usage.lastRequestInputTokens;
    const outputTokens = usage.lastRequestOutputTokens ?? 0;
    this.lastContextManifest.actual = {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      ...(usage.runInputTokens !== undefined ? { runInputTokens: usage.runInputTokens } : {}),
      ...(usage.runOutputTokens !== undefined ? { runOutputTokens: usage.runOutputTokens } : {}),
      ...(usage.runTotalTokens !== undefined ? { runTotalTokens: usage.runTotalTokens } : {}),
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
    if (!manifest) return { value: estimateTokens(items), source: 'raw-history', contextWindow };
    return {
      value: manifest.actual?.inputTokens ?? manifest.estimatedInputTokens,
      source: manifest.actual ? 'actual' : 'estimate',
      contextWindow,
      requestId: manifest.requestId,
      ...(manifest.compression.length
        ? { compressedFrom: Math.max(...manifest.compression.map((record) => record.beforeTokens)) }
        : {}),
    };
  }

  private memoryMaintenanceContext(profileId: string) {
    return this.runContexts.forInspection(profileId, 'memory-maintenance');
  }

  private async clearSessionState(
    sessionId: string,
    session: FileSession,
    retainedExecutionKey?: string,
  ): Promise<void> {
    await session.clearSession(async () => Promise.all([
      this.components.state.goalsAndPlans.store.clear(sessionId),
      this.components.state.team.store.clear(sessionId),
      retainedExecutionKey
        ? this.components.state.executionLedger.store.clearSessionExcept(sessionId, retainedExecutionKey)
        : this.components.state.executionLedger.store.clearSession(sessionId),
    ]).then(() => undefined));
    await this.mediaArtifacts.releaseOwner(sessionMediaArtifactOwner(sessionId));
  }

}

export type AgentSessionSnapshot = Awaited<ReturnType<MimiAgent['sessionSnapshot']>>;
export type CompletedExecutionReceipt = NonNullable<Awaited<ReturnType<
  MimiAgent['completedExecution']
>>>;
