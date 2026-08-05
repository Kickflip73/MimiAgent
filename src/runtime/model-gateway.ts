import {
  modelTargetKey,
  type ModelRegistration,
  type ModelTarget,
  type ProviderDefinition,
  type ProviderTransport,
  type ReasoningIntent,
} from '../core/model-routing.js';
import { AnthropicMessagesAdapter } from './providers/anthropic.js';
import { GoogleGenerateContentAdapter } from './providers/google.js';
import { OpenAICompatibleAdapter } from './providers/openai-compatible.js';
import { OpenAIResponsesAdapter } from './providers/openai-responses.js';
import type {
  AgentModelRuntime,
  ImageModelRuntime,
  ProviderAdapter,
} from './providers/types.js';

export interface ModelHealth {
  target: ModelTarget;
  status: 'healthy' | 'unhealthy' | 'unconfigured';
  checkedAt: string;
  requestId?: string;
  error?: string;
}

export interface ModelGatewayOptions {
  providers: ProviderDefinition[];
  environment?: Readonly<Record<string, string | undefined>>;
  adapters?: Partial<Record<ProviderTransport, ProviderAdapter>>;
}

interface RegisteredModel {
  provider: ProviderDefinition;
  registration: ModelRegistration;
}

const DEFAULT_ADAPTERS: Record<ProviderTransport, ProviderAdapter> = {
  'openai-responses': new OpenAIResponsesAdapter(),
  'openai-chat-completions': new OpenAICompatibleAdapter(),
  'anthropic-messages': new AnthropicMessagesAdapter(),
  'google-generate-content': new GoogleGenerateContentAdapter(),
};

export class ModelGateway {
  private readonly models = new Map<string, RegisteredModel>();
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly adapters: Record<ProviderTransport, ProviderAdapter>;

  constructor(options: ModelGatewayOptions) {
    this.environment = options.environment ?? process.env;
    this.adapters = { ...DEFAULT_ADAPTERS, ...options.adapters };
    const providers = new Set<string>();
    for (const provider of options.providers) {
      if (providers.has(provider.id)) throw new Error(`Provider id 重复：${provider.id}`);
      providers.add(provider.id);
      for (const registration of provider.models) {
        if (registration.target.providerId !== provider.id) {
          throw new Error(`模型 target Provider 不匹配：${modelTargetKey(registration.target)}`);
        }
        const key = modelTargetKey(registration.target);
        if (this.models.has(key)) throw new Error(`模型 target 重复：${key}`);
        this.models.set(key, { provider, registration });
      }
    }
  }

  inspect(target: ModelTarget): ModelRegistration {
    return structuredClone(this.registered(target).registration);
  }

  provider(target: ModelTarget): ProviderDefinition {
    return structuredClone(this.registered(target).provider);
  }

  list(): ModelRegistration[] {
    return [...this.models.values()].map(({ registration }) => structuredClone(registration));
  }

  resolveAgentTarget(modelName: string): ModelTarget {
    if (!/^[a-zA-Z0-9._:/-]+$/.test(modelName)) throw new Error('模型名称格式无效');
    const slash = modelName.indexOf('/');
    const candidates = slash > 0
      ? [{ providerId: modelName.slice(0, slash), modelId: modelName.slice(slash + 1) }]
        .filter((target) => this.models.get(modelTargetKey(target))?.registration.kind === 'agent')
      : [...this.models.values()]
        .filter(({ registration }) => registration.kind === 'agent'
          && registration.target.modelId === modelName)
        .map(({ registration }) => registration.target);
    if (candidates.length !== 1) {
      const available = [...new Set(this.list()
        .filter((model) => model.kind === 'agent').map((model) => model.target.modelId))];
      throw new Error(candidates.length
        ? `模型名称不唯一，请使用 providerId/modelId：${modelName}`
        : `模型不可用：${modelName}。可用模型：${available.join('、')}`);
    }
    return structuredClone(candidates[0]!);
  }

  legacyAgentTarget(
    modelName: string | undefined,
    provider?: 'openai' | 'deepseek' | 'openai-compatible',
  ): ModelTarget | undefined {
    if (!modelName) return undefined;
    const matches = [...this.models.values()].filter(({ provider: candidate, registration }) => {
      if (registration.kind !== 'agent' || registration.target.modelId !== modelName) return false;
      if (!provider) return true;
      if (provider === 'openai') return candidate.transport === 'openai-responses';
      if (provider === 'deepseek') return candidate.id === 'deepseek-main';
      return candidate.transport === 'openai-chat-completions' && candidate.id !== 'deepseek-main';
    });
    return matches.length === 1 ? structuredClone(matches[0]!.registration.target) : undefined;
  }

  createAgentRuntime(
    target: ModelTarget,
    reasoning: ReasoningIntent = 'auto',
  ): AgentModelRuntime {
    const { provider, registration } = this.registered(target);
    if (registration.kind !== 'agent' || !registration.capabilities.toolCalling) {
      throw new Error(`模型 ${modelTargetKey(target)} 不是可运行工具循环的 Agent Runtime`);
    }
    const credential = this.environment[provider.apiKeyEnv]?.trim();
    if (!credential && provider.transport === 'openai-responses' && !provider.baseUrl) {
      return {
        model: registration.target.modelId,
        target: registration.target,
        registration,
        reasoning,
      };
    }
    return this.adapter(provider).createAgentRuntime(
      provider,
      registration,
      credential ?? this.credential(provider),
      reasoning,
    );
  }

  createImageRuntime(target: ModelTarget): ImageModelRuntime {
    const { provider, registration } = this.registered(target);
    if (registration.kind !== 'image-generation' || !registration.capabilities.imageOutput) {
      throw new Error(`模型 ${modelTargetKey(target)} 不是 imageOutput 图片 Runtime`);
    }
    return this.adapter(provider).createImageRuntime(
      provider,
      registration,
      this.credential(provider),
    );
  }

  async health(target: ModelTarget, signal?: AbortSignal): Promise<ModelHealth> {
    const { provider, registration } = this.registered(target);
    const checkedAt = new Date().toISOString();
    let apiKey: string;
    try {
      apiKey = this.credential(provider);
    } catch (error) {
      return {
        target: structuredClone(target),
        status: 'unconfigured',
        checkedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      const result = await this.adapter(provider).health(
        provider,
        registration,
        apiKey,
        signal,
      );
      return {
        target: structuredClone(target),
        status: 'healthy',
        checkedAt,
        ...result,
      };
    } catch (error) {
      return {
        target: structuredClone(target),
        status: 'unhealthy',
        checkedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private registered(target: ModelTarget): RegisteredModel {
    const value = this.models.get(modelTargetKey(target));
    if (!value) throw new Error(`模型 target 未注册：${modelTargetKey(target)}`);
    return value;
  }

  private credential(provider: ProviderDefinition): string {
    const value = this.environment[provider.apiKeyEnv]?.trim();
    if (!value) throw new Error(`Provider ${provider.id} 缺少 credential：${provider.apiKeyEnv}`);
    return value;
  }

  private adapter(provider: ProviderDefinition): ProviderAdapter {
    const adapter = this.adapters[provider.transport];
    if (!adapter) throw new Error(`Provider adapter 未注册：${provider.transport}`);
    return adapter;
  }
}
