import { z } from 'zod';

export const modelTargetSchema = z.object({
  providerId: z.string().trim().min(1).max(100),
  modelId: z.string().trim().min(1).max(200),
}).strict();

export interface ModelTarget {
  providerId: string;
  modelId: string;
}

export type ModelKind = 'agent' | 'image-generation' | 'realtime';
export type ProviderTransport =
  | 'openai-responses'
  | 'openai-chat-completions'
  | 'anthropic-messages'
  | 'google-generate-content';
export type RealtimeTransport = 'openai-realtime-websocket';
export type ReasoningIntent = 'off' | 'auto' | 'high';
export type TaskComplexity = 'simple' | 'normal' | 'hard';

export interface ModelCapabilities {
  imageInput: boolean;
  imageOutput: boolean;
  toolCalling: boolean;
  fileInput?: boolean;
  audioInput?: boolean;
  audioOutput?: boolean;
  videoInput?: boolean;
  realtimeAudio?: boolean;
}

export interface ModelRegistration {
  target: ModelTarget;
  kind: ModelKind;
  capabilities: ModelCapabilities;
  reasoning?: {
    high: 'manual' | 'adaptive';
    supportsOff: boolean;
    manualBudgetTokens?: number;
  };
  contextWindow?: number;
}

export interface ProviderDefinition {
  id: string;
  label: string;
  transport: ProviderTransport;
  realtimeTransport?: RealtimeTransport;
  baseUrl?: string;
  region?: string;
  apiKeyEnv: string;
  models: ModelRegistration[];
}

export interface ModelRequirements {
  imageInput?: boolean;
  imageOutput?: boolean;
  fileInput?: boolean;
  audioInput?: boolean;
  audioOutput?: boolean;
  videoInput?: boolean;
  realtimeAudio?: boolean;
  toolCalling?: boolean;
  reasoning?: ReasoningIntent;
}

export interface WorkUnitModelProfile {
  complexity?: TaskComplexity;
  requirements?: ModelRequirements;
  modelTarget?: ModelTarget;
}

export interface ScenarioRoute {
  target?: ModelTarget;
  candidates?: ModelTarget[];
  maxTurns?: number;
  maxOutputTokens?: number;
}

export interface ModelRoutingConfig {
  globalDefault: ModelTarget;
  scenarios: Record<string, ScenarioRoute>;
}

export type ModelControlRequest =
  | { action: 'list' | 'current' | 'routes' }
  | { action: 'inspect' | 'use'; target: ModelTarget }
  | { action: 'auto' }
  | {
      action: 'route';
      scenario: string;
      target: ModelTarget;
      maxTurns?: number;
      maxOutputTokens?: number;
    }
  | { action: 'route'; scenario: string; routeAuto: true }
  | { action: 'doctor'; target?: ModelTarget };

export interface RunModelBinding {
  target: ModelTarget;
  kind: ModelKind;
  reasoning: ReasoningIntent;
  scenario: string;
  complexity?: TaskComplexity;
  reason:
    | 'explicit-work-unit'
    | 'team-override'
    | 'session-preference'
    | 'scenario-route'
    | 'global-default'
    | 'safe-fallback';
  routeVersion: number;
  contextWindow?: number;
  maxTurns?: number;
  maxOutputTokens?: number;
}

export const modelCapabilitiesSchema: z.ZodType<ModelCapabilities> = z.object({
  imageInput: z.boolean(),
  imageOutput: z.boolean(),
  toolCalling: z.boolean(),
  fileInput: z.boolean().default(false),
  audioInput: z.boolean().default(false),
  audioOutput: z.boolean().default(false),
  videoInput: z.boolean().default(false),
  realtimeAudio: z.boolean().default(false),
}).strict();

export const modelRegistrationSchema = z.object({
  target: modelTargetSchema,
  kind: z.enum(['agent', 'image-generation', 'realtime']),
  capabilities: modelCapabilitiesSchema,
  reasoning: z.object({
    high: z.enum(['manual', 'adaptive']),
    supportsOff: z.boolean(),
    manualBudgetTokens: z.number().int().min(1_024).optional(),
  }).strict().optional(),
  contextWindow: z.number().int().positive().optional(),
}).strict();

export const providerDefinitionSchema = z.object({
  id: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
  transport: z.enum([
    'openai-responses',
    'openai-chat-completions',
    'anthropic-messages',
    'google-generate-content',
  ]),
  realtimeTransport: z.literal('openai-realtime-websocket').optional(),
  baseUrl: z.string().url().optional(),
  region: z.string().trim().min(1).max(100).optional(),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  models: z.array(modelRegistrationSchema).min(1).max(200),
}).strict().superRefine((provider, context) => {
  const realtimeModels = provider.models.filter((model) => model.capabilities.realtimeAudio);
  if (realtimeModels.length && provider.realtimeTransport !== 'openai-realtime-websocket') {
    context.addIssue({
      code: 'custom',
      message: 'realtimeAudio 模型必须显式声明 openai-realtime-websocket transport',
      path: ['realtimeTransport'],
    });
  }
  if (provider.realtimeTransport
    && (provider.transport !== 'openai-responses' || provider.baseUrl !== undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'Realtime WebSocket 仅允许官方 OpenAI Provider，兼容端点必须 fail closed',
      path: ['realtimeTransport'],
    });
  }
  for (const [index, model] of provider.models.entries()) {
    if (model.capabilities.fileInput
      && (provider.transport === 'anthropic-messages'
        || provider.transport === 'google-generate-content')) {
      context.addIssue({
        code: 'custom',
        message: `${provider.transport} adapter 尚未实现 fileInput 显式转换`,
        path: ['models', index, 'capabilities', 'fileInput'],
      });
    }
    if (model.kind === 'realtime' && !model.capabilities.realtimeAudio) {
      context.addIssue({
        code: 'custom',
        message: 'Realtime Runtime 必须声明 realtimeAudio 硬能力',
        path: ['models', index, 'capabilities', 'realtimeAudio'],
      });
    }
    if (model.capabilities.realtimeAudio && model.kind !== 'realtime') {
      context.addIssue({
        code: 'custom',
        message: 'realtimeAudio 模型必须使用 realtime kind，避免进入普通 Agent 路由',
        path: ['models', index, 'kind'],
      });
    }
    if (model.kind === 'realtime'
      && (!model.capabilities.audioInput || !model.capabilities.audioOutput)) {
      context.addIssue({
        code: 'custom',
        message: 'realtimeAudio 模型必须同时声明 audioInput 和 audioOutput',
        path: ['models', index, 'capabilities'],
      });
    }
  }
});

export const modelRequirementsSchema = z.object({
  imageInput: z.boolean().optional(),
  imageOutput: z.boolean().optional(),
  fileInput: z.boolean().optional(),
  audioInput: z.boolean().optional(),
  audioOutput: z.boolean().optional(),
  videoInput: z.boolean().optional(),
  realtimeAudio: z.boolean().optional(),
  toolCalling: z.boolean().optional(),
  reasoning: z.enum(['off', 'auto', 'high']).optional(),
}).strict();

export const workUnitModelProfileSchema = z.object({
  complexity: z.enum(['simple', 'normal', 'hard']).optional(),
  requirements: modelRequirementsSchema.optional(),
  modelTarget: modelTargetSchema.optional(),
}).strict();

export const scenarioRouteSchema = z.object({
  target: modelTargetSchema.optional(),
  candidates: z.array(modelTargetSchema).min(1).max(20).optional(),
  maxTurns: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
}).strict().refine((value) => !(value.target && value.candidates), {
  message: '场景路由不能同时配置 target 和 candidates',
});

export const modelRoutingConfigSchema = z.object({
  globalDefault: modelTargetSchema,
  scenarios: z.record(z.string().trim().min(1).max(100), scenarioRouteSchema),
}).strict();

const modelScenarioSchema = z.string()
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/)
  .max(100);

export const modelControlRequestSchema: z.ZodType<ModelControlRequest> = z.union(
  [
    z.object({ action: z.enum(['list', 'current', 'routes']) }).strict(),
    z.object({
      action: z.enum(['inspect', 'use']),
      target: modelTargetSchema,
    }).strict(),
    z.object({ action: z.literal('auto') }).strict(),
    z.object({
      action: z.literal('route'),
      scenario: modelScenarioSchema,
      target: modelTargetSchema,
      maxTurns: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
    }).strict(),
    z.object({
      action: z.literal('route'),
      scenario: modelScenarioSchema,
      routeAuto: z.literal(true),
    }).strict(),
    z.object({
      action: z.literal('doctor'),
      target: modelTargetSchema.optional(),
    }).strict(),
  ],
);

export const runModelBindingSchema = z.object({
  target: modelTargetSchema,
  kind: z.enum(['agent', 'image-generation', 'realtime']),
  reasoning: z.enum(['off', 'auto', 'high']),
  scenario: z.string().trim().min(1).max(100),
  complexity: z.enum(['simple', 'normal', 'hard']).optional(),
  reason: z.enum([
    'explicit-work-unit',
    'team-override',
    'session-preference',
    'scenario-route',
    'global-default',
    'safe-fallback',
  ]),
  routeVersion: z.number().int().positive(),
  contextWindow: z.number().int().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
}).strict();

export function modelTargetKey(target: ModelTarget): string {
  return `${target.providerId}/${target.modelId}`;
}

export function sameModelTarget(left: ModelTarget, right: ModelTarget): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}
