import { OpenAIResponsesModel } from '@openai/agents';
import OpenAI from 'openai';
import type {
  ModelRegistration,
  ProviderDefinition,
  ReasoningIntent,
} from '../../core/model-routing.js';
import type { ProviderAdapter } from './types.js';
import { assertHealthyResponse } from './shared.js';

function openAiBaseUrl(provider: ProviderDefinition): string {
  return (provider.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
}

export class OpenAIResponsesAdapter implements ProviderAdapter {
  createAgentRuntime(
    provider: ProviderDefinition,
    registration: ModelRegistration,
    apiKey: string,
    reasoning: ReasoningIntent,
  ) {
    return {
      model: new OpenAIResponsesModel(
        new OpenAI({ apiKey, baseURL: openAiBaseUrl(provider), fetch: globalThis.fetch }),
        registration.target.modelId,
      ),
      target: registration.target,
      registration,
      reasoning,
    };
  }

  createImageRuntime(
    provider: ProviderDefinition,
    registration: ModelRegistration,
    apiKey: string,
  ) {
    return {
      target: registration.target,
      registration,
      generate: async (
        input: { prompt: string; image?: string; size?: string },
        signal?: AbortSignal,
      ) => {
        if (input.image) throw new Error('OpenAI 图片编辑需要专用 multipart adapter，当前配置不支持');
        const response = await fetch(`${openAiBaseUrl(provider)}/images/generations`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: registration.target.modelId,
            prompt: input.prompt,
            ...(input.size ? { size: input.size } : {}),
          }),
          signal,
        });
        if (!response.ok) throw new Error(`图片生成失败：HTTP ${response.status}`);
        const body = await response.json() as {
          data?: Array<{ b64_json?: string; url?: string }>;
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        return {
          artifacts: (body.data ?? []).map((item) => ({
            ...(item.b64_json ? { data: item.b64_json } : {}),
            ...(item.url ? { url: item.url } : {}),
            mediaType: 'image/png',
          })),
          requestId: response.headers.get('x-request-id') ?? undefined,
          usage: {
            inputTokens: body.usage?.input_tokens,
            outputTokens: body.usage?.output_tokens,
          },
        };
      },
    };
  }

  async health(
    provider: ProviderDefinition,
    registration: ModelRegistration,
    apiKey: string,
    signal?: AbortSignal,
  ) {
    const response = await fetch(
      `${openAiBaseUrl(provider)}/models/${encodeURIComponent(registration.target.modelId)}`,
      { headers: { authorization: `Bearer ${apiKey}` }, signal },
    );
    return assertHealthyResponse(response, provider, registration);
  }
}
