import type { Tool } from '@openai/agents';
import {
  modelControlRequestSchema,
  modelTargetKey,
  type ModelTarget,
} from '../core/model-routing.js';
import type { ComputerAccess, ComputerTargetSummary } from '../extensions/computer/types.js';
import type { PersonalMessageAuthorization } from '../core/personal-message.js';
import { RUNTIME_OUTPUT_LEVELS, type RuntimeOutputLevel } from './control.js';
import { AGENT_MODES, type AgentMode } from './instructions.js';
import { createModelContext } from './model.js';
import { ModelConfigStore } from './model-config.js';
import type { PersonalMessageScope } from './personal-message-hub.js';
import type {
  MimiAgent,
  RunPolicy,
} from './mimi-agent.js';
import type { EffectiveCapabilitySnapshot } from './pipeline/capability-resolver.js';
import { captureRunScope } from './pipeline/run-scope.js';

export class RuntimeControlCoordinator {
  constructor(private readonly host: MimiAgent) {}

  async runtimeInfo() {
    if (!this.host.activeRun) await this.host.refreshModelConfiguration();
    const components = this.host.components;
    const [
      sessionSummary,
      soul,
      preferences,
      projectGuidance,
      team,
      memoryStatus,
      sessionPreferences,
    ] = await Promise.all([
      this.host.session.summary(), components.soul.load(), components.preferences.load(), components.projectGuidance.load(), components.state.team.store.list(),
      components.memory.status(this.host.runContexts.forInspection()),
      this.host.session.getPreferences(),
    ]);
    const capabilitySnapshot = this.host.activeRun?.capabilitySnapshot ?? this.host.lastCapabilitySnapshot;
    const binding = this.host.activeRun?.scope.modelBinding ?? components.modelResolver.resolve({
      scenario: 'conversation.default',
      sessionTarget: sessionPreferences.modelTarget
        ?? components.modelGateway.legacyAgentTarget(sessionPreferences.model, sessionPreferences.provider),
      routeVersion: components.modelConfig.routeVersion,
    });
    const provider = components.modelGateway.provider(binding.target);
    return {
      provider: provider.id,
      transport: provider.transport,
      configuredProviders: components.modelConfig.providers.map((configured) => ({
        id: configured.id,
        label: configured.label,
        model: configured.models[0]?.target.modelId,
        transport: configured.transport,
        configured: Boolean(process.env[configured.apiKeyEnv]?.trim()),
        models: configured.models.map((model) => model.target.modelId),
      })),
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
      permissionMode: this.host.runtimeSecurity.permissionMode,
      securityProfile: this.host.runtimeSecurity,
      skillCount: capabilitySnapshot?.skills.length ?? components.skills.list().length,
      memoryCount: memoryStatus.pages,
      mcpServers: this.host.runtimeAccess.mcp
        ? components.mcp.servers.map((server) => server.name)
        : [],
      mcpStatuses: this.host.runtimeAccess.mcp ? components.mcp.statuses() : [],
      computer: this.host.runtimeAccess.computer
        ? components.computer?.status() ?? { configured: false, backend: undefined }
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
    const info = await this.runtimeInfo();
    if (projection === 'detail') {
      return {
        schemaVersion: 1 as const,
        projection,
        ...info,
      };
    }
    return {
      schemaVersion: 1 as const,
      projection,
      provider: info.provider,
      configuredProviders: info.configuredProviders.map((provider) => ({
        id: provider.id,
        models: provider.models,
      })),
      model: info.model,
      mode: info.mode,
      sessionId: info.sessionId,
      workspaceRoot: info.workspaceRoot,
      outputLevel: info.outputLevel,
      permissionMode: info.permissionMode,
      securityProfile: info.securityProfile,
      computer: info.computer,
      capability: info.capabilitySnapshot ? {
        runId: info.capabilitySnapshot.runId,
        policyRevision: info.capabilitySnapshot.policyRevision,
        toolSetDigest: info.capabilitySnapshot.toolSetDigest,
        snapshotDigest: info.capabilitySnapshot.snapshotDigest,
        tools: info.capabilitySnapshot.tools,
      } : undefined,
    };
  }

  currentCapabilitySnapshot(): Readonly<EffectiveCapabilitySnapshot> | undefined {
    return this.host.activeRun?.capabilitySnapshot ?? this.host.lastCapabilitySnapshot;
  }

  computerStatus() {
    return this.host.components.computer?.status();
  }

  async prepareQqPersonalMessageScope(
    authorization: PersonalMessageAuthorization,
    computerAccess: ComputerAccess | undefined,
    computerApps: readonly string[] | undefined,
    signal?: AbortSignal,
  ): Promise<PersonalMessageScope | undefined> {
    return this.host.qqPersonalMessages?.prepareScope(
      authorization, computerAccess, computerApps, signal,
    );
  }

  assertReadOnlyDaemonProbePolicy(hostTools: readonly Tool[]): void {
    const policy: RunPolicy = {
      allowedCapabilities: ['state-read'],
      allowedTools: ['inspect_mimi_capabilities'],
    };
    const scope = this.probeScope('authenticated daemon read-only probe policy check');
    const capabilities = this.host.capabilityResolver.resolve({
      scope,
      runtimeAccess: this.host.runtimeAccess,
      policy,
    });
    const tools = this.host.toolSetBuilder.scoped(
      this.host.authorizeTools([...hostTools]),
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
    const computer = this.host.components.computer;
    if (!computer) throw new Error('ComputerManager 未注册');
    const policy: RunPolicy = {
      allowedCapabilities: ['computer-read'],
      allowedTools: ['computer_observe'],
      computerAccess: 'observe',
    };
    const scope = this.probeScope('authenticated daemon read-only computer probe', true);
    const capabilities = this.host.capabilityResolver.resolve({
      scope,
      runtimeAccess: this.host.runtimeAccess,
      policy,
      requestedComputerAccess: 'observe',
      defaultComputerAccess: this.host.config.computer?.defaultAccess,
    });
    const tools = this.host.toolSetBuilder.scoped(
      this.host.registeredTools(),
      policy,
      capabilities.computerAccess !== 'none',
    );
    if (capabilities.computerAccess !== 'observe'
      || tools.length !== 1
      || tools[0]?.name !== 'computer_observe') {
      throw new Error('正式 CapabilityResolver/Tool policy 未授权 computer_observe');
    }
    return computer.observeStableBackgroundWindow({
      runId: scope.runId,
      access: capabilities.computerAccess,
      allowedApps,
      deniedApps,
      supportsImageInput: false,
    }, signal, expectedTarget);
  }

  async guidanceInfo() {
    const [soul, preferences, project] = await Promise.all([
      this.host.components.soul.load(),
      this.host.components.preferences.load(),
      this.host.components.projectGuidance.load(),
    ]);
    return {
      files: [...soul.files, ...preferences.files, ...project.files],
      instructions: [soul.instructions, preferences.instructions, project.instructions].filter(Boolean).join('\n\n'),
    };
  }

  async modelControl(rawRequest: unknown): Promise<unknown> {
    if (!this.host.activeRun) await this.host.refreshModelConfiguration();
    const components = this.host.components;
    const request = modelControlRequestSchema.parse(rawRequest);
    if (request.action === 'list') {
      return components.modelConfig.providers.flatMap((provider) =>
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
      const registration = components.modelGateway.inspect(request.target);
      const provider = components.modelGateway.provider(request.target);
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
      const preferences = await components.state.sessions.open(
        this.host.activeRun?.sessionId ?? this.host.sessionId,
      ).getPreferences();
      const next = components.modelResolver.resolve({
        scenario: 'conversation.default',
        sessionTarget: preferences.modelTarget
          ?? components.modelGateway.legacyAgentTarget(preferences.model, preferences.provider),
        routeVersion: components.modelConfig.routeVersion,
      });
      return {
        sessionTarget: preferences.modelTarget,
        next,
        last: this.host.lastModelBinding,
      };
    }
    if (request.action === 'use') {
      const registration = components.modelGateway.inspect(request.target);
      if (registration.kind !== 'agent' || !registration.capabilities.toolCalling) {
        throw new Error(`Session 只能固定 Agent 模型：${modelTargetKey(request.target)}`);
      }
      const sessionId = this.host.activeRun?.sessionId ?? this.host.sessionId;
      await components.state.sessions.open(sessionId).setPreferences({
        modelTarget: { ...request.target },
        provider: undefined,
        model: undefined,
      });
      return {
        target: request.target,
        effective: 'next_run',
        daemonRestarted: false,
      };
    }
    if (request.action === 'auto') {
      const sessionId = this.host.activeRun?.sessionId ?? this.host.sessionId;
      await components.state.sessions.open(sessionId).setPreferences({
        modelTarget: undefined,
        provider: undefined,
        model: undefined,
      });
      return { effective: 'next_run', daemonRestarted: false };
    }
    if (request.action === 'routes') {
      return {
        routeVersion: components.modelConfig.routeVersion,
        ...structuredClone(components.modelConfig.routing),
      };
    }
    if (request.action === 'route') {
      if (!this.host.config.modelsConfig) {
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
        ? components.modelGateway.health(request.target)
        : Promise.all(components.modelGateway.list().map((registration) =>
            components.modelGateway.health(registration.target)));
    }
    throw new Error(`未知模型控制动作：${String((request as { action?: unknown }).action)}`);
  }

  availableModels(): string[] {
    return [...new Set(this.host.components.modelConfig.providers.flatMap((provider) =>
      provider.models.filter((model) => model.kind === 'agent')
        .map((model) => model.target.modelId)))];
  }

  async switchModel(modelName: string): Promise<void> {
    await this.switchModelTarget(this.host.components.modelGateway.resolveAgentTarget(modelName));
  }

  async switchModelTarget(target: ModelTarget): Promise<void> {
    const runtime = this.host.targetRuntime(target);
    this.host.components.modelRuntime = runtime;
    this.host.lastContextManifest = undefined;
    await this.host.session.setPreferences({
      modelTarget: { ...target },
      provider: undefined,
      model: undefined,
    });
  }

  availableModes() {
    return AGENT_MODES.map(({ id, label, description }) => ({ id, label, description }));
  }

  async switchMode(mode: string): Promise<void> {
    if (!AGENT_MODES.some((item) => item.id === mode)) throw new Error(`未知模式：${mode}`);
    this.host.mode = mode as AgentMode;
    await this.host.session.setPreferences({ mode: this.host.mode });
  }

  async setOutputLevel(level: RuntimeOutputLevel): Promise<void> {
    if (!RUNTIME_OUTPUT_LEVELS.includes(level)) throw new Error(`未知输出等级：${level}`);
    this.host.outputLevel = level;
    await this.host.session.setPreferences({ outputLevel: this.host.outputLevel });
  }

  async contextInfo() {
    const [history, memories, plan, goal, team, archive, checkpoint] = await Promise.all([
      this.host.session.getItems(),
      this.host.components.memory.list(this.host.runContexts.forInspection()),
      this.host.components.state.goalsAndPlans.store.get(),
      this.host.components.state.goalsAndPlans.store.getGoal(),
      this.host.components.state.team.store.list(),
      this.host.session.getContextArchive(),
      this.host.session.getCheckpoint(),
    ]);
    const context = createModelContext(this.host.config, this.host.components.modelRuntime.profile);
    const effective = context.effectiveHistory(history, [], archive);
    const stats = context.stats(history, effective, archive);
    const manifest = this.host.lastContextManifest?.sessionId === this.host.sessionId
      ? this.host.lastContextManifest
      : undefined;
    const requestBudget = context.requestBudget([]);
    const inputBudget = manifest?.availableInputBudget ?? requestBudget.inputBudget;
    return {
      historyItems: history.length,
      historyLimit: this.host.config.historyLimit,
      estimatedTokens: manifest?.estimatedInputTokens ?? stats.effectiveTokens + stats.archiveTokens,
      estimateScope: manifest ? 'last_request' as const : 'history_only' as const,
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
      contextWindow: this.host.components.modelRuntime.profile.contextWindow,
      outputReserve: this.host.components.modelRuntime.profile.outputReserve,
      inputBudget,
      lastRequestInputTokens: manifest?.actual?.inputTokens,
      lastRequestOutputTokens: manifest?.actual?.outputTokens,
      runInputTokens: manifest?.actual?.runInputTokens,
      runOutputTokens: manifest?.actual?.runOutputTokens,
      runTotalTokens: manifest?.actual?.runTotalTokens,
      modelViewTokens: manifest?.estimatedInputTokens ?? stats.effectiveTokens,
      modelViewRatio: (manifest?.estimatedInputTokens ?? stats.effectiveTokens) / Math.max(1, inputBudget),
      staticCapabilityTokens: (manifest?.sections ?? [])
        .filter((section) => section.id === 'tool-schemas' || section.id === 'runtime-context')
        .reduce((total, section) => total + section.estimatedTokens, 0),
      protocolReserveTokens: manifest?.sections
        .find((section) => section.id === 'protocol-reserve')?.estimatedTokens
        ?? requestBudget.protocolReserveTokens,
      compressionCount: manifest?.compression.length ?? 0,
      memories: memories.length,
      planSteps: plan.length,
      goal: goal?.status,
      teamTasks: team.length,
      runStatus: checkpoint?.status,
    };
  }

  private probeScope(input: string, owner = false) {
    const binding = this.host.activeRun?.scope.modelBinding ?? this.host.components.modelResolver.resolve({
      scenario: 'conversation.default',
      routeVersion: this.host.components.modelConfig.routeVersion,
    });
    const provider = this.host.components.modelGateway.provider(binding.target);
    return captureRunScope({
      sessionId: this.host.sessionId,
      workspaceRoot: this.host.config.workspaceRoot,
      provider: provider.id,
      transport: provider.transport,
      model: binding.target.modelId,
      mode: 'general',
      input,
      ...(owner ? { options: { cause: {
        eventId: `internal-computer-probe:${this.host.sessionId}`,
        source: 'mimi-kernel',
        trust: 'owner' as const,
      } } } : {}),
    });
  }
}
