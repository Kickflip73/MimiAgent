import { z } from 'zod';

export const modelTargetSchema = z.object({
  providerId: z.string().trim().min(1).max(100),
  modelId: z.string().trim().min(1).max(200),
}).strict();

export interface ModelTarget {
  providerId: string;
  modelId: string;
}

export type ModelKind = 'agent' | 'image-generation';
export type ProviderTransport =
  | 'openai-responses'
  | 'openai-chat-completions'
  | 'anthropic-messages'
  | 'google-generate-content';
export type ReasoningIntent = 'off' | 'auto' | 'high';
export type TaskComplexity = 'simple' | 'normal' | 'hard';

export interface ModelCapabilities {
  imageInput: boolean;
  imageOutput: boolean;
  toolCalling: boolean;
}

export interface ModelRegistration {
  target: ModelTarget;
  kind: ModelKind;
  capabilities: ModelCapabilities;
  contextWindow?: number;
}

export interface ProviderDefinition {
  id: string;
  label: string;
  transport: ProviderTransport;
  baseUrl?: string;
  region?: string;
  apiKeyEnv: string;
  models: ModelRegistration[];
}

export interface ModelRequirements {
  imageInput?: boolean;
  imageOutput?: boolean;
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
  | { action: 'route'; scenario: string; target: ModelTarget }
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
}

export const modelCapabilitiesSchema = z.object({
  imageInput: z.boolean(),
  imageOutput: z.boolean(),
  toolCalling: z.boolean(),
}).strict();

export const modelRegistrationSchema = z.object({
  target: modelTargetSchema,
  kind: z.enum(['agent', 'image-generation']),
  capabilities: modelCapabilitiesSchema,
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
  baseUrl: z.string().url().optional(),
  region: z.string().trim().min(1).max(100).optional(),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  models: z.array(modelRegistrationSchema).min(1).max(200),
}).strict();

export const modelRequirementsSchema = z.object({
  imageInput: z.boolean().optional(),
  imageOutput: z.boolean().optional(),
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
  kind: z.enum(['agent', 'image-generation']),
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
}).strict();

export function modelTargetKey(target: ModelTarget): string {
  return `${target.providerId}/${target.modelId}`;
}

export function sameModelTarget(left: ModelTarget, right: ModelTarget): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}
