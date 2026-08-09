import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createGeneratedImageEvidence,
  createMediaEvidence,
  createOriginalMediaEvidence,
  mediaEvidenceIdSchema,
  mediaEvidenceSchema,
  renderMediaEvidenceReference,
} from '../src/core/media-evidence.js';
import { evidenceFromMedia } from '../src/core/memory/compilation-v2.js';
import { FileSession } from '../src/core/session.js';
import {
  attachmentPayload,
  inputWithAttachments,
  parseAttachmentInput,
  stageAttachments,
} from '../src/runtime/attachments.js';
import { mediaArtifactOwner, MediaArtifactStore } from '../src/runtime/media-artifact-store.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const wave = (() => {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 4, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(24_000, 12);
  fmt.writeUInt32LE(48_000, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const data = Buffer.alloc(10);
  data.write('data', 0, 4, 'ascii');
  data.writeUInt32LE(2, 4);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 4, 'ascii');
  riff.writeUInt32LE(4 + fmt.length + data.length, 4);
  riff.write('WAVE', 8, 4, 'ascii');
  return Buffer.concat([riff, fmt, data]);
})();
function isoBox(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + payload.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, payload]);
}
const mp4 = Buffer.concat([
  isoBox('ftyp', Buffer.concat([Buffer.from('isom'), Buffer.alloc(4)])),
  // Keep moov beyond the 64KiB sniff header to prove detection seeks through box sizes.
  isoBox('mdat', Buffer.alloc(70 * 1024)),
  isoBox('moov', isoBox('trak', isoBox('mdia', isoBox('hdlr', Buffer.concat([
    Buffer.alloc(8), Buffer.from('vide'), Buffer.alloc(12),
  ]))))),
]);

test('MediaEvidence is deterministic, content-addressed and contains no binary locator', () => {
  const input = {
    kind: 'image' as const,
    sha256: 'a'.repeat(64),
    mimeType: 'image/png',
    bytes: 12,
    originalName: 'photo.png',
    mediaRef: `media-artifact:sha256:${'a'.repeat(64)}`,
    sourceRef: {
      entry: 'local-attachment' as const,
      sourceId: 'event-1:image:0',
      trust: 'owner' as const,
      profileId: 'owner',
      sessionId: 'session-1',
      eventId: 'event-1',
    },
    occurredAt: '2026-08-09T00:00:00.000Z',
  };
  const first = createOriginalMediaEvidence(input);
  const second = createOriginalMediaEvidence(input);
  assert.deepEqual(second, first);
  assert.equal(first.imageOrdinal, 0);
  assert.equal(first.coverage.status, 'metadata-only');
  assert.doesNotMatch(JSON.stringify(first), /data:|base64|\/Users\//);
  assert.deepEqual(mediaEvidenceSchema.parse(first), first);

  const memoryRef = evidenceFromMedia(first, 'owner', 'workspace-1');
  assert.equal(memoryRef.kind, 'media');
  assert.equal(memoryRef.locator.mediaEvidenceId, first.id);
  assert.deepEqual(memoryRef.locator.mediaAnchor, { kind: 'image', imageOrdinal: 0 });

  assert.throws(() => mediaEvidenceSchema.parse({
    ...first,
    mediaRef: '/tmp/private-photo.png',
  }));
});

test('derived MediaEvidence carries bounded transcript and keyframe coverage with distinct digests', () => {
  const audio = createOriginalMediaEvidence({
    kind: 'audio',
    sha256: 'b'.repeat(64),
    mimeType: 'audio/wav',
    bytes: 128,
    originalName: 'clip.wav',
    mediaRef: `media-artifact:sha256:${'b'.repeat(64)}`,
    sourceRef: {
      entry: 'local-attachment', sourceId: 'event-1:audio:0', trust: 'owner',
      profileId: 'owner', sessionId: 'session-1', eventId: 'event-1',
    },
    occurredAt: '2026-08-09T00:00:00.000Z',
  });
  const transcript = createMediaEvidence({
    schemaVersion: 1,
    mediaRef: audio.mediaRef,
    kind: 'audio',
    mimeType: audio.mimeType,
    sha256: audio.sha256,
    bytes: audio.bytes,
    originalName: audio.originalName,
    sourceRef: {
      entry: 'derived-audio-slice',
      sourceId: 'asr:event-1:0',
      trust: 'owner',
      profileId: 'owner',
      sessionId: 'session-1',
      eventId: 'event-1',
      parentEvidenceId: audio.id,
    },
    occurredAt: audio.occurredAt,
    durationMs: 1_000,
    transcriptSegments: [{
      id: 'segment:0', startMs: 0, endMs: 900, text: 'hello', confidence: 0.9,
    }],
    keyframes: [],
    timeRanges: [{ id: 'time-range:0', startMs: 0, endMs: 900, label: 'speech' }],
    modelBinding: { status: 'local', adapter: 'fixture-asr', version: '1' },
    derivedArtifactRefs: [],
    coverage: { status: 'partial', modalities: ['audio', 'transcript'], reason: 'speaker unsupported' },
    summary: 'one speech segment',
  });
  assert.notEqual(transcript.id, audio.id);
  assert.equal(transcript.transcriptSegments[0]?.endMs, 900);
  const transcriptMemory = evidenceFromMedia(
    transcript,
    'owner',
    'workspace-1',
    { kind: 'segment', segmentId: 'segment:0' },
  );
  assert.deepEqual(transcriptMemory.locator.mediaAnchor, {
    kind: 'segment', segmentId: 'segment:0',
  });
  assert.throws(
    () => evidenceFromMedia(transcript, 'owner', 'workspace-1'),
    /必须显式选择 anchor/,
  );
  const unsupported = createMediaEvidence({
    schemaVersion: 1,
    mediaRef: audio.mediaRef,
    kind: 'audio',
    mimeType: audio.mimeType,
    sha256: audio.sha256,
    bytes: audio.bytes,
    originalName: audio.originalName,
    sourceRef: audio.sourceRef,
    occurredAt: audio.occurredAt,
    transcriptSegments: [],
    keyframes: [],
    timeRanges: [],
    modelBinding: { status: 'unsupported', reason: 'selected model has no audio input' },
    derivedArtifactRefs: [],
    coverage: {
      status: 'unsupported', modalities: ['audio'], reason: 'no eligible route',
    },
  });
  assert.deepEqual(
    evidenceFromMedia(unsupported, 'owner', 'workspace-1').locator.mediaAnchor,
    { kind: 'whole' },
  );
  assert.match(renderMediaEvidenceReference(unsupported), /anchor=whole/);
  const { id: _transcriptId, ...transcriptContent } = transcript;
  assert.throws(() => createMediaEvidence({
    ...transcriptContent,
    durationMs: 500,
  }), /超出 durationMs/);

  const video = createOriginalMediaEvidence({
    kind: 'video',
    sha256: 'c'.repeat(64),
    mimeType: 'video/mp4',
    bytes: 1_024,
    originalName: 'movie.mp4',
    mediaRef: `media-artifact:sha256:${'c'.repeat(64)}`,
    sourceRef: {
      entry: 'connector-event', sourceId: 'connector-video-1', trust: 'external',
      profileId: 'external-profile', sessionId: 'session-1', eventId: 'connector-event-1',
    },
    occurredAt: '2026-08-09T00:00:00.000Z',
  });
  const keyframeRef = `media-artifact:sha256:${'d'.repeat(64)}`;
  const analyzed = createMediaEvidence({
    schemaVersion: 1,
    mediaRef: video.mediaRef,
    kind: 'video',
    mimeType: video.mimeType,
    sha256: video.sha256,
    bytes: video.bytes,
    originalName: video.originalName,
    sourceRef: {
      entry: 'derived-video-keyframe', sourceId: 'frames:connector-video-1', trust: 'external',
      profileId: 'external-profile', sessionId: 'session-1', eventId: 'connector-event-1',
      parentEvidenceId: video.id,
    },
    occurredAt: video.occurredAt,
    durationMs: 2_000,
    transcriptSegments: [],
    keyframes: [{
      id: 'keyframe:0', timestampMs: 1_000, mediaRef: keyframeRef,
      sha256: 'd'.repeat(64), mimeType: 'image/png', summary: 'slide',
    }],
    timeRanges: [{ id: 'time-range:slide', startMs: 800, endMs: 1_200, summary: 'slide visible' }],
    modelBinding: { status: 'local', adapter: 'fixture-keyframes' },
    derivedArtifactRefs: [keyframeRef],
    coverage: { status: 'partial', modalities: ['video', 'keyframes'], reason: 'sampled keyframes only' },
  });
  assert.deepEqual(mediaEvidenceSchema.parse(analyzed), analyzed);
  assert.throws(
    () => evidenceFromMedia(analyzed, 'external-profile', 'workspace-1', { kind: 'whole' }),
    /不包含请求的 whole anchor/,
  );
  const { id: _analyzedId, ...analyzedContent } = analyzed;
  assert.throws(() => createMediaEvidence({
    ...analyzedContent,
    derivedArtifactRefs: [],
  }), /关键帧必须列入 derivedArtifactRefs/);
});

test('MediaEvidence rejects kind/MIME mismatches and oversized metadata', () => {
  assert.throws(() => createOriginalMediaEvidence({
    kind: 'audio',
    sha256: 'e'.repeat(64),
    mimeType: 'video/mp4',
    bytes: 128,
    originalName: 'clip.mp4',
    mediaRef: `media-artifact:sha256:${'e'.repeat(64)}`,
    sourceRef: {
      entry: 'local-attachment', sourceId: 'mismatch', trust: 'owner', profileId: 'owner',
    },
    occurredAt: '2026-08-09T00:00:00.000Z',
  }), /kind 与 MIME 主类型不一致/);

  const base = createOriginalMediaEvidence({
    kind: 'audio',
    sha256: 'f'.repeat(64),
    mimeType: 'audio/wav',
    bytes: 128,
    originalName: 'large.wav',
    mediaRef: `media-artifact:sha256:${'f'.repeat(64)}`,
    sourceRef: {
      entry: 'local-attachment', sourceId: 'large', trust: 'owner', profileId: 'owner',
    },
    occurredAt: '2026-08-09T00:00:00.000Z',
  });
  assert.throws(() => createMediaEvidence({
    schemaVersion: 1,
    mediaRef: base.mediaRef,
    kind: base.kind,
    mimeType: base.mimeType,
    sha256: base.sha256,
    bytes: base.bytes,
    originalName: base.originalName,
    sourceRef: {
      entry: 'derived-audio-slice', sourceId: 'large-derived', trust: 'owner', profileId: 'owner',
      parentEvidenceId: base.id,
    },
    occurredAt: base.occurredAt,
    durationMs: 200_000,
    transcriptSegments: Array.from({ length: 140 }, (_, index) => ({
      id: `segment:${index}`,
      startMs: index * 1_000,
      endMs: index * 1_000 + 900,
      text: 'x'.repeat(4_000),
    })),
    keyframes: [],
    timeRanges: [],
    modelBinding: { status: 'local', adapter: 'fixture-asr' },
    derivedArtifactRefs: [],
    coverage: { status: 'partial', modalities: ['audio', 'transcript'], reason: 'size-limit fixture' },
  }), /文本总量超过 512000 字符/);
});

test('media artifacts persist stable refs, not absolute paths, and are hash-verified on read', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-artifacts-'));
  const artifacts = path.join(root, '.artifacts');
  await writeFile(path.join(root, 'photo.png'), png);
  await writeFile(path.join(root, 'note.txt'), 'hello');
  const parsed = parseAttachmentInput('比较 @image:photo.png @file:note.txt');
  const staged = await stageAttachments(parsed.attachments, root, artifacts, {
    profileId: 'owner', sessionId: 'session-1', eventId: 'event-1',
  });
  assert.equal(staged.length, 2);
  assert.equal('path' in staged[0]!, false);
  assert.match(staged[0]!.artifactRef, /^media-artifact:sha256:[a-f0-9]{64}$/);
  const serialized = JSON.stringify(staged);
  assert.doesNotMatch(serialized, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(serialized, /base64|data:/);

  const modelInput = await inputWithAttachments(parsed.text, staged, artifacts);
  assert.notEqual(typeof modelInput, 'string');
  const parts = (modelInput as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content;
  assert.deepEqual(parts.map((part) => part.type), [
    'input_text', 'input_text', 'input_image', 'input_text', 'input_file',
  ]);
  assert.match(String(parts[1]!.text), /^\[媒体引用 media-evidence:sha256:/);

  const digest = staged[0]!.sha256;
  await writeFile(path.join(artifacts, digest), 'tampered');
  await assert.rejects(
    inputWithAttachments(parsed.text, staged, artifacts),
    /摘要不匹配|大小不匹配/,
  );
  assert.equal(await readFile(path.join(artifacts, staged[1]!.sha256), 'utf8'), 'hello');
});

test('audio and video attachments are classified but blocked before model input until analyzed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-analysis-required-'));
  const artifacts = path.join(root, '.artifacts');
  await writeFile(path.join(root, 'clip.wav'), wave);
  await writeFile(path.join(root, 'movie.mp4'), mp4);
  const parsed = parseAttachmentInput('检查 @audio:clip.wav @video:movie.mp4');
  assert.deepEqual(parsed.attachments.map((item) => item.kind), ['audio', 'video']);
  const staged = await stageAttachments(parsed.attachments, root, artifacts);
  assert.deepEqual(staged.map((item) => item.mediaType), ['audio/wav', 'video/mp4']);
  await assert.rejects(
    inputWithAttachments(parsed.text, staged, artifacts),
    /必须先生成带时间片或关键帧的 MediaEvidence/,
  );
});

test('@file cannot downgrade detected audio/video and fake PDF signatures fail closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-kind-detection-'));
  const artifacts = path.join(root, '.artifacts');
  await writeFile(path.join(root, 'clip.wav'), wave);
  await writeFile(path.join(root, 'movie.mp4'), mp4);
  await writeFile(path.join(root, 'fake.pdf'), 'plain text pretending to be pdf');
  const parsed = parseAttachmentInput('检查 @file:clip.wav @file:movie.mp4');
  assert.deepEqual(parsed.attachments.map((item) => item.kind), ['file', 'file']);
  const staged = await stageAttachments(parsed.attachments, root, artifacts);
  assert.deepEqual(staged.map((item) => item.kind), ['audio', 'video']);
  assert.ok(staged.every((item) => item.evidence));
  await assert.rejects(
    inputWithAttachments(parsed.text, staged, artifacts),
    /必须先生成带时间片或关键帧的 MediaEvidence/,
  );
  await assert.rejects(
    stageAttachments([{ path: 'fake.pdf', kind: 'file' }], root, artifacts),
    /PDF 暂不支持：缺少有界结构解析器/,
  );
});

test('artifact batch publication is atomic and rollback preserves a concurrent claimant', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-batch-'));
  const artifacts = path.join(root, '.artifacts');
  await writeFile(path.join(root, 'valid.png'), png);
  await writeFile(path.join(root, 'invalid.png'), 'not an image');
  await assert.rejects(
    stageAttachments([
      { path: 'valid.png', kind: 'image' },
      { path: 'invalid.png', kind: 'image' },
    ], root, artifacts),
    /内容与声明类型 image 不一致/,
  );
  const publishedAfterFailure = (await readdir(artifacts))
    .filter((name) => /^[a-f0-9]{64}$/.test(name));
  assert.deepEqual(publishedAfterFailure, []);

  const store = new MediaArtifactStore(artifacts);
  const first = await store.stageBatch([{ path: 'valid.png', kind: 'image' }], root, {
    eventId: 'event-first', sessionId: 'session-first',
  });
  const second = await store.stageBatch([{ path: 'valid.png', kind: 'image' }], root, {
    eventId: 'event-second', sessionId: 'session-second',
  });
  await first.rollback();
  await store.verify(second.attachments[0]!);
  await second.commit(mediaArtifactOwner('event', 'event-second'));
  const reopened = new MediaArtifactStore(artifacts);
  await reopened.verify(second.attachments[0]!);
});

test('stage verification never materializes audio/video and range reads stay bounded', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-streaming-'));
  const artifacts = path.join(root, '.artifacts');
  await writeFile(path.join(root, 'movie.mp4'), mp4);
  const store = new MediaArtifactStore(artifacts);
  store.read = async () => {
    throw new Error('read must not be called by stage');
  };
  const staged = await store.stage([{ path: 'movie.mp4', kind: 'video' }], root);
  assert.equal(staged[0]?.kind, 'video');
  const reopened = new MediaArtifactStore(artifacts);
  await assert.rejects(reopened.read(staged[0]!), /必须使用有界流式 reader/);
  const chunks: Buffer[] = [];
  for await (const chunk of reopened.readChunks(staged[0]!, { start: 4, endExclusive: 12 })) {
    chunks.push(chunk);
  }
  assert.deepEqual(Buffer.concat(chunks), mp4.subarray(4, 12));
});

test('malformed durable attachment metadata and non-canonical names fail closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-canonical-name-'));
  await writeFile(path.join(root, ' photo.png '), png);
  await assert.rejects(
    stageAttachments([{ path: ' photo.png ', kind: 'image' }], root, path.join(root, '.artifacts')),
    /原始名称不能包含首尾空白/,
  );
  assert.throws(() => attachmentPayload({ attachments: [{ kind: 'image' }] }), /元数据无效/);
});

test('inline image/file totals retain the 20MiB staging and model-boundary cap', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-inline-total-'));
  const sevenMiB = Buffer.alloc(7 * 1024 * 1024, 0x61);
  await Promise.all(['one.bin', 'two.bin', 'three.bin'].map((name) => (
    writeFile(path.join(root, name), sevenMiB)
  )));
  await assert.rejects(
    stageAttachments(
      ['one.bin', 'two.bin', 'three.bin'].map((requestedPath) => ({
        path: requestedPath, kind: 'file' as const,
      })),
      root,
      path.join(root, '.artifacts'),
    ),
    /合计超过 20MB/,
  );
  const oversized = ['1', '2', '3'].map((suffix) => ({
    kind: 'file' as const,
    name: `${suffix}.bin`,
    mediaType: 'application/octet-stream',
    bytes: 7 * 1024 * 1024,
    sha256: suffix.repeat(64),
    artifactRef: `media-artifact:sha256:${suffix.repeat(64)}`,
  }));
  await assert.rejects(
    inputWithAttachments('inspect', oversized, path.join(root, '.artifacts')),
    /拒绝在模型边界分配 base64/,
  );
});

test('Session media registry is atomic, deduplicated and scoped to the active run owner', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-session-media-'));
  const session = new FileSession(root, 'media-session');
  const evidence = createOriginalMediaEvidence({
    kind: 'audio',
    sha256: 'b'.repeat(64),
    mimeType: 'audio/wav',
    bytes: 128,
    originalName: 'clip.wav',
    mediaRef: `media-artifact:sha256:${'b'.repeat(64)}`,
    sourceRef: {
      entry: 'local-attachment', sourceId: 'event-1:audio:0', trust: 'owner',
      profileId: 'owner', sessionId: 'media-session', eventId: 'event-1',
    },
    occurredAt: '2026-08-09T00:00:00.000Z',
  });
  await session.beginRun('inspect clip', 'run-1', 'owner-1');
  assert.equal(await session.registerMediaEvidence([evidence], 'run-1'), 1);
  assert.equal(await session.registerMediaEvidence([evidence], 'run-1'), 0);
  assert.deepEqual(await session.getMediaEvidence(evidence.id), evidence);
  assert.equal(await session.registerMediaEvidence([{ ...evidence, summary: 'stale write' }], 'run-stale'), 0);
  const raw = await readFile(path.join(root, 'media-session.json'), 'utf8');
  assert.doesNotMatch(raw, /data:|base64|\/Users\//);
  assert.equal((await session.listMediaEvidence()).length, 1);

  const oldRunEvidence = createOriginalMediaEvidence({
    kind: 'audio',
    sha256: 'd'.repeat(64),
    mimeType: 'audio/wav',
    bytes: 64,
    originalName: 'old.wav',
    mediaRef: `media-artifact:sha256:${'d'.repeat(64)}`,
    sourceRef: {
      entry: 'voice-session', sourceId: 'voice-old', trust: 'owner', profileId: 'owner',
      sessionId: 'media-session', eventId: 'old-event', runId: 'run-old',
    },
    occurredAt: '2026-08-09T00:00:00.000Z',
  });
  await assert.rejects(
    session.registerMediaEvidence([oldRunEvidence], 'run-1'),
    /不能注册到 run-1/,
  );

  const externalParent = createOriginalMediaEvidence({
    kind: 'video',
    sha256: 'c'.repeat(64),
    mimeType: 'video/mp4',
    bytes: 256,
    originalName: 'external.mp4',
    mediaRef: `media-artifact:sha256:${'c'.repeat(64)}`,
    sourceRef: {
      entry: 'connector-event', sourceId: 'external-video', trust: 'external',
      profileId: 'external-profile', sessionId: 'media-session', eventId: 'external-event',
    },
    occurredAt: '2026-08-09T00:00:00.000Z',
  });
  const launderingChild = createMediaEvidence({
    schemaVersion: 1,
    mediaRef: externalParent.mediaRef,
    kind: 'video',
    mimeType: externalParent.mimeType,
    sha256: externalParent.sha256,
    bytes: externalParent.bytes,
    originalName: externalParent.originalName,
    sourceRef: {
      entry: 'derived-video-audio', sourceId: 'derived-audio', trust: 'owner',
      profileId: 'external-profile', sessionId: 'media-session', eventId: 'external-event',
      parentEvidenceId: externalParent.id,
    },
    occurredAt: externalParent.occurredAt,
    durationMs: 1_000,
    transcriptSegments: [],
    keyframes: [],
    timeRanges: [{ id: 'time-range:0', startMs: 0, endMs: 1_000 }],
    modelBinding: { status: 'local', adapter: 'fixture-audio-extractor' },
    derivedArtifactRefs: [],
    coverage: { status: 'partial', modalities: ['video', 'audio'], reason: 'audio track only' },
  });
  await assert.rejects(
    session.registerMediaEvidence([externalParent, launderingChild], 'run-1'),
    /不能提升父 Evidence 的 trust\/profile/,
  );
  assert.equal((await session.listMediaEvidence()).length, 1);
  await session.completeRun('done', 'run-1');
  await session.clearSession();
  assert.deepEqual(await session.listMediaEvidence(), []);
  assert.equal(await session.getMediaEvidence(evidence.id), undefined);
});

test('generated image Evidence maps the frozen model binding and preserves ref-only edit lineage', () => {
  const inputEvidenceId = `media-evidence:sha256:${'a'.repeat(64)}`;
  assert.equal(mediaEvidenceIdSchema.parse(inputEvidenceId), inputEvidenceId);
  const evidence = createGeneratedImageEvidence({
    attachment: {
      artifactRef: `media-artifact:sha256:${'b'.repeat(64)}`,
      sha256: 'b'.repeat(64),
      mediaType: 'image/png',
      bytes: png.length,
      name: 'generated.png',
    },
    binding: {
      target: { providerId: 'openai-main', modelId: 'gpt-image-1' },
      kind: 'image-generation',
      reasoning: 'off',
      scenario: 'image-editing.default',
      reason: 'explicit-work-unit',
      routeVersion: 7,
    },
    runId: 'run-generated-1',
    sessionId: 'session-generated-1',
    profileId: 'owner',
    workspaceId: 'workspace-1',
    eventId: 'event-generated-1',
    trust: 'owner',
    occurredAt: '2026-08-10T00:00:00.000Z',
    inputEvidenceIds: [inputEvidenceId],
  });

  assert.equal(evidence.sourceRef.entry, 'media-work-unit');
  assert.deepEqual(evidence.sourceRef.inputEvidenceIds, [inputEvidenceId]);
  assert.equal(evidence.sourceRef.parentEvidenceId, undefined);
  assert.deepEqual(evidence.modelBinding, {
    status: 'model',
    providerId: 'openai-main',
    modelId: 'gpt-image-1',
    scenario: 'image-editing.default',
    routeVersion: 7,
    selectionReason: 'explicit-work-unit',
  });
  assert.deepEqual(evidence.coverage, { status: 'full', modalities: ['image'] });
  assert.equal(evidence.imageOrdinal, 0);
  assert.doesNotMatch(JSON.stringify(evidence), /data:|base64|\/Users\//);
});

test('Session media registry accepts different-blob edit lineage and rejects missing or cross-scope inputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-session-media-lineage-'));
  const session = new FileSession(root, 'lineage-session');
  const original = createOriginalMediaEvidence({
    kind: 'image',
    sha256: '1'.repeat(64),
    mimeType: 'image/png',
    bytes: png.length,
    originalName: 'source.png',
    mediaRef: `media-artifact:sha256:${'1'.repeat(64)}`,
    sourceRef: {
      entry: 'local-attachment', sourceId: 'source-image', trust: 'owner', profileId: 'owner',
      workspaceId: 'workspace-1', sessionId: 'lineage-session', eventId: 'event-source',
    },
    occurredAt: '2026-08-10T00:00:00.000Z',
  });
  const generated = createGeneratedImageEvidence({
    attachment: {
      artifactRef: `media-artifact:sha256:${'2'.repeat(64)}`,
      sha256: '2'.repeat(64),
      mediaType: 'image/png',
      bytes: png.length + 1,
      name: 'edited.png',
    },
    binding: {
      target: { providerId: 'google-main', modelId: 'gemini-image' },
      kind: 'image-generation', reasoning: 'off', scenario: 'image-editing.default',
      reason: 'scenario-route', routeVersion: 3,
    },
    runId: 'run-lineage',
    sessionId: 'lineage-session',
    profileId: 'owner',
    workspaceId: 'workspace-1',
    eventId: 'event-edit',
    trust: 'owner',
    occurredAt: '2026-08-10T00:01:00.000Z',
    inputEvidenceIds: [original.id],
  });
  await session.beginRun('edit image', 'run-lineage', 'owner-lineage');
  assert.equal(await session.registerMediaEvidence([original, generated], 'run-lineage'), 2);
  assert.notEqual(generated.mediaRef, original.mediaRef);

  const missing = createGeneratedImageEvidence({
    attachment: {
      artifactRef: `media-artifact:sha256:${'3'.repeat(64)}`,
      sha256: '3'.repeat(64), mediaType: 'image/png', bytes: png.length, name: 'missing.png',
    },
    binding: {
      target: { providerId: 'google-main', modelId: 'gemini-image' },
      kind: 'image-generation', reasoning: 'off', scenario: 'image-editing.default',
      reason: 'scenario-route', routeVersion: 3,
    },
    runId: 'run-lineage', sessionId: 'lineage-session', profileId: 'owner',
    workspaceId: 'workspace-1', trust: 'owner', occurredAt: '2026-08-10T00:02:00.000Z',
    inputEvidenceIds: [`media-evidence:sha256:${'9'.repeat(64)}`],
  });
  await assert.rejects(
    session.registerMediaEvidence([missing], 'run-lineage'),
    /缺少输入 Evidence/,
  );

  for (const mismatch of [
    { trust: 'external' as const },
    { profileId: 'other-profile' },
    { sessionId: 'other-session' },
    { workspaceId: 'other-workspace' },
  ]) {
    const crossScope = createOriginalMediaEvidence({
      kind: 'image', sha256: '4'.repeat(64), mimeType: 'image/png', bytes: png.length,
      originalName: 'cross-scope.png', mediaRef: `media-artifact:sha256:${'4'.repeat(64)}`,
      sourceRef: {
        entry: 'local-attachment', sourceId: `cross-${Object.keys(mismatch)[0]}`,
        trust: 'owner', profileId: 'owner', workspaceId: 'workspace-1',
        sessionId: 'lineage-session', ...mismatch,
      },
      occurredAt: '2026-08-10T00:03:00.000Z',
    });
    const output = createGeneratedImageEvidence({
      attachment: {
        artifactRef: `media-artifact:sha256:${'5'.repeat(64)}`,
        sha256: '5'.repeat(64), mediaType: 'image/png', bytes: png.length, name: 'output.png',
      },
      binding: {
        target: { providerId: 'google-main', modelId: 'gemini-image' },
        kind: 'image-generation', reasoning: 'off', scenario: 'image-editing.default',
        reason: 'scenario-route', routeVersion: 3,
      },
      runId: 'run-lineage', sessionId: 'lineage-session', profileId: 'owner',
      workspaceId: 'workspace-1', trust: 'owner', occurredAt: '2026-08-10T00:04:00.000Z',
      inputEvidenceIds: [crossScope.id],
    });
    await assert.rejects(
      session.registerMediaEvidence([crossScope, output], 'run-lineage'),
      /不能注册到 lineage-session|不能跨 Session|input.*trust\/profile|不能跨 Workspace/u,
    );
  }
});

test('MediaEvidence edit lineage is unique, bounded and cannot reference itself', () => {
  const base = createOriginalMediaEvidence({
    kind: 'image', sha256: '6'.repeat(64), mimeType: 'image/png', bytes: png.length,
    originalName: 'base.png', mediaRef: `media-artifact:sha256:${'6'.repeat(64)}`,
    sourceRef: {
      entry: 'local-attachment', sourceId: 'base', trust: 'owner', profileId: 'owner',
    },
    occurredAt: '2026-08-10T00:00:00.000Z',
  });
  const content = {
    schemaVersion: 1 as const,
    mediaRef: `media-artifact:sha256:${'7'.repeat(64)}`,
    kind: 'image' as const,
    mimeType: 'image/png',
    sha256: '7'.repeat(64),
    bytes: png.length,
    originalName: 'result.png',
    sourceRef: {
      entry: 'media-work-unit' as const, sourceId: 'work-unit', trust: 'owner' as const,
      profileId: 'owner', inputEvidenceIds: [base.id, base.id],
    },
    occurredAt: '2026-08-10T00:00:00.000Z',
    imageOrdinal: 0,
    transcriptSegments: [], keyframes: [], timeRanges: [],
    modelBinding: {
      status: 'model' as const, providerId: 'google-main', modelId: 'gemini-image',
      scenario: 'image-editing.default', routeVersion: 1,
      selectionReason: 'explicit-work-unit' as const,
    },
    derivedArtifactRefs: [],
    coverage: { status: 'full' as const, modalities: ['image' as const] },
  };
  assert.throws(() => createMediaEvidence(content), /inputEvidenceIds.*唯一/u);
  assert.throws(() => createMediaEvidence({
    ...content,
    sourceRef: {
      ...content.sourceRef,
      inputEvidenceIds: Array.from({ length: 9 }, (_, index) => (
        `media-evidence:sha256:${String(index + 1).repeat(64)}`
      )),
    },
  }), /too_big|最多|8/u);

  const generated = createMediaEvidence({
    ...content,
    sourceRef: { ...content.sourceRef, inputEvidenceIds: [base.id] },
  });
  assert.throws(() => mediaEvidenceSchema.parse({
    ...generated,
    sourceRef: { ...generated.sourceRef, inputEvidenceIds: [generated.id] },
  }), /不能引用自身/u);
});
