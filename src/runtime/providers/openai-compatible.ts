import type {
  ModelRegistration,
  ProviderDefinition,
  ReasoningIntent,
} from '../../core/model-routing.js';
import type { ProviderAdapter } from './types.js';
import { createOpenAICompatibleModel } from './openai-compatible-model.js';
import { assertHealthyResponse, requiredBaseUrl } from './shared.js';

function usesReasoningContentDialect(
  provider: ProviderDefinition,
  registration: ModelRegistration,
): boolean {
  return ['deepseek', 'deepseek-main'].includes(provider.id.toLowerCase())
    || registration.target.modelId.toLowerCase().startsWith('deepseek-')
    || provider.baseUrl?.toLowerCase().includes('deepseek.') === true;
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  createAgentRuntime(
    provider: ProviderDefinition,
    registration: ModelRegistration,
    apiKey: string,
    reasoning: ReasoningIntent,
  ) {
    return {
      model: createOpenAICompatibleModel(
        apiKey,
        requiredBaseUrl(provider),
        registration.target.modelId,
        {
          reasoningContentDialect: usesReasoningContentDialect(provider, registration),
          strictFeatureValidation: true,
        },
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
    // A Provider-level /models response proves only endpoint and credential
    // reachability. Probe the registered model itself so aliases, entitlement,
    // and request compatibility cannot be reported as healthy by mistake.
    return assertHealthyResponse(await fetch(`${requiredBaseUrl(provider)}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: registration.target.modelId,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 1,
        stream: false,
      }),
      signal,
    }), provider, registration);
  }
}
