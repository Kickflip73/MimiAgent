import type { ModelRegistration, ProviderDefinition } from '../../core/model-routing.js';

export async function assertHealthyResponse(
  response: Response,
  provider: ProviderDefinition,
  registration: ModelRegistration,
): Promise<{ requestId?: string }> {
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(
      `模型健康检查失败 ${provider.id}/${registration.target.modelId}: HTTP ${response.status} ${detail}`,
    );
  }
  const requestId = response.headers.get('x-request-id')
    ?? response.headers.get('request-id')
    ?? undefined;
  return requestId ? { requestId } : {};
}

export function requiredBaseUrl(provider: ProviderDefinition): string {
  if (!provider.baseUrl) throw new Error(`Provider ${provider.id} 缺少 baseUrl`);
  return provider.baseUrl.replace(/\/+$/, '');
}

export function modelHealthUrl(provider: ProviderDefinition, modelId: string): string {
  return `${requiredBaseUrl(provider)}/models/${encodeURIComponent(modelId)}`;
}
