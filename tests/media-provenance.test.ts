import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMediaEvidence, createOriginalMediaEvidence } from '../src/core/media-evidence.js';
import { evidenceFromMedia } from '../src/core/memory/compilation-v2.js';
import { FileSession } from '../src/core/session.js';

function originalAudio(workspaceId = 'workspace-a') {
  return createOriginalMediaEvidence({
    kind: 'audio',
    sha256: 'a'.repeat(64),
    mimeType: 'audio/wav',
    bytes: 128,
    originalName: 'clip.wav',
    mediaRef: `media-artifact:sha256:${'a'.repeat(64)}`,
    sourceRef: {
      entry: 'local-attachment', sourceId: 'event-1:0', trust: 'owner', profileId: 'owner',
      workspaceId, sessionId: 'media-session', eventId: 'event-1',
    },
    occurredAt: '2026-08-09T00:00:00.000Z',
  });
}

function analyzedAudio(parent = originalAudio()) {
  return createMediaEvidence({
    schemaVersion: 1,
    mediaRef: parent.mediaRef,
    kind: parent.kind,
    mimeType: parent.mimeType,
    sha256: parent.sha256,
    bytes: parent.bytes,
    originalName: parent.originalName,
    sourceRef: {
      entry: 'derived-audio-slice', sourceId: 'asr:event-1', trust: 'owner', profileId: 'owner',
      workspaceId: parent.sourceRef.workspaceId,
      sessionId: 'media-session', eventId: 'event-2', parentEvidenceId: parent.id,
    },
    occurredAt: '2026-08-09T00:00:01.000Z',
    durationMs: 2_000,
    transcriptSegments: [
      { id: 'segment:one', startMs: 0, endMs: 900, text: 'one' },
      { id: 'segment:two', startMs: 1_000, endMs: 1_900, text: 'two' },
    ],
    keyframes: [],
    timeRanges: [{ id: 'time-range:full', startMs: 0, endMs: 2_000 }],
    modelBinding: { status: 'local', adapter: 'fixture-asr' },
    derivedArtifactRefs: [],
    coverage: { status: 'full', modalities: ['audio', 'transcript'] },
  });
}

test('media locators have unique ids and Memory identity includes the canonical anchor', () => {
  const parent = originalAudio();
  const analyzed = analyzedAudio(parent);
  const first = evidenceFromMedia(analyzed, 'owner', 'workspace-a', {
    kind: 'segment', segmentId: 'segment:one',
  });
  const second = evidenceFromMedia(analyzed, 'owner', 'workspace-a', {
    kind: 'segment', segmentId: 'segment:two',
  });
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.digest, second.digest);
  assert.throws(
    () => evidenceFromMedia(analyzed, 'owner', 'workspace-b', {
      kind: 'segment', segmentId: 'segment:one',
    }),
    /Memory workspace/u,
  );

  const { id: _id, ...analyzedContent } = analyzed;
  assert.throws(() => createMediaEvidence({
    ...analyzedContent,
    transcriptSegments: [
      { id: 'segment:duplicate', startMs: 0, endMs: 500, text: 'one' },
      { id: 'segment:duplicate', startMs: 500, endMs: 1_000, text: 'two' },
    ],
  }), /transcriptSegments id 必须唯一/u);

  assert.throws(() => createMediaEvidence({
    ...analyzedContent,
    modelBinding: { status: 'unprocessed' },
    coverage: { status: 'metadata-only', modalities: ['audio'], reason: 'not analyzed' },
  }), /不能携带派生分析内容/u);
  assert.throws(() => createMediaEvidence({
    ...analyzedContent,
    modelBinding: { status: 'unsupported', reason: 'no route' },
    coverage: { status: 'unsupported', modalities: ['audio'], reason: 'no route' },
  }), /不能携带派生分析内容/u);
  assert.throws(() => createMediaEvidence({
    ...analyzedContent,
    timeRanges: [{ id: 'time-range:tiny', startMs: 0, endMs: 1 }],
  }), /连续覆盖/u);
});

test('derived MediaEvidence cannot swap the parent asset or workspace lineage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-lineage-'));
  const session = new FileSession(root, 'media-session');
  const parent = originalAudio();
  const analyzed = analyzedAudio(parent);
  const { id: _id, ...analyzedContent } = analyzed;
  const unrelated = createMediaEvidence({
    ...analyzedContent,
    mediaRef: `media-artifact:sha256:${'b'.repeat(64)}`,
    sha256: 'b'.repeat(64),
  });
  await session.beginRun('analyze', 'run-1', 'owner-1');
  await assert.rejects(
    session.registerMediaEvidence([parent, unrelated], 'run-1'),
    /父媒体资产身份不一致/u,
  );
  assert.deepEqual(await session.listMediaEvidence(), []);

  const crossWorkspace = createMediaEvidence({
    ...analyzedContent,
    sourceRef: {
      ...analyzedContent.sourceRef,
      workspaceId: 'workspace-b',
    },
  });
  await assert.rejects(
    session.registerMediaEvidence([parent, crossWorkspace], 'run-1'),
    /不能跨 Workspace/u,
  );
  assert.deepEqual(await session.listMediaEvidence(), []);
});
