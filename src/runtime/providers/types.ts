import type { Model } from '@openai/agents';
import type {
  ModelRegistration,
  ModelTarget,
  ProviderDefinition,
  ReasoningIntent,
} from '../../core/model-routing.js';

export interface AgentModelRuntime {
  model: string | Model;
  target: ModelTarget;
  registration: ModelRegistration;
  reasoning: ReasoningIntent;
}

export interface ImageGenerationInput {
  prompt: string;
  image?: string;
  size?: string;
}

export interface ImageGenerationResult {
  artifacts: Array<{ data?: string; url?: string; mediaType: string }>;
  requestId?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ImageModelRuntime {
  target: ModelTarget;
  registration: ModelRegistration;
  generate(input: ImageGenerationInput, signal?: AbortSignal): Promise<ImageGenerationResult>;
}

export interface ProviderAdapter {
  createAgentRuntime(
    provider: ProviderDefinition,
    registration: ModelRegistration,
    apiKey: string,
    reasoning: ReasoningIntent,
  ): AgentModelRuntime;
  createImageRuntime(
    provider: ProviderDefinition,
    registration: ModelRegistration,
    apiKey: string,
  ): ImageModelRuntime;
  health(
    provider: ProviderDefinition,
    registration: ModelRegistration,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<{ requestId?: string }>;
}
