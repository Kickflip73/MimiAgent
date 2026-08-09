import { OpenAIChatCompletionsModel } from '@openai/agents';
import OpenAI from 'openai';
import type {
  ModelRegistration,
  ProviderDefinition,
  ReasoningIntent,
} from '../../core/model-routing.js';
import type { ProviderAdapter } from './types.js';
import { withFileInputCapability } from './file-input.js';
import { assertHealthyResponse, requiredBaseUrl } from './shared.js';

export class OpenAICompatibleAdapter implements ProviderAdapter {
  createAgentRuntime(
    provider: ProviderDefinition,
    registration: ModelRegistration,
    apiKey: string,
    reasoning: ReasoningIntent,
  ) {
    return {
      model: withFileInputCapability(
        new OpenAIChatCompletionsModel(
          new OpenAI({ apiKey, baseURL: requiredBaseUrl(provider), fetch: globalThis.fetch }),
          registration.target.modelId,
          { strictFeatureValidation: true },
        ),
        registration,
        provider.transport,
        true,
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
