import type { EventEnvelope } from './types.js';

export const BENCHMARK_NO_TOOLS_RUN_POLICY = 'benchmark-no-tools-v1' as const;
export const VOICE_CONVERSATION_RUN_POLICY = 'voice-conversation-v1' as const;
export type RequestedLocalRunPolicy =
  | typeof BENCHMARK_NO_TOOLS_RUN_POLICY
  | typeof VOICE_CONVERSATION_RUN_POLICY;

const NO_TOOLS_RUN_POLICIES = new Set<RequestedLocalRunPolicy>([
  BENCHMARK_NO_TOOLS_RUN_POLICY,
  VOICE_CONVERSATION_RUN_POLICY,
]);

export function parseRequestedLocalRunPolicy(value: unknown): RequestedLocalRunPolicy | undefined {
  if (value === undefined) return undefined;
  if (value !== BENCHMARK_NO_TOOLS_RUN_POLICY && value !== VOICE_CONVERSATION_RUN_POLICY) {
    throw new Error(`不支持的 local-cli RunPolicy：${String(value)}`);
  }
  return value;
}

export function isNoToolsLocalRunPolicy(
  value: RequestedLocalRunPolicy | undefined,
): boolean {
  return value !== undefined && NO_TOOLS_RUN_POLICIES.has(value);
}

export function requestedLocalRunPolicyForEvent(
  event: Pick<EventEnvelope, 'source' | 'trust' | 'payload'>,
): RequestedLocalRunPolicy | undefined {
  if (event.source !== 'local-cli' || event.trust !== 'owner') return undefined;
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    return undefined;
  }
  return parseRequestedLocalRunPolicy(
    (event.payload as Record<string, unknown>).requestedRunPolicy,
  );
}
