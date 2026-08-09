import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  createMediaEvidence,
  mediaEvidenceSchema,
  type MediaEvidence,
  type MediaEvidenceAnchor,
  type MediaTranscriptSegment,
  type MediaTimeRange,
} from './media-evidence.js';

const MAX_ASR_SEGMENTS = 128;
const MAX_ASR_RANGES = 128;
const MAX_ASR_TEXT_CHARACTERS = 64_000;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const boundedAuthorityIdSchema = z.string().trim().min(1).max(200);
const localAdapterIdSchema = z.string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/);
const localAdapterVersionSchema = z.string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,99}$/);

const finalAudioAsrSegmentSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  text: z.string().trim().min(1).max(4_000),
  confidence: z.number().min(0).max(1).optional(),
}).strict().refine((value) => value.endMs > value.startMs, {
  message: 'ASR segment endMs must be greater than startMs',
});

const finalAudioAsrRangeSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
}).strict().refine((value) => value.endMs > value.startMs, {
  message: 'ASR analyzed range endMs must be greater than startMs',
});

export const finalAudioAsrReceiptSchema = z.object({
  status: z.literal('final'),
  adapter: localAdapterIdSchema,
  version: localAdapterVersionSchema.optional(),
  inputSha256: sha256Schema,
  durationMs: z.number().int().positive(),
  truncated: z.boolean(),
  segments: z.array(finalAudioAsrSegmentSchema).max(MAX_ASR_SEGMENTS),
  analyzedRanges: z.array(finalAudioAsrRangeSchema).min(1).max(MAX_ASR_RANGES),
}).strict().superRefine((value, context) => {
  const textCharacters = value.segments.reduce((total, segment) => total + segment.text.length, 0);
  if (textCharacters > MAX_ASR_TEXT_CHARACTERS) {
    context.addIssue({
      code: 'custom',
      path: ['segments'],
      message: `ASR transcript exceeds ${MAX_ASR_TEXT_CHARACTERS} characters`,
    });
  }
});
export type FinalAudioAsrReceipt = z.infer<typeof finalAudioAsrReceiptSchema>;

const createDerivedAudioEvidenceInputSchema = z.object({
  parent: mediaEvidenceSchema,
  authoritativeDurationMs: z.number().int().positive(),
  occurredAt: z.string().datetime({ offset: true }),
  eventId: boundedAuthorityIdSchema.optional(),
  runId: boundedAuthorityIdSchema.optional(),
  receipt: finalAudioAsrReceiptSchema,
}).strict();
export type CreateDerivedAudioEvidenceInput = z.input<typeof createDerivedAudioEvidenceInputSchema>;

export interface DerivedAudioEvidenceResult {
  evidence: MediaEvidence;
  anchors: MediaEvidenceAnchor[];
}

function segmentOrder(
  left: FinalAudioAsrReceipt['segments'][number],
  right: FinalAudioAsrReceipt['segments'][number],
): number {
  return left.startMs - right.startMs
    || left.endMs - right.endMs
    || (left.text < right.text ? -1 : left.text > right.text ? 1 : 0)
    || (left.confidence ?? -1) - (right.confidence ?? -1);
}

function rangeOrder(
  left: FinalAudioAsrReceipt['analyzedRanges'][number],
  right: FinalAudioAsrReceipt['analyzedRanges'][number],
): number {
  return left.startMs - right.startMs || left.endMs - right.endMs;
}

function canonicalId(prefix: 'segment:asr-' | 'time-range:asr-', index: number): string {
  return `${prefix}${String(index + 1).padStart(4, '0')}`;
}

function receiptSourceId(
  parent: MediaEvidence,
  receipt: FinalAudioAsrReceipt,
  segments: readonly MediaTranscriptSegment[],
  ranges: readonly MediaTimeRange[],
): string {
  const digest = createHash('sha256').update(JSON.stringify({
    adapter: receipt.adapter,
    version: receipt.version,
    inputSha256: receipt.inputSha256,
    durationMs: receipt.durationMs,
    truncated: receipt.truncated,
    segments,
    ranges,
  })).digest('hex');
  return `audio-asr:${parent.id}:${digest}`;
}

function assertOriginalWavParent(parent: MediaEvidence, authoritativeDurationMs: number): void {
  if (parent.kind !== 'audio' || parent.mimeType !== 'audio/wav') {
    throw new Error('Derived audio Evidence requires an original WAV audio parent');
  }
  if (parent.modelBinding.status !== 'unprocessed'
    || parent.coverage.status !== 'metadata-only'
    || parent.sourceRef.parentEvidenceId) {
    throw new Error('Derived audio Evidence requires an unprocessed original parent');
  }
  if (parent.durationMs !== undefined && parent.durationMs !== authoritativeDurationMs) {
    throw new Error('Parent duration does not match authoritative duration');
  }
}

function continuousCoverageEnd(ranges: readonly MediaTimeRange[]): number {
  let coveredUntil = 0;
  for (const range of ranges) {
    if (range.startMs > coveredUntil) break;
    coveredUntil = Math.max(coveredUntil, range.endMs);
  }
  return coveredUntil;
}

function coversInterval(
  ranges: readonly MediaTimeRange[],
  startMs: number,
  endMs: number,
): boolean {
  let coveredUntil = startMs;
  for (const range of ranges) {
    if (range.endMs <= coveredUntil) continue;
    if (range.startMs > coveredUntil) return false;
    coveredUntil = Math.max(coveredUntil, range.endMs);
    if (coveredUntil >= endMs) return true;
  }
  return false;
}

export function canonicalAudioEvidenceAnchors(evidence: MediaEvidence): MediaEvidenceAnchor[] {
  if (evidence.kind !== 'audio'
    || evidence.modelBinding.status !== 'local'
    || (evidence.coverage.status !== 'full' && evidence.coverage.status !== 'partial')) {
    throw new Error('Canonical audio anchors require processed audio Evidence');
  }
  return [
    ...evidence.transcriptSegments.map((segment) => ({
      kind: 'segment' as const,
      segmentId: segment.id,
    })),
    ...evidence.timeRanges.map((range) => ({
      kind: 'time-range' as const,
      timeRangeId: range.id,
    })),
  ];
}

export function createDerivedAudioEvidence(
  input: CreateDerivedAudioEvidenceInput,
): DerivedAudioEvidenceResult {
  const parsed = createDerivedAudioEvidenceInputSchema.parse(input);
  const { parent, receipt, authoritativeDurationMs } = parsed;
  assertOriginalWavParent(parent, authoritativeDurationMs);
  if (receipt.inputSha256 !== parent.sha256) {
    throw new Error('ASR receipt input digest does not match parent audio');
  }
  if (receipt.durationMs !== authoritativeDurationMs) {
    throw new Error('ASR receipt duration does not match authoritative WAV duration');
  }

  const sortedRanges = [...receipt.analyzedRanges].sort(rangeOrder);
  for (const range of sortedRanges) {
    if (range.endMs > authoritativeDurationMs) {
      throw new Error('ASR analyzed range exceeds authoritative WAV duration');
    }
  }
  const timeRanges: MediaTimeRange[] = sortedRanges.map((range, index) => ({
    id: canonicalId('time-range:asr-', index),
    startMs: range.startMs,
    endMs: range.endMs,
  }));

  const sortedSegments = [...receipt.segments].sort(segmentOrder);
  const transcriptSegments: MediaTranscriptSegment[] = sortedSegments.map((segment, index) => {
    if (segment.endMs > authoritativeDurationMs) {
      throw new Error('ASR segment exceeds authoritative WAV duration');
    }
    const analyzed = coversInterval(timeRanges, segment.startMs, segment.endMs);
    if (!analyzed) {
      throw new Error('ASR segment is outside its analyzed range');
    }
    return {
      id: canonicalId('segment:asr-', index),
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      ...(segment.confidence !== undefined ? { confidence: segment.confidence } : {}),
    };
  });

  const fullyCovered = timeRanges[0]?.startMs === 0
    && continuousCoverageEnd(timeRanges) === authoritativeDurationMs;
  const partialReasons = [
    ...(receipt.truncated ? ['ASR receipt was truncated'] : []),
    ...(!fullyCovered ? ['analyzed ranges do not continuously cover authoritative WAV duration'] : []),
  ];
  const modalities = transcriptSegments.length
    ? ['audio', 'transcript'] as const
    : ['audio'] as const;
  const evidence = createMediaEvidence({
    schemaVersion: 1,
    mediaRef: parent.mediaRef,
    kind: parent.kind,
    mimeType: parent.mimeType,
    sha256: parent.sha256,
    bytes: parent.bytes,
    originalName: parent.originalName,
    sourceRef: {
      entry: 'derived-audio-slice',
      sourceId: receiptSourceId(parent, receipt, transcriptSegments, timeRanges),
      trust: parent.sourceRef.trust,
      profileId: parent.sourceRef.profileId,
      ...(parent.sourceRef.workspaceId ? { workspaceId: parent.sourceRef.workspaceId } : {}),
      ...(parent.sourceRef.sessionId ? { sessionId: parent.sourceRef.sessionId } : {}),
      ...(parsed.eventId ?? parent.sourceRef.eventId
        ? { eventId: parsed.eventId ?? parent.sourceRef.eventId }
        : {}),
      ...(parsed.runId ?? parent.sourceRef.runId
        ? { runId: parsed.runId ?? parent.sourceRef.runId }
        : {}),
      parentEvidenceId: parent.id,
    },
    occurredAt: parsed.occurredAt,
    durationMs: authoritativeDurationMs,
    transcriptSegments,
    keyframes: [],
    timeRanges,
    modelBinding: {
      status: 'local',
      adapter: receipt.adapter,
      ...(receipt.version ? { version: receipt.version } : {}),
    },
    derivedArtifactRefs: [],
    coverage: partialReasons.length
      ? {
          status: 'partial',
          modalities: [...modalities],
          reason: partialReasons.join('; '),
        }
      : { status: 'full', modalities: [...modalities] },
  });
  return { evidence, anchors: canonicalAudioEvidenceAnchors(evidence) };
}
