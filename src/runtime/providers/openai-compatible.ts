import { OpenAIChatCompletionsModel } from '@openai/agents';
import OpenAI from 'openai';
import type {
  ModelRegistration,
  ProviderDefinition,
  ReasoningIntent,
} from '../../core/model-routing.js';
import type { ProviderAdapter } from './types.js';
import { assertHealthyResponse, requiredBaseUrl } from './shared.js';

export class OpenAICompatibleAdapter implements ProviderAdapter {
  createAgentRuntime(
    provider: ProviderDefinition,
    registration: ModelRegistration,
    apiKey: string,
    reasoning: ReasoningIntent,
  ) {
    return {
      model: new OpenAIChatCompletionsModel(
        new OpenAI({ apiKey, baseURL: requiredBaseUrl(provider), fetch: globalThis.fetch }),
        registration.target.modelId,
        { strictFeatureValidation: true },
      ),
      target: registration.target,
      registration,
      reasoning,
    };
  }

  createImageRuntime(): never {
    throw new Error('OpenAI-compatible Chat Completions adapter 不提供图片生成 Runtime');
  }

  async health(
    provider: ProviderDefinition,
    registration: ModelRegistration,
    apiKey: string,
    signal?: AbortSignal,
  ) {
    // The OpenAI-compatible contract does not require a model-detail endpoint.
    // Probe the authenticated list endpoint so gateways such as Friday are not
    // reported unhealthy merely because GET /models/{id} is unsupported.
    return assertHealthyResponse(await fetch(`${requiredBaseUrl(provider)}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal,
    }), provider, registration);
  }
}
