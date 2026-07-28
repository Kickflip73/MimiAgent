import { createHash } from 'node:crypto';
import { z } from 'zod';

export const ACTION_INTENT_SCHEMA_VERSION = 2 as const;

export const actionIntentStatusSchema = z.enum([
  'not_started',
  'started',
  'confirmed',
  'failed_safe',
  'uncertain',
]);

const actionIntentFields = {
  intentId: z.string().min(1).max(200),
  actionFamily: z.string().min(1).max(120),
  targetRef: z.string().min(1).max(500),
  targetEvidenceRef: z.string().min(1).max(500).optional(),
  payloadDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  selectedRoute: z.string().min(1).max(200),
  executionKey: z.string().min(1).max(300),
  policyRevision: z.string().min(1).max(200),
  status: actionIntentStatusSchema,
};

const legacyActionIntentSchema = z.object({
  schemaVersion: z.literal(1),
  ...actionIntentFields,
}).strict();

const currentActionIntentSchema = z.object({
  schemaVersion: z.literal(ACTION_INTENT_SCHEMA_VERSION),
  businessActionRef: z.string().min(1).max(300),
  ...actionIntentFields,
}).strict();

export const actionIntentSchema = z.discriminatedUnion('schemaVersion', [
  legacyActionIntentSchema,
  currentActionIntentSchema,
]);

export type ActionIntent = z.infer<typeof actionIntentSchema>;
export type ActionIntentV2 = z.infer<typeof currentActionIntentSchema>;
export type ActionIntentStatus = z.infer<typeof actionIntentStatusSchema>;

export const oneTimeActionAuthorizationSchema = z.object({
  schemaVersion: z.literal(1),
  authorizationId: z.string().min(1).max(200),
  intentId: z.string().min(1).max(200),
  targetRef: z.string().min(1).max(500),
  payloadDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  policyRevision: z.string().min(1).max(200),
  expiresAt: z.string().datetime(),
  maxUses: z.literal(1),
}).strict();

export type OneTimeActionAuthorization = z.infer<typeof oneTimeActionAuthorizationSchema>;

export interface GuardedActionContext {
  ownerAuthenticated: boolean;
  exactTarget: boolean;
  lowRisk: boolean;
  reversible: boolean;
  boundedLocal?: boolean;
}

export type ActionAuthorizationDecision =
  | { allowed: true; source: 'guarded-owner-fast-path' | 'one-time-authorization'; authorizationId?: string }
  | { allowed: false; reason: string };

export function actionPayloadDigest(payload: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

export function actionExecutionKey(
  actionFamily: string,
  targetRef: string,
  payloadDigest: string,
  policyRevision: string,
  businessActionRef?: string,
): string {
  return `action:${createHash('sha256')
    .update([
      actionFamily,
      targetRef,
      payloadDigest,
      policyRevision,
      ...(businessActionRef ? [businessActionRef] : []),
    ].join('\0'))
    .digest('hex')}`;
}

export function evaluateActionAuthorization(
  intentInput: ActionIntent,
  context: GuardedActionContext,
  authorizationInput?: OneTimeActionAuthorization,
  now = new Date(),
): ActionAuthorizationDecision {
  const intent = actionIntentSchema.parse(intentInput);
  const guardedReversible = context.lowRisk && context.reversible;
  if (context.ownerAuthenticated && context.exactTarget
    && (guardedReversible || context.boundedLocal === true)) {
    return { allowed: true, source: 'guarded-owner-fast-path' };
  }
  if (!authorizationInput) return { allowed: false, reason: '动作不满足 guarded owner 快速通道且缺少一次性授权' };
  const authorization = oneTimeActionAuthorizationSchema.parse(authorizationInput);
  if (authorization.intentId !== intent.intentId
    || authorization.targetRef !== intent.targetRef
    || authorization.payloadDigest !== intent.payloadDigest
    || authorization.policyRevision !== intent.policyRevision) {
    return { allowed: false, reason: '一次性授权与 ActionIntent 的目标、正文或策略版本不一致' };
  }
  if (Date.parse(authorization.expiresAt) <= now.getTime()) {
    return { allowed: false, reason: '一次性授权已过期' };
  }
  return {
    allowed: true,
    source: 'one-time-authorization',
    authorizationId: authorization.authorizationId,
  };
}

export interface ActionIntentReceipt<T = unknown> {
  intent: ActionIntent;
  outcome: Extract<ActionIntentStatus, 'confirmed' | 'failed_safe' | 'uncertain'>;
  result?: T;
  authorizationSource: 'guarded-owner-fast-path' | 'one-time-authorization';
  attempts: number;
  updatedAt: string;
}

export class ActionFailedSafeError extends Error {
  override readonly name = 'ActionFailedSafeError';
}

export class ActionIntentUncertainError extends Error {
  override readonly name = 'ActionIntentUncertainError';
}
