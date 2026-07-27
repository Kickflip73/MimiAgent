import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AgentInputItem } from '@openai/agents';

const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export type AttachmentKind = 'image' | 'file';

export interface LocalAttachmentRequest {
  path: string;
  kind?: AttachmentKind;
}

export interface StagedAttachment {
  kind: AttachmentKind;
  name: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  path: string;
}

const IMAGE_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const FILE_TYPES: Record<string, string> = {
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
};

function inferredKind(file: string): AttachmentKind {
  return IMAGE_TYPES[path.extname(file).toLowerCase()] ? 'image' : 'file';
}

function mediaType(file: string, kind: AttachmentKind): string {
  const extension = path.extname(file).toLowerCase();
  return (kind === 'image' ? IMAGE_TYPES[extension] : FILE_TYPES[extension])
    ?? (kind === 'image' ? 'application/octet-stream' : 'application/octet-stream');
}

export function parseAttachmentInput(input: string): {
  text: string;
  attachments: LocalAttachmentRequest[];
} {
  const attachments: LocalAttachmentRequest[] = [];
  const text = input.replace(/(?:^|\s)@(image|file):(?:"([^"]+)"|'([^']+)'|(\S+))/gi,
    (match, kind: string, doubleQuoted: string, singleQuoted: string, plain: string) => {
      const requestedPath = doubleQuoted ?? singleQuoted ?? plain;
      attachments.push({ path: requestedPath, kind: kind.toLowerCase() as AttachmentKind });
      return match.startsWith(' ') ? ' ' : '';
    }).replace(/[ \t]{2,}/g, ' ').trim();
  return { text, attachments };
}

async function readBoundedRegularFile(file: string): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`附件必须是常规文件：${file}`);
    if (info.size > MAX_ATTACHMENT_BYTES) throw new Error(`附件超过 10MB：${file}`);
    const data = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < data.length) {
      const result = await handle.read(data, offset, data.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== data.length) throw new Error(`附件读取不完整：${file}`);
    return data;
  } finally {
    await handle.close();
  }
}

export async function stageAttachments(
  requests: readonly LocalAttachmentRequest[],
  workspaceRoot: string,
  attachmentRoot: string,
): Promise<StagedAttachment[]> {
  if (requests.length > MAX_ATTACHMENTS) throw new Error(`附件最多 ${MAX_ATTACHMENTS} 个`);
  if (!requests.length) return [];
  await mkdir(attachmentRoot, { recursive: true, mode: 0o700 });
  const root = path.resolve(workspaceRoot);
  const staged: StagedAttachment[] = [];
  let totalBytes = 0;
  for (const request of requests) {
    const source = path.resolve(root, request.path);
    const relative = path.relative(root, source);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`附件不能超出当前工作区：${request.path}`);
    }
    const data = await readBoundedRegularFile(source);
    totalBytes += data.byteLength;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('附件合计超过 20MB');
    const sha256 = createHash('sha256').update(data).digest('hex');
    const kind = request.kind ?? inferredKind(source);
    const destination = path.join(attachmentRoot, sha256);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, destination).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      await chmod(destination, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
    staged.push({
      kind,
      name: path.basename(source),
      mediaType: mediaType(source, kind),
      bytes: data.byteLength,
      sha256,
      path: destination,
    });
  }
  return staged;
}

export function attachmentPayload(value: unknown): StagedAttachment[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const attachments = (value as Record<string, unknown>).attachments;
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    if ((value.kind !== 'image' && value.kind !== 'file')
      || typeof value.name !== 'string'
      || typeof value.mediaType !== 'string'
      || typeof value.bytes !== 'number'
      || typeof value.sha256 !== 'string'
      || typeof value.path !== 'string') return [];
    return [value as unknown as StagedAttachment];
  });
}

export async function inputWithAttachments(
  text: string,
  attachments: readonly StagedAttachment[],
): Promise<string | AgentInputItem[]> {
  if (!attachments.length) return text;
  const content: Array<Record<string, unknown>> = [];
  if (text.trim()) content.push({ type: 'input_text', text });
  for (const attachment of attachments) {
    const info = await stat(attachment.path);
    if (!info.isFile() || info.size !== attachment.bytes) throw new Error(`附件快照已失效：${attachment.name}`);
    const data = await readFile(attachment.path);
    const digest = createHash('sha256').update(data).digest('hex');
    if (digest !== attachment.sha256) throw new Error(`附件摘要不匹配：${attachment.name}`);
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
