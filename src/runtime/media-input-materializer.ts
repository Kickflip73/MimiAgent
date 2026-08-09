import type { AgentInputItem } from '@openai/agents';
import {
  mediaEvidenceIdSchema,
  renderMediaEvidenceReference,
  type MediaEvidence,
  type MediaTrust,
} from '../core/media-evidence.js';
import type { FileSession } from '../core/session.js';
import {
  MAX_ATTACHMENTS,
  MAX_INLINE_ATTACHMENT_BYTES,
  type MediaArtifactStore,
  type StagedAttachment,
} from './media-artifact-store.js';

export interface MediaEvidenceReferenceAuthority {
  sessionId: string;
  profileId: string;
  workspaceId?: string;
  trust: MediaTrust;
}

export interface MaterializeMediaEvidenceReferencesInput {
  input: string | AgentInputItem[];
  evidenceIds: readonly string[];
  session: FileSession;
  artifacts: MediaArtifactStore;
  authority: MediaEvidenceReferenceAuthority;
}

export interface PreflightMediaEvidenceReferencesInput {
  attachments: readonly StagedAttachment[];
  evidenceIds: readonly string[];
  session: FileSession;
  authority: MediaEvidenceReferenceAuthority;
}

function evidenceAttachment(evidence: MediaEvidence): StagedAttachment {
  return {
    kind: evidence.kind,
    name: evidence.originalName,
    mediaType: evidence.mimeType,
    bytes: evidence.bytes,
    sha256: evidence.sha256,
    artifactRef: evidence.mediaRef,
    evidence,
  };
}

function assertEvidenceScope(
  evidence: MediaEvidence,
  authority: MediaEvidenceReferenceAuthority,
): void {
  if (evidence.sourceRef.sessionId !== authority.sessionId) {
    throw new Error(`MediaEvidence ${evidence.id} 不属于当前 Session`);
  }
  if (evidence.sourceRef.profileId !== authority.profileId) {
    throw new Error(`MediaEvidence ${evidence.id} profile 与当前 Run 不一致`);
  }
  if (evidence.sourceRef.workspaceId !== authority.workspaceId) {
    throw new Error(`MediaEvidence ${evidence.id} Workspace 与当前 Run 不一致`);
  }
  if (evidence.sourceRef.trust !== authority.trust) {
    throw new Error(`MediaEvidence ${evidence.id} trust 与当前 Run 不一致`);
  }
}

function assertEvidenceAuthority(
  evidence: MediaEvidence,
  authority: MediaEvidenceReferenceAuthority,
): void {
  assertEvidenceScope(evidence, authority);
  if (evidence.kind !== 'image') {
    throw new Error(`MediaEvidence ${evidence.id} 不是可注入模型的图片`);
  }
}

function validatedEvidenceIds(ids: readonly string[]): string[] {
  if (ids.length > MAX_ATTACHMENTS) {
    throw new Error(`MediaEvidence 引用最多 ${MAX_ATTACHMENTS} 个`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error('MediaEvidence 引用必须唯一');
  }
  return ids.map((id) => mediaEvidenceIdSchema.parse(id));
}

async function resolvedReferenceEvidence(
  session: FileSession,
  ids: readonly string[],
  authority: MediaEvidenceReferenceAuthority,
): Promise<MediaEvidence[]> {
  const sessionId = await session.getSessionId();
  if (sessionId !== authority.sessionId) {
    throw new Error(`MediaEvidence Session authority 不一致：${sessionId}`);
  }
  return Promise.all(ids.map(async (id) => {
    const found = await session.getMediaEvidence(id);
    if (!found) throw new Error(`当前 Session 不存在 MediaEvidence：${id}`);
    assertEvidenceAuthority(found, authority);
    return found;
  }));
}

function checkedByteTotal(items: readonly { bytes: number }[]): number {
  let total = 0;
  for (const item of items) {
    if (!Number.isSafeInteger(item.bytes) || item.bytes <= 0) {
      throw new Error('媒体元数据 bytes 必须是正安全整数');
    }
    total += item.bytes;
    if (!Number.isSafeInteger(total)) throw new Error('媒体元数据 bytes 合计超出安全整数');
  }
  return total;
}

/**
 * Validate the combined current-attachment/reference envelope using durable metadata only.
 * Callers must run this inside the selected Session actor before reading either CAS lane.
 */
export async function preflightMediaEvidenceReferences(
  input: PreflightMediaEvidenceReferencesInput,
): Promise<void> {
  const ids = validatedEvidenceIds(input.evidenceIds);
  if (input.attachments.length + ids.length > MAX_ATTACHMENTS) {
    throw new Error(`附件与 MediaEvidence 引用合计最多 ${MAX_ATTACHMENTS} 个`);
  }
  for (const attachment of input.attachments) {
    if (attachment.evidence) assertEvidenceScope(attachment.evidence, input.authority);
    if (attachment.kind === 'audio'
      || attachment.kind === 'video'
      || attachment.mediaType.startsWith('audio/')
      || attachment.mediaType.startsWith('video/')) {
      throw new Error(
        `${attachment.kind === 'audio' || attachment.mediaType.startsWith('audio/') ? '音频' : '视频'}附件 ${attachment.name}`
        + ' 必须先生成带时间片或关键帧的 MediaEvidence，不能作为普通文件冒充完整理解',
      );
    }
  }
  const evidence = await resolvedReferenceEvidence(input.session, ids, input.authority);
  const inlineAttachments = input.attachments.filter((attachment) => (
    attachment.kind === 'image' || attachment.kind === 'file'
  ));
  const inlineBytes = checkedByteTotal([...inlineAttachments, ...evidence]);
  if (inlineBytes > MAX_INLINE_ATTACHMENT_BYTES) {
    throw new Error('图片/文件附件与 MediaEvidence 引用合计超过 20MB，拒绝在模型边界分配 base64');
  }
}

function clonedInputWithUniqueUser(
  input: string | AgentInputItem[],
): { items: AgentInputItem[]; userIndex: number; content: unknown[] } {
  if (typeof input === 'string') {
    return {
      items: [{
        role: 'user',
        content: input.length ? [{ type: 'input_text', text: input }] : [],
      }] as AgentInputItem[],
      userIndex: 0,
      content: input.length ? [{ type: 'input_text', text: input }] : [],
    };
  }

  const items = structuredClone(input) as AgentInputItem[];
  const userIndexes = items.flatMap((item, index) => {
    const value = item as unknown as Record<string, unknown>;
    return value.role === 'user' ? [index] : [];
  });
  if (userIndexes.length !== 1) {
    throw new Error('结构化模型输入必须恰好包含一个当前 user 协议单元');
  }
  const userIndex = userIndexes[0]!;
  const user = items[userIndex] as unknown as Record<string, unknown>;
  const content = typeof user.content === 'string'
    ? [{ type: 'input_text', text: user.content }]
    : Array.isArray(user.content)
      ? [...user.content]
      : undefined;
  if (!content) throw new Error('当前 user 协议单元缺少有效 content');
  items[userIndex] = { ...user, content } as unknown as AgentInputItem;
  return { items, userIndex, content };
}

function decodedDataUrlBytes(value: unknown, kind: 'input_image' | 'input_file'): number {
  if (typeof value !== 'string') throw new Error(`${kind} 缺少 data URL`);
  const delimiter = ';base64,';
  const delimiterAt = value.indexOf(delimiter);
  if (!value.startsWith('data:') || delimiterAt <= 5) {
    throw new Error(`${kind} 必须使用 canonical base64 data URL`);
  }
  const mediaType = value.slice(5, delimiterAt);
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(mediaType)
    || mediaType !== mediaType.toLowerCase()
    || (kind === 'input_image' && !mediaType.startsWith('image/'))
    || (kind === 'input_file' && /^(?:audio|image|video)\//u.test(mediaType))) {
    throw new Error(`${kind} MIME 或 data URL 不规范`);
  }
  const payloadAt = delimiterAt + delimiter.length;
  const payloadLength = value.length - payloadAt;
  if (payloadLength <= 0 || payloadLength % 4 !== 0) {
    throw new Error(`${kind} base64 长度无效`);
  }
  let padding = 0;
  if (value.endsWith('==')) padding = 2;
  else if (value.endsWith('=')) padding = 1;
  const contentEnd = value.length - padding;
  for (let index = payloadAt; index < contentEnd; index += 1) {
    const code = value.charCodeAt(index);
    const valid = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if (!valid) throw new Error(`${kind} base64 内容无效`);
  }
  for (let index = contentEnd; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) throw new Error(`${kind} base64 padding 无效`);
  }
  const bytes = (payloadLength / 4) * 3 - padding;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`${kind} decoded bytes 无效`);
  }
  return bytes;
}

function existingInlineMedia(content: readonly unknown[]): { bytes: number; count: number } {
  let total = 0;
  let count = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
    const value = part as Record<string, unknown>;
    if (value.type === 'input_image') {
      total += decodedDataUrlBytes(value.image, 'input_image');
      count += 1;
    } else if (value.type === 'input_file') {
      total += decodedDataUrlBytes(value.file, 'input_file');
      count += 1;
    }
    if (!Number.isSafeInteger(total) || total > MAX_INLINE_ATTACHMENT_BYTES) {
      throw new Error('当前模型输入的 inline 媒体已经超过 20MB');
    }
  }
  return { bytes: total, count };
}

/**
 * Materialize durable image Evidence into transient Provider input. The returned data URLs
 * must never be written back to the canonical Session, Event, or execution ledger.
 */
export async function materializeMediaEvidenceReferences(
  input: MaterializeMediaEvidenceReferencesInput,
): Promise<string | AgentInputItem[]> {
  const ids = validatedEvidenceIds(input.evidenceIds);
  if (!ids.length) {
    return typeof input.input === 'string' ? input.input : structuredClone(input.input);
  }

  const target = clonedInputWithUniqueUser(input.input);
  const currentInline = existingInlineMedia(target.content);
  if (currentInline.count + ids.length > MAX_ATTACHMENTS) {
    throw new Error(`附件与 MediaEvidence 引用合计最多 ${MAX_ATTACHMENTS} 个`);
  }
  const evidence = await resolvedReferenceEvidence(input.session, ids, input.authority);
  const inlineBytes = evidence.reduce((total, item) => total + item.bytes, currentInline.bytes);
  if (inlineBytes > MAX_INLINE_ATTACHMENT_BYTES) {
    throw new Error('MediaEvidence 图片合计超过 20MB，拒绝在模型边界分配 base64');
  }

  const mediaContent: Array<Record<string, unknown>> = [];
  for (const item of evidence) {
    const bytes = await input.artifacts.read(evidenceAttachment(item));
    mediaContent.push(
      { type: 'input_text', text: renderMediaEvidenceReference(item) },
      {
        type: 'input_image',
        image: `data:${item.mimeType};base64,${bytes.toString('base64')}`,
        detail: 'auto',
      },
    );
  }
  const user = target.items[target.userIndex] as unknown as Record<string, unknown>;
  target.items[target.userIndex] = {
    ...user,
    content: [...target.content, ...mediaContent],
  } as unknown as AgentInputItem;
  return target.items;
}
