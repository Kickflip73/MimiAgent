import type { SecurityProfile } from '../config.js';
import type { EventEnvelope } from './types.js';

export function parseRequestedSecurityProfile(value: unknown): SecurityProfile | undefined {
  if (value === undefined) return undefined;
  if (value !== 'safe' && value !== 'workstation' && value !== 'full-owner') {
    throw new Error(`不支持的安全档位：${String(value)}`);
  }
  return value;
}

export function requestedSecurityProfileForLocalSubmit(input: {
  source?: string;
  trust?: EventEnvelope['trust'];
  sessionKey?: unknown;
  payload?: unknown;
  requestedSecurityProfile?: unknown;
}): SecurityProfile | undefined {
  const payloadRecord = input.payload && typeof input.payload === 'object'
    && !Array.isArray(input.payload)
    ? input.payload as Record<string, unknown>
    : undefined;
  if (payloadRecord && Object.hasOwn(payloadRecord, 'requestedSecurityProfile')) {
    throw new Error('payload.requestedSecurityProfile 是保留字段；必须通过认证 local-cli 提交参数设置');
  }
  const requested = parseRequestedSecurityProfile(input.requestedSecurityProfile);
  if (requested && ((input.source ?? 'local-cli') !== 'local-cli'
    || (input.trust ?? 'owner') !== 'owner')) {
    throw new Error('requestedSecurityProfile 仅允许认证 local-cli owner 收窄本轮权限');
  }
  if (requested && input.sessionKey === undefined) {
    throw new Error('requestedSecurityProfile 需要显式 Session 绑定');
  }
  if (requested && input.payload !== undefined && !payloadRecord) {
    throw new Error('requestedSecurityProfile 不能与非对象 payload 同时提交');
  }
  return requested;
}

export function requestedSecurityProfileForEvent(
  event: Pick<EventEnvelope, 'source' | 'trust' | 'payload'>,
): SecurityProfile | undefined {
  if (event.source !== 'local-cli' || event.trust !== 'owner') return undefined;
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    return undefined;
  }
  return parseRequestedSecurityProfile(
    (event.payload as Record<string, unknown>).requestedSecurityProfile,
  );
}
