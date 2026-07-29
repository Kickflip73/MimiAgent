import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ExecutionCallRecord } from './execution-ledger.js';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const toolExecutionManifestEntrySchema = z.object({
  runId: z.string().min(1),
  toolName: z.string().min(1),
  callId: z.string().min(1),
  modelCallId: z.string().min(1).optional(),
  status: z.enum(['started', 'succeeded', 'failed', 'uncertain']),
  argumentsDigest: digestSchema,
  outcomeDigest: digestSchema.optional(),
}).strict();

export const runFinalizationRecordSchema = z.object({
  runId: z.string().min(1),
  answerDigest: digestSchema,
  completionDecision: z.enum(['pass', 'continue', 'blocked', 'uncertain']).optional(),
  toolManifest: z.array(toolExecutionManifestEntrySchema),
}).strict();

export type ToolExecutionManifestEntry = z.infer<typeof toolExecutionManifestEntrySchema>;
export type RunFinalizationRecord = z.infer<typeof runFinalizationRecordSchema>;

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
  return calls.map((call) => ({
    runId: call.runId,
    toolName: call.toolName,
    callId: call.callId,
    ...(call.modelCallId ?? call.modelCallIds?.[0]
      ? { modelCallId: call.modelCallId ?? call.modelCallIds?.[0] }
      : {}),
    status: call.status,
    argumentsDigest: digest(call.argumentsJson),
    ...(outcomeDigest(call) ? { outcomeDigest: outcomeDigest(call) } : {}),
  }));
}

export function createRunFinalization(input: {
  runId: string;
  answer: string;
  completionDecision?: RunFinalizationRecord['completionDecision'];
  calls: readonly ExecutionCallRecord[];
}): RunFinalizationRecord {
  return runFinalizationRecordSchema.parse({
    runId: input.runId,
    answerDigest: digest(input.answer),
    ...(input.completionDecision ? { completionDecision: input.completionDecision } : {}),
    toolManifest: toolExecutionManifest(input.calls),
  });
}
