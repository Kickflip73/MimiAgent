import { createHash } from 'node:crypto';
import { z } from 'zod';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const mediaArtifactRefSchema = z.string()
  .regex(/^media-artifact:sha256:[a-f0-9]{64}$/);

export const mediaOriginalNameSchema = z.string().min(1).max(255)
  .refine((value) => value === value.trim(), {
    message: '媒体原始名称不能包含首尾空白',
  })
  .refine((value) => value !== '.' && value !== '..', {
    message: '媒体原始名称不能是 dot path',
  })
  .refine((value) => !/[\\/\u0000-\u001f\u007f]/u.test(value), {
    message: '媒体原始名称不能包含路径分隔符或控制字符',
  });

export const mediaKindSchema = z.enum(['image', 'audio', 'video']);
export type MediaKind = z.infer<typeof mediaKindSchema>;

export const mediaTrustSchema = z.enum(['owner', 'trusted', 'external', 'public', 'system']);
export type MediaTrust = z.infer<typeof mediaTrustSchema>;

export const mediaEvidenceSourceSchema = z.object({
  entry: z.enum([
    'local-attachment',
    'voice-session',
    'connector-event',
    'derived-audio-slice',
    'derived-video-keyframe',
    'derived-video-audio',
  ]),
  sourceId: z.string().trim().min(1).max(500),
  trust: mediaTrustSchema,
  profileId: z.string().trim().min(1).max(200),
  workspaceId: z.string().trim().min(1).max(200).optional(),
  sessionId: z.string().trim().min(1).max(200).optional(),
  eventId: z.string().trim().min(1).max(200).optional(),
  runId: z.string().trim().min(1).max(200).optional(),
  parentEvidenceId: z.string()
    .regex(/^media-evidence:sha256:[a-f0-9]{64}$/)
    .optional(),
}).strict();
export type MediaEvidenceSource = z.infer<typeof mediaEvidenceSourceSchema>;

export const mediaModelBindingSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unprocessed') }).strict(),
  z.object({
    status: z.literal('local'),
    adapter: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(100).optional(),
  }).strict(),
  z.object({
    status: z.literal('model'),
    providerId: z.string().trim().min(1).max(100),
    modelId: z.string().trim().min(1).max(200),
    scenario: z.string().trim().min(1).max(100),
    routeVersion: z.number().int().positive(),
    selectionReason: z.enum([
      'explicit-work-unit',
      'team-override',
      'session-preference',
      'scenario-route',
      'global-default',
      'safe-fallback',
    ]),
  }).strict(),
  z.object({
    status: z.literal('unsupported'),
    reason: z.string().trim().min(1).max(2_000),
  }).strict(),
]);
export type MediaModelBinding = z.infer<typeof mediaModelBindingSchema>;

export const mediaCoverageSchema = z.object({
  status: z.enum(['full', 'partial', 'metadata-only', 'unsupported']),
  modalities: z.array(z.enum(['image', 'audio', 'video', 'transcript', 'keyframes']))
    .max(5)
    .default([]),
  reason: z.string().trim().min(1).max(2_000).optional(),
}).strict();
export type MediaCoverage = z.infer<typeof mediaCoverageSchema>;

export const mediaTranscriptSegmentSchema = z.object({
  id: z.string().regex(/^segment:[a-zA-Z0-9._-]{1,100}$/),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  text: z.string().trim().min(1).max(4_000),
  speaker: z.string().trim().min(1).max(200).optional(),
  confidence: z.number().min(0).max(1).optional(),
}).strict().refine((value) => value.endMs > value.startMs, {
  message: '转写时间片 endMs 必须大于 startMs',
});
export type MediaTranscriptSegment = z.infer<typeof mediaTranscriptSegmentSchema>;

export const mediaKeyframeSchema = z.object({
  id: z.string().regex(/^keyframe:[a-zA-Z0-9._-]{1,100}$/),
  timestampMs: z.number().int().nonnegative(),
  mediaRef: mediaArtifactRefSchema,
  sha256: sha256Schema,
  mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/i).max(200),
  summary: z.string().trim().min(1).max(2_000).optional(),
}).strict().superRefine((value, context) => {
  if (!value.mediaRef.endsWith(value.sha256)) {
    context.addIssue({ code: 'custom', path: ['mediaRef'], message: '关键帧 ref 与 sha256 不一致' });
  }
});
export type MediaKeyframe = z.infer<typeof mediaKeyframeSchema>;

export const mediaTimeRangeSchema = z.object({
  id: z.string().regex(/^time-range:[a-zA-Z0-9._-]{1,100}$/),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  label: z.string().trim().min(1).max(500).optional(),
  summary: z.string().trim().min(1).max(2_000).optional(),
}).strict().refine((value) => value.endMs > value.startMs, {
  message: '媒体时间片 endMs 必须大于 startMs',
});
export type MediaTimeRange = z.infer<typeof mediaTimeRangeSchema>;

export const mediaEvidenceAnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('whole') }).strict(),
  z.object({ kind: z.literal('image'), imageOrdinal: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('segment'), segmentId: z.string().min(1).max(120) }).strict(),
  z.object({ kind: z.literal('keyframe'), keyframeId: z.string().min(1).max(120) }).strict(),
  z.object({ kind: z.literal('time-range'), timeRangeId: z.string().min(1).max(120) }).strict(),
]);
export type MediaEvidenceAnchor = z.infer<typeof mediaEvidenceAnchorSchema>;

function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(record[key])}`
  )).join(',')}}`;
}

function mediaEvidenceDigest(value: Record<string, unknown>): string {
  const { id: _id, ...content } = value;
  return createHash('sha256').update(`media-evidence-v1\0${canonical(content)}`).digest('hex');
}

const mediaEvidenceObjectSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^media-evidence:sha256:[a-f0-9]{64}$/),
  mediaRef: mediaArtifactRefSchema,
  kind: mediaKindSchema,
  mimeType: z.string().trim().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i).max(200),
  sha256: sha256Schema,
  bytes: z.number().int().positive(),
  originalName: mediaOriginalNameSchema,
  sourceRef: mediaEvidenceSourceSchema,
  occurredAt: z.string().datetime({ offset: true }),
  durationMs: z.number().int().positive().optional(),
  imageOrdinal: z.number().int().nonnegative().optional(),
  transcriptSegments: z.array(mediaTranscriptSegmentSchema).max(2_000).default([]),
  keyframes: z.array(mediaKeyframeSchema).max(1_000).default([]),
  timeRanges: z.array(mediaTimeRangeSchema).max(2_000).default([]),
  modelBinding: mediaModelBindingSchema,
  derivedArtifactRefs: z.array(mediaArtifactRefSchema).max(2_000).default([]),
  coverage: mediaCoverageSchema,
  summary: z.string().trim().min(1).max(8_000).optional(),
}).strict();

export const mediaEvidenceSchema = mediaEvidenceObjectSchema.superRefine((value, context) => {
  if (!value.mimeType.startsWith(`${value.kind}/`)) {
    context.addIssue({ code: 'custom', path: ['mimeType'], message: '媒体 kind 与 MIME 主类型不一致' });
  }
  if (!value.mediaRef.endsWith(value.sha256)) {
    context.addIssue({ code: 'custom', path: ['mediaRef'], message: 'mediaRef 与 sha256 不一致' });
  }
  const expectedId = `media-evidence:sha256:${mediaEvidenceDigest(value as unknown as Record<string, unknown>)}`;
  if (value.id !== expectedId) {
    context.addIssue({ code: 'custom', path: ['id'], message: 'MediaEvidence id 与内容摘要不一致' });
  }
  if ((value.kind === 'image') !== (value.imageOrdinal !== undefined)) {
    context.addIssue({ code: 'custom', path: ['imageOrdinal'], message: '只有图片 Evidence 必须包含稳定 imageOrdinal' });
  }
  if (value.kind === 'image' && (value.durationMs !== undefined
    || value.transcriptSegments.length || value.keyframes.length || value.timeRanges.length)) {
    context.addIssue({ code: 'custom', path: ['kind'], message: '图片 Evidence 不能携带音视频时间信息' });
  }
  if (value.kind !== 'video' && value.keyframes.length) {
    context.addIssue({ code: 'custom', path: ['keyframes'], message: '只有视频 Evidence 可以携带关键帧' });
  }
  const timed = [
    ...value.transcriptSegments.map((item) => ({ start: item.startMs, end: item.endMs, path: 'transcriptSegments' })),
    ...value.timeRanges.map((item) => ({ start: item.startMs, end: item.endMs, path: 'timeRanges' })),
    ...value.keyframes.map((item) => ({ start: item.timestampMs, end: item.timestampMs, path: 'keyframes' })),
  ];
  if (timed.length && value.durationMs === undefined) {
    context.addIssue({ code: 'custom', path: ['durationMs'], message: '带时间定位的 Evidence 必须包含 durationMs' });
  }
  for (const item of timed) {
    if (value.durationMs !== undefined && item.end > value.durationMs) {
      context.addIssue({ code: 'custom', path: [item.path], message: '媒体定位超出 durationMs' });
    }
  }
  const derived = new Set(value.derivedArtifactRefs);
  for (const frame of value.keyframes) {
    if (!derived.has(frame.mediaRef)) {
      context.addIssue({ code: 'custom', path: ['derivedArtifactRefs'], message: '关键帧必须列入 derivedArtifactRefs' });
    }
  }
  for (const [field, ids] of [
    ['transcriptSegments', value.transcriptSegments.map((item) => item.id)],
    ['keyframes', value.keyframes.map((item) => item.id)],
    ['timeRanges', value.timeRanges.map((item) => item.id)],
  ] as const) {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', path: [field], message: `${field} id 必须唯一` });
    }
  }
  if (value.modelBinding.status === 'unsupported' && value.coverage.status !== 'unsupported') {
    context.addIssue({ code: 'custom', path: ['coverage'], message: 'unsupported binding 必须对应 unsupported coverage' });
  }
  if (value.coverage.status === 'unsupported' && value.modelBinding.status !== 'unsupported') {
    context.addIssue({ code: 'custom', path: ['modelBinding'], message: 'unsupported coverage 必须记录 unsupported binding' });
  }
  if (value.modelBinding.status === 'unprocessed' && value.coverage.status !== 'metadata-only') {
    context.addIssue({ code: 'custom', path: ['coverage'], message: 'unprocessed binding 只能记录 metadata-only coverage' });
  }
  if (value.coverage.status !== 'full' && !value.coverage.reason) {
    context.addIssue({ code: 'custom', path: ['coverage', 'reason'], message: '非 full coverage 必须说明原因' });
  }
  const derivedContentCount = value.transcriptSegments.length
    + value.keyframes.length
    + value.timeRanges.length
    + value.derivedArtifactRefs.length;
  if ((value.coverage.status === 'metadata-only' || value.coverage.status === 'unsupported')
    && derivedContentCount > 0) {
    context.addIssue({
      code: 'custom',
      path: ['coverage'],
      message: 'metadata-only/unsupported Evidence 不能携带派生分析内容',
    });
  }
  if (value.kind !== 'image' && value.coverage.status === 'full') {
    if (value.durationMs === undefined) {
      context.addIssue({ code: 'custom', path: ['durationMs'], message: 'full 音视频 coverage 必须包含 durationMs' });
    } else {
      const ranges = [...value.timeRanges].sort((left, right) => left.startMs - right.startMs);
      let coveredUntil = 0;
      for (const range of ranges) {
        if (range.startMs > coveredUntil) break;
        coveredUntil = Math.max(coveredUntil, range.endMs);
      }
      if (!ranges.length || ranges[0]?.startMs !== 0 || coveredUntil < value.durationMs) {
        context.addIssue({
          code: 'custom',
          path: ['coverage'],
          message: 'full 音视频 coverage 必须用 timeRanges 连续覆盖 [0,durationMs]',
        });
      }
    }
  }
  if ((value.modelBinding.status === 'local' || value.modelBinding.status === 'model')
    && (value.coverage.status === 'metadata-only' || value.coverage.status === 'unsupported')) {
    context.addIssue({ code: 'custom', path: ['coverage'], message: '已处理 binding 必须记录 full 或 partial coverage' });
  }
  if (!value.coverage.modalities.includes(value.kind)) {
    context.addIssue({ code: 'custom', path: ['coverage', 'modalities'], message: 'coverage 必须包含原媒体 kind' });
  }
  if (value.transcriptSegments.length && !value.coverage.modalities.includes('transcript')) {
    context.addIssue({ code: 'custom', path: ['coverage', 'modalities'], message: '转写时间片必须声明 transcript coverage' });
  }
  if (value.keyframes.length && !value.coverage.modalities.includes('keyframes')) {
    context.addIssue({ code: 'custom', path: ['coverage', 'modalities'], message: '关键帧必须声明 keyframes coverage' });
  }
  if (value.kind !== 'image'
    && (value.modelBinding.status === 'local' || value.modelBinding.status === 'model')
    && !value.transcriptSegments.length && !value.keyframes.length && !value.timeRanges.length) {
    context.addIssue({ code: 'custom', message: '已处理音视频 Evidence 必须包含可定位的 segment/keyframe/timeRange' });
  }
  const derivedSource = value.sourceRef.entry.startsWith('derived-');
  if (derivedSource !== Boolean(value.sourceRef.parentEvidenceId)) {
    context.addIssue({
      code: 'custom',
      path: ['sourceRef', 'parentEvidenceId'],
      message: '派生媒体来源必须且只能声明 parentEvidenceId',
    });
  }
  const textCharacters = [
    value.summary ?? '',
    value.coverage.reason ?? '',
    ...value.transcriptSegments.flatMap((item) => [item.text, item.speaker ?? '']),
    ...value.keyframes.map((item) => item.summary ?? ''),
    ...value.timeRanges.flatMap((item) => [item.label ?? '', item.summary ?? '']),
  ].reduce((total, item) => total + item.length, 0);
  if (textCharacters > 512_000) {
    context.addIssue({ code: 'custom', message: 'MediaEvidence 文本总量超过 512000 字符' });
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (serializedBytes > 1024 * 1024) {
    context.addIssue({ code: 'custom', message: 'MediaEvidence 序列化后超过 1MiB' });
  }
});
export type MediaEvidence = z.infer<typeof mediaEvidenceSchema>;

export type MediaEvidenceContent = Omit<z.input<typeof mediaEvidenceObjectSchema>, 'id'>;

export function createMediaEvidence(
  input: MediaEvidenceContent,
): MediaEvidence {
  const content = mediaEvidenceObjectSchema.omit({ id: true }).parse(input);
  return mediaEvidenceSchema.parse({
    ...content,
    id: `media-evidence:sha256:${mediaEvidenceDigest(content as unknown as Record<string, unknown>)}`,
  });
}

export interface CreateOriginalMediaEvidenceInput {
  kind: MediaKind;
  sha256: string;
  mimeType: string;
  bytes: number;
  originalName: string;
  mediaRef: string;
  sourceRef: MediaEvidenceSource;
  occurredAt: string;
  imageOrdinal?: number;
  durationMs?: number;
}

export function createOriginalMediaEvidence(input: CreateOriginalMediaEvidenceInput): MediaEvidence {
  return createMediaEvidence({
    schemaVersion: 1,
    mediaRef: input.mediaRef,
    kind: input.kind,
    mimeType: input.mimeType,
    sha256: input.sha256,
    bytes: input.bytes,
    originalName: input.originalName,
    sourceRef: input.sourceRef,
    occurredAt: input.occurredAt,
    ...(input.durationMs ? { durationMs: input.durationMs } : {}),
    ...(input.kind === 'image' ? { imageOrdinal: input.imageOrdinal ?? 0 } : {}),
    transcriptSegments: [],
    keyframes: [],
    timeRanges: [],
    modelBinding: { status: 'unprocessed' },
    derivedArtifactRefs: [],
    coverage: {
      status: 'metadata-only',
      modalities: [input.kind],
      reason: input.kind === 'image'
        ? '原图已内容寻址，结论尚未生成'
        : '媒体已内容寻址，尚未生成时间片或关键帧分析',
    },
  });
}

export function resolveMediaEvidenceAnchor(
  evidence: MediaEvidence,
  requested?: MediaEvidenceAnchor,
): MediaEvidenceAnchor {
  const anchor = requested ?? (() => {
    if (evidence.kind === 'image') {
      return { kind: 'image' as const, imageOrdinal: evidence.imageOrdinal! };
    }
    if (evidence.coverage.status === 'metadata-only' || evidence.coverage.status === 'unsupported') {
      return { kind: 'whole' as const };
    }
    const candidates: MediaEvidenceAnchor[] = [
      ...evidence.transcriptSegments.map((item) => ({ kind: 'segment' as const, segmentId: item.id })),
      ...evidence.keyframes.map((item) => ({ kind: 'keyframe' as const, keyframeId: item.id })),
      ...evidence.timeRanges.map((item) => ({ kind: 'time-range' as const, timeRangeId: item.id })),
    ];
    if (candidates.length !== 1) {
      throw new Error(`MediaEvidence ${evidence.id} 有 ${candidates.length} 个定位点，必须显式选择 anchor`);
    }
    return candidates[0]!;
  })();
  mediaEvidenceAnchorSchema.parse(anchor);
  const valid = anchor.kind === 'whole'
    ? evidence.coverage.status === 'metadata-only' || evidence.coverage.status === 'unsupported'
    : anchor.kind === 'image'
      ? evidence.kind === 'image' && anchor.imageOrdinal === evidence.imageOrdinal
      : anchor.kind === 'segment'
        ? evidence.transcriptSegments.some((item) => item.id === anchor.segmentId)
        : anchor.kind === 'keyframe'
          ? evidence.keyframes.some((item) => item.id === anchor.keyframeId)
          : evidence.timeRanges.some((item) => item.id === anchor.timeRangeId);
  if (!valid) throw new Error(`MediaEvidence ${evidence.id} 不包含请求的 ${anchor.kind} anchor`);
  return anchor;
}

export function mediaEvidenceAnchorLabel(
  evidence: MediaEvidence,
  requested?: MediaEvidenceAnchor,
): string {
  const anchor = resolveMediaEvidenceAnchor(evidence, requested);
  if (anchor.kind === 'whole') return 'whole';
  if (anchor.kind === 'image') return `original-image#${anchor.imageOrdinal}`;
  if (anchor.kind === 'segment') return `segment#${anchor.segmentId}`;
  if (anchor.kind === 'keyframe') return `keyframe#${anchor.keyframeId}`;
  return `time-range#${anchor.timeRangeId}`;
}

export function renderMediaEvidenceReference(
  evidence: MediaEvidence,
  anchor?: MediaEvidenceAnchor,
): string {
  return [
    `[媒体引用 ${evidence.id}`,
    `kind=${evidence.kind}`,
    `anchor=${mediaEvidenceAnchorLabel(evidence, anchor)}`,
    `sha256=${evidence.sha256}]`,
  ].join(' ');
}
