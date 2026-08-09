import {
  parseModelsConfig,
  type ModelsConfig,
} from '../src/runtime/model-config.js';
import type {
  ModelCapabilities,
  ModelRegistration,
  ProviderDefinition,
} from '../src/core/model-routing.js';

export interface ConversationProviderProjection {
  config: ModelsConfig;
  contents: string;
  providerId: string;
  modelId: string;
  apiKeyEnv: string;
}

function projectedCapabilities(capabilities: ModelCapabilities): ModelCapabilities {
  return {
    imageInput: capabilities.imageInput,
    imageOutput: capabilities.imageOutput,
    toolCalling: capabilities.toolCalling,
    fileInput: capabilities.fileInput ?? false,
    audioInput: capabilities.audioInput ?? false,
    audioOutput: capabilities.audioOutput ?? false,
    videoInput: capabilities.videoInput ?? false,
    realtimeAudio: capabilities.realtimeAudio ?? false,
  };
}

function projectedModel(model: ModelRegistration): ModelRegistration {
  return {
    target: {
      providerId: model.target.providerId,
      modelId: model.target.modelId,
    },
    kind: model.kind,
    capabilities: projectedCapabilities(model.capabilities),
    ...(model.reasoning ? {
      reasoning: {
        high: model.reasoning.high,
        supportsOff: model.reasoning.supportsOff,
        ...(model.reasoning.manualBudgetTokens === undefined
          ? {}
          : { manualBudgetTokens: model.reasoning.manualBudgetTokens }),
      },
    } : {}),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
  };
}

function projectedProvider(
  provider: ProviderDefinition,
  model: ModelRegistration,
): ProviderDefinition {
  return {
    id: provider.id,
    label: provider.label,
    transport: provider.transport,
    ...(provider.realtimeTransport ? { realtimeTransport: provider.realtimeTransport } : {}),
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.region ? { region: provider.region } : {}),
    apiKeyEnv: provider.apiKeyEnv,
    models: [projectedModel(model)],
  };
}

function assertFormalProviderEndpoint(provider: ProviderDefinition): void {
  if (!provider.baseUrl) return;
  const endpoint = new URL(provider.baseUrl);
  if (endpoint.protocol !== 'https:') {
    throw new Error('formal conversation Provider baseUrl must use https');
  }
  if (endpoint.username || endpoint.password) {
    throw new Error('formal conversation Provider baseUrl must not contain userinfo');
  }
}

export function projectConversationProviderConfig(
  value: unknown,
): ConversationProviderProjection {
  const source = parseModelsConfig(value);
  const { providerId, modelId } = source.routing.globalDefault;
  const provider = source.providers.find((candidate) => candidate.id === providerId);
  const model = provider?.models.find((candidate) => (
    candidate.target.providerId === providerId && candidate.target.modelId === modelId
  ));
  if (!provider || !model) {
    throw new Error('formal conversation models config must resolve one global-default Provider/Model');
  }
  assertFormalProviderEndpoint(provider);
  const config = parseModelsConfig({
    version: 1,
    routeVersion: source.routeVersion,
    providers: [projectedProvider(provider, model)],
    routing: {
      globalDefault: { providerId, modelId },
      scenarios: {},
    },
  });
  return {
    config,
    contents: `${JSON.stringify(config, null, 2)}\n`,
    providerId,
    modelId,
    apiKeyEnv: provider.apiKeyEnv,
  };
}

export function projectConversationProviderConfigJson(
  contents: string,
): ConversationProviderProjection {
  return projectConversationProviderConfig(JSON.parse(contents) as unknown);
}
