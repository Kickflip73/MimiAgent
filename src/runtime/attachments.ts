import type { AgentInputItem } from '@openai/agents';
import {
  mediaEvidenceSchema,
  mediaOriginalNameSchema,
  renderMediaEvidenceReference,
} from '../core/media-evidence.js';
import {
  MAX_ATTACHMENTS,
  MAX_INLINE_ATTACHMENT_BYTES,
  MediaArtifactStore,
  type AttachmentKind,
  type LocalAttachmentRequest,
  type MediaArtifactStageBatch,
  type MediaEvidenceContext,
  type StagedAttachment,
} from './media-artifact-store.js';

const DURABLE_ATTACHMENT_KEYS = new Set([
  'artifactRef',
  'bytes',
  'evidence',
  'kind',
  'mediaType',
  'name',
  'sha256',
]);
const LEGACY_ATTACHMENT_KEYS = new Set([
  'bytes',
  'kind',
  'mediaType',
  'name',
  'path',
  'sha256',
]);
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/iu;

export type {
  AttachmentKind,
  LocalAttachmentRequest,
  MediaArtifactStageBatch,
  MediaEvidenceContext,
  StagedAttachment,
} from './media-artifact-store.js';

export function parseAttachmentInput(input: string): {
  text: string;
  attachments: LocalAttachmentRequest[];
} {
  const attachments: LocalAttachmentRequest[] = [];
  const text = input.replace(/(?:^|\s)@(image|file|audio|video):(?:"([^"]+)"|'([^']+)'|(\S+))/gi,
    (match, kind: string, doubleQuoted: string, singleQuoted: string, plain: string) => {
      const requestedPath = doubleQuoted ?? singleQuoted ?? plain;
      attachments.push({ path: requestedPath, kind: kind.toLowerCase() as AttachmentKind });
      return match.startsWith(' ') ? ' ' : '';
    }).replace(/[ \t]{2,}/g, ' ').trim();
  return { text, attachments };
}

export async function stageAttachments(
  requests: readonly LocalAttachmentRequest[],
  workspaceRoot: string,
  attachmentRoot: string,
  context: MediaEvidenceContext = {},
): Promise<StagedAttachment[]> {
  return new MediaArtifactStore(attachmentRoot).stage(requests, workspaceRoot, context);
}

export async function stageAttachmentBatch(
  requests: readonly LocalAttachmentRequest[],
  workspaceRoot: string,
  attachmentRoot: string,
  context: MediaEvidenceContext = {},
): Promise<MediaArtifactStageBatch> {
  return new MediaArtifactStore(attachmentRoot).stageBatch(requests, workspaceRoot, context);
}

export function validateLocalAttachmentSubmission(input: {
  source: string;
  trust: string;
  payload?: unknown;
  attachments?: unknown;
}): LocalAttachmentRequest[] | undefined {
  const payloadHasAttachments = input.payload !== null
    && typeof input.payload === 'object'
    && !Array.isArray(input.payload)
    && Object.prototype.hasOwnProperty.call(input.payload, 'attachments');
  if (payloadHasAttachments) {
    throw new Error('payload.attachments 是保留字段，附件必须经过受控 staging');
  }
  if (input.attachments === undefined) return undefined;
  if (!Array.isArray(input.attachments)) throw new Error('attachments 必须是数组');
  if (input.attachments.length > MAX_ATTACHMENTS) throw new Error(`附件最多 ${MAX_ATTACHMENTS} 个`);
  const attachments = input.attachments.map((item, index): LocalAttachmentRequest => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`本地附件 ${index} 结构无效`);
    }
    const value = item as Record<string, unknown>;
    if (!hasOnlyKeys(value, new Set(['kind', 'path']))
      || typeof value.path !== 'string'
      || !value.path.trim()
      || value.path.length > 4_096
      || /[\u0000\r\n]/u.test(value.path)
      || (value.kind !== undefined
        && value.kind !== 'image'
        && value.kind !== 'file'
        && value.kind !== 'audio'
        && value.kind !== 'video')) {
      throw new Error(`本地附件 ${index} 参数无效`);
    }
    return {
      path: value.path,
      ...(value.kind ? { kind: value.kind } : {}),
    } as LocalAttachmentRequest;
  });
  if (attachments.length && (input.source !== 'local-cli' || input.trust !== 'owner')) {
    throw new Error('只有 local-cli owner 输入可以提交本地附件');
  }
  if (attachments.length && input.payload !== undefined) {
    throw new Error('显式 payload 不能与本地附件同时提交');
  }
  return attachments;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function canonicalName(value: unknown): value is string {
  return mediaOriginalNameSchema.safeParse(value).success;
}

function canonicalMediaType(value: unknown, kind: AttachmentKind): value is string {
  if (typeof value !== 'string'
    || value !== value.trim()
    || value !== value.toLowerCase()
    || !MIME_TYPE_PATTERN.test(value)) return false;
  if (kind === 'image' && !value.startsWith('image/')) return false;
  if (kind === 'audio' && !value.startsWith('audio/')) return false;
  if (kind === 'video' && !value.startsWith('video/')) return false;
  if (kind === 'file' && /^(?:audio|image|video)\//u.test(value)) return false;
  return true;
}

function persistedAttachment(value: Record<string, unknown>): StagedAttachment | undefined {
  if ((value.kind !== 'image' && value.kind !== 'file'
      && value.kind !== 'audio' && value.kind !== 'video')
    || !hasOnlyKeys(value, DURABLE_ATTACHMENT_KEYS)
    || !canonicalName(value.name)
    || !canonicalMediaType(value.mediaType, value.kind)
    || typeof value.bytes !== 'number'
    || !Number.isSafeInteger(value.bytes)
    || value.bytes <= 0
    || typeof value.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.sha256)
    || typeof value.artifactRef !== 'string'
    || value.artifactRef !== `media-artifact:sha256:${value.sha256}`) return undefined;
  const evidence = value.evidence === undefined
    ? undefined
    : mediaEvidenceSchema.safeParse(value.evidence);
  if (evidence && !evidence.success) return undefined;
  if (value.kind !== 'file' && !evidence?.success) return undefined;
  if (evidence?.success && (
    evidence.data.kind !== value.kind
    || evidence.data.mediaRef !== value.artifactRef
    || evidence.data.sha256 !== value.sha256
    || evidence.data.mimeType !== value.mediaType
    || evidence.data.bytes !== value.bytes
    || evidence.data.originalName !== value.name
  )) return undefined;
  return {
    kind: value.kind,
    name: value.name,
    mediaType: value.mediaType,
    bytes: value.bytes,
    sha256: value.sha256,
    artifactRef: value.artifactRef,
    ...(evidence?.success ? { evidence: evidence.data } : {}),
  };
}

function legacyAttachment(value: Record<string, unknown>): StagedAttachment | undefined {
  if ((value.kind !== 'image' && value.kind !== 'file')
    || !hasOnlyKeys(value, LEGACY_ATTACHMENT_KEYS)
    || !canonicalName(value.name)
    || !canonicalMediaType(value.mediaType, value.kind)
    || typeof value.bytes !== 'number'
    || !Number.isSafeInteger(value.bytes)
    || value.bytes <= 0
    || typeof value.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.sha256)
    || typeof value.path !== 'string') return undefined;
  return {
    kind: value.kind,
    name: value.name,
    mediaType: value.mediaType,
    bytes: value.bytes,
    sha256: value.sha256,
    artifactRef: `media-artifact:sha256:${value.sha256}`,
    legacyPath: value.path,
  };
}

export function attachmentPayload(
  value: unknown,
  options: { allowLegacyPath?: boolean } = {},
): StagedAttachment[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const payload = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(payload, 'attachments')) return [];
  const attachments = payload.attachments;
  if (!Array.isArray(attachments)) {
    throw new Error('持久化 attachments 必须是数组，拒绝静默丢弃');
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error(`持久化附件最多 ${MAX_ATTACHMENTS} 个`);
  }
  return attachments.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`持久化附件 ${index} 结构无效，拒绝静默丢弃`);
    }
    const record = item as Record<string, unknown>;
    const parsed = persistedAttachment(record)
      ?? (options.allowLegacyPath ? legacyAttachment(record) : undefined);
    if (!parsed) throw new Error(`持久化附件 ${index} 元数据无效，拒绝静默丢弃`);
    return parsed;
  });
}

function mediaReference(attachment: StagedAttachment): string {
  if (attachment.evidence) return renderMediaEvidenceReference(attachment.evidence);
  return `[文件引用 ${attachment.artifactRef} sha256=${attachment.sha256} name=${attachment.name}]`;
}

export async function inputWithAttachments(
  text: string,
  attachments: readonly StagedAttachment[],
  attachmentRoot?: string,
): Promise<string | AgentInputItem[]> {
  if (!attachments.length) return text;
  if (attachments.length > MAX_ATTACHMENTS) throw new Error(`附件最多 ${MAX_ATTACHMENTS} 个`);
  const inlineBytes = attachments
    .filter((attachment) => attachment.kind === 'image' || attachment.kind === 'file')
    .reduce((total, attachment) => total + attachment.bytes, 0);
  if (inlineBytes > MAX_INLINE_ATTACHMENT_BYTES) {
    throw new Error('图片与普通文件附件合计超过 20MB，拒绝在模型边界分配 base64');
  }
  const unanalyzed = attachments.find((attachment) => (
    attachment.kind === 'audio'
    || attachment.kind === 'video'
    || attachment.mediaType.startsWith('audio/')
    || attachment.mediaType.startsWith('video/')
  ));
  if (unanalyzed) {
    throw new Error(
      `${unanalyzed.kind === 'audio' || unanalyzed.mediaType.startsWith('audio/') ? '音频' : '视频'}附件 ${unanalyzed.name}`
      + ' 必须先生成带时间片或关键帧的 MediaEvidence，不能作为普通文件冒充完整理解',
    );
  }
  if (!attachmentRoot) throw new Error('媒体 artifact root 未配置');
  const store = new MediaArtifactStore(attachmentRoot);
  const content: Array<Record<string, unknown>> = [];
  if (text.trim()) content.push({ type: 'input_text', text });
  for (const attachment of attachments) {
    content.push({ type: 'input_text', text: mediaReference(attachment) });
    const data = await store.read(attachment);
    const encoded = `data:${attachment.mediaType};base64,${data.toString('base64')}`;
    content.push(attachment.kind === 'image'
      ? { type: 'input_image', image: encoded, detail: 'auto' }
      : { type: 'input_file', file: encoded, filename: attachment.name });
  }
  return [{ role: 'user', content }] as AgentInputItem[];
}

export function inputText(input: string | AgentInputItem[]): string {
  if (typeof input === 'string') return input;
  return input.flatMap((item) => {
    if (!('role' in item) || item.role !== 'user' || !('content' in item)) return [];
    if (typeof item.content === 'string') return [item.content];
    return item.content.flatMap((part) => (
      'text' in part && typeof part.text === 'string' ? [part.text] : []
    ));
  }).join('\n');
}
