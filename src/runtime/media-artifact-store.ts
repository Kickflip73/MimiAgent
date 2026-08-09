import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { connect as connectSocket, createServer, type Server } from 'node:net';
import path from 'node:path';
import {
  createOriginalMediaEvidence,
  mediaArtifactRefSchema,
  mediaEvidenceSchema,
  mediaOriginalNameSchema,
  type MediaEvidence,
  type MediaTrust,
} from '../core/media-evidence.js';
import { parsePcm16Wav } from './pcm-wav.js';

export const MAX_ATTACHMENTS = 8;
const MAX_SMALL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_GENERATED_IMAGE_BYTES = MAX_SMALL_ATTACHMENT_BYTES;
const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export const MAX_INLINE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 500 * 1024 * 1024;
const COPY_BUFFER_BYTES = 64 * 1024;
const HEADER_BYTES = 64 * 1024;
const DEFAULT_STORE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_GC_GRACE_MS = 24 * 60 * 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const MAX_ISO_BMFF_BOXES = 4_096;
const MAX_ISO_BMFF_DEPTH = 8;

export type AttachmentKind = 'image' | 'file' | 'audio' | 'video';

export interface LocalAttachmentRequest {
  path: string;
  kind?: AttachmentKind;
}

export interface GeneratedImageArtifactInput {
  data: Uint8Array;
  mediaType: string;
  originalName: string;
}

export interface MediaEvidenceContext {
  profileId?: string;
  workspaceId?: string;
  sessionId?: string;
  eventId?: string;
  runId?: string;
  sourceId?: string;
  trust?: MediaTrust;
  occurredAt?: string;
}

export interface StagedAttachment {
  kind: AttachmentKind;
  name: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  artifactRef: string;
  evidence?: MediaEvidence;
  /** Read compatibility only. New persisted payloads never contain this field. */
  legacyPath?: string;
}

export interface MediaArtifactStageBatch {
  attachments: StagedAttachment[];
  commit(owner?: MediaArtifactOwner): Promise<void>;
  rollback(): Promise<void>;
}

export interface MediaArtifactOwner {
  kind: 'event' | 'session' | 'memory' | 'standalone';
  id: string;
}

export interface MediaArtifactOwnerLease {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface MediaArtifactStoreOptions {
  maxStoreBytes?: number;
  gcGraceMs?: number;
  lockTimeoutMs?: number;
  now?: () => Date;
}

export interface MediaArtifactGarbageCollectionResult {
  orphanEventOwners: number;
  unownedPreserved: number;
  staleClaims: number;
  staleStaging: number;
  tombstoned: number;
  deleted: number;
  reclaimedBytes: number;
}

export function mediaArtifactOwner(
  kind: MediaArtifactOwner['kind'],
  id: string,
): MediaArtifactOwner {
  if (!id.trim() || id.length > 512 || /[\u0000-\u001f\u007f]/u.test(id)) {
    throw new Error(`媒体 artifact ${kind} owner id 无效`);
  }
  return { kind, id };
}

export function sessionMediaArtifactOwner(sessionId: string): MediaArtifactOwner {
  return mediaArtifactOwner('session', sessionId);
}

const IMAGE_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const AUDIO_TYPES: Record<string, string> = {
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
};

const UNSUPPORTED_UNPARSED_EXTENSIONS = new Map<string, string>([
  ['.aac', 'AAC'],
  ['.flac', 'FLAC'],
  ['.mp3', 'MP3'],
  ['.ogg', 'Ogg'],
  ['.pdf', 'PDF'],
]);

const VIDEO_TYPES: Record<string, string> = {
  '.avi': 'video/x-msvideo',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const FILE_TYPES: Record<string, string> = {
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
};

function inferredKind(file: string): AttachmentKind {
  const extension = path.extname(file).toLowerCase();
  if (IMAGE_TYPES[extension]) return 'image';
  if (AUDIO_TYPES[extension]) return 'audio';
  if (VIDEO_TYPES[extension]) return 'video';
  return 'file';
}

function configuredMediaType(file: string, kind: AttachmentKind): string | undefined {
  const extension = path.extname(file).toLowerCase();
  if (kind === 'image') return IMAGE_TYPES[extension];
  if (kind === 'audio') return AUDIO_TYPES[extension];
  if (kind === 'video') return VIDEO_TYPES[extension];
  return FILE_TYPES[extension];
}

function mediaKindForType(mediaType: string): Exclude<AttachmentKind, 'file'> | undefined {
  if (mediaType.startsWith('image/')) return 'image';
  if (mediaType.startsWith('audio/')) return 'audio';
  if (mediaType.startsWith('video/')) return 'video';
  return undefined;
}

function canonicalGeneratedImageMediaType(value: string): string {
  if (typeof value !== 'string'
    || value.length > 200
    || !/^image\/[a-z0-9.+-]+$/u.test(value)) {
    throw new Error('生成图片 MIME 必须是规范的小写 image/* 类型');
  }
  if (value !== value.trim().toLowerCase()) {
    throw new Error('生成图片 MIME 必须使用规范小写形式');
  }
  return value;
}

function startsWith(header: Buffer, bytes: readonly number[]): boolean {
  return bytes.every((byte, index) => header[index] === byte);
}

function ascii(header: Buffer, start: number, length: number): string {
  return header.subarray(start, start + length).toString('ascii');
}

function sniffFixedMediaType(header: Buffer): string | undefined {
  if (startsWith(header, [137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (startsWith(header, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(header, 0, 6) === 'GIF87a' || ascii(header, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(header, 0, 4) === 'RIFF' && ascii(header, 8, 4) === 'WEBP') return 'image/webp';
  if (ascii(header, 0, 4) === 'RIFF' && ascii(header, 8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(header, 0, 4) === 'RIFF' && ascii(header, 8, 4) === 'AVI ') return 'video/x-msvideo';
  // EBML does not expose a trustworthy audio/video kind in its fixed header. Until a
  // bounded track parser exists, fail closed instead of trusting @audio/@video or suffixes.
  if (startsWith(header, [0x1a, 0x45, 0xdf, 0xa3])) return undefined;
  return undefined;
}

function unsupportedUnparsedFormat(header: Buffer, file: string): string | undefined {
  const extension = path.extname(file).toLowerCase();
  const unsupportedExtension = UNSUPPORTED_UNPARSED_EXTENSIONS.get(extension);
  if (unsupportedExtension) return unsupportedExtension;
  if (ascii(header, 0, 4) === 'OggS') return 'Ogg';
  if (startsWith(header, [0xff, 0xf1]) || startsWith(header, [0xff, 0xf9])) return 'AAC';
  if (ascii(header, 0, 3) === 'ID3' || startsWith(header, [0xff, 0xfb])) return 'MP3';
  if (ascii(header, 0, 4) === 'fLaC') return 'FLAC';
  if (startsWith(header, [0x1a, 0x45, 0xdf, 0xa3])) return 'EBML';
  if (ascii(header, 0, 5) === '%PDF-') return 'PDF';
  return undefined;
}

interface IsoBmffBox {
  type: string;
  start: number;
  end: number;
  payloadStart: number;
}

async function readExactly(
  handle: FileHandle,
  position: number,
  length: number,
): Promise<Buffer | undefined> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = await handle.read(buffer, offset, length - offset, position + offset);
    if (read.bytesRead === 0) return undefined;
    offset += read.bytesRead;
  }
  return buffer;
}

async function readIsoBmffBox(
  handle: FileHandle,
  start: number,
  parentEnd: number,
): Promise<IsoBmffBox | undefined> {
  if (start + 8 > parentEnd) return undefined;
  const header = await readExactly(handle, start, 8);
  if (!header) return undefined;
  const size32 = header.readUInt32BE(0);
  const type = ascii(header, 4, 4);
  let headerBytes = 8;
  let size: number;
  if (size32 === 1) {
    const extended = await readExactly(handle, start + 8, 8);
    if (!extended) return undefined;
    const size64 = extended.readBigUInt64BE(0);
    if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    size = Number(size64);
    headerBytes = 16;
  } else if (size32 === 0) {
    size = parentEnd - start;
  } else {
    size = size32;
  }
  if (size < headerBytes || start + size > parentEnd) return undefined;
  return { type, start, end: start + size, payloadStart: start + headerBytes };
}

async function isoBmffMediaKind(
  file: string,
  bytes: number,
): Promise<'audio' | 'video' | undefined> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let boxes = 0;
  let hasAudio = false;
  let hasVideo = false;
  const walk = async (
    start: number,
    end: number,
    depth: number,
    insideMedia: boolean,
  ): Promise<boolean> => {
    if (depth > MAX_ISO_BMFF_DEPTH) return false;
    let offset = start;
    while (offset < end) {
      boxes += 1;
      if (boxes > MAX_ISO_BMFF_BOXES) return false;
      const box = await readIsoBmffBox(handle, offset, end);
      if (!box || box.end <= offset) return false;
      if (box.type === 'hdlr' && insideMedia) {
        if (box.end - box.payloadStart < 20) return false;
        const handler = await readExactly(handle, box.payloadStart + 8, 4);
        if (!handler) return false;
        if (ascii(handler, 0, 4) === 'soun') hasAudio = true;
        if (ascii(handler, 0, 4) === 'vide') hasVideo = true;
      } else if (box.type === 'moov' || box.type === 'trak' || box.type === 'mdia') {
        if (!await walk(
          box.payloadStart,
          box.end,
          depth + 1,
          insideMedia || box.type === 'mdia',
        )) return false;
      }
      offset = box.end;
    }
    return offset === end;
  };
  try {
    const first = await readIsoBmffBox(handle, 0, bytes);
    // `ftyp` is a real box, not a magic substring. Require the fixed brand/version
    // payload before seeking through top-level boxes to a possibly tail-located moov.
    if (!first || first.type !== 'ftyp' || first.end - first.payloadStart < 8) return undefined;
    if (!await walk(first.end, bytes, 0, false)) return undefined;
    return hasVideo ? 'video' : hasAudio ? 'audio' : undefined;
  } finally {
    await handle.close();
  }
}

async function detectedMediaType(
  header: Buffer,
  artifactFile: string,
  bytes: number,
  originalFile: string,
): Promise<string | undefined> {
  const fixed = sniffFixedMediaType(header);
  if (fixed) return fixed;
  if (ascii(header, 4, 4) !== 'ftyp') return undefined;
  const detectedKind = await isoBmffMediaKind(artifactFile, bytes);
  if (detectedKind === 'audio') return 'audio/mp4';
  if (detectedKind === 'video') {
    return path.extname(originalFile).toLowerCase() === '.mov' ? 'video/quicktime' : 'video/mp4';
  }
  return undefined;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validPng(data: Buffer): boolean {
  if (!startsWith(data, [137, 80, 78, 71, 13, 10, 26, 10])) return false;
  let offset = 8;
  let chunks = 0;
  let sawHeader = false;
  let sawData = false;
  while (offset + 12 <= data.length && chunks < 4_096) {
    const length = data.readUInt32BE(offset);
    const typeStart = offset + 4;
    const payloadStart = offset + 8;
    const crcOffset = payloadStart + length;
    const end = crcOffset + 4;
    if (end > data.length) return false;
    const type = ascii(data, typeStart, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (crc32(data.subarray(typeStart, crcOffset)) !== data.readUInt32BE(crcOffset)) return false;
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) return false;
      const width = data.readUInt32BE(payloadStart);
      const height = data.readUInt32BE(payloadStart + 4);
      const bitDepth = data[payloadStart + 8]!;
      const colorType = data[payloadStart + 9]!;
      const validDepths = colorType === 0 ? [1, 2, 4, 8, 16]
        : colorType === 2 ? [8, 16]
          : colorType === 3 ? [1, 2, 4, 8]
            : colorType === 4 || colorType === 6 ? [8, 16]
              : [];
      if (width === 0 || height === 0
        || !validDepths.includes(bitDepth)
        || data[payloadStart + 10] !== 0
        || data[payloadStart + 11] !== 0
        || (data[payloadStart + 12] !== 0 && data[payloadStart + 12] !== 1)) return false;
      sawHeader = true;
    }
    else if (type === 'IHDR') return false;
    if (type === 'IDAT') {
      if (length === 0) return false;
      sawData = true;
    }
    if (type === 'IEND') return sawData && length === 0 && end === data.length;
    offset = end;
    chunks += 1;
  }
  return false;
}

function validJpeg(data: Buffer): boolean {
  if (!startsWith(data, [0xff, 0xd8]) || data.length < 6) return false;
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  let inScan = false;
  while (offset < data.length) {
    if (inScan && data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    if (data[offset] !== 0xff) return false;
    while (data[offset] === 0xff) offset += 1;
    const marker = data[offset++];
    if (marker === undefined) return false;
    if (inScan && marker === 0x00) continue;
    if (marker === 0xd9) return sawFrame && sawScan && offset === data.length;
    if (marker === 0x00) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) return false;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return false;
    if ((marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf)) {
      if (length < 8) return false;
      sawFrame = true;
    }
    if (marker === 0xda) {
      if (length < 6) return false;
      sawScan = true;
      inScan = true;
    } else {
      inScan = false;
    }
    offset += length;
  }
  return false;
}

function skipGifSubBlocks(data: Buffer, start: number): number | undefined {
  let offset = start;
  while (offset < data.length) {
    const length = data[offset++];
    if (length === undefined) return undefined;
    if (length === 0) return offset;
    if (offset + length > data.length) return undefined;
    offset += length;
  }
  return undefined;
}

function validGif(data: Buffer): boolean {
  if (data.length < 14
    || (ascii(data, 0, 6) !== 'GIF87a' && ascii(data, 0, 6) !== 'GIF89a')) return false;
  let offset = 13;
  if ((data[10]! & 0x80) !== 0) offset += 3 * (2 ** ((data[10]! & 0x07) + 1));
  let sawImage = false;
  while (offset < data.length) {
    const introducer = data[offset++];
    if (introducer === 0x3b) return sawImage && offset === data.length;
    if (introducer === 0x21) {
      if (offset >= data.length) return false;
      offset += 1;
      const next = skipGifSubBlocks(data, offset);
      if (next === undefined) return false;
      offset = next;
      continue;
    }
    if (introducer !== 0x2c || offset + 9 > data.length) return false;
    const packed = data[offset + 8]!;
    offset += 9;
    if ((packed & 0x80) !== 0) offset += 3 * (2 ** ((packed & 0x07) + 1));
    if (offset >= data.length) return false;
    offset += 1; // LZW minimum code size.
    const next = skipGifSubBlocks(data, offset);
    if (next === undefined) return false;
    offset = next;
    sawImage = true;
  }
  return false;
}

async function validRiffContainer(
  file: string,
  bytes: number,
  form: 'WEBP' | 'AVI ',
): Promise<boolean> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = await readExactly(handle, 0, 12);
    if (!header
      || ascii(header, 0, 4) !== 'RIFF'
      || ascii(header, 8, 4) !== form
      || header.readUInt32LE(4) + 8 !== bytes) return false;
    let offset = 12;
    let sawWebpPayload = false;
    let boxes = 0;
    while (offset < bytes && boxes < 4_096) {
      const chunk = await readExactly(handle, offset, 8);
      if (!chunk) return false;
      const type = ascii(chunk, 0, 4);
      const length = chunk.readUInt32LE(4);
      const end = offset + 8 + length;
      if (end > bytes) return false;
      if (type === 'VP8 ' || type === 'VP8L' || type === 'VP8X') sawWebpPayload = true;
      offset = end + (length % 2);
      boxes += 1;
    }
    if (offset !== bytes) return false;
    if (form === 'WEBP') return sawWebpPayload;
    return boxes > 0;
  } finally {
    await handle.close();
  }
}

async function validPcm16Wav(file: string, bytes: number): Promise<boolean> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await parsePcm16Wav(handle, bytes);
    return true;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

async function validateDetectedContainer(
  file: string,
  mediaType: string,
  bytes: number,
): Promise<boolean> {
  if (mediaType === 'audio/wav') return validPcm16Wav(file, bytes);
  if (mediaType === 'image/webp') return validRiffContainer(file, bytes, 'WEBP');
  if (mediaType === 'video/x-msvideo') return validRiffContainer(file, bytes, 'AVI ');
  if (mediaType !== 'image/png'
    && mediaType !== 'image/jpeg'
    && mediaType !== 'image/gif') return true;
  // These kinds already have a 10MiB per-file cap, so full structural validation remains bounded.
  const data = await readFile(file);
  if (data.length !== bytes) return false;
  if (mediaType === 'image/png') return validPng(data);
  if (mediaType === 'image/jpeg') return validJpeg(data);
  return validGif(data);
}

async function validatedConfiguredFileType(
  file: string,
  configuredType: string | undefined,
): Promise<string> {
  if (!configuredType) return 'application/octet-stream';
  const textual = configuredType.startsWith('text/') || configuredType === 'application/xml'
    || configuredType === 'application/json';
  if (!textual) return 'application/octet-stream';
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const parts: string[] = [];
    let offset = 0;
    while (offset < info.size) {
      const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, info.size - offset));
      const result = await handle.read(buffer, 0, buffer.length, offset);
      if (result.bytesRead === 0) return 'application/octet-stream';
      const text = decoder.decode(buffer.subarray(0, result.bytesRead), { stream: true });
      if (text.includes('\0')) return 'application/octet-stream';
      parts.push(text);
      offset += result.bytesRead;
    }
    const tail = decoder.decode();
    if (tail.includes('\0')) return 'application/octet-stream';
    parts.push(tail);
    if (configuredType === 'application/json') {
      try {
        JSON.parse(parts.join(''));
      } catch {
        return 'application/octet-stream';
      }
    }
    return configuredType;
  } catch (error) {
    if (error instanceof TypeError) return 'application/octet-stream';
    throw error;
  } finally {
    await handle.close();
  }
}

function maximumBytes(kind: AttachmentKind): number {
  if (kind === 'audio') return MAX_AUDIO_BYTES;
  if (kind === 'video') return MAX_VIDEO_BYTES;
  return MAX_SMALL_ATTACHMENT_BYTES;
}

function artifactSha256(ref: string): string {
  mediaArtifactRefSchema.parse(ref);
  return ref.slice('media-artifact:sha256:'.length);
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function exactWorkspaceFile(workspaceRoot: string, requestedPath: string): Promise<string> {
  const lexicalRoot = path.resolve(workspaceRoot);
  const lexicalSource = path.resolve(lexicalRoot, requestedPath);
  if (!contained(lexicalRoot, lexicalSource)) {
    throw new Error(`附件不能超出当前工作区：${requestedPath}`);
  }
  const physicalRoot = await realpath(lexicalRoot);
  const physicalSource = await realpath(lexicalSource);
  const expectedPhysical = path.resolve(physicalRoot, path.relative(lexicalRoot, lexicalSource));
  if (!contained(physicalRoot, physicalSource)) {
    throw new Error(`附件不能通过符号链接超出当前工作区：${requestedPath}`);
  }
  if (physicalSource !== expectedPhysical) {
    throw new Error(`附件路径不能包含符号链接：${requestedPath}`);
  }
  return physicalSource;
}

interface CopiedArtifact {
  bytes: number;
  sha256: string;
  header: Buffer;
}

async function copyBoundedRegularFile(
  source: string,
  temporary: string,
  maximum: number,
): Promise<CopiedArtifact> {
  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let temporaryHandle;
  try {
    const info = await sourceHandle.stat();
    if (!info.isFile()) throw new Error(`附件必须是常规文件：${source}`);
    if (info.size <= 0) throw new Error(`附件不能为空：${source}`);
    if (info.size > maximum) throw new Error(`附件超过 ${maximum} bytes：${source}`);
    temporaryHandle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    const hash = createHash('sha256');
    const header = Buffer.alloc(Math.min(HEADER_BYTES, info.size));
    let offset = 0;
    while (offset < info.size) {
      const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, info.size - offset));
      const read = await sourceHandle.read(buffer, 0, buffer.length, offset);
      if (read.bytesRead === 0) break;
      const chunk = buffer.subarray(0, read.bytesRead);
      hash.update(chunk);
      if (offset < header.length) chunk.copy(header, offset, 0, Math.min(chunk.length, header.length - offset));
      let written = 0;
      while (written < chunk.length) {
        const result = await temporaryHandle.write(chunk, written, chunk.length - written, null);
        if (result.bytesWritten === 0) throw new Error(`附件写入不完整：${source}`);
        written += result.bytesWritten;
      }
      offset += read.bytesRead;
    }
    if (offset !== info.size) throw new Error(`附件读取不完整：${source}`);
    await temporaryHandle.sync();
    return { bytes: offset, sha256: hash.digest('hex'), header };
  } finally {
    await temporaryHandle?.close();
    await sourceHandle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function hasMarker(markerRoot: string, sha256: string): Promise<boolean> {
  let directories;
  try {
    directories = await readdir(markerRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    if (await pathExists(path.join(markerRoot, directory.name, sha256))) return true;
  }
  return false;
}

function referenceKey(rawOwner: MediaArtifactOwner): string {
  const owner = mediaArtifactOwner(rawOwner.kind, rawOwner.id);
  return `${owner.kind}-${createHash('sha256')
    .update(owner.kind)
    .update('\0')
    .update(owner.id)
    .digest('hex')}`;
}

function isSha256Name(name: string): boolean {
  return /^[a-f0-9]{64}$/.test(name);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startLockWitness(token: string): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    // A probe may time out and reset its socket while this owner's event loop is busy.
    // The accepted socket is only a liveness witness; that reset must never crash the
    // lock owner and thereby turn a live critical section into a recoverable lock.
    socket.on('error', () => undefined);
    socket.end(token);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('媒体 artifact lock witness 未获得 loopback 端口');
  }
  return { server, port: address.port };
}

type LockWitnessState = 'alive' | 'dead' | 'unknown';

function lockWitnessState(port: number, token: string): Promise<LockWitnessState> {
  return new Promise((resolve) => {
    let value = '';
    let settled = false;
    let connected = false;
    const socket = connectSocket({ host: '127.0.0.1', port });
    const finish = (result: LockWitnessState) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    // Once TCP connects, a delayed token can mean the live owner event loop is busy.
    // Treat that state as live/fail-safe; only an explicit connection failure or a
    // complete mismatching response proves this witness no longer owns the lock.
    const timer = setTimeout(() => finish(connected ? 'alive' : 'unknown'), 250);
    socket.setEncoding('utf8');
    socket.on('connect', () => { connected = true; });
    socket.on('data', (chunk: string) => { value += chunk; });
    socket.on('end', () => finish(value === token ? 'alive' : 'dead'));
    socket.on('error', () => finish(connected ? 'alive' : 'dead'));
  });
}

async function hashOpenFile(handle: FileHandle, bytes: number): Promise<string> {
  const hash = createHash('sha256');
  let offset = 0;
  while (offset < bytes) {
    const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, bytes - offset));
    const result = await handle.read(buffer, 0, buffer.length, offset);
    if (result.bytesRead === 0) break;
    hash.update(buffer.subarray(0, result.bytesRead));
    offset += result.bytesRead;
  }
  if (offset !== bytes) throw new Error('媒体 artifact 读取不完整');
  return hash.digest('hex');
}

async function writeDurableMarker(file: string): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.sync();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await existing.stat();
      if (!info.isFile()) throw new Error(`媒体 artifact marker 不是常规文件：${file}`);
    } finally {
      await existing.close();
    }
    return false;
  } finally {
    await handle?.close();
  }
}

async function writeTimestampMarker(file: string, timestamp: number): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(String(timestamp));
    await handle.sync();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  } finally {
    await handle?.close();
  }
}

async function writeOwnerMarker(
  referenceDirectory: string,
  sha256: string,
  token: string,
): Promise<boolean> {
  const shaDirectory = path.join(referenceDirectory, sha256);
  try {
    await mkdir(shaDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const info = await lstat(shaDirectory);
    // Legacy v1 refs used one empty file per sha. It is already a stable owner marker.
    if (info.isFile()) return false;
    if (!info.isDirectory()) throw new Error(`媒体 artifact owner marker 类型无效：${sha256}`);
  }
  const created = await writeDurableMarker(path.join(shaDirectory, token));
  await syncDirectory(shaDirectory);
  return created;
}

async function removeOwnerToken(
  referenceDirectory: string,
  sha256: string,
  token: string,
): Promise<void> {
  const shaDirectory = path.join(referenceDirectory, sha256);
  let info;
  try {
    info = await lstat(shaDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!info.isDirectory()) return;
  await rm(path.join(shaDirectory, token), { force: true });
  if (!(await readdir(shaDirectory)).length) await rm(shaDirectory, { recursive: true, force: true });
}

function evidenceArtifactRefs(evidenceItems: readonly MediaEvidence[]): Map<string, MediaEvidence | undefined> {
  const refs = new Map<string, MediaEvidence | undefined>();
  for (const raw of evidenceItems) {
    const evidence = mediaEvidenceSchema.parse(raw);
    refs.set(evidence.mediaRef, evidence);
    for (const ref of evidence.derivedArtifactRefs) refs.set(ref, undefined);
    for (const frame of evidence.keyframes) refs.set(frame.mediaRef, undefined);
  }
  return refs;
}

interface PreparedAttachment {
  temporary: string;
  destination: string;
  attachment: StagedAttachment;
}

export class MediaArtifactStore {
  private readonly maxStoreBytes: number;
  private readonly gcGraceMs: number;
  private readonly lockTimeoutMs: number;
  private readonly clock: () => Date;

  constructor(
    readonly root: string,
    options: MediaArtifactStoreOptions = {},
  ) {
    this.maxStoreBytes = options.maxStoreBytes ?? DEFAULT_STORE_QUOTA_BYTES;
    this.gcGraceMs = options.gcGraceMs ?? DEFAULT_GC_GRACE_MS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.clock = options.now ?? (() => new Date());
    for (const [name, value] of [
      ['maxStoreBytes', this.maxStoreBytes],
      ['gcGraceMs', this.gcGraceMs],
      ['lockTimeoutMs', this.lockTimeoutMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0 || (name !== 'gcGraceMs' && value === 0)) {
        throw new Error(`媒体 artifact ${name} 必须为有效非负安全整数`);
      }
    }
  }

  private get claimsRoot(): string { return path.join(this.root, '.claims'); }
  private get referencesRoot(): string { return path.join(this.root, '.refs'); }
  private get garbageRoot(): string { return path.join(this.root, '.gc'); }
  private get ownerGarbageRoot(): string { return path.join(this.root, '.owner-gc'); }

  private async ensureLayout(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await Promise.all([
      mkdir(this.claimsRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.referencesRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.garbageRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.ownerGarbageRoot, { recursive: true, mode: 0o700 }),
    ]);
    await syncDirectory(this.root);
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureLayout();
    const lockPath = path.join(this.root, '.mutation.lock');
    const reapPath = path.join(this.root, '.mutation.reap');
    const token = randomUUID();
    const witness = await startLockWitness(token);
    const deadline = Date.now() + this.lockTimeoutMs;
    let acquired = false;
    try {
      while (true) {
        let handle: FileHandle | undefined;
        try {
          if (await pathExists(reapPath)) {
            let reapedOwner: { token?: unknown; witnessPort?: unknown } | undefined;
            try {
              reapedOwner = JSON.parse(await readFile(reapPath, 'utf8')) as typeof reapedOwner;
            } catch {
              // A malformed reaped lock cannot authorize an operation.
            }
            const reapedState = typeof reapedOwner?.token === 'string'
              && typeof reapedOwner.witnessPort === 'number'
              ? await lockWitnessState(reapedOwner.witnessPort, reapedOwner.token)
              : 'dead';
            if (reapedState === 'dead') {
              await rm(reapPath, { force: true });
              await syncDirectory(this.root);
              continue;
            }
            throw Object.assign(new Error('媒体 artifact lock 正在安全回收'), { code: 'EEXIST' });
          }
          handle = await open(
            lockPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            0o600,
          );
          await handle.writeFile(JSON.stringify({
            pid: process.pid,
            token,
            witnessPort: witness.port,
            createdAt: Date.now(),
          }));
          await handle.sync();
          await handle.close();
          handle = undefined;
          await syncDirectory(this.root);
          if (await pathExists(reapPath)) {
            const current = JSON.parse(await readFile(lockPath, 'utf8')) as { token?: unknown };
            if (current.token === token) {
              await rm(lockPath, { force: true });
              await syncDirectory(this.root);
            }
            throw Object.assign(new Error('媒体 artifact lock 回收门仍生效'), { code: 'EEXIST' });
          }
          acquired = true;
          break;
        } catch (error) {
          await handle?.close();
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (await pathExists(reapPath)) {
            if (Date.now() >= deadline) throw new Error('媒体 artifact mutation lock 获取超时');
            await sleep(25);
            continue;
          }
          let owner: { token?: unknown; witnessPort?: unknown } | undefined;
          try {
            owner = JSON.parse(await readFile(lockPath, 'utf8')) as typeof owner;
          } catch (readError) {
            if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          }
          const ownerState = typeof owner?.token === 'string'
            && typeof owner.witnessPort === 'number'
            ? await lockWitnessState(owner.witnessPort, owner.token)
            : 'dead';
          if (ownerState === 'dead') {
            try {
              // Atomically move the observed generation out of the acquisition path. New
              // owners never operate while `.reap` exists, and a killed reaper is itself
              // recoverable because this file retains the original token witness.
              await rename(lockPath, reapPath);
              await syncDirectory(this.root);
              const latest = JSON.parse(await readFile(reapPath, 'utf8')) as {
                token?: unknown;
                witnessPort?: unknown;
              };
              const latestState = typeof latest.token === 'string'
                && typeof latest.witnessPort === 'number'
                ? await lockWitnessState(latest.witnessPort, latest.token)
                : 'dead';
              if (latestState === 'dead') {
                await rm(reapPath, { force: true });
                await syncDirectory(this.root);
              }
            } catch (recoveryError) {
              const code = (recoveryError as NodeJS.ErrnoException).code;
              if (code !== 'EEXIST' && code !== 'ENOENT') throw recoveryError;
            }
          }
          if (Date.now() >= deadline) throw new Error('媒体 artifact mutation lock 获取超时');
          await sleep(25);
        }
      }
      return await operation();
    } finally {
      let cleanupError: unknown;
      if (acquired) {
        try {
          const value = JSON.parse(await readFile(lockPath, 'utf8')) as { token?: unknown };
          if (value.token === token) {
            await rm(lockPath, { force: true });
            await syncDirectory(this.root);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupError = error;
        }
      }
      await new Promise<void>((resolve) => witness.server.close(() => resolve()));
      if (cleanupError) throw cleanupError;
    }
  }

  private async currentStoreBytesLocked(): Promise<number> {
    let total = 0;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!isSha256Name(entry.name) || !entry.isFile()) continue;
      total += (await lstat(path.join(this.root, entry.name))).size;
    }
    return total;
  }

  private async assertQuotaLocked(items: readonly PreparedAttachment[]): Promise<void> {
    const unique = new Map<string, PreparedAttachment>();
    for (const item of items) unique.set(item.attachment.sha256, item);
    let additional = 0;
    for (const item of unique.values()) {
      if (!await pathExists(item.destination)) additional += item.attachment.bytes;
    }
    const used = await this.currentStoreBytesLocked();
    if (used + additional > this.maxStoreBytes) {
      throw new Error(
        `媒体 artifact 全局配额不足：${used} + ${additional} > ${this.maxStoreBytes} bytes`,
      );
    }
  }

  private async verifyArtifactHandle(
    handle: FileHandle,
    sha256: string,
    expectedBytes?: number,
    maximum = MAX_VIDEO_BYTES,
  ): Promise<{ dev: bigint | number; ino: bigint | number; size: number }> {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new Error(`媒体 artifact 不是常规文件：${sha256}`);
    if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`媒体 artifact 大小不可安全表示：${sha256}`);
    const size = Number(info.size);
    if (expectedBytes !== undefined && size !== expectedBytes) {
      throw new Error(`附件大小不匹配：${sha256}`);
    }
    if (size > maximum) throw new Error(`附件 artifact 超出读取上限：${sha256}`);
    if (await hashOpenFile(handle, size) !== sha256) throw new Error(`附件摘要不匹配：${sha256}`);
    return { dev: info.dev, ino: info.ino, size };
  }

  private async verifyArtifactRefLocked(
    ref: string,
    evidence?: MediaEvidence,
  ): Promise<string> {
    const sha256 = artifactSha256(ref);
    if (evidence && evidence.sha256 !== sha256) {
      throw new Error(`MediaEvidence ${evidence.id} ref 与摘要不一致`);
    }
    const handle = await open(
      path.join(this.root, sha256),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await this.verifyArtifactHandle(
        handle,
        sha256,
        evidence?.bytes,
        evidence ? maximumBytes(evidence.kind) : MAX_VIDEO_BYTES,
      );
    } finally {
      await handle.close();
    }
    return sha256;
  }

  private async markGarbageLocked(
    sha256: string,
    timestamp = this.clock().getTime(),
  ): Promise<boolean> {
    if (await hasMarker(this.claimsRoot, sha256) || await hasMarker(this.referencesRoot, sha256)) {
      await rm(path.join(this.garbageRoot, sha256), { force: true });
      return false;
    }
    const created = await writeTimestampMarker(path.join(this.garbageRoot, sha256), timestamp);
    await syncDirectory(this.garbageRoot);
    return created;
  }

  private async removeClaimLocked(
    claimDirectory: string,
    sha256s: readonly string[],
    timestamp?: number,
  ): Promise<number> {
    await rm(claimDirectory, { recursive: true, force: true });
    await syncDirectory(this.claimsRoot);
    let tombstoned = 0;
    for (const sha256 of sha256s) {
      if (await this.markGarbageLocked(sha256, timestamp ?? this.clock().getTime())) {
        tombstoned += 1;
      }
    }
    await syncDirectory(this.root);
    return tombstoned;
  }

  async stage(
    requests: readonly LocalAttachmentRequest[],
    workspaceRoot: string,
    context: MediaEvidenceContext = {},
  ): Promise<StagedAttachment[]> {
    const batch = await this.stageBatch(requests, workspaceRoot, context);
    await batch.commit(context.eventId
      ? mediaArtifactOwner('event', context.eventId)
      : mediaArtifactOwner('standalone', context.sourceId ?? randomUUID()));
    return batch.attachments;
  }

  async stageGeneratedImage(
    input: GeneratedImageArtifactInput,
  ): Promise<MediaArtifactStageBatch> {
    if (!(input.data instanceof Uint8Array)) {
      throw new Error('生成图片必须提供二进制字节');
    }
    if (input.data.byteLength === 0) throw new Error('生成图片不能为空');
    if (input.data.byteLength > MAX_GENERATED_IMAGE_BYTES) {
      throw new Error(`生成图片超过 ${MAX_GENERATED_IMAGE_BYTES} bytes`);
    }
    const mediaType = canonicalGeneratedImageMediaType(input.mediaType);
    const originalName = mediaOriginalNameSchema.parse(input.originalName);
    await this.ensureLayout();
    // A killed process leaves this in the managed `.staging-*` recovery lane instead
    // of leaking raw generated media into a global temporary directory.
    const source = path.join(this.root, `.staging-generated-${process.pid}-${randomUUID()}`);
    let sourceHandle: FileHandle | undefined;
    let batch: MediaArtifactStageBatch | undefined;
    try {
      sourceHandle = await open(
        source,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await sourceHandle.writeFile(input.data);
      await sourceHandle.sync();
      await sourceHandle.close();
      sourceHandle = undefined;

      // Generated output has no immutable Event owner. Keep its claim unbound until the
      // caller durably transfers it to the canonical Session Evidence owner.
      batch = await this.stageBatch([{ path: path.basename(source), kind: 'image' }], this.root);
      const attachment = batch.attachments[0];
      if (!attachment || batch.attachments.length !== 1 || attachment.kind !== 'image') {
        throw new Error('生成图片 staging 未返回唯一图片 artifact');
      }
      if (attachment.mediaType !== mediaType) {
        throw new Error(
          `生成图片声明 MIME 与实际内容不一致：${mediaType} != ${attachment.mediaType}`,
        );
      }
      const artifact: StagedAttachment = {
        kind: attachment.kind,
        name: originalName,
        mediaType: attachment.mediaType,
        bytes: attachment.bytes,
        sha256: attachment.sha256,
        artifactRef: attachment.artifactRef,
      };
      return {
        attachments: [artifact],
        commit: (owner) => batch!.commit(owner),
        rollback: () => batch!.rollback(),
      };
    } catch (error) {
      if (batch) {
        try {
          await batch.rollback();
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            '生成图片 staging 失败且 rollback 未完成',
          );
        }
      }
      throw error;
    } finally {
      await sourceHandle?.close();
      await rm(source, { force: true });
    }
  }

  async stageBatch(
    requests: readonly LocalAttachmentRequest[],
    workspaceRoot: string,
    context: MediaEvidenceContext = {},
  ): Promise<MediaArtifactStageBatch> {
    if (requests.length > MAX_ATTACHMENTS) throw new Error(`附件最多 ${MAX_ATTACHMENTS} 个`);
    if (!requests.length) {
      return { attachments: [], commit: async () => undefined, rollback: async () => undefined };
    }
    await this.ensureLayout();
    const token = randomUUID();
    const claimDirectory = path.join(this.claimsRoot, token);
    const prepared: PreparedAttachment[] = [];
    const temporaries = new Set<string>();
    let totalBytes = 0;
    let inlineBytes = 0;
    let imageOrdinal = 0;
    const occurredAt = context.occurredAt ?? new Date().toISOString();
    try {
      // Validate and hash the complete batch before making any CAS name visible.
      for (const [index, request] of requests.entries()) {
        const source = await exactWorkspaceFile(workspaceRoot, request.path);
        const requestedKind = request.kind ?? inferredKind(source);
        const temporary = path.join(this.root, `.staging-${process.pid}-${randomUUID()}`);
        temporaries.add(temporary);
        const copied = await copyBoundedRegularFile(source, temporary, maximumBytes(requestedKind));
        totalBytes += copied.bytes;
        if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('附件合计超过 500MB');
        const unsupportedFormat = unsupportedUnparsedFormat(copied.header, source);
        if (unsupportedFormat) {
          throw new Error(`附件 ${unsupportedFormat} 暂不支持：缺少有界结构解析器，已在持久化前拒绝`);
        }
        const sniffedMediaType = await detectedMediaType(
          copied.header,
          temporary,
          copied.bytes,
          source,
        );
        const configuredType = configuredMediaType(source, requestedKind);
        const mediaType = sniffedMediaType
          ?? (requestedKind === 'file'
            ? await validatedConfiguredFileType(temporary, configuredType)
            : configuredType)
          ?? 'application/octet-stream';
        if (sniffedMediaType
          && !await validateDetectedContainer(temporary, sniffedMediaType, copied.bytes)) {
          throw new Error(`附件容器截断、损坏或含尾随 polyglot 数据：${request.path}`);
        }
        const detectedKind = mediaKindForType(mediaType);
        if (requestedKind !== 'file'
          && (!sniffedMediaType || detectedKind !== requestedKind)) {
          throw new Error(`附件内容与声明类型 ${requestedKind} 不一致：${request.path}`);
        }
        // A generic @file tag cannot downgrade detected media and bypass the audio/video
        // evidence gate. Content, not the prompt tag, owns the durable kind.
        const kind = requestedKind === 'file' && detectedKind ? detectedKind : requestedKind;
        if (kind === 'image' || kind === 'file') {
          inlineBytes += copied.bytes;
          if (inlineBytes > MAX_INLINE_ATTACHMENT_BYTES) {
            throw new Error('图片与普通文件附件合计超过 20MB');
          }
        }
        const originalName = mediaOriginalNameSchema.parse(path.basename(source));
        const destination = path.join(this.root, copied.sha256);
        const artifactRef = `media-artifact:sha256:${copied.sha256}`;
        const ordinal = kind === 'image' ? imageOrdinal++ : undefined;
        const evidence = kind === 'file' ? undefined : createOriginalMediaEvidence({
          kind,
          sha256: copied.sha256,
          mimeType: mediaType,
          bytes: copied.bytes,
          originalName,
          mediaRef: artifactRef,
          sourceRef: {
            entry: 'local-attachment',
            sourceId: context.sourceId
              ? `${context.sourceId}:${index}`
              : context.eventId
                ? `${context.eventId}:${index}`
                : `artifact:${copied.sha256}:${index}`,
            trust: context.trust ?? 'owner',
            profileId: context.profileId ?? 'owner',
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(context.sessionId ? { sessionId: context.sessionId } : {}),
            ...(context.eventId ? { eventId: context.eventId } : {}),
            ...(context.runId ? { runId: context.runId } : {}),
          },
          occurredAt,
          ...(ordinal !== undefined ? { imageOrdinal: ordinal } : {}),
        });
        const attachment: StagedAttachment = {
          kind,
          name: originalName,
          mediaType,
          bytes: copied.bytes,
          sha256: copied.sha256,
          artifactRef,
          ...(evidence ? { evidence } : {}),
        };
        prepared.push({ temporary, destination, attachment });
      }
      const uniqueSha256s = [...new Set(prepared.map((item) => item.attachment.sha256))];
      await this.withMutationLock(async () => {
        await this.assertQuotaLocked(prepared);
        await mkdir(claimDirectory, { mode: 0o700 });
        for (const sha256 of uniqueSha256s) {
          await writeDurableMarker(path.join(claimDirectory, sha256));
        }
        const ownerHandle = await open(
          path.join(claimDirectory, '.owner'),
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await ownerHandle.writeFile(context.eventId
            ? referenceKey(mediaArtifactOwner('event', context.eventId))
            : 'unbound');
          await ownerHandle.sync();
        } finally {
          await ownerHandle.close();
        }
        // Claims protect the not-yet-committed Event window. Flush every directory layer
        // before publishing a CAS name or allowing the Event transaction to start.
        await syncDirectory(claimDirectory);
        await syncDirectory(this.claimsRoot);
        await syncDirectory(this.root);
        try {
          for (const item of prepared) {
            let published = false;
            await link(item.temporary, item.destination).then(() => {
              published = true;
            }).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'EEXIST') throw error;
            });
            // Open with O_NOFOLLOW before any chmod. An attacker-controlled EEXIST symlink
            // is rejected without changing the target's mode or reading outside the CAS.
            const handle = await open(
              item.destination,
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            try {
              await this.verifyArtifactHandle(
                handle,
                item.attachment.sha256,
                item.attachment.bytes,
                maximumBytes(item.attachment.kind),
              );
              if (published) {
                await handle.chmod(0o600);
                await handle.sync();
              }
            } finally {
              await handle.close();
            }
            await rm(path.join(this.garbageRoot, item.attachment.sha256), { force: true });
          }
          // CAS links and marker removals are durable before Event commit may reference them.
          await syncDirectory(this.garbageRoot);
          await syncDirectory(this.root);
        } catch (error) {
          await this.removeClaimLocked(claimDirectory, uniqueSha256s);
          throw error;
        }
      });
    } catch (error) {
      throw error;
    } finally {
      await Promise.all([...temporaries].map((temporary) => rm(temporary, { force: true })));
    }
    let state: 'open' | 'committed' | 'rolled-back' = 'open';
    let transition: Promise<void> = Promise.resolve();
    const serialize = (operation: () => Promise<void>): Promise<void> => {
      const next = transition.then(operation);
      transition = next.catch(() => undefined);
      return next;
    };
    const sha256s = [...new Set(prepared.map((item) => item.attachment.sha256))];
    return {
      attachments: prepared.map((item) => item.attachment),
      commit: (owner = mediaArtifactOwner('standalone', token)) => serialize(async () => {
        if (state === 'committed') return;
        if (state === 'rolled-back') throw new Error('媒体 artifact batch 已回滚，不能提交');
        await this.withMutationLock(async () => {
          const ownerKey = referenceKey(owner);
          const directory = path.join(this.referencesRoot, ownerKey);
          try {
            await mkdir(directory, { mode: 0o700 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if (!(await lstat(directory)).isDirectory()) {
              throw new Error('媒体 artifact owner 目录类型无效');
            }
          }
          for (const sha256 of sha256s) {
            await writeOwnerMarker(directory, sha256, 'committed');
            await rm(path.join(this.garbageRoot, sha256), { force: true });
          }
          await syncDirectory(directory);
          await syncDirectory(this.referencesRoot);
          await rm(path.join(this.ownerGarbageRoot, ownerKey), { force: true });
          await syncDirectory(this.ownerGarbageRoot);
          await syncDirectory(this.garbageRoot);
          await rm(claimDirectory, { recursive: true, force: true });
          await syncDirectory(this.claimsRoot);
          await syncDirectory(this.root);
        });
        state = 'committed';
      }),
      rollback: () => serialize(async () => {
        if (state !== 'open') return;
        // Rollback only withdraws this batch's claim. CAS deletion is exclusively a
        // locked, grace-delayed GC operation, so a later concurrent claimant cannot dangle.
        await this.withMutationLock(() => this.removeClaimLocked(claimDirectory, sha256s));
        state = 'rolled-back';
      }),
    };
  }

  async acquireEvidenceOwner(
    owner: MediaArtifactOwner,
    evidenceItems: readonly MediaEvidence[],
  ): Promise<MediaArtifactOwnerLease> {
    const refs = evidenceArtifactRefs(evidenceItems);
    const ownerKey = referenceKey(owner);
    const referenceDirectory = path.join(this.referencesRoot, ownerKey);
    const leaseToken = `lease-${randomUUID()}`;
    const leased: string[] = [];
    await this.withMutationLock(async () => {
      // Verify every main, derived, and keyframe artifact before creating any owner marker.
      const verified = new Map<string, string>();
      for (const [ref, evidence] of refs) {
        verified.set(ref, await this.verifyArtifactRefLocked(ref, evidence));
      }
      try {
        await mkdir(referenceDirectory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!(await lstat(referenceDirectory)).isDirectory()) {
          throw new Error('媒体 artifact owner 目录类型无效');
        }
      }
      for (const sha256 of verified.values()) {
        if (await writeOwnerMarker(referenceDirectory, sha256, leaseToken)) leased.push(sha256);
        await rm(path.join(this.garbageRoot, sha256), { force: true });
      }
      await syncDirectory(referenceDirectory);
      await syncDirectory(this.referencesRoot);
      await syncDirectory(this.garbageRoot);
      await syncDirectory(this.root);
    });
    let state: 'open' | 'committed' | 'rolled-back' = 'open';
    let transition: Promise<void> = Promise.resolve();
    const serialize = (operation: () => Promise<void>): Promise<void> => {
      const next = transition.then(operation);
      transition = next.catch(() => undefined);
      return next;
    };
    return {
      commit: () => serialize(async () => {
        if (state === 'committed') return;
        if (state === 'rolled-back') throw new Error('媒体 artifact owner lease 已回滚');
        await this.withMutationLock(async () => {
          for (const sha256 of leased) {
            await writeOwnerMarker(referenceDirectory, sha256, 'committed');
            await removeOwnerToken(referenceDirectory, sha256, leaseToken);
          }
          await syncDirectory(referenceDirectory);
          await syncDirectory(this.referencesRoot);
          await syncDirectory(this.root);
        });
        state = 'committed';
      }),
      rollback: () => serialize(async () => {
        if (state !== 'open') return;
        await this.withMutationLock(async () => {
          for (const sha256 of leased) {
            await removeOwnerToken(referenceDirectory, sha256, leaseToken);
            await this.markGarbageLocked(sha256);
          }
          if (await pathExists(referenceDirectory) && !(await readdir(referenceDirectory)).length) {
            await rm(referenceDirectory, { recursive: true, force: true });
          }
          await syncDirectory(this.referencesRoot);
          await syncDirectory(this.root);
        });
        state = 'rolled-back';
      }),
    };
  }

  async reconcileEvidenceOwner(
    owner: MediaArtifactOwner,
    evidenceItems: readonly MediaEvidence[],
  ): Promise<void> {
    const refs = evidenceArtifactRefs(evidenceItems);
    const ownerKey = referenceKey(owner);
    await this.withMutationLock(async () => {
      const desired = new Set<string>();
      for (const [ref, evidence] of refs) {
        desired.add(await this.verifyArtifactRefLocked(ref, evidence));
      }
      const referenceDirectory = path.join(this.referencesRoot, ownerKey);
      try {
        await mkdir(referenceDirectory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!(await lstat(referenceDirectory)).isDirectory()) {
          throw new Error('媒体 artifact owner 目录类型无效');
        }
      }
      const existing = (await readdir(referenceDirectory)).filter(isSha256Name);
      for (const sha256 of desired) {
        await writeOwnerMarker(referenceDirectory, sha256, 'committed');
        const shaDirectory = path.join(referenceDirectory, sha256);
        const markerInfo = await lstat(shaDirectory);
        if (markerInfo.isDirectory()) {
          for (const marker of await readdir(shaDirectory)) {
            if (marker !== 'committed') await rm(path.join(shaDirectory, marker), { force: true });
          }
          await syncDirectory(shaDirectory);
        }
        await rm(path.join(this.garbageRoot, sha256), { force: true });
      }
      for (const sha256 of existing) {
        if (desired.has(sha256)) continue;
        await rm(path.join(referenceDirectory, sha256), { recursive: true, force: true });
        await this.markGarbageLocked(sha256);
      }
      if (!(await readdir(referenceDirectory)).length) {
        await rm(referenceDirectory, { recursive: true, force: true });
      }
      else await syncDirectory(referenceDirectory);
      await syncDirectory(this.referencesRoot);
      await syncDirectory(this.garbageRoot);
      await syncDirectory(this.root);
    });
  }

  async releaseOwner(owner: MediaArtifactOwner): Promise<number> {
    const ownerKey = referenceKey(owner);
    return this.withMutationLock(async () => {
      const referenceDirectory = path.join(this.referencesRoot, ownerKey);
      let sha256s: string[];
      try {
        sha256s = (await readdir(referenceDirectory)).filter(isSha256Name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          await rm(path.join(this.ownerGarbageRoot, ownerKey), { force: true });
          await syncDirectory(this.ownerGarbageRoot);
          return 0;
        }
        throw error;
      }
      await rm(referenceDirectory, { recursive: true, force: true });
      await syncDirectory(this.referencesRoot);
      await rm(path.join(this.ownerGarbageRoot, ownerKey), { force: true });
      await syncDirectory(this.ownerGarbageRoot);
      for (const sha256 of sha256s) await this.markGarbageLocked(sha256);
      await syncDirectory(this.root);
      return sha256s.length;
    });
  }

  async collectGarbage(options: {
    now?: Date;
    liveReferenceIds?: readonly string[];
  } = {}): Promise<MediaArtifactGarbageCollectionResult> {
    const now = options.now ?? this.clock();
    if (!Number.isFinite(now.getTime())) throw new Error('媒体 artifact GC 时间无效');
    const liveReferenceKeys = options.liveReferenceIds
      ? new Set(options.liveReferenceIds.map((id) => referenceKey(mediaArtifactOwner('event', id))))
      : undefined;
    return this.withMutationLock(async () => {
      let orphanEventOwners = 0;
      let unownedPreserved = 0;
      let staleClaims = 0;
      let staleStaging = 0;
      let tombstoned = 0;
      let deleted = 0;
      let reclaimedBytes = 0;
      if (liveReferenceKeys) {
        for (const entry of await readdir(this.referencesRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith('event-')) continue;
          const ownerTombstone = path.join(this.ownerGarbageRoot, entry.name);
          if (liveReferenceKeys.has(entry.name)) {
            await rm(ownerTombstone, { force: true });
            continue;
          }
          if (!await pathExists(ownerTombstone)) {
            await writeTimestampMarker(ownerTombstone, now.getTime());
            await syncDirectory(this.ownerGarbageRoot);
            continue;
          }
          const observedAt = Number(await readFile(ownerTombstone, 'utf8'));
          if (!Number.isFinite(observedAt)
            || now.getTime() - observedAt < this.gcGraceMs) continue;
          const directory = path.join(this.referencesRoot, entry.name);
          const sha256s = (await readdir(directory)).filter(isSha256Name);
          await rm(directory, { recursive: true, force: true });
          await rm(ownerTombstone, { force: true });
          orphanEventOwners += 1;
          await syncDirectory(this.referencesRoot);
          for (const sha256 of sha256s) {
            if (await this.markGarbageLocked(sha256, now.getTime())) tombstoned += 1;
          }
        }
      }
      for (const entry of await readdir(this.claimsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const claimDirectory = path.join(this.claimsRoot, entry.name);
        const info = await stat(claimDirectory);
        if (now.getTime() - info.mtimeMs < this.gcGraceMs) continue;
        const ownerKey = (await readFile(path.join(claimDirectory, '.owner'), 'utf8').catch(() => 'unbound')).trim();
        const sha256s = (await readdir(claimDirectory)).filter(isSha256Name);
        if (ownerKey === 'unbound' || !ownerKey) {
          // Generated output is deliberately unbound until its canonical Session Evidence
          // becomes durable. A stale claim can be withdrawn safely: an already-acquired
          // Session/Memory ref wins markGarbageLocked's stable snapshot, while a truly
          // abandoned blob enters the ordinary grace-delayed tombstone path.
          tombstoned += await this.removeClaimLocked(claimDirectory, sha256s, now.getTime());
          staleClaims += 1;
          continue;
        }
        if (!liveReferenceKeys) continue;
        if (liveReferenceKeys.has(ownerKey)) {
          const referenceDirectory = path.join(this.referencesRoot, ownerKey);
          await mkdir(referenceDirectory, { recursive: true, mode: 0o700 });
          for (const sha256 of sha256s) {
            await writeOwnerMarker(referenceDirectory, sha256, 'committed');
            await rm(path.join(this.garbageRoot, sha256), { force: true });
          }
          await syncDirectory(referenceDirectory);
          await syncDirectory(this.referencesRoot);
          await rm(path.join(this.ownerGarbageRoot, ownerKey), { force: true });
        }
        tombstoned += await this.removeClaimLocked(claimDirectory, sha256s, now.getTime());
        staleClaims += 1;
      }
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith('.staging-')) continue;
        const temporary = path.join(this.root, entry.name);
        const info = await lstat(temporary);
        if (now.getTime() - info.mtimeMs < this.gcGraceMs) continue;
        await rm(temporary, { force: true });
        staleStaging += 1;
      }
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (!entry.isFile() || !isSha256Name(entry.name)) continue;
        const sha256 = entry.name;
        const artifact = path.join(this.root, sha256);
        const tombstone = path.join(this.garbageRoot, sha256);
        if (await hasMarker(this.claimsRoot, sha256) || await hasMarker(this.referencesRoot, sha256)) {
          await rm(tombstone, { force: true });
          continue;
        }
        if (!await pathExists(tombstone)) {
          // Legacy versions had no owner registry. Without a controlled release/claim
          // tombstone, liveness is unknowable; preserve rather than delete live media.
          unownedPreserved += 1;
          continue;
        }
        let tombstoneAt: number;
        try {
          tombstoneAt = Number(await readFile(tombstone, 'utf8'));
          if (!Number.isFinite(tombstoneAt)) tombstoneAt = (await stat(tombstone)).mtimeMs;
        } catch {
          tombstoneAt = (await stat(tombstone)).mtimeMs;
        }
        if (now.getTime() - tombstoneAt < this.gcGraceMs) continue;
        // The mutation lock makes this final marker snapshot stable across processes.
        const bytes = (await lstat(artifact)).size;
        await rm(artifact, { force: true });
        await rm(tombstone, { force: true });
        deleted += 1;
        reclaimedBytes += bytes;
      }
      await syncDirectory(this.claimsRoot);
      await syncDirectory(this.referencesRoot);
      await syncDirectory(this.garbageRoot);
      await syncDirectory(this.ownerGarbageRoot);
      await syncDirectory(this.root);
      return {
        orphanEventOwners,
        unownedPreserved,
        staleClaims,
        staleStaging,
        tombstoned,
        deleted,
        reclaimedBytes,
      };
    });
  }

  private async physicalArtifact(attachment: StagedAttachment): Promise<string> {
    const sha256 = artifactSha256(attachment.artifactRef);
    if (sha256 !== attachment.sha256) throw new Error(`附件 ref 与摘要不一致：${attachment.name}`);
    const selected = attachment.legacyPath ?? path.join(this.root, sha256);
    let resolvedRoot: string;
    let physical: string;
    try {
      [resolvedRoot, physical] = await Promise.all([realpath(this.root), realpath(selected)]);
    } catch (error) {
      throw new Error(`附件 artifact 不存在或不可访问：${attachment.name}`, { cause: error });
    }
    const expected = path.join(resolvedRoot, sha256);
    if (physical !== expected) throw new Error(`附件 artifact ref 越界：${attachment.name}`);
    return physical;
  }

  private async assertArtifactIdentity(
    physical: string,
    expected: { dev: bigint | number; ino: bigint | number; size: number },
    attachment: StagedAttachment,
  ): Promise<void> {
    const current = await lstat(physical, { bigint: true });
    if (!current.isFile()
      || current.dev !== expected.dev
      || current.ino !== expected.ino
      || current.size !== BigInt(expected.size)) {
      throw new Error(`附件 artifact 在验证与消费之间被替换：${attachment.name}`);
    }
  }

  async verify(attachment: StagedAttachment): Promise<void> {
    const physical = await this.physicalArtifact(attachment);
    const handle = await open(physical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const identity = await this.verifyArtifactHandle(
        handle,
        attachment.sha256,
        attachment.bytes,
        maximumBytes(attachment.kind),
      );
      await this.assertArtifactIdentity(physical, identity, attachment);
    } finally {
      await handle.close();
    }
  }

  async *readChunks(
    attachment: StagedAttachment,
    range: { start?: number; endExclusive?: number } = {},
  ): AsyncGenerator<Buffer> {
    const start = range.start ?? 0;
    const end = range.endExclusive ?? attachment.bytes;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end <= start || end > attachment.bytes) {
      throw new Error(`附件时间/字节范围无效：${attachment.name}`);
    }
    const physical = await this.physicalArtifact(attachment);
    const handle = await open(physical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const identity = await this.verifyArtifactHandle(
        handle,
        attachment.sha256,
        attachment.bytes,
        maximumBytes(attachment.kind),
      );
      let offset = start;
      while (offset < end) {
        const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, end - offset));
        const result = await handle.read(buffer, 0, buffer.length, offset);
        if (result.bytesRead === 0) throw new Error(`附件范围读取不完整：${attachment.name}`);
        offset += result.bytesRead;
        yield buffer.subarray(0, result.bytesRead);
      }
      // The generator only completes successfully after the exact fd consumed above still
      // hashes to the Evidence digest and the CAS pathname still names that same inode.
      await this.verifyArtifactHandle(
        handle,
        attachment.sha256,
        attachment.bytes,
        maximumBytes(attachment.kind),
      );
      await this.assertArtifactIdentity(physical, identity, attachment);
    } finally {
      await handle.close();
    }
  }

  async read(attachment: StagedAttachment): Promise<Buffer> {
    if (attachment.kind === 'audio' || attachment.kind === 'video') {
      throw new Error(`音视频 artifact 必须使用有界流式 reader：${attachment.name}`);
    }
    const physical = await this.physicalArtifact(attachment);
    const handle = await open(physical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const identity = await this.verifyArtifactHandle(
        handle,
        attachment.sha256,
        attachment.bytes,
        maximumBytes(attachment.kind),
      );
      const data = await handle.readFile();
      const digest = createHash('sha256').update(data).digest('hex');
      if (digest !== attachment.sha256) throw new Error(`附件摘要不匹配：${attachment.name}`);
      await this.assertArtifactIdentity(physical, identity, attachment);
      return data;
    } finally {
      await handle.close();
    }
  }
}
