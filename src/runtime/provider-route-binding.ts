import { isDeepStrictEqual } from 'node:util';
import type { AppConfig } from '../config.js';
import {
  modelTargetKey,
  runModelBindingSchema,
  type ModelRequirements,
  type RunModelBinding,
} from '../core/model-routing.js';
import type { ModelGateway } from './model-gateway.js';
import type { WorkUnitModelResolver } from './work-unit-model-resolver.js';

export interface ProviderRunRoute {
  provider: AppConfig['provider'];
  model?: string;
  /** Exact registry binding admitted before failover; never reselect through a legacy alias. */
  exactBinding?: Readonly<RunModelBinding>;
}

export interface ProviderRouteBindingContext {
  modelGateway: ModelGateway;
  modelResolver: WorkUnitModelResolver;
  routeVersion: number;
  fixedModelBinding?: RunModelBinding;
}

export function resolveProviderRouteBinding(
  context: ProviderRouteBindingContext,
  route: ProviderRunRoute,
  requirements: Readonly<ModelRequirements>,
  scenario: string,
): RunModelBinding {
  const model = route.model?.trim();
  if (!model) throw new Error('Provider failover 必须冻结一个显式模型');
  let binding: RunModelBinding;
  if (route.exactBinding) {
    const exact = runModelBindingSchema.parse(route.exactBinding);
    if (exact.target.modelId !== model) {
      throw new Error(`Provider failover exact binding 模型不一致：${exact.target.modelId} != ${model}`);
    }
    const exactProvider = context.modelGateway.provider(exact.target);
    const providerMatches = route.provider === 'openai'
      ? exactProvider.transport === 'openai-responses'
      : route.provider === 'deepseek'
        ? exactProvider.id === 'deepseek-main'
        : exactProvider.transport === 'openai-chat-completions'
          && exactProvider.id !== 'deepseek-main';
    if (!providerMatches) {
      throw new Error(
        `Provider failover exact binding Provider 不一致：`
        + `${route.provider} != ${exactProvider.id}/${exactProvider.transport}`,
      );
    }
    if (exact.scenario !== scenario) {
      throw new Error(`Provider failover exact binding 场景不一致：${exact.scenario} != ${scenario}`);
    }
    if (exact.routeVersion !== context.routeVersion) {
      throw new Error(
        `Provider failover exact binding routeVersion 已过期：`
        + `${exact.routeVersion} != ${context.routeVersion}`,
      );
    }
    const verified = context.modelResolver.resolve({
      scenario,
      profile: {
        modelTarget: exact.target,
        requirements: { ...requirements },
      },
      routeVersion: exact.routeVersion,
    });
    const { reason: _exactReason, ...exactContract } = exact;
    const { reason: _verifiedReason, ...verifiedContract } = verified;
    if (!isDeepStrictEqual(exactContract, verifiedContract)) {
      throw new Error('Provider failover exact binding 与当前 registry 能力或路由契约不一致');
    }
    binding = Object.freeze({
      ...exact,
      target: Object.freeze({ ...exact.target }),
    });
  } else {
    const target = context.modelGateway.legacyAgentTarget(model, route.provider);
    if (!target) {
      throw new Error(`Provider failover 模型未在当前 registry 精确注册：${route.provider}/${model}`);
    }
    binding = context.modelResolver.resolve({
      scenario,
      profile: {
        modelTarget: target,
        requirements: { ...requirements },
      },
      routeVersion: context.routeVersion,
    });
  }
  if (context.fixedModelBinding) {
    const fixedTarget = modelTargetKey(context.fixedModelBinding.target);
    const routeTarget = modelTargetKey(binding.target);
    if (fixedTarget !== routeTarget) {
      throw new Error(
        `Provider failover target ${routeTarget} 与冻结 modelBinding ${fixedTarget} 冲突`,
      );
    }
    return context.fixedModelBinding;
  }
  return route.exactBinding ? binding : Object.freeze({ ...binding, reason: 'safe-fallback' });
}
