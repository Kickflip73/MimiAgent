import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalAudioEvidenceAnchors,
  createDerivedAudioEvidence,
  type CreateDerivedAudioEvidenceInput,
} from '../src/core/audio-evidence.js';
import {
  createMediaEvidence,
  createOriginalMediaEvidence,
  type MediaEvidence,
} from '../src/core/media-evidence.js';

const sha256 = 'a'.repeat(64);

function originalAudio(): MediaEvidence {
  return createOriginalMediaEvidence({
    kind: 'audio',
    sha256,
    mimeType: 'audio/wav',
    bytes: 96_044,
    originalName: 'meeting.wav',
    mediaRef: `media-artifact:sha256:${sha256}`,
    sourceRef: {
      entry: 'local-attachment',
      sourceId: 'event-source:audio:0',
      trust: 'owner',
      profileId: 'owner',
      workspaceId: 'workspace:opaque-a',
      sessionId: 'session-a',
      eventId: 'event-source',
      runId: 'run-source',
    },
    occurredAt: '2026-08-10T00:00:00.000Z',
  });
}

function input(overrides: Partial<CreateDerivedAudioEvidenceInput> = {}): CreateDerivedAudioEvidenceInput {
  return {
    parent: originalAudio(),
    authoritativeDurationMs: 2_000,
    occurredAt: '2026-08-10T00:00:01.000Z',
    eventId: 'event-analysis',
    runId: 'run-analysis',
    receipt: {
      status: 'final',
      adapter: 'macos-speech-file-asr',
      version: '1.0.0',
      inputSha256: sha256,
      durationMs: 2_000,
      truncated: false,
      segments: [
        { startMs: 0, endMs: 800, text: 'hello', confidence: 0.95 },
        { startMs: 900, endMs: 1_100, text: 'world', confidence: 0.9 },
      ],
      analyzedRanges: [
        { startMs: 0, endMs: 1_000 },
        { startMs: 1_000, endMs: 2_000 },
      ],
    },
    ...overrides,
  };
}

test('final WAV ASR receipt creates full derived Evidence with inherited authority and canonical anchors', () => {
  const parent = originalAudio();
  const result = createDerivedAudioEvidence(input({ parent }));

  assert.equal(result.evidence.mediaRef, parent.mediaRef);
  assert.equal(result.evidence.sha256, parent.sha256);
  assert.equal(result.evidence.kind, parent.kind);
  assert.equal(result.evidence.mimeType, parent.mimeType);
  assert.equal(result.evidence.bytes, parent.bytes);
  assert.equal(result.evidence.originalName, parent.originalName);
  assert.equal(result.evidence.sourceRef.parentEvidenceId, parent.id);
  assert.equal(result.evidence.sourceRef.profileId, parent.sourceRef.profileId);
  assert.equal(result.evidence.sourceRef.sessionId, parent.sourceRef.sessionId);
  assert.equal(result.evidence.sourceRef.workspaceId, parent.sourceRef.workspaceId);
  assert.equal(result.evidence.sourceRef.trust, parent.sourceRef.trust);
  assert.equal(result.evidence.sourceRef.eventId, 'event-analysis');
  assert.equal(result.evidence.sourceRef.runId, 'run-analysis');
  assert.deepEqual(result.evidence.modelBinding, {
    status: 'local', adapter: 'macos-speech-file-asr', version: '1.0.0',
  });
  assert.deepEqual(result.evidence.coverage, {
    status: 'full', modalities: ['audio', 'transcript'],
  });
  assert.deepEqual(
    result.evidence.transcriptSegments.map((segment) => segment.id),
    ['segment:asr-0001', 'segment:asr-0002'],
  );
  assert.deepEqual(
    result.evidence.timeRanges.map((range) => range.id),
    ['time-range:asr-0001', 'time-range:asr-0002'],
  );
  assert.deepEqual(result.anchors, [
    { kind: 'segment', segmentId: 'segment:asr-0001' },
    { kind: 'segment', segmentId: 'segment:asr-0002' },
    { kind: 'time-range', timeRangeId: 'time-range:asr-0001' },
    { kind: 'time-range', timeRangeId: 'time-range:asr-0002' },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /data:|base64|\/Users\//u);
});

test('partial ASR coverage is sorted, bounded and always carries a reason', () => {
  const result = createDerivedAudioEvidence(input({
    receipt: {
      status: 'final',
      adapter: 'fixture-asr',
      inputSha256: sha256,
      durationMs: 2_000,
      truncated: true,
      segments: [
        { startMs: 1_000, endMs: 1_400, text: 'second' },
        { startMs: 100, endMs: 400, text: 'first' },
      ],
      analyzedRanges: [
        { startMs: 1_000, endMs: 1_500 },
        { startMs: 0, endMs: 500 },
      ],
    },
  }));

  assert.equal(result.evidence.coverage.status, 'partial');
  assert.match(result.evidence.coverage.reason ?? '', /truncated/u);
  assert.match(result.evidence.coverage.reason ?? '', /continuous/u);
  assert.deepEqual(
    result.evidence.transcriptSegments.map((segment) => [segment.id, segment.text]),
    [
      ['segment:asr-0001', 'first'],
      ['segment:asr-0002', 'second'],
    ],
  );
  assert.deepEqual(
    result.evidence.timeRanges.map((range) => [range.id, range.startMs, range.endMs]),
    [
      ['time-range:asr-0001', 0, 500],
      ['time-range:asr-0002', 1_000, 1_500],
    ],
  );
});

test('a final full-range silence receipt creates local Evidence without inventing transcript text', () => {
  const result = createDerivedAudioEvidence(input({
    receipt: {
      status: 'final',
      adapter: 'fixture-asr',
      inputSha256: sha256,
      durationMs: 2_000,
      truncated: false,
      segments: [],
      analyzedRanges: [{ startMs: 0, endMs: 2_000 }],
    },
  }));

  assert.deepEqual(result.evidence.transcriptSegments, []);
  assert.deepEqual(result.evidence.coverage, { status: 'full', modalities: ['audio'] });
  assert.deepEqual(result.anchors, [
    { kind: 'time-range', timeRangeId: 'time-range:asr-0001' },
  ]);
});

test('audio derivation rejects unbound, non-final, malformed and oversized ASR receipts', () => {
  assert.throws(() => createDerivedAudioEvidence(input({
    receipt: { ...input().receipt, inputSha256: 'b'.repeat(64) },
  })), /digest/u);
  assert.throws(() => createDerivedAudioEvidence(input({
    receipt: { ...input().receipt, durationMs: 1_999 },
  })), /duration/u);
  assert.throws(() => createDerivedAudioEvidence({
    ...input(),
    receipt: { ...input().receipt, status: 'interim' },
  } as unknown as CreateDerivedAudioEvidenceInput), /final/u);
  assert.throws(() => createDerivedAudioEvidence(input({
    receipt: {
      ...input().receipt,
      segments: [{ startMs: 0, endMs: 2_001, text: 'outside' }],
    },
  })), /duration/u);
  assert.throws(() => createDerivedAudioEvidence(input({
    receipt: {
      ...input().receipt,
      segments: [{ startMs: 750, endMs: 900, text: 'not analyzed' }],
      analyzedRanges: [{ startMs: 0, endMs: 500 }],
    },
  })), /analyzed range/u);
  assert.throws(() => createDerivedAudioEvidence(input({
    receipt: {
      ...input().receipt,
      segments: Array.from({ length: 129 }, (_, index) => ({
        startMs: index,
        endMs: index + 1,
        text: 'x',
      })),
    },
  })), /128/u);
  assert.throws(() => createDerivedAudioEvidence({
    ...input(),
    modelBinding: { status: 'local', adapter: 'caller-controlled' },
  } as unknown as CreateDerivedAudioEvidenceInput), /Unrecognized key/u);
  assert.throws(() => createDerivedAudioEvidence(input({
    receipt: { ...input().receipt, adapter: '/Users/private/asr' },
  })));
});

test('audio derivation accepts only original WAV audio and rejects unsupported lineage', () => {
  const image = createOriginalMediaEvidence({
    kind: 'image',
    sha256,
    mimeType: 'image/png',
    bytes: 128,
    originalName: 'image.png',
    mediaRef: `media-artifact:sha256:${sha256}`,
    sourceRef: {
      entry: 'local-attachment', sourceId: 'image', trust: 'owner', profileId: 'owner',
    },
    occurredAt: '2026-08-10T00:00:00.000Z',
  });
  assert.throws(() => createDerivedAudioEvidence(input({ parent: image })), /WAV audio/u);

  const parent = originalAudio();
  assert.throws(() => canonicalAudioEvidenceAnchors(parent), /processed audio Evidence/u);
  const { id: _parentId, ...parentContent } = parent;
  const unsupported = createMediaEvidence({
    ...parentContent,
    modelBinding: { status: 'unsupported', reason: 'no local adapter' },
    coverage: { status: 'unsupported', modalities: ['audio'], reason: 'no local adapter' },
  });
  assert.throws(
    () => createDerivedAudioEvidence(input({ parent: unsupported })),
    /unprocessed original/u,
  );
  assert.throws(() => canonicalAudioEvidenceAnchors(unsupported), /processed audio Evidence/u);

  const parentWithDuration = createOriginalMediaEvidence({
    kind: 'audio',
    sha256,
    mimeType: 'audio/wav',
    bytes: 96_044,
    originalName: 'meeting.wav',
    mediaRef: `media-artifact:sha256:${sha256}`,
    sourceRef: parent.sourceRef,
    occurredAt: parent.occurredAt,
    durationMs: 1_999,
  });
  assert.throws(
    () => createDerivedAudioEvidence(input({ parent: parentWithDuration })),
    /authoritative duration/u,
  );
});
