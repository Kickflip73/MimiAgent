import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  finalAudioAsrReceiptSchema,
  type FinalAudioAsrReceipt,
} from '../core/audio-evidence.js';
import { mediaEvidenceIdSchema } from '../core/media-evidence.js';
import type {
  MediaArtifactStore,
  StagedAttachment,
} from './media-artifact-store.js';
import { parsePcm16Wav } from './pcm-wav.js';

const MAX_AUDIO_TRANSCRIPT_CHARACTERS = 64_000;
const MAX_AUDIO_TRANSCRIPT_SEGMENTS = 128;
const UNOWNED_AUDIO_SNAPSHOT_GRACE_MS = 60 * 60 * 1_000;

function audioSnapshotRoot(): string {
  return path.join(os.tmpdir(), 'mimi-audio-asr');
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Removes private audio snapshots left by a process that died before its finally block. */
export async function recoverStaleAudioSnapshots(
  root = audioSnapshotRoot(),
  now = Date.now(),
): Promise<number> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  let removed = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const owner = await readFile(path.join(directory, '.owner'), 'utf8')
      .then((value) => {
        try {
          return z.object({ schemaVersion: z.literal(1), pid: z.number().int().positive() })
            .strict().parse(JSON.parse(value) as unknown);
        } catch {
          return undefined;
        }
      })
      .catch(() => undefined);
    if (owner && processIsAlive(owner.pid)) continue;
    if (!owner) {
      const metadata = await lstat(directory).catch(() => undefined);
      if (!metadata) continue;
      const age = now - metadata.mtimeMs;
      if (age < UNOWNED_AUDIO_SNAPSHOT_GRACE_MS) continue;
    }
    await rm(directory, { recursive: true, force: true });
    removed += 1;
  }
  if (removed) await syncDirectory(root);
  return removed;
}

async function createAudioSnapshotDirectory(): Promise<string> {
  const root = audioSnapshotRoot();
  await recoverStaleAudioSnapshots(root);
  const directory = await mkdtemp(path.join(root, `${process.pid}-`));
  await chmod(directory, 0o700);
  const owner = await open(
    path.join(directory, '.owner'),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await owner.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid }));
    await owner.sync();
  } finally {
    await owner.close();
  }
  await syncDirectory(directory);
  await syncDirectory(root);
  return directory;
}

const audioFileTranscriptionResultSchema = z.object({
  receiptVersion: z.literal(1),
  adapter: z.literal('macos-speech-framework'),
  adapterVersion: z.literal('1'),
  final: z.literal(true),
  text: z.string().max(MAX_AUDIO_TRANSCRIPT_CHARACTERS),
  charCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  locale: z.string().regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/).max(35),
  onDevice: z.literal(true),
  segments: z.array(z.object({
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    text: z.string().trim().min(1).max(4_000),
    confidence: z.number().min(0).max(1).optional(),
  }).strict().refine((segment) => segment.endMs > segment.startMs, {
    message: 'ASR segment endMs must be greater than startMs',
  })).max(MAX_AUDIO_TRANSCRIPT_SEGMENTS),
  untrusted: z.literal(true),
}).strict().superRefine((result, context) => {
  if (result.text.trim() && result.segments.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['segments'],
      message: 'non-empty transcript requires timestamped segments',
    });
  }
  const segmentCharacters = result.segments.reduce((total, segment) => total + segment.text.length, 0);
  if (segmentCharacters > MAX_AUDIO_TRANSCRIPT_CHARACTERS) {
    context.addIssue({
      code: 'custom',
      path: ['segments'],
      message: `ASR segments exceed ${MAX_AUDIO_TRANSCRIPT_CHARACTERS} characters`,
    });
  }
});

export interface AudioFileTranscriptionPort {
  readonly adapterId: string;
  readonly adapterVersion?: string;
  transcribe(input: {
    filePath: string;
    locale: string;
    onDevice: true;
    maxChars: number;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

export const preparedAudioTranscriptionSchema = z.object({
  parentEvidenceId: mediaEvidenceIdSchema,
  occurredAt: z.string().datetime({ offset: true }),
  receipt: finalAudioAsrReceiptSchema,
}).strict();
export type PreparedAudioTranscription = z.infer<typeof preparedAudioTranscriptionSchema>;

async function writeComplete(
  handle: FileHandle,
  chunk: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const result = await handle.write(chunk, offset, chunk.length - offset, position + offset);
    if (result.bytesWritten <= 0) throw new Error('音频 artifact 临时快照写入未取得进展');
    offset += result.bytesWritten;
  }
}

async function prepareWavAudioTranscriptionInternal(input: {
  attachment: StagedAttachment;
  artifacts: MediaArtifactStore;
  transcriber: AudioFileTranscriptionPort;
  occurredAt: string;
  locale?: string;
  signal?: AbortSignal;
}): Promise<PreparedAudioTranscription> {
  input.signal?.throwIfAborted();
  const evidence = input.attachment.evidence;
  if (!evidence || evidence.kind !== 'audio' || evidence.mimeType !== 'audio/wav'
    || input.attachment.kind !== 'audio' || input.attachment.mediaType !== 'audio/wav') {
    throw new Error('音频分析首版只接受带原始 MediaEvidence 的 PCM WAV');
  }
  if (evidence.mediaRef !== input.attachment.artifactRef
    || evidence.sha256 !== input.attachment.sha256
    || evidence.bytes !== input.attachment.bytes) {
    throw new Error('音频附件与原始 MediaEvidence 身份不一致');
  }
  const occurredAt = z.string().datetime({ offset: true }).parse(input.occurredAt);
  const temporaryRoot = await createAudioSnapshotDirectory();
  const temporaryFile = path.join(temporaryRoot, 'input.wav');
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryFile, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    let copied = 0;
    for await (const chunk of input.artifacts.readChunks(input.attachment)) {
      input.signal?.throwIfAborted();
      await writeComplete(handle, chunk, copied);
      copied += chunk.length;
    }
    if (copied !== input.attachment.bytes) throw new Error('音频 artifact 流式快照长度不一致');
    await handle.sync();
    const metadata = await parsePcm16Wav(handle, copied);
    await handle.chmod(0o400);
    await handle.sync();
    await handle.close();
    handle = undefined;
    input.signal?.throwIfAborted();
    const raw = await input.transcriber.transcribe({
      filePath: temporaryFile,
      locale: input.locale ?? 'zh-CN',
      onDevice: true,
      maxChars: MAX_AUDIO_TRANSCRIPT_CHARACTERS,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    input.signal?.throwIfAborted();
    const decoded = audioFileTranscriptionResultSchema.safeParse(raw);
    if (!decoded.success) throw new Error('本地 WAV 转写回执结构无效');
    const result = decoded.data;
    const receipt: FinalAudioAsrReceipt = finalAudioAsrReceiptSchema.parse({
      status: 'final',
      adapter: input.transcriber.adapterId,
      ...(input.transcriber.adapterVersion ? { version: input.transcriber.adapterVersion } : {}),
      inputSha256: input.attachment.sha256,
      durationMs: metadata.durationMs,
      truncated: result.truncated,
      segments: result.segments,
      analyzedRanges: [{ startMs: 0, endMs: metadata.durationMs }],
    });
    return preparedAudioTranscriptionSchema.parse({
      parentEvidenceId: evidence.id,
      occurredAt,
      receipt,
    });
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
    await syncDirectory(audioSnapshotRoot());
  }
}

export async function prepareWavAudioTranscription(
  input: Parameters<typeof prepareWavAudioTranscriptionInternal>[0],
): Promise<PreparedAudioTranscription> {
  try {
    return await prepareWavAudioTranscriptionInternal(input);
  } catch (error) {
    const failure = new Error(
      '本地 WAV 音频准备或转写失败；未将未验证内容发送给模型',
      { cause: error },
    );
    failure.name = 'AudioPreparationError';
    throw failure;
  }
}
