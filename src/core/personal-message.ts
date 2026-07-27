import { z } from 'zod';

export const PERSONAL_MESSAGE_CHANNELS = ['daxiang', 'qq', 'wechat'] as const;
export const PERSONAL_MESSAGE_COVERAGE = [
  'complete',
  'bounded',
  'notification_only',
  'metadata_only',
] as const;
export const PERSONAL_MESSAGE_MODES = ['observe', 'digest', 'draft', 'confirm', 'auto'] as const;

export type PersonalMessageChannel = typeof PERSONAL_MESSAGE_CHANNELS[number];
export type PersonalMessageCoverage = typeof PERSONAL_MESSAGE_COVERAGE[number];
export type PersonalMessageMode = typeof PERSONAL_MESSAGE_MODES[number];

const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const directionSchema = z.enum(['incoming', 'outgoing']);

export const personalMessagePayloadSchema = z.object({
  version: z.literal(1),
  channel: z.enum(PERSONAL_MESSAGE_CHANNELS),
  accountFingerprint: fingerprintSchema,
  messageId: z.string().trim().min(1).max(500).optional(),
  direction: directionSchema,
  messageType: z.enum(['text', 'image', 'file', 'voice', 'system', 'unknown']),
  coverage: z.enum(PERSONAL_MESSAGE_COVERAGE),
  preview: z.string().max(4_000).optional(),
  mentionsOwner: z.boolean().optional(),
  attachments: z.array(z.object({
    name: z.string().max(500).optional(),
    type: z.string().trim().min(1).max(200),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  }).strict()).max(50).optional(),
}).strict();
export type PersonalMessagePayload = z.infer<typeof personalMessagePayloadSchema>;

const contextMessageSchema = z.object({
  id: z.string().trim().min(1).max(500).optional(),
  direction: directionSchema,
  actorId: z.string().trim().min(1).max(500).optional(),
  text: z.string().max(4_000).optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export const personalMessageContextSchema = z.object({
  channel: z.enum(PERSONAL_MESSAGE_CHANNELS),
  accountFingerprint: fingerprintSchema,
  conversationId: z.string().trim().min(1).max(500),
  coverage: z.enum(PERSONAL_MESSAGE_COVERAGE),
  observedAt: z.string().datetime({ offset: true }),
  latestFingerprint: fingerprintSchema,
  messages: z.array(contextMessageSchema).max(100),
  truncated: z.boolean(),
}).strict().superRefine((context, refinement) => {
  if (Buffer.byteLength(JSON.stringify(context)) > 256 * 1024) {
    refinement.addIssue({
      code: 'custom',
      path: ['messages'],
      message: 'personal message context must not exceed 256 KB',
    });
  }
});
export type PersonalMessageContext = z.infer<typeof personalMessageContextSchema>;

export const personalMessageResultSchema = z.object({
  status: z.enum(['not_executed', 'observed', 'accepted', 'confirmed', 'failed', 'uncertain']),
  route: z.enum(['connector', 'browser', 'computer', 'none']),
  deliveryConfirmed: z.boolean(),
  accountVerified: z.boolean(),
  targetVerified: z.boolean(),
  evidence: z.string().max(2_000).optional(),
  error: z.string().max(2_000).optional(),
}).strict();
export type PersonalMessageResult = z.infer<typeof personalMessageResultSchema>;

export interface PersonalMessageAuthorization {
  channel: PersonalMessageChannel;
  accountFingerprint: string;
  conversationId: string;
  actorId?: string;
  eventId: string;
  mode: PersonalMessageMode;
  approvedText?: string;
}

interface PersonalMessageEventLike {
  source: string;
  payload: unknown;
  replyRoute?: unknown;
}

interface PersonalMessageAuthorizationEventLike extends PersonalMessageEventLike {
  id: string;
  actor?: { id: string };
  conversation?: { id: string };
}

export const PERSONAL_MESSAGE_MODE_LEVEL: Readonly<Record<PersonalMessageMode, number>> = {
  observe: 0,
  digest: 1,
  draft: 2,
  confirm: 3,
  auto: 4,
};

export function mostRestrictiveMessageMode(
  modes: readonly PersonalMessageMode[],
  fallback: PersonalMessageMode = 'draft',
): PersonalMessageMode {
  return modes.length
    ? modes.reduce((selected, candidate) => (
        PERSONAL_MESSAGE_MODE_LEVEL[candidate] < PERSONAL_MESSAGE_MODE_LEVEL[selected]
          ? candidate
          : selected
      ))
    : fallback;
}

export function personalMessagePayloadFor(
  event: PersonalMessageEventLike,
): PersonalMessagePayload | undefined {
  if (!event.source.startsWith('personal-message:') || event.replyRoute !== undefined) return undefined;
  const parsed = personalMessagePayloadSchema.safeParse(event.payload);
  if (!parsed.success || event.source !== `personal-message:${parsed.data.channel}`) return undefined;
  return parsed.data;
}

export function personalMessageAuthorizationFor(
  event: PersonalMessageAuthorizationEventLike,
  mode: PersonalMessageMode,
): PersonalMessageAuthorization | undefined {
  const payload = personalMessagePayloadFor(event);
  if (!payload || payload.direction !== 'incoming' || !event.conversation?.id) return undefined;
  return {
    channel: payload.channel,
    accountFingerprint: payload.accountFingerprint,
    conversationId: event.conversation.id,
    actorId: event.actor?.id,
    eventId: event.id,
    mode,
  };
}

export function personalMessageSource(channel: PersonalMessageChannel): string {
  return `personal-message:${channel}`;
}

export function personalMessageConfirmationText(input: unknown): string | undefined {
  const prompt = typeof input === 'string'
    ? input
    : input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>).prompt
      : undefined;
  if (typeof prompt !== 'string') return undefined;
  const match = /^\s*确认发送(?:(大象|QQ|微信))?消息?[：:]\s*([\s\S]{1,4000}?)\s*$/u.exec(prompt);
  const text = match?.[2]?.trim();
  return text || undefined;
}
