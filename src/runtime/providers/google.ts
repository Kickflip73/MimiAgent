import type {
  ModelRegistration,
  ProviderDefinition,
  ReasoningIntent,
} from '../../core/model-routing.js';
import type { ProviderAdapter } from './types.js';
import { assertHealthyResponse, requiredBaseUrl } from './shared.js';
import { NativeJsonAgentModel } from './native-model.js';

export class GoogleGenerateContentAdapter implements ProviderAdapter {
  createAgentRuntime(
    provider: ProviderDefinition,
    registration: ModelRegistration,
    apiKey: string,
    reasoning: ReasoningIntent,
  ) {
    return {
      model: new NativeJsonAgentModel({
        protocol: 'google',
        baseUrl: requiredBaseUrl(provider),
        apiKey,
        modelId: registration.target.modelId,
        reasoning,
      }),
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
        input: { prompt: string; image?: string },
        signal?: AbortSignal,
      ) => {
        const parts: Array<Record<string, unknown>> = [{ text: input.prompt }];
        if (input.image) {
          const match = /^data:([^;]+);base64,(.+)$/.exec(input.image);
          if (!match) throw new Error('Gemini 图片编辑只接受 data URL 图片输入');
          parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        }
        const response = await fetch(
          `${requiredBaseUrl(provider)}/models/${encodeURIComponent(registration.target.modelId)}:generateContent`,
          {
            method: 'POST',
            headers: {
              'x-goog-api-key': apiKey,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              contents: [{ role: 'user', parts }],
              generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
            }),
            signal,
          },
        );
        if (!response.ok) throw new Error(`Google 图片生成失败：HTTP ${response.status}`);
        const body = await response.json() as {
          responseId?: string;
          candidates?: Array<{ content?: { parts?: Array<{
            inlineData?: { data?: string; mimeType?: string };
          }> } }>;
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        };
        const artifacts = (body.candidates?.[0]?.content?.parts ?? [])
          .filter((part) => part.inlineData?.data)
          .map((part) => ({
            data: part.inlineData!.data!,
            mediaType: part.inlineData?.mimeType ?? 'image/png',
          }));
        return {
          artifacts,
          requestId: body.responseId ?? response.headers.get('x-request-id') ?? undefined,
          usage: {
            inputTokens: body.usageMetadata?.promptTokenCount,
            outputTokens: body.usageMetadata?.candidatesTokenCount,
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
      `${requiredBaseUrl(provider)}/models/${encodeURIComponent(registration.target.modelId)}`,
      { headers: { 'x-goog-api-key': apiKey }, signal },
    );
    return assertHealthyResponse(response, provider, registration);
  }
}
