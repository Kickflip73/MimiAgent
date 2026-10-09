import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ExecutionCallRecord } from './execution-ledger.js';
import { resultArtifactSchema, resultArtifacts, toolResultFailure, toolResultUncertain, toolResultObject } from './tool-result.js';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const runOutcomeSchema = z.enum([
  'completed',
  'partial',
  'blocked',
  'interrupted',
  'failed',
  'uncertain',
]);
export type RunOutcome = z.infer<typeof runOutcomeSchema>;

export const toolExecutionManifestEntrySchema = z.object({
  runId: z.string().min(1),
  toolName: z.string().min(1),
  callId: z.string().min(1),
  modelCallId: z.string().min(1).optional(),
  recoveredByCallId: z.string().min(1).optional(),
  status: z.enum(['started', 'succeeded', 'failed', 'uncertain']),
  argumentsDigest: digestSchema,
  outcomeDigest: digestSchema.optional(),
}).strict();

export const runFinalizationRecordSchema = z.object({
  runId: z.string().min(1),
  answerDigest: digestSchema,
  outcome: runOutcomeSchema.default('completed'),
  reason: z.string().trim().min(1).max(2_000).optional(),
  nextAction: z.string().trim().min(1).max(2_000).optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  artifacts: z.array(resultArtifactSchema).max(100).optional(),
  // Preserve durable evidence written by builds with the optional media subsystem.
  mediaAnchors: z.array(z.unknown()).max(100).optional(),
  mediaAnchorsTruncated: z.literal(true).optional(),
  completionDecision: z.enum(['pass', 'continue', 'blocked', 'uncertain']).optional(),
  toolManifest: z.array(toolExecutionManifestEntrySchema),
}).strict();

export type ToolExecutionManifestEntry = z.infer<typeof toolExecutionManifestEntrySchema>;
export type RunFinalizationRecord = z.infer<typeof runFinalizationRecordSchema>;

export const contextUsageSnapshotSchema = z.object({
  lastRequestInputTokens: z.number().finite().nonnegative().optional(),
  lastRequestOutputTokens: z.number().finite().nonnegative().optional(),
  runInputTokens: z.number().finite().nonnegative().optional(),
  runOutputTokens: z.number().finite().nonnegative().optional(),
  runTotalTokens: z.number().finite().nonnegative().optional(),
  providerId: z.string().min(1).max(100).optional(),
  modelId: z.string().min(1).max(200).optional(),
  scenario: z.string().min(1).max(100).optional(),
  selectionReason: z.enum([
    'explicit-work-unit',
    'team-override',
    'session-preference',
    'scenario-route',
    'global-default',
    'safe-fallback',
  ]).optional(),
  cost: z.literal('unknown').optional(),
}).strict();
export type ContextUsageSnapshot = z.infer<typeof contextUsageSnapshotSchema>;
const ERROR_FINALIZATIONS = new WeakMap<Error, RunFinalizationRecord>();

export function attachRunFinalization(
  error: unknown,
  finalization: RunFinalizationRecord,
): Error {
  const target = error instanceof Error ? error : new Error(String(error));
  ERROR_FINALIZATIONS.set(target, finalization);
  return target;
}

export function runFinalizationFromError(error: unknown): RunFinalizationRecord | undefined {
  return error instanceof Error ? ERROR_FINALIZATIONS.get(error) : undefined;
}

export interface RunOutcomeInput {
  sdk: 'completed' | 'interrupted' | 'failed';
  calls: readonly ExecutionCallRecord[];
  completionDecision?: RunFinalizationRecord['completionDecision'];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function actionEvidence(value: unknown): Record<string, unknown> | undefined {
  return objectValue(objectValue(value)?.mimiActionIntent);
}

function isInteractionOnly(value: unknown): boolean {
  const record = objectValue(value);
  return record?.completionScope === 'interaction'
    || record?.businessOutcome === 'unverified';
}

function isAcceptedOnly(value: unknown): boolean {
  const record = objectValue(value);
  return record?.outcome === 'accepted'
    || actionEvidence(value)?.outcome === 'failed_safe';
}

function blocksForInput(call: ExecutionCallRecord): boolean {
  return call.status === 'succeeded'
    && call.toolName === 'request_background_task_input'
    && objectValue(call.output)?.accepted === true;
}

function repairsRejectedArguments(failed: ExecutionCallRecord, later: ExecutionCallRecord): boolean {
  const result = toolResultObject(failed.output);
  const disposition = objectValue(result?.disposition);
  if (disposition?.phase !== 'pre_dispatch' || disposition.kind !== 'validation'
    || disposition.dispatchStarted !== false || disposition.toolName !== failed.toolName) return false;
  const before = toolResultObject(failed.argumentsJson);
  const after = toolResultObject(later.argumentsJson);
  if (!before || !after || !Array.isArray(result?.issues) || !result.issues.length) return false;
  // A generic dispatcher can serve unrelated capabilities. Never associate their
  // successes just because the wrapper has the same name.
  for (const key of ['name', 'toolName', 'capability', 'connector', 'action', 'server', 'method']) {
    if (!isDeepStrictEqual(before[key], after[key])) return false;
  }
  const left = structuredClone(before);
  const right = structuredClone(after);
  for (const issue of result.issues) {
    const value = objectValue(issue)?.path;
    const keys = typeof value === 'string' ? value.split('.') : Array.isArray(value) ? value.map(String) : [];
    if (!keys.length || keys.some((key) => !key || ['__proto__', 'prototype', 'constructor'].includes(key))) return false;
    for (const args of [left, right]) {
      let parent: Record<string, unknown> | undefined = args;
      for (const key of keys.slice(0, -1)) {
        const child: unknown = parent?.[key];
        parent = child !== null && typeof child === 'object' ? child as Record<string, unknown> : undefined;
      }
      if (parent) delete parent[keys.at(-1)!];
    }
  }
  // Only the rejected fields may change. Evidence of another task cannot clear
  // an earlier failure. Both attempts remain unchanged in the canonical manifest.
  return isDeepStrictEqual(left, right);
}

function recoveringCall(calls: readonly ExecutionCallRecord[], index: number): ExecutionCallRecord | undefined {
  const call = calls[index]!;
  if (call.status !== 'failed') return undefined;
  return calls.slice(index + 1).find((later) => later.status === 'succeeded'
    && later.toolName === call.toolName
    && !isInteractionOnly(later.output) && !isAcceptedOnly(later.output)
    && (later.argumentsJson === call.argumentsJson || repairsRejectedArguments(call, later)));
}

function unresolvedFailures(calls: readonly ExecutionCallRecord[]): ExecutionCallRecord[] {
  return calls.filter((call, index) => call.status === 'failed' && !recoveringCall(calls, index));
}

export function classifyRunOutcome(input: RunOutcomeInput): RunOutcome {
  input = { ...input, calls: input.calls.map((call) => call.status !== 'succeeded' ? call
    : toolResultUncertain(call.output) ? { ...call, status: 'uncertain' }
      : toolResultFailure(call.output) ? { ...call, status: 'failed' } : call) };
  if (input.calls.some((call) => call.status === 'started' || call.status === 'uncertain')) {
    return 'uncertain';
  }
  if (input.calls.some(blocksForInput)) return 'blocked';
  if (input.sdk === 'interrupted') return 'interrupted';
  if (input.sdk === 'failed') return 'failed';
  if (input.completionDecision) {
    const gateOutcomes: Record<NonNullable<RunFinalizationRecord['completionDecision']>, RunOutcome> = {
      pass: 'completed',
      continue: 'partial',
      blocked: 'blocked',
      uncertain: 'uncertain',
    };
    return gateOutcomes[input.completionDecision];
  }
  const failed = unresolvedFailures(input.calls);
  if (failed.length) {
    return input.calls.some((call) => call.status === 'succeeded') ? 'partial' : 'failed';
  }
  if (input.calls.some((call) => call.status === 'succeeded'
    && (isInteractionOnly(call.output) || isAcceptedOnly(call.output)))) return 'partial';
  return 'completed';
}

function collectEvidenceRefs(value: unknown, refs: Set<string>, depth = 0): void {
  if (depth > 5 || refs.size >= 100) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectEvidenceRefs(item, refs, depth + 1));
    return;
  }
  const record = objectValue(value);
  if (!record) return;
  if (typeof record.ref === 'string'
    && /^(?:action-intent|execution|artifact|test):/u.test(record.ref)) {
    refs.add(record.ref.slice(0, 500));
  }
  Object.values(record).forEach((item) => collectEvidenceRefs(item, refs, depth + 1));
}

export function runEvidenceRefs(calls: readonly ExecutionCallRecord[]): string[] {
  const refs = new Set<string>();
  calls.forEach((call) => collectEvidenceRefs(call.output, refs));
  return [...refs].sort();
}

export function constrainRunAnswer(input: {
  draft: string;
  outcome: RunOutcome;
  reason?: string;
  nextAction?: string;
  evidenceRefs?: readonly string[];
}): string {
  const draft = input.draft.trim().slice(0, 20_000);
  if (input.outcome === 'completed') return draft;
  const status = [
    `Host 终态：outcome=${input.outcome}；本轮不构成整体完成声明。`,
    input.reason ? `原因：${input.reason.trim().slice(0, 2_000)}` : '',
    input.nextAction ? `下一步：${input.nextAction.trim().slice(0, 2_000)}` : '',
    input.evidenceRefs?.length
      ? `证据引用：${input.evidenceRefs.slice(0, 20).join('、')}`
      : '',
    draft ? `模型草稿（仅作未验证的执行摘要）：\n${draft}` : '',
  ].filter(Boolean);
  return status.join('\n\n').slice(0, 20_000);
}

export function executionCompletionDecision(
  calls: readonly ExecutionCallRecord[],
): 'uncertain' | undefined {
  return calls.some((call) => call.status === 'uncertain' || call.status === 'started')
    ? 'uncertain'
    : undefined;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function outcomeDigest(call: ExecutionCallRecord): string | undefined {
  if (call.output !== undefined) return digest(JSON.stringify(call.output));
  if (call.error !== undefined) return digest(call.error);
  return undefined;
}

/**
 * Projects the side-effect ledger into a bounded, non-secret manifest.
 * The ledger remains the source of truth; receipts never copy raw arguments,
 * outputs, or errors into a second durable fact store.
 */
export function toolExecutionManifest(
  calls: readonly ExecutionCallRecord[],
): ToolExecutionManifestEntry[] {
  calls = calls.map((call) => call.status !== 'succeeded' ? call
    : toolResultUncertain(call.output) ? { ...call, status: 'uncertain' }
      : toolResultFailure(call.output) ? { ...call, status: 'failed' } : call);
  return calls.map((call, index) => ({
    runId: call.runId,
    toolName: call.toolName,
    callId: call.callId,
    ...(call.modelCallId ?? call.modelCallIds?.[0]
      ? { modelCallId: call.modelCallId ?? call.modelCallIds?.[0] }
      : {}),
    status: call.status !== 'succeeded' ? call.status
      : toolResultUncertain(call.output) ? 'uncertain' : toolResultFailure(call.output) ? 'failed' : 'succeeded',
    ...(recoveringCall(calls, index) ? { recoveredByCallId: recoveringCall(calls, index)!.callId } : {}),
    argumentsDigest: digest(call.argumentsJson),
    ...(outcomeDigest(call) ? { outcomeDigest: outcomeDigest(call) } : {}),
  }));
}

export function createRunFinalization(input: {
  runId: string;
  answer: string;
  outcome?: RunOutcome;
  reason?: string;
  nextAction?: string;
  evidenceRefs?: readonly string[];
  completionDecision?: RunFinalizationRecord['completionDecision'];
  calls: readonly ExecutionCallRecord[];
}): RunFinalizationRecord {
  const outcome = input.outcome ?? classifyRunOutcome({
    sdk: 'completed',
    calls: input.calls,
    completionDecision: input.completionDecision,
  });
  return runFinalizationRecordSchema.parse({
    runId: input.runId,
    answerDigest: digest(input.answer),
    outcome,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.nextAction ? { nextAction: input.nextAction } : {}),
    evidenceRefs: input.evidenceRefs ?? runEvidenceRefs(input.calls),
    artifacts: resultArtifacts(input.calls),
    ...(input.completionDecision ? { completionDecision: input.completionDecision } : {}),
    toolManifest: toolExecutionManifest(input.calls),
  });
}
