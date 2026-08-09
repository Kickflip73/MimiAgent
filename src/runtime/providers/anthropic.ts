import type {
  ModelRegistration,
  ProviderDefinition,
  ReasoningIntent,
} from '../../core/model-routing.js';
import type { ProviderAdapter } from './types.js';
import { assertHealthyResponse, modelHealthUrl } from './shared.js';
import { NativeJsonAgentModel } from './native-model.js';
import { withFileInputCapability } from './file-input.js';

export class AnthropicMessagesAdapter implements ProviderAdapter {
  createAgentRuntime(
    provider: ProviderDefinition,
    registration: ModelRegistration,
    apiKey: string,
    reasoning: ReasoningIntent,
  ) {
    if (!provider.baseUrl) throw new Error(`Provider ${provider.id} 缺少 baseUrl`);
    if (reasoning === 'high' && !registration.reasoning) {
      throw new Error('Claude reasoning=high 的推理能力未知或未注册；请求未发送');
    }
    if (reasoning === 'off' && !registration.reasoning?.supportsOff) {
      throw new Error('Claude reasoning=off 未注册为受支持能力；请求未发送');
    }
    return {
      model: withFileInputCapability(
        new NativeJsonAgentModel({
          protocol: 'anthropic',
          baseUrl: provider.baseUrl.replace(/\/+$/, ''),
          apiKey,
          modelId: registration.target.modelId,
          reasoning,
          reasoningCapability: registration.reasoning,
        }),
        registration,
        provider.transport,
        false,
      ),
      target: registration.target,
      registration,
      reasoning,
    };
  }

  createImageRuntime(): never {
    throw new Error('Anthropic Messages 不提供图片生成 Runtime');
  }

  async health(
    provider: ProviderDefinition,
    registration: ModelRegistration,
    apiKey: string,
    signal?: AbortSignal,
  ) {
    return assertHealthyResponse(await fetch(modelHealthUrl(provider, registration.target.modelId), {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal,
    }), provider, registration);
  }
}
