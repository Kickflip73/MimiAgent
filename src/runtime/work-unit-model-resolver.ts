import {
  modelTargetKey,
  type ModelRegistration,
  type ModelRequirements,
  type ModelRoutingConfig,
  type ModelTarget,
  type ProviderDefinition,
  type RunModelBinding,
  type WorkUnitModelProfile,
} from '../core/model-routing.js';

export interface WorkUnitModelResolverOptions {
  providers: ProviderDefinition[];
  routing: ModelRoutingConfig;
  isConfigured?: (provider: ProviderDefinition) => boolean;
}

export interface ResolveWorkUnitModelInput {
  scenario: string;
  profile?: WorkUnitModelProfile;
  sessionTarget?: ModelTarget;
  teamTarget?: ModelTarget;
  routeVersion: number;
}

interface Candidate {
  target: ModelTarget;
  reason: RunModelBinding['reason'];
  strict: boolean;
}

function satisfies(
  registration: ModelRegistration,
  requirements: ModelRequirements,
): boolean {
  if (requirements.imageInput && !registration.capabilities.imageInput) return false;
  if (requirements.imageOutput && !registration.capabilities.imageOutput) return false;
  if (requirements.toolCalling && !registration.capabilities.toolCalling) return false;
  if (requirements.imageOutput && registration.kind !== 'image-generation') return false;
  if (!requirements.imageOutput && registration.kind !== 'agent') return false;
  return true;
}

function incompatibility(requirements: ModelRequirements): string {
  const values = [
    requirements.imageInput ? 'imageInput/图片输入' : '',
    requirements.imageOutput ? 'imageOutput/生图' : '',
    requirements.toolCalling ? 'toolCalling' : '',
  ].filter(Boolean);
  return values.length ? values.join('、') : 'Agent Runtime';
}

export class WorkUnitModelResolver {
  private readonly models = new Map<string, {
    provider: ProviderDefinition;
    registration: ModelRegistration;
  }>();

  constructor(private readonly options: WorkUnitModelResolverOptions) {
    for (const provider of options.providers) {
      for (const registration of provider.models) {
        this.models.set(modelTargetKey(registration.target), { provider, registration });
      }
    }
  }

  resolve(input: ResolveWorkUnitModelInput): RunModelBinding {
    const requirements = input.profile?.requirements ?? {};
    const reasoning = requirements.reasoning ?? 'auto';
    const route = this.options.routing.scenarios[input.scenario]
      ?? (input.profile?.complexity
        ? this.options.routing.scenarios[`team.${input.profile.complexity}`]
        : undefined);
    const candidates: Candidate[] = [
      ...(input.profile?.modelTarget
        ? [{ target: input.profile.modelTarget, reason: 'explicit-work-unit' as const, strict: true }]
        : []),
      ...(input.teamTarget
        ? [{ target: input.teamTarget, reason: 'team-override' as const, strict: true }]
        : []),
      ...(input.scenario === 'conversation.default' && input.sessionTarget
        ? [{ target: input.sessionTarget, reason: 'session-preference' as const, strict: true }]
        : []),
      ...(route?.target
        ? [{ target: route.target, reason: 'scenario-route' as const, strict: true }]
        : []),
      ...(route?.candidates ?? []).map((target, index) => ({
        target,
        reason: index === 0 ? 'scenario-route' as const : 'safe-fallback' as const,
        strict: false,
      })),
      {
        target: this.options.routing.globalDefault,
        reason: 'global-default',
        strict: false,
      },
    ];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = modelTargetKey(candidate.target);
      if (seen.has(key)) continue;
      seen.add(key);
      const registered = this.models.get(key);
      if (!registered) {
        if (candidate.strict) throw new Error(`模型 target 未注册：${key}`);
        continue;
      }
      if (this.options.isConfigured && !this.options.isConfigured(registered.provider)) {
        if (candidate.strict) throw new Error(`模型 Provider 未配置 credential：${key}`);
        continue;
      }
      if (!satisfies(registered.registration, requirements)) {
        if (candidate.strict) {
          throw new Error(`模型 ${key} 不满足 ${incompatibility(requirements)} 硬能力`);
        }
        continue;
      }
      return Object.freeze({
        target: Object.freeze({ ...candidate.target }),
        kind: registered.registration.kind,
        reasoning,
        scenario: input.scenario,
        ...(input.profile?.complexity ? { complexity: input.profile.complexity } : {}),
        reason: candidate.reason,
        routeVersion: input.routeVersion,
      });
    }
    throw new Error(
      `模型路由 blocked：场景 ${input.scenario} 没有满足 ${incompatibility(requirements)} 的兼容模型`,
    );
  }
}
