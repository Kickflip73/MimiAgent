import { setTracingDisabled } from '@openai/agents';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { access } from 'node:fs/promises';
import type { AppConfig } from '../config.js';
import {
  legacyModelConfigurationForAppConfig,
  loadModelConfiguration,
} from './model-config.js';

let configured = false;

export function requireProviderApiKey(config: AppConfig): void {
  const name = config.provider === 'deepseek'
    ? 'DEEPSEEK_API_KEY'
    : config.provider === 'openai-compatible'
      ? 'MIMI_PROVIDER_API_KEY'
      : 'OPENAI_API_KEY';
  if (!process.env[name]) throw new Error(`缺少 ${name}`);
}

export async function requireConfiguredProviderApiKey(
  config: AppConfig,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const hasExplicitModelConfig = Boolean(config.modelsConfig
    && await access(config.modelsConfig).then(() => true, () => false));
  const modelConfig = hasExplicitModelConfig && config.modelsConfig
    ? await loadModelConfiguration(config.modelsConfig, environment)
    : legacyModelConfigurationForAppConfig(config, environment);
  const providerId = modelConfig.routing.globalDefault.providerId;
  const provider = modelConfig.providers.find((candidate) => candidate.id === providerId);
  if (!provider) throw new Error(`默认模型引用未知 Provider：${providerId}`);
  if (!environment[provider.apiKeyEnv]?.trim()) {
    throw new Error(`Provider ${provider.id} 缺少 credential：${provider.apiKeyEnv}`);
  }
}

export function configureAgentRuntime(config: AppConfig): void {
  if (!configured) {
    const dispatcher = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
      ? new EnvHttpProxyAgent()
      : undefined;
    const proxyAwareFetch: typeof globalThis.fetch = (input, init) => {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
      headers.set('accept-encoding', 'identity');
      return undiciFetch(input as never, { ...init, dispatcher, headers } as never) as unknown as Promise<Response>;
    };
    globalThis.fetch = proxyAwareFetch;
    setTracingDisabled(true);
    configured = true;
  }
  // Every Run receives an explicit Model from ModelGateway. A process-global
  // client would allow concurrent Sessions to leak endpoint or credential state.
}
