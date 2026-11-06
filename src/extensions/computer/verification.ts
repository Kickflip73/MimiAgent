import { z } from 'zod';
import type { ComputerElement } from './types.js';

// Match semantic identity, never a snapshot-local element index or tool arguments.
export const computerExpectationSchema = z.object({
  role: z.string().min(1).max(100),
  identifier: z.string().min(1).max(200).nullable().optional(),
  label: z.string().max(240).nullable().optional(),
  equals: z.union([z.string().max(10_000), z.number().finite(), z.boolean()]),
}).strict();
export type ComputerExpectation = z.infer<typeof computerExpectationSchema>;

export function verifyComputerState(state: unknown, expected?: ComputerExpectation | null) {
  if (!expected) return { status: 'not_requested' as const };
  const value = state as { observationId?: string; actionable?: boolean; elements?: ComputerElement[]; truncated?: boolean } | undefined;
  const matches = value?.elements?.filter(element => !element.secure
    && element.role === expected.role
    && (expected.identifier == null || element.identifier === expected.identifier)
    && (expected.label == null || element.label === expected.label)) ?? [];
  if (!value?.observationId || value.actionable !== true || value.truncated || matches.length !== 1
    || matches[0]!.value === undefined || matches[0]!.valueTruncated) {
    return { status: 'unavailable' as const, reason: 'A fresh, unique, complete semantic value is required' };
  }
  return {
    status: matches[0]!.value === expected.equals ? 'passed' as const : 'failed' as const,
    evidenceViewRef: value.observationId,
    expected,
    actual: matches[0]!.value,
  };
}

export function hasVerifiedComputerResult(output: unknown): boolean {
  if (typeof output === 'string') {
    try { return hasVerifiedComputerResult(JSON.parse(output) as unknown); } catch { return false; }
  }
  if (Array.isArray(output)) {
    const text = output.find(item => item?.type === 'text');
    return hasVerifiedComputerResult(text?.text);
  }
  if (!output || typeof output !== 'object') return false;
  const record = output as Record<string, unknown>;
  if ('result' in record) return hasVerifiedComputerResult(record.result);
  const verification = record.verification as Record<string, unknown> | undefined;
  return record.ok === true && record.verified === true && verification?.status === 'passed'
    && typeof verification.evidenceViewRef === 'string';
}
