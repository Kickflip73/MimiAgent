import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import {
  resolveEnvironmentFile,
  type ModelProvider,
} from './config.js';
import {
  modelTargetSchema,
  type ModelRegistration,
  type ProviderDefinition,
  type ProviderTransport,
} from './core/model-routing.js';
import {
  ModelConfigStore,
  parseModelsConfig,
  type ModelsConfig,
} from './runtime/model-config.js';
import { ModelGateway } from './runtime/model-gateway.js';

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

export function providerApiKeyName(provider: ModelProvider): string {
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

function registryTarget(value: string | undefined) {
  const slash = value?.indexOf('/') ?? -1;
  if (slash <= 0 || slash === value!.length - 1) {
    throw new Error('模型 target 必须是 providerId/modelId');
  }
  return modelTargetSchema.parse({
    providerId: value!.slice(0, slash),
    modelId: value!.slice(slash + 1),
  });
}

function booleanOption(value: string, name: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} 只能是 true 或 false`);
}

function positiveIntegerOption(value: string, name: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new Error(`${name} 必须是正安全整数`);
  }
  return Number(value);
}

function registryOptions(args: string[], start: number): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = start; index < args.length; index += 2) {
    const name = args[index];
    if (!name?.startsWith('--')) throw new Error(`未知 Provider registry 参数：${name ?? '(empty)'}`);
    const value = optionValue(args, index, name);
    if (options.has(name)) throw new Error(`Provider registry 选项重复：${name}`);
    options.set(name, value);
  }
  return options;
}

const REGISTRY_TRANSPORTS = new Set<ProviderTransport>([
  'openai-responses',
  'openai-chat-completions',
  'anthropic-messages',
  'google-generate-content',
]);

async function modelConfigExists(file: string): Promise<boolean> {
  return access(file).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

function listedProviders(
  config: ModelsConfig,
  environment: Readonly<Record<string, string | undefined>>,
) {
  return config.providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    transport: provider.transport,
    baseUrl: provider.baseUrl,
    apiKeyEnv: provider.apiKeyEnv,
    configured: Boolean(environment[provider.apiKeyEnv]?.trim()),
    models: provider.models,
  }));
}

export async function runProviderRegistryCommand(
  args: string[],
  modelsFile: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<unknown> {
  const action = args[0];
  const store = new ModelConfigStore(modelsFile);
  if (action === 'list') {
    if (args.length !== 1) throw new Error('用法：mimi provider list');
    const config = await store.read();
    return {
      routeVersion: config.routeVersion,
      globalDefault: config.routing.globalDefault,
      providers: listedProviders(config, environment),
    };
  }
  if (action === 'test') {
    if (args.length !== 2) throw new Error('用法：mimi provider test <providerId/modelId>');
    const target = registryTarget(args[1]);
    const config = await store.read();
    return new ModelGateway({
      providers: config.providers,
      environment,
    }).health(target);
  }
  if (action === 'set') {
    if (args.length !== 2) throw new Error('用法：mimi provider set <providerId/modelId>');
    const target = registryTarget(args[1]);
    const next = await store.update((config) => {
      const registration = config.providers.flatMap((provider) => provider.models)
        .find((model) => model.target.providerId === target.providerId
          && model.target.modelId === target.modelId);
      if (!registration) throw new Error(`模型 target 未注册：${target.providerId}/${target.modelId}`);
      if (registration.kind !== 'agent' || !registration.capabilities.toolCalling) {
        throw new Error('全局默认 target 必须是可运行工具循环的 Agent 模型');
      }
      return {
        ...config,
        routeVersion: config.routeVersion + 1,
        routing: { ...config.routing, globalDefault: target },
      };
    });
    return { action: 'set', target, routeVersion: next.routeVersion, daemonRestarted: false };
  }
  if (action !== 'add') {
    throw new Error('用法：mimi provider <add|set|list|test> ...');
  }

  const rawTarget = args[1]?.trim();
  if (!rawTarget) throw new Error('provider add 需要 providerId 或 providerId/modelId');
  const targetArgument = rawTarget.includes('/') ? registryTarget(rawTarget) : undefined;
  const positionalModelId = !targetArgument && args[2] && !args[2].startsWith('--')
    ? args[2].trim()
    : undefined;
  const providerId = targetArgument?.providerId ?? rawTarget;
  const options = registryOptions(args, positionalModelId ? 3 : 2);
  const allowed = new Set([
    '--label', '--transport', '--base-url', '--api-key-env', '--model', '--kind',
    '--image-input', '--image-output', '--file-input', '--tool-calling', '--context-window',
    '--reasoning-high', '--reasoning-off', '--manual-budget-tokens',
  ]);
  for (const name of options.keys()) {
    if (!allowed.has(name)) throw new Error(`未知 Provider registry 选项：${name}`);
  }
  const exists = await modelConfigExists(modelsFile);
  const current = exists ? await store.read() : undefined;
  const existingProvider = current?.providers.find((candidate) => candidate.id === providerId);
  const optionModelId = options.get('--model');
  const modelId = targetArgument?.modelId ?? positionalModelId ?? optionModelId;
  if (optionModelId && modelId !== optionModelId) {
    throw new Error('位置 modelId 与 --model 不一致');
  }
  const label = options.get('--label') ?? existingProvider?.label;
  const transport = (options.get('--transport') ?? existingProvider?.transport) as ProviderTransport | undefined;
  const apiKeyEnv = options.get('--api-key-env') ?? existingProvider?.apiKeyEnv;
  const kind = options.get('--kind') ?? 'agent';
  if (!label || !transport || !apiKeyEnv || !modelId) {
    throw new Error('provider add 需要 --label、--transport、--api-key-env 和 --model');
  }
  if (!REGISTRY_TRANSPORTS.has(transport)) throw new Error(`不支持的 Provider transport：${transport}`);
  if (!/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv)) throw new Error('--api-key-env 必须是环境变量名');
  if (kind !== 'agent' && kind !== 'image-generation') throw new Error('--kind 只能是 agent 或 image-generation');
  const baseUrl = options.get('--base-url') ?? existingProvider?.baseUrl;
  if (transport !== 'openai-responses' && !baseUrl) {
    throw new Error(`${transport} 需要显式 --base-url`);
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
  const imageInput = booleanOption(options.get('--image-input') ?? 'false', '--image-input');
  const imageOutput = booleanOption(options.get('--image-output') ?? 'false', '--image-output');
  const fileInput = booleanOption(options.get('--file-input') ?? 'false', '--file-input');
  const toolCalling = booleanOption(options.get('--tool-calling') ?? 'false', '--tool-calling');
  const reasoningHighValue = options.get('--reasoning-high');
  if (reasoningHighValue && reasoningHighValue !== 'manual' && reasoningHighValue !== 'adaptive') {
    throw new Error('--reasoning-high 只能是 manual 或 adaptive');
  }
  const reasoningHigh = reasoningHighValue as 'manual' | 'adaptive' | undefined;
  const supportsOff = options.has('--reasoning-off')
    ? booleanOption(options.get('--reasoning-off')!, '--reasoning-off')
    : false;
  const manualBudgetTokens = options.has('--manual-budget-tokens')
    ? positiveIntegerOption(options.get('--manual-budget-tokens')!, '--manual-budget-tokens')
    : undefined;
  const registration: ModelRegistration = {
    target: { providerId, modelId },
    kind,
    capabilities: { imageInput, imageOutput, toolCalling, fileInput },
    ...(options.has('--context-window')
      ? { contextWindow: positiveIntegerOption(options.get('--context-window')!, '--context-window') }
      : {}),
    ...(reasoningHigh ? {
      reasoning: {
        high: reasoningHigh,
        supportsOff,
        ...(manualBudgetTokens ? { manualBudgetTokens } : {}),
      },
    } : {}),
  };
  const provider: ProviderDefinition = {
    id: providerId,
    label,
    transport,
    ...(baseUrl ? { baseUrl } : {}),
    apiKeyEnv,
    models: [registration],
  };
  let next: ModelsConfig;
  if (!exists) {
    next = parseModelsConfig({
      version: 1,
      routeVersion: 1,
      providers: [provider],
      routing: { globalDefault: registration.target, scenarios: {} },
    });
    await store.write(next);
  } else {
    next = await store.update((config) => {
      const existing = config.providers.find((candidate) => candidate.id === providerId);
      if (!existing) {
        return {
          ...config,
          routeVersion: config.routeVersion + 1,
          providers: [...config.providers, provider],
        };
      }
      if (existing.label !== label
        || existing.transport !== transport
        || existing.baseUrl !== provider.baseUrl
        || existing.apiKeyEnv !== apiKeyEnv) {
        throw new Error(`Provider ${providerId} 已存在且定义不一致`);
      }
      if (existing.models.some((model) => model.target.modelId === modelId)) {
        throw new Error(`模型 target 已注册：${providerId}/${modelId}`);
      }
      return {
        ...config,
        routeVersion: config.routeVersion + 1,
        providers: config.providers.map((candidate) => candidate.id === providerId
          ? { ...candidate, models: [...candidate.models, registration] }
          : candidate),
      };
    });
  }
  return {
    action: 'added',
    target: registration.target,
    routeVersion: next.routeVersion,
    daemonRestarted: false,
  };
}
