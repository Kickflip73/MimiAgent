import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import {
  resolveEnvironmentFile,
  type ModelProvider,
} from './config.js';

export interface ProviderSetRequest {
  provider: ModelProvider;
  apiKeyEnvironment: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  models?: string[];
  contextWindow?: number;
  restart: boolean;
}

export interface PersistedProviderConfiguration {
  environmentFile: string;
  provider: ModelProvider;
  model?: string;
  baseUrl?: string;
}

export interface ConfiguredProvider {
  id: ModelProvider;
  label: string;
  model: string;
  models: string[];
}

function optionValue(args: string[], index: number, name: string): string {
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要参数值`);
  return value;
}

function providerApiKeyName(provider: ModelProvider): string {
  if (provider === 'deepseek') return 'DEEPSEEK_API_KEY';
  if (provider === 'openai-compatible') return 'MIMI_PROVIDER_API_KEY';
  return 'OPENAI_API_KEY';
}

function modelList(value: string | undefined, fallback: string[]): string[] {
  const configured = value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
  return [...new Set([...configured, ...fallback])];
}

export function configuredProviders(
  environment: NodeJS.ProcessEnv = process.env,
): ConfiguredProvider[] {
  const providers: ConfiguredProvider[] = [];
  if (environment.OPENAI_API_KEY?.trim()) {
    const model = environment.OPENAI_MODEL?.trim() || 'gpt-5.4-mini';
    providers.push({
      id: 'openai',
      label: 'OpenAI',
      model,
      models: modelList(environment.OPENAI_MODELS, [model, 'gpt-5.4', 'gpt-5-mini']),
    });
  }
  if (environment.DEEPSEEK_API_KEY?.trim()) {
    const model = environment.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-pro';
    providers.push({
      id: 'deepseek',
      label: 'DeepSeek',
      model,
      models: modelList(environment.DEEPSEEK_MODELS, [model, 'deepseek-v4-flash']),
    });
  }
  const compatibleModel = environment.MIMI_MODEL?.trim();
  if (environment.MIMI_PROVIDER_API_KEY?.trim()
    && environment.MIMI_PROVIDER_BASE_URL?.trim()
    && compatibleModel) {
    providers.push({
      id: 'openai-compatible',
      label: 'OpenAI Compatible',
      model: compatibleModel,
      models: modelList(environment.MIMI_MODELS, [compatibleModel]),
    });
  }
  return providers;
}

export function configuredProviderRequest(
  provider: ModelProvider,
  environment: NodeJS.ProcessEnv = process.env,
): ProviderSetRequest {
  const configured = configuredProviders(environment).find((candidate) => candidate.id === provider);
  if (!configured) throw new Error(`Provider 未配置：${provider}`);
  const apiKeyEnvironment = providerApiKeyName(provider);
  const apiKey = environment[apiKeyEnvironment]!.trim();
  return {
    provider,
    apiKeyEnvironment,
    apiKey,
    ...(provider === 'openai-compatible'
      ? { baseUrl: environment.MIMI_PROVIDER_BASE_URL!.trim() }
      : provider === 'deepseek' && environment.DEEPSEEK_BASE_URL?.trim()
        ? { baseUrl: environment.DEEPSEEK_BASE_URL.trim() }
        : {}),
    model: configured.model,
    models: configured.models,
    ...(environment.MIMI_CONTEXT_WINDOW?.trim()
      ? { contextWindow: Number(environment.MIMI_CONTEXT_WINDOW) }
      : {}),
    restart: true,
  };
}

function resolveApiKeyEnvironment(
  provider: ModelProvider,
  requested: string | undefined,
  environment: NodeJS.ProcessEnv,
): string {
  if (requested) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(requested)) throw new Error('--api-key-env 必须是环境变量名');
    return requested;
  }
  const providerName = providerApiKeyName(provider);
  if (environment[providerName]?.trim()) return providerName;
  const ephemeral = Object.keys(environment)
    .filter((name) => /^MIMI_EPHEMERAL_SECRET_\d+$/.test(name) && environment[name]?.trim());
  if (ephemeral.length === 1) return ephemeral[0]!;
  if (ephemeral.length > 1) {
    throw new Error('当前 Run 有多个临时敏感值，请用 --api-key-env 指定要使用的环境变量');
  }
  throw new Error(`未找到 Provider API Key；请设置 ${providerName} 或通过 --api-key-env 指定当前 Run 的临时环境变量`);
}

export function parseProviderSetRequest(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): ProviderSetRequest {
  if (args[0] !== 'set') {
    throw new Error('用法：mimi provider set <openai|deepseek|openai-compatible> [选项]');
  }
  const provider = args[1]?.trim();
  if (provider !== 'openai' && provider !== 'deepseek' && provider !== 'openai-compatible') {
    throw new Error('Provider 只能是 openai、deepseek 或 openai-compatible');
  }
  let apiKeyEnvironment: string | undefined;
  let baseUrl: string | undefined;
  let model: string | undefined;
  let models: string[] | undefined;
  let contextWindow: number | undefined;
  let restart = true;
  for (let index = 2; index < args.length; index += 1) {
    const option = args[index]!;
    if (option === '--no-restart') {
      restart = false;
      continue;
    }
    const value = optionValue(args, index, option);
    index += 1;
    if (option === '--api-key-env') apiKeyEnvironment = value;
    else if (option === '--base-url') baseUrl = value;
    else if (option === '--model') model = value;
    else if (option === '--models') models = value.split(',').map((item) => item.trim()).filter(Boolean);
    else if (option === '--context-window') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
        throw new Error('--context-window 必须是正安全整数');
      }
      contextWindow = Number(value);
    } else {
      throw new Error(`未知 Provider 选项：${option}`);
    }
  }
  if (provider === 'openai-compatible') {
    if (!baseUrl) throw new Error('openai-compatible 需要 --base-url');
    if (!model) throw new Error('openai-compatible 需要 --model');
  }
  if (baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error('--base-url 必须是有效 URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('--base-url 必须使用 http 或 https');
    }
  }
  const resolvedEnvironment = resolveApiKeyEnvironment(provider, apiKeyEnvironment, environment);
  const apiKey = environment[resolvedEnvironment]?.trim();
  if (!apiKey) throw new Error(`环境变量 ${resolvedEnvironment} 为空`);
  return {
    provider,
    apiKeyEnvironment: resolvedEnvironment,
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
    ...(models?.length ? { models } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    restart,
  };
}

function dotenvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

export async function persistEnvironmentValues(
  environmentFile: string,
  updates: Readonly<Record<string, string>>,
): Promise<void> {
  let existing = '';
  try {
    existing = await readFile(environmentFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const pending = new Map(Object.entries(updates));
  const lines = existing.split(/\r?\n/);
  const result: string[] = [];
  for (const line of lines) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = match?.[1];
    if (!key || !pending.has(key)) {
      if (line || result.length > 0) result.push(line);
      continue;
    }
    result.push(`${key}=${dotenvValue(pending.get(key)!)}`);
    pending.delete(key);
  }
  while (result.at(-1) === '') result.pop();
  for (const [key, value] of pending) result.push(`${key}=${dotenvValue(value)}`);
  const directory = path.dirname(environmentFile);
  const temporary = `${environmentFile}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, `${result.join('\n')}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, environmentFile);
    await chmod(environmentFile, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

function providerUpdates(request: ProviderSetRequest): Record<string, string> {
  const updates: Record<string, string> = {
    MIMI_MODEL_PROVIDER: request.provider,
    [providerApiKeyName(request.provider)]: request.apiKey,
  };
  if (request.provider === 'openai-compatible') {
    updates.MIMI_PROVIDER_BASE_URL = request.baseUrl!;
    updates.MIMI_MODEL = request.model!;
    updates.MIMI_MODELS = request.models?.join(',') ?? request.model!;
  } else if (request.provider === 'deepseek') {
    if (request.baseUrl) updates.DEEPSEEK_BASE_URL = request.baseUrl;
    if (request.model) updates.DEEPSEEK_MODEL = request.model;
    if (request.models?.length) updates.DEEPSEEK_MODELS = request.models.join(',');
  } else {
    if (request.model) updates.OPENAI_MODEL = request.model;
    if (request.models?.length) updates.OPENAI_MODELS = request.models.join(',');
  }
  if (request.contextWindow) updates.MIMI_CONTEXT_WINDOW = String(request.contextWindow);
  return updates;
}

export async function persistProviderConfiguration(
  request: ProviderSetRequest,
  environmentFile = resolveEnvironmentFile(),
): Promise<PersistedProviderConfiguration> {
  const updates = providerUpdates(request);
  await persistEnvironmentValues(environmentFile, updates);
  Object.assign(process.env, updates);
  return {
    environmentFile,
    provider: request.provider,
    ...(request.model ? { model: request.model } : {}),
    ...(request.baseUrl ? { baseUrl: request.baseUrl } : {}),
  };
}
