import os from 'node:os';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { z } from 'zod';
import {
  modelRoutingConfigSchema,
  modelTargetKey,
  providerDefinitionSchema,
  type ModelRoutingConfig,
  type ProviderDefinition,
} from '../core/model-routing.js';
import { AtomicJsonStore } from '../core/state-file.js';
import type { AppConfig } from '../config.js';

export interface ModelsConfig {
  version: 1;
  routeVersion: number;
  providers: ProviderDefinition[];
  routing: ModelRoutingConfig;
}

export const modelsConfigSchema = z.object({
  version: z.literal(1),
  routeVersion: z.number().int().positive(),
  providers: z.array(providerDefinitionSchema).min(1).max(50),
  routing: modelRoutingConfigSchema,
}).strict().superRefine((value, context) => {
  const providerIds = new Set<string>();
  const targets = new Set<string>();
  const contextWindows = new Map<string, number>();
  for (const [providerIndex, provider] of value.providers.entries()) {
    if (providerIds.has(provider.id)) {
      context.addIssue({
        code: 'custom',
        message: `Provider id 重复：${provider.id}`,
        path: ['providers', providerIndex, 'id'],
      });
    }
    providerIds.add(provider.id);
    for (const [modelIndex, model] of provider.models.entries()) {
      if (model.target.providerId !== provider.id) {
        context.addIssue({
          code: 'custom',
          message: `模型 target Provider 与所属 Provider 不匹配：${modelTargetKey(model.target)}`,
          path: ['providers', providerIndex, 'models', modelIndex, 'target'],
        });
      }
      const key = modelTargetKey(model.target);
      if (targets.has(key)) {
        context.addIssue({
          code: 'custom',
          message: `模型 target 重复：${key}`,
          path: ['providers', providerIndex, 'models', modelIndex, 'target'],
        });
      }
      targets.add(key);
      if (model.contextWindow !== undefined) contextWindows.set(key, model.contextWindow);
      if (model.kind === 'image-generation'
        && (!model.capabilities.imageOutput || model.capabilities.toolCalling)) {
        context.addIssue({
          code: 'custom',
          message: `图片 Runtime 必须 imageOutput=true 且 toolCalling=false：${key}`,
          path: ['providers', providerIndex, 'models', modelIndex, 'capabilities'],
        });
      }
      if (model.kind === 'agent' && model.capabilities.imageOutput) {
        context.addIssue({
          code: 'custom',
          message: `Agent Runtime 不能声明 imageOutput：${key}`,
          path: ['providers', providerIndex, 'models', modelIndex, 'capabilities'],
        });
      }
    }
  }
  const routedTargets = [
    value.routing.globalDefault,
    ...Object.values(value.routing.scenarios).flatMap((route) => [
      ...(route.target ? [route.target] : []),
      ...(route.candidates ?? []),
    ]),
  ];
  for (const target of routedTargets) {
    if (!targets.has(modelTargetKey(target))) {
      context.addIssue({
        code: 'custom',
        message: `路由引用未注册 target：${modelTargetKey(target)}`,
        path: ['routing'],
      });
    }
  }
  for (const [scenario, route] of Object.entries(value.routing.scenarios)) {
    if (route.maxOutputTokens === undefined) continue;
    const targetsForRoute = route.target
      ? [route.target]
      : route.candidates?.length
        ? route.candidates
        : [value.routing.globalDefault];
    for (const target of targetsForRoute) {
      const contextWindow = contextWindows.get(modelTargetKey(target));
      if (contextWindow !== undefined && route.maxOutputTokens >= contextWindow) {
        context.addIssue({
          code: 'custom',
          message: `场景 ${scenario} 的 maxOutputTokens 必须小于模型 contextWindow`,
          path: ['routing', 'scenarios', scenario, 'maxOutputTokens'],
        });
      }
    }
  }
});

export function parseModelsConfig(value: unknown): ModelsConfig {
  return modelsConfigSchema.parse(value) as ModelsConfig;
}

export function resolveModelsConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  const configured = environment.MIMI_MODELS_CONFIG?.trim();
  if (!configured) return path.join(homeDirectory, '.mimi-agent', 'models.json');
  if (configured === '~') return homeDirectory;
  if (configured.startsWith('~/')) return path.resolve(homeDirectory, configured.slice(2));
  if (configured.startsWith('~')) throw new Error('MIMI_MODELS_CONFIG 中的 ~ 只支持 ~/path');
  return path.resolve(configured);
}

export class ModelConfigStore {
  private readonly state: AtomicJsonStore<ModelsConfig>;

  constructor(readonly file: string) {
    this.state = new AtomicJsonStore(file, {
      defaultValue: () => {
        throw new Error(`模型配置不存在：${file}`);
      },
      decode: parseModelsConfig,
      preserveSchemaMismatch: true,
    });
  }

  read(): Promise<ModelsConfig> {
    return this.state.read();
  }

  async write(value: ModelsConfig): Promise<void> {
    await this.state.replace(parseModelsConfig(value));
  }

  async update(
    mutation: (value: ModelsConfig) => ModelsConfig,
  ): Promise<ModelsConfig> {
    let next!: ModelsConfig;
    await this.state.update((value) => {
      next = parseModelsConfig(mutation(structuredClone(value)));
      for (const key of Object.keys(value) as Array<keyof ModelsConfig>) delete value[key];
      Object.assign(value, next);
    });
    return next;
  }
}

export async function loadModelConfiguration(
  file: string,
  environment: NodeJS.ProcessEnv = process.env,
  fallback?: ModelsConfig,
): Promise<ModelsConfig> {
  try {
    await access(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback ?? legacyModelConfiguration(environment);
    }
    throw error;
  }
  return new ModelConfigStore(file).read();
}

function legacyProvider(
  environment: NodeJS.ProcessEnv,
): { provider: ProviderDefinition; modelId: string } {
  const selected = environment.MIMI_MODEL_PROVIDER?.trim()
    || environment.MODEL_PROVIDER?.trim()
    || 'openai';
  if (selected === 'deepseek') {
    const modelId = environment.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-pro';
    return {
      modelId,
      provider: {
        id: 'deepseek-main',
        label: 'DeepSeek',
        transport: 'openai-chat-completions',
        baseUrl: environment.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        models: [{
          target: { providerId: 'deepseek-main', modelId },
          kind: 'agent',
          capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
        }],
      },
    };
  }
  if (selected === 'openai-compatible') {
    const baseUrl = environment.MIMI_PROVIDER_BASE_URL?.trim();
    const modelId = environment.MIMI_MODEL?.trim();
    if (!baseUrl || !modelId) {
      throw new Error('legacy openai-compatible 需要 MIMI_PROVIDER_BASE_URL 和 MIMI_MODEL');
    }
    return {
      modelId,
      provider: {
        id: 'legacy-compatible',
        label: 'Legacy OpenAI-compatible',
        transport: 'openai-chat-completions',
        baseUrl,
        apiKeyEnv: 'MIMI_PROVIDER_API_KEY',
        models: [{
          target: { providerId: 'legacy-compatible', modelId },
          kind: 'agent',
          capabilities: { imageInput: false, imageOutput: false, toolCalling: true },
        }],
      },
    };
  }
  if (selected !== 'openai') throw new Error(`不支持的 legacy Provider：${selected}`);
  const modelId = environment.OPENAI_MODEL?.trim() || 'gpt-5.4-mini';
  return {
    modelId,
    provider: {
      id: 'openai-main',
      label: 'OpenAI',
      transport: 'openai-responses',
      apiKeyEnv: 'OPENAI_API_KEY',
      models: [{
        target: { providerId: 'openai-main', modelId },
        kind: 'agent',
        capabilities: { imageInput: true, imageOutput: false, toolCalling: true },
      }],
    },
  };
}

export function legacyModelConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): ModelsConfig {
  const { provider, modelId } = legacyProvider(environment);
  return parseModelsConfig({
    version: 1,
    routeVersion: 1,
    providers: [provider],
    routing: {
      globalDefault: { providerId: provider.id, modelId },
      scenarios: {},
    },
  });
}

export function legacyModelConfigurationForAppConfig(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
): ModelsConfig {
  const modelId = config.defaultModel ?? (config.provider === 'deepseek'
    ? environment.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-pro'
    : environment.OPENAI_MODEL?.trim() || 'gpt-5.4-mini');
  const providerId = config.provider === 'deepseek'
    ? 'deepseek-main'
    : config.provider === 'openai-compatible'
      ? 'legacy-compatible'
      : 'openai-main';
  const transport = config.provider === 'openai'
    ? 'openai-responses' as const
    : 'openai-chat-completions' as const;
  const apiKeyEnv = config.provider === 'deepseek'
    ? 'DEEPSEEK_API_KEY'
    : config.provider === 'openai-compatible'
      ? 'MIMI_PROVIDER_API_KEY'
      : 'OPENAI_API_KEY';
  const compatibilityModels = config.provider === 'openai'
    ? ['gpt-5.4', 'gpt-5-mini']
    : config.provider === 'deepseek'
      ? ['deepseek-v4-flash']
      : [];
  const modelIds = [...new Set([
    ...(config.availableModels ?? []),
    modelId,
    ...compatibilityModels,
  ])];
  return parseModelsConfig({
    version: 1,
    routeVersion: 1,
    providers: [{
      id: providerId,
      label: config.provider,
      transport,
      ...(config.providerBaseUrl ? { baseUrl: config.providerBaseUrl } : {}),
      apiKeyEnv,
      models: modelIds.map((registeredModelId) => ({
        target: { providerId, modelId: registeredModelId },
        kind: 'agent',
        capabilities: {
          imageInput: config.provider === 'openai',
          imageOutput: false,
          toolCalling: true,
        },
      })),
    }],
    routing: {
      globalDefault: { providerId, modelId },
      scenarios: {},
    },
  });
}
