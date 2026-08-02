import type { Tool } from '@openai/agents';
import {
  SECURITY_PROFILES,
  securityProfileSummary,
  type AgentPermissionMode,
  type AppConfig,
  type SecurityProfile,
} from '../config.js';
import {
  ContextManager,
  type ContextManifest,
  type ContextStats,
} from '../core/context.js';
import type { ProjectGuidanceLoader, SoulLoader } from '../core/guidance.js';
import type { MemoryHub } from '../core/memory.js';
import type { PreferenceStore } from '../core/preferences.js';
import type { PlanStore } from '../core/plan.js';
import {
  modelControlRequestSchema,
  modelTargetKey,
  type ModelTarget,
  type ProviderTransport,
  type RunModelBinding,
} from '../core/model-routing.js';
import type { FileSession, SessionPreferences } from '../core/session.js';
import type { TeamTaskStore } from '../core/team.js';
import type { MCPManager } from '../extensions/mcp.js';
import type { SkillLoader } from '../extensions/skills.js';
import type { ComputerManager } from '../extensions/computer/manager.js';
import type { QqPersonalMessageComputerAdapter } from '../extensions/computer/qq-personal-message.js';
import type { ComputerAccess, ComputerTargetSummary } from '../extensions/computer/types.js';
import type { PersonalMessageAuthorization } from '../core/personal-message.js';
import { configuredProviders } from '../provider-config.js';
import { RUNTIME_OUTPUT_LEVELS, type RuntimeOutputLevel } from './control.js';
import { AGENT_MODES, type AgentMode } from './instructions.js';
import type { AgentModel, ModelProfile } from './model.js';
import { ModelConfigStore, type ModelsConfig } from './model-config.js';
import type { ModelGateway } from './model-gateway.js';
import type { WorkUnitModelResolver } from './work-unit-model-resolver.js';
import type { RunContextBuilder } from './run-context-builder.js';
import type { PersonalMessageScope } from './personal-message-hub.js';
import type {
  ActiveRun,
  ContextUsageSnapshot,
  RunPolicy,
} from './mimi-agent.js';
import type { CapabilityResolver } from './pipeline/capability-resolver.js';
import type { EffectiveCapabilitySnapshot } from './pipeline/capability-resolver.js';
import { captureRunScope } from './pipeline/run-scope.js';
import type { ToolSetBuilder } from './pipeline/tool-set-builder.js';

export interface RuntimeControlHost {
  readonly config: AppConfig;
  readonly soul: SoulLoader;
  readonly preferences: PreferenceStore;
  readonly projectGuidance: ProjectGuidanceLoader;
  readonly team: TeamTaskStore;
  readonly plans: PlanStore;
  readonly memory: MemoryHub;
  readonly runContexts: RunContextBuilder;
  readonly skills: SkillLoader;
  readonly mcp: MCPManager;
  readonly computer?: ComputerManager;
  readonly qqPersonalMessages?: QqPersonalMessageComputerAdapter;
  readonly capabilityResolver: CapabilityResolver;
  readonly toolSetBuilder: ToolSetBuilder;
  readonly runtimeRoot: string;
  readonly legacyModels: boolean;
  activeRun?: ActiveRun;
  session: FileSession;
  sessionId: string;
  modelConfig: ModelsConfig;
  modelGateway: ModelGateway;
  modelResolver: WorkUnitModelResolver;
  modelName: string;
  modelProfile: ModelProfile;
  context: ContextManager;
  mode: AgentMode;
  outputLevel: RuntimeOutputLevel;
  permissionMode: AgentPermissionMode;
  securityProfile: SecurityProfile;
  defaultPermissionMode: AgentPermissionMode;
  defaultSecurityProfile: SecurityProfile;
  lastCapabilitySnapshot?: Readonly<EffectiveCapabilitySnapshot>;
  lastContextTokens: number;
  lastContextStats?: ContextStats;
  lastContextManifest?: ContextManifest;
  lastCompressionCount: number;
  lastUsage?: ContextUsageSnapshot;
  lastModelBinding?: RunModelBinding;
  refreshModelConfiguration(): Promise<void>;
  configuredModelProviders(): Array<{
    id: string;
    label: string;
    model?: string;
    models: string[];
    transport?: ProviderTransport;
    configured?: boolean;
  }>;
  providerForTarget(target: ModelTarget): {
    id: string;
    transport?: ProviderTransport;
  };
  legacySessionTarget(preferences: SessionPreferences): ModelTarget | undefined;
  exactRoute(binding: RunModelBinding | undefined): {
    provider: string;
    transport?: ProviderTransport;
  };
  installModelConfiguration(next: ModelsConfig): void;
  targetRuntime(target: ModelTarget): {
    model: AgentModel;
    name: string;
    profile: ModelProfile;
  };
  createSession(sessionId: string): FileSession;
  registeredTools(profile?: SecurityProfile, binding?: RunModelBinding): Tool[];
}

export class RuntimeControlCoordinator {
  constructor(private readonly host: RuntimeControlHost) {}

  async runtimeInfo() {
    if (!this.host.activeRun) await this.host.refreshModelConfiguration();
    const [
      sessionSummary,
      soul,
      preferences,
      projectGuidance,
      team,
      memoryStatus,
      sessionPreferences,
    ] = await Promise.all([
      this.host.session.summary(), this.host.soul.load(), this.host.preferences.load(), this.host.projectGuidance.load(), this.host.team.list(),
      this.host.memory.status(this.host.runContexts.forInspection()),
      this.host.session.getPreferences(),
    ]);
    const capabilitySnapshot = this.host.activeRun?.capabilitySnapshot ?? this.host.lastCapabilitySnapshot;
    const binding = this.host.activeRun?.scope.modelBinding ?? this.host.modelResolver.resolve({
      scenario: 'conversation.default',
      sessionTarget: sessionPreferences.modelTarget ?? this.host.legacySessionTarget(sessionPreferences),
      routeVersion: this.host.modelConfig.routeVersion,
    });
    const provider = this.host.providerForTarget(binding.target);
    return {
      provider: provider.id,
      transport: provider.transport,
      configuredProviders: this.host.configuredModelProviders(),
      model: binding.target.modelId,
      modelTarget: binding.target,
      modelBinding: binding,
      mode: AGENT_MODES.find((item) => item.id === this.host.mode)!,
      sessionId: this.host.sessionId,
      sessionTitle: sessionSummary.title,
      workspaceRoot: this.host.config.workspaceRoot,
      runtimeRoot: this.host.runtimeRoot,
      outputLevel: this.host.outputLevel,
      maxTurns: binding.maxTurns ?? this.host.config.maxTurns,
      permissionMode: this.host.permissionMode,
      securityProfile: securityProfileSummary({
        ...this.host.config,
        securityProfile: this.host.securityProfile,
        permissionMode: SECURITY_PROFILES[this.host.securityProfile].permissionMode,
      }),
      skillCount: capabilitySnapshot?.skills.length ?? this.host.skills.list().length,
      memoryCount: memoryStatus.pages,
      mcpServers: this.host.securityProfile === 'full-owner'
        ? this.host.mcp.servers.map((server) => server.name)
        : [],
      mcpStatuses: this.host.securityProfile === 'full-owner' ? this.host.mcp.statuses() : [],
      computer: this.host.securityProfile === 'full-owner'
        ? this.host.computer?.status() ?? { configured: false, backend: undefined }
        : { configured: false, backend: undefined },
      capabilitySnapshot,
      guidanceFiles: [...soul.files, ...preferences.files, ...projectGuidance.files]
        .map((file) => ({ scope: file.scope, path: file.path, truncated: file.truncated })),
      team: {
        total: team.length,
        pending: team.filter((item) => item.status === 'pending').length,
        running: team.filter((item) => item.status === 'running').length,
        completed: team.filter((item) => item.status === 'completed').length,
        failed: team.filter((item) => item.status === 'failed').length,
      },
    };
  }

  async runtimeStatus(projection: 'summary' | 'detail' = 'summary') {
    if (projection === 'detail') {
      return {
        schemaVersion: 1 as const,
        projection,
        ...await this.runtimeInfo(),
      };
    }
    const capabilitySnapshot = this.host.activeRun?.capabilitySnapshot ?? this.host.lastCapabilitySnapshot;
    return {
      schemaVersion: 1 as const,
      projection,
      provider: this.host.config.provider,
      configuredProviders: configuredProviders().map((provider) => ({
        id: provider.id,
        models: provider.models,
      })),
      model: this.host.modelName,
      mode: AGENT_MODES.find((item) => item.id === this.host.mode)!,
      sessionId: this.host.sessionId,
      workspaceRoot: this.host.config.workspaceRoot,
      outputLevel: this.host.outputLevel,
      permissionMode: this.host.permissionMode,
      securityProfile: securityProfileSummary({
        ...this.host.config,
        securityProfile: this.host.securityProfile,
        permissionMode: SECURITY_PROFILES[this.host.securityProfile].permissionMode,
      }),
      computer: this.host.securityProfile === 'full-owner'
        ? this.host.computer?.status() ?? { configured: false, backend: undefined }
        : { configured: false, backend: undefined },
      capability: capabilitySnapshot ? {
        runId: capabilitySnapshot.runId,
        policyRevision: capabilitySnapshot.policyRevision,
        toolSetDigest: capabilitySnapshot.toolSetDigest,
        snapshotDigest: capabilitySnapshot.snapshotDigest,
        tools: capabilitySnapshot.tools,
      } : undefined,
    };
  }

  currentCapabilitySnapshot(): Readonly<EffectiveCapabilitySnapshot> | undefined {
    return this.host.activeRun?.capabilitySnapshot ?? this.host.lastCapabilitySnapshot;
  }

  computerStatus() {
    return this.host.computer?.status();
  }

  async prepareQqPersonalMessageScope(
    authorization: PersonalMessageAuthorization,
    computerAccess: ComputerAccess | undefined,
    computerApps: readonly string[] | undefined,
    signal?: AbortSignal,
  ): Promise<PersonalMessageScope | undefined> {
    if (!this.host.qqPersonalMessages || authorization.channel !== 'qq') return undefined;
    if (!computerAccess || !['background', 'foreground', 'admin'].includes(computerAccess)) {
      return undefined;
    }
    if (!computerApps?.includes('com.tencent.qq')) return undefined;
    const probe = await this.host.qqPersonalMessages.probe(authorization, signal).catch(() => undefined);
    if (!probe) return undefined;
    const adapter = this.host.qqPersonalMessages;
    return {
      eventId: authorization.eventId,
      channel: authorization.channel,
      accountFingerprint: authorization.accountFingerprint,
      conversationId: authorization.conversationId,
      actorId: authorization.actorId,
      messageMode: authorization.mode,
      approvedText: authorization.approvedText,
      capability: probe.capability,
      getContext: (limit, requestSignal) => adapter.getContext(
        authorization,
        limit,
        requestSignal,
      ),
      send: ({ text, latestFingerprint }, requestSignal) => adapter.send(
        authorization,
        text,
        latestFingerprint,
        requestSignal,
      ),
    };
  }

  assertReadOnlyDaemonProbePolicy(hostTools: readonly Tool[]): void {
    const policy: RunPolicy = {
      allowedCapabilities: ['state-read'],
      allowedTools: ['inspect_mimi_capabilities'],
    };
    const binding = this.host.activeRun?.scope.modelBinding ?? this.host.modelResolver.resolve({
      scenario: 'conversation.default',
      routeVersion: this.host.modelConfig.routeVersion,
    });
    const route = this.host.exactRoute(binding);
    const scope = captureRunScope({
      sessionId: this.host.sessionId,
      workspaceRoot: this.host.config.workspaceRoot,
      provider: route.provider,
      transport: route.transport,
      model: binding.target.modelId,
      mode: 'general',
      permissionMode: this.host.permissionMode,
      securityProfile: this.host.securityProfile,
      input: 'authenticated daemon read-only probe policy check',
    });
    const capabilities = this.host.capabilityResolver.resolve({
      scope,
      policy,
    });
    const tools = this.host.toolSetBuilder.scoped(
      [...hostTools],
      this.host.permissionMode,
      this.host.securityProfile,
      policy,
      false,
    );
    if (!capabilities.canReadState
      || tools.length !== 1
      || tools[0]?.name !== 'inspect_mimi_capabilities') {
      throw new Error('正式 CapabilityResolver/Tool policy 未授权只读 Connector probe');
    }
  }

  async probeReadOnlyComputerWindow(
    allowedApps: readonly string[],
    deniedApps: readonly string[],
    signal?: AbortSignal,
    expectedTarget?: Pick<ComputerTargetSummary, 'bundleId' | 'pid' | 'windowId'>,
  ) {
    if (!this.host.computer) throw new Error('ComputerManager 未注册');
    const policy: RunPolicy = {
      allowedCapabilities: ['computer-read'],
      allowedTools: ['computer_observe'],
      computerAccess: 'observe',
    };
    const binding = this.host.activeRun?.scope.modelBinding ?? this.host.modelResolver.resolve({
      scenario: 'conversation.default',
      routeVersion: this.host.modelConfig.routeVersion,
    });
    const route = this.host.exactRoute(binding);
    const scope = captureRunScope({
      sessionId: this.host.sessionId,
      workspaceRoot: this.host.config.workspaceRoot,
      provider: route.provider,
      transport: route.transport,
      model: binding.target.modelId,
      mode: 'general',
      permissionMode: 'trusted',
      securityProfile: 'full-owner',
      input: 'authenticated daemon read-only computer probe',
      options: {
        cause: {
          eventId: `internal-computer-probe:${this.host.sessionId}`,
          source: 'mimi-kernel',
          trust: 'owner',
        },
      },
    });
    const capabilities = this.host.capabilityResolver.resolve({
      scope,
      policy,
      requestedComputerAccess: 'observe',
      defaultComputerAccess: this.host.config.computer?.defaultAccess,
    });
    const tools = this.host.toolSetBuilder.scoped(
      this.host.registeredTools('full-owner'),
      'trusted',
      'full-owner',
      policy,
      capabilities.computerAccess !== 'none',
    );
    if (capabilities.computerAccess !== 'observe'
      || tools.length !== 1
      || tools[0]?.name !== 'computer_observe') {
      throw new Error('正式 CapabilityResolver/Tool policy 未授权 computer_observe');
    }
    return this.host.computer.observeStableBackgroundWindow({
      runId: scope.runId,
      access: capabilities.computerAccess,
      allowedApps,
      deniedApps,
      supportsImageInput: false,
    }, signal, expectedTarget);
  }

  async guidanceInfo() {
    const [soul, preferences, project] = await Promise.all([
      this.host.soul.load(),
      this.host.preferences.load(),
      this.host.projectGuidance.load(),
    ]);
    return {
      files: [...soul.files, ...preferences.files, ...project.files],
      instructions: [soul.instructions, preferences.instructions, project.instructions].filter(Boolean).join('\n\n'),
    };
  }

  async modelControl(rawRequest: unknown): Promise<unknown> {
    if (!this.host.activeRun) await this.host.refreshModelConfiguration();
    const request = modelControlRequestSchema.parse(rawRequest);
    if (request.action === 'list') {
      return this.host.modelConfig.providers.flatMap((provider) =>
        provider.models.map((registration) => ({
          ...registration,
          provider: {
            id: provider.id,
            label: provider.label,
            transport: provider.transport,
          },
          configured: Boolean(process.env[provider.apiKeyEnv]?.trim()),
        })));
    }
    if (request.action === 'inspect') {
      const registration = this.host.modelGateway.inspect(request.target);
      const provider = this.host.modelConfig.providers.find(
        (item) => item.id === request.target.providerId,
      )!;
      return {
        ...registration,
        provider: {
          id: provider.id,
          label: provider.label,
          transport: provider.transport,
          ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
          ...(provider.region ? { region: provider.region } : {}),
          apiKeyEnv: provider.apiKeyEnv,
          configured: Boolean(process.env[provider.apiKeyEnv]?.trim()),
        },
      };
    }
    if (request.action === 'current') {
      const preferences = await this.host.createSession(
        this.host.activeRun?.sessionId ?? this.host.sessionId,
      ).getPreferences();
      const next = this.host.modelResolver.resolve({
        scenario: 'conversation.default',
        sessionTarget: preferences.modelTarget ?? this.host.legacySessionTarget(preferences),
        routeVersion: this.host.modelConfig.routeVersion,
      });
      return {
        sessionTarget: preferences.modelTarget,
        next,
        last: this.host.lastModelBinding,
      };
    }
    if (request.action === 'use') {
      const registration = this.host.modelGateway.inspect(request.target);
      if (registration.kind !== 'agent' || !registration.capabilities.toolCalling) {
        throw new Error(`Session 只能固定 Agent 模型：${modelTargetKey(request.target)}`);
      }
      const sessionId = this.host.activeRun?.sessionId ?? this.host.sessionId;
      await this.host.createSession(sessionId).setPreferences({
        modelTarget: { ...request.target },
        model: request.target.modelId,
      });
      return {
        target: request.target,
        effective: 'next_run',
        daemonRestarted: false,
      };
    }
    if (request.action === 'auto') {
      const sessionId = this.host.activeRun?.sessionId ?? this.host.sessionId;
      await this.host.createSession(sessionId).setPreferences({
        modelTarget: undefined,
        provider: undefined,
        model: undefined,
      });
      return { effective: 'next_run', daemonRestarted: false };
    }
    if (request.action === 'routes') {
      return {
        routeVersion: this.host.modelConfig.routeVersion,
        ...structuredClone(this.host.modelConfig.routing),
      };
    }
    if (request.action === 'route') {
      if (this.host.legacyModels || !this.host.config.modelsConfig) {
        throw new Error('legacy 环境没有 models.json，不能持久化场景路由');
      }
      const next = await new ModelConfigStore(this.host.config.modelsConfig).update((value) => {
        const scenarios = { ...value.routing.scenarios };
        if ('target' in request) {
          scenarios[request.scenario] = {
            target: request.target,
            ...(request.maxTurns ? { maxTurns: request.maxTurns } : {}),
            ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
          };
        }
        else delete scenarios[request.scenario];
        return {
          ...value,
          routeVersion: value.routeVersion + 1,
          routing: { ...value.routing, scenarios },
        };
      });
      if (!this.host.activeRun) this.host.installModelConfiguration(next);
      return {
        scenario: request.scenario,
        route: 'target' in request ? request.target : 'auto',
        routeVersion: next.routeVersion,
        daemonRestarted: false,
      };
    }
    if (request.action === 'doctor') {
      return request.target
        ? this.host.modelGateway.health(request.target)
        : Promise.all(this.host.modelGateway.list().map((registration) =>
            this.host.modelGateway.health(registration.target)));
    }
    throw new Error(`未知模型控制动作：${String((request as { action?: unknown }).action)}`);
  }

  availableModels(): string[] {
    return [...new Set(this.host.modelConfig.providers.flatMap((provider) =>
      provider.models.filter((model) => model.kind === 'agent')
        .map((model) => model.target.modelId)))];
  }

  async switchModel(modelName: string): Promise<void> {
    if (!/^[a-zA-Z0-9._:/-]+$/.test(modelName)) throw new Error('模型名称格式无效');
    const slash = modelName.indexOf('/');
    const candidates = slash > 0
      ? [{
          providerId: modelName.slice(0, slash),
          modelId: modelName.slice(slash + 1),
        }]
      : this.host.modelConfig.providers.flatMap((provider) =>
          provider.models
            .filter((model) => model.kind === 'agent' && model.target.modelId === modelName)
            .map((model) => model.target));
    if (candidates.length !== 1) {
      throw new Error(candidates.length
        ? `模型名称不唯一，请使用 providerId/modelId：${modelName}`
        : `模型不可用：${modelName}。可用模型：${this.availableModels().join('、')}`);
    }
    await this.switchModelTarget(candidates[0]!);
  }

  async switchModelTarget(target: ModelTarget): Promise<void> {
    const runtime = this.host.targetRuntime(target);
    this.host.modelName = runtime.name;
    this.host.modelProfile = runtime.profile;
    this.host.context = new ContextManager(
      this.host.config.historyLimit,
      runtime.profile.contextWindow,
      0.55,
      runtime.profile.outputReserve,
    );
    this.host.lastContextTokens = 0;
    this.host.lastContextStats = undefined;
    this.host.lastContextManifest = undefined;
    this.host.lastUsage = undefined;
    await this.host.session.setPreferences({
      modelTarget: { ...target },
      model: this.host.modelName,
    });
  }

  assertModelAvailable(modelName: string): void {
    if (!this.availableModels().includes(modelName)) throw new Error(`模型不可用：${modelName}`);
  }

  availableModes() {
    return AGENT_MODES.map(({ id, label, description }) => ({ id, label, description }));
  }

  async switchMode(mode: string): Promise<void> {
    if (!AGENT_MODES.some((item) => item.id === mode)) throw new Error(`未知模式：${mode}`);
    this.host.mode = mode as AgentMode;
    await this.host.session.setPreferences({ mode: this.host.mode });
  }

  async switchSecurityProfile(profile: string): Promise<void> {
    if (!Object.hasOwn(SECURITY_PROFILES, profile)) throw new Error(`未知安全档位：${profile}`);
    if (this.host.activeRun) throw new Error(`Session ${this.host.activeRun.sessionId} 仍有任务运行中，不能切换安全档位`);
    const next = profile as SecurityProfile;
    this.host.defaultSecurityProfile = next;
    this.host.defaultPermissionMode = SECURITY_PROFILES[next].permissionMode;
    this.host.securityProfile = next;
    this.host.permissionMode = this.host.defaultPermissionMode;
  }

  async setOutputLevel(level: RuntimeOutputLevel): Promise<void> {
    if (!RUNTIME_OUTPUT_LEVELS.includes(level)) throw new Error(`未知输出等级：${level}`);
    this.host.outputLevel = level;
    await this.host.session.setPreferences({ outputLevel: this.host.outputLevel });
  }

  async contextInfo() {
    const [history, memories, plan, goal, team, archive, checkpoint] = await Promise.all([
      this.host.session.getItems(),
      this.host.memory.list(this.host.runContexts.forInspection()),
      this.host.plans.get(),
      this.host.plans.getGoal(),
      this.host.team.list(),
      this.host.session.getContextArchive(),
      this.host.session.getCheckpoint(),
    ]);
    const effective = this.host.context.effectiveHistory(history, [], archive);
    const stats = this.host.lastContextStats ?? this.host.context.stats(history, effective, archive);
    const manifest = this.host.lastContextManifest?.sessionId === this.host.sessionId
      ? this.host.lastContextManifest
      : undefined;
    return {
      historyItems: history.length,
      historyLimit: this.host.config.historyLimit,
      estimatedTokens: this.host.lastContextTokens || stats.effectiveTokens + stats.archiveTokens,
      estimateScope: this.host.lastContextTokens ? 'last_request' as const : 'history_only' as const,
      rawTokens: stats.rawTokens,
      effectiveTokens: manifest
        ? manifest.sections.find((section) => section.id === 'recent-history')?.estimatedTokens ?? stats.effectiveTokens
        : stats.effectiveTokens,
      requestEstimateTokens: manifest?.estimatedInputTokens,
      archiveTokens: stats.archiveTokens,
      archivedItems: stats.coveredItems,
      contextStrategies: manifest?.compression.map((record) => record.strategy) ?? stats.strategies,
      sections: manifest?.sections,
      compression: manifest?.compression,
      estimator: manifest?.estimator ?? 'mimi-char-v1',
      requestId: manifest?.requestId,
      compactedAt: archive?.updatedAt,
      contextWindow: this.host.modelProfile.contextWindow,
      outputReserve: this.host.modelProfile.outputReserve,
      inputBudget: manifest?.availableInputBudget
        ?? this.host.context.requestBudget([]).inputBudget,
      lastRequestInputTokens: this.host.lastUsage?.lastRequestInputTokens,
      lastRequestOutputTokens: this.host.lastUsage?.lastRequestOutputTokens,
      runInputTokens: this.host.lastUsage?.runInputTokens,
      runOutputTokens: this.host.lastUsage?.runOutputTokens,
      runTotalTokens: this.host.lastUsage?.runTotalTokens,
      modelViewTokens: stats.effectiveTokens,
      modelViewRatio: stats.effectiveTokens / Math.max(
        1,
        manifest?.availableInputBudget ?? this.host.context.requestBudget([]).inputBudget,
      ),
      staticCapabilityTokens: (manifest?.sections ?? [])
        .filter((section) => section.id === 'tool-schemas' || section.id === 'runtime-context')
        .reduce((total, section) => total + section.estimatedTokens, 0),
      protocolReserveTokens: manifest?.sections
        .find((section) => section.id === 'protocol-reserve')?.estimatedTokens
        ?? this.host.context.requestBudget([]).protocolReserveTokens,
      compressionCount: this.host.lastCompressionCount,
      memories: memories.length,
      planSteps: plan.length,
      goal: goal?.status,
      teamTasks: team.length,
      runStatus: checkpoint?.status,
    };
  }
}
