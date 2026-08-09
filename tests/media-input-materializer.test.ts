import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentInputItem } from '@openai/agents';
import {
  createOriginalMediaEvidence,
  type MediaEvidence,
  type MediaTrust,
} from '../src/core/media-evidence.js';
import { FileSession } from '../src/core/session.js';
import {
  MediaArtifactStore,
  sessionMediaArtifactOwner,
  type StagedAttachment,
} from '../src/runtime/media-artifact-store.js';
import { materializeMediaEvidenceReferences } from '../src/runtime/media-input-materializer.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

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

function pngChunk(type: string, payload: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + payload.length);
  chunk.writeUInt32BE(payload.length, 0);
  typeBytes.copy(chunk, 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])), chunk.length - 4);
  return chunk;
}

function pngWithLabel(label: string): Buffer {
  return Buffer.concat([
    png.subarray(0, png.length - 12),
    pngChunk('tEXt', Buffer.from(label, 'utf8')),
    png.subarray(png.length - 12),
  ]);
}

interface Fixture {
  root: string;
  sessionDirectory: string;
  artifactRoot: string;
  session: FileSession;
  artifacts: MediaArtifactStore;
  evidence: MediaEvidence[];
  authority: {
    sessionId: string;
    profileId: string;
    workspaceId?: string;
    trust: MediaTrust;
  };
}

class CountingMediaArtifactStore extends MediaArtifactStore {
  reads = 0;

  override async read(attachment: StagedAttachment): Promise<Buffer> {
    this.reads += 1;
    return super.read(attachment);
  }
}

async function fixture(images: readonly Buffer[] = [png]): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-materializer-'));
  const sessionDirectory = path.join(root, 'sessions');
  const artifactRoot = path.join(root, 'attachments');
  const sessionId = 'materializer-session';
  const runId = 'materializer-source-run';
  const authority = {
    sessionId,
    profileId: 'owner',
    workspaceId: 'workspace-A',
    trust: 'owner' as const,
  };
  const session = new FileSession(sessionDirectory, sessionId);
  const artifacts = new MediaArtifactStore(artifactRoot);
  await session.ensure();
  await session.beginRun('stage source images', runId, 'materializer-owner');
  const evidence: MediaEvidence[] = [];
  for (const [index, bytes] of images.entries()) {
    const name = `source-${index}.png`;
    await writeFile(path.join(root, name), bytes);
    const batch = await artifacts.stageBatch([{ path: name, kind: 'image' }], root, {
      profileId: authority.profileId,
      workspaceId: authority.workspaceId,
      sessionId,
      runId,
      sourceId: `materializer:${index}`,
      trust: authority.trust,
      occurredAt: `2026-08-10T00:00:0${index}.000Z`,
    });
    const item = batch.attachments[0]?.evidence;
    assert.ok(item);
    assert.equal(await session.registerMediaEvidence([item], runId), 1);
    await batch.commit(sessionMediaArtifactOwner(sessionId));
    evidence.push(item);
  }
  await session.completeRun('sources durable', runId);
  return { root, sessionDirectory, artifactRoot, session, artifacts, evidence, authority };
}

function userContent(result: string | AgentInputItem[]): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  const user = result[0] as unknown as Record<string, unknown>;
  assert.equal(user.role, 'user');
  assert.ok(Array.isArray(user.content));
  return user.content as Array<Record<string, unknown>>;
}

test('materializes exact image bytes in reference order and survives Session restart', async () => {
  const second = pngWithLabel('second-image');
  const source = await fixture([png, second]);
  const restartedSession = new FileSession(source.sessionDirectory, source.authority.sessionId);
  const restartedArtifacts = new MediaArtifactStore(source.artifactRoot);
  const result = await materializeMediaEvidenceReferences({
    input: 'compare these originals',
    evidenceIds: [source.evidence[1]!.id, source.evidence[0]!.id],
    session: restartedSession,
    artifacts: restartedArtifacts,
    authority: source.authority,
  });
  const content = userContent(result);
  assert.equal(content.length, 5);
  assert.deepEqual(content[0], { type: 'input_text', text: 'compare these originals' });
  assert.match(String(content[1]?.text), new RegExp(source.evidence[1]!.id, 'u'));
  assert.match(String(content[3]?.text), new RegExp(source.evidence[0]!.id, 'u'));
  const firstData = String(content[2]?.image).replace(/^data:image\/png;base64,/u, '');
  const secondData = String(content[4]?.image).replace(/^data:image\/png;base64,/u, '');
  assert.deepEqual(Buffer.from(firstData, 'base64'), second);
  assert.deepEqual(Buffer.from(secondData, 'base64'), png);
});

test('appends to the unique structured user unit without mutating the input', async () => {
  const source = await fixture();
  const input = [{
    role: 'user',
    content: [{ type: 'input_text', text: 'inspect it' }],
  }] as AgentInputItem[];
  const snapshot = structuredClone(input);
  const result = await materializeMediaEvidenceReferences({
    input,
    evidenceIds: [source.evidence[0]!.id],
    session: source.session,
    artifacts: source.artifacts,
    authority: source.authority,
  });
  assert.deepEqual(input, snapshot);
  assert.notEqual(result, input);
  const content = userContent(result);
  assert.deepEqual(content[0], { type: 'input_text', text: 'inspect it' });
  assert.equal(content[1]?.type, 'input_text');
  assert.equal(content[2]?.type, 'input_image');
});

test('rejects missing and cross-authority Evidence before artifact materialization', async () => {
  const source = await fixture();
  const id = source.evidence[0]!.id;
  const missing = `media-evidence:sha256:${'f'.repeat(64)}`;
  await assert.rejects(materializeMediaEvidenceReferences({
    input: 'missing', evidenceIds: [missing], session: source.session,
    artifacts: source.artifacts, authority: source.authority,
  }), /不存在 MediaEvidence/u);

  for (const [name, authority, pattern] of [
    ['session', { ...source.authority, sessionId: 'other-session' }, /Session/u],
    ['profile', { ...source.authority, profileId: 'other-profile' }, /profile/u],
    ['workspace', { ...source.authority, workspaceId: 'workspace-B' }, /Workspace/u],
    ['trust', { ...source.authority, trust: 'external' as const }, /trust/u],
  ] as const) {
    await assert.rejects(materializeMediaEvidenceReferences({
      input: name, evidenceIds: [id], session: source.session,
      artifacts: source.artifacts, authority,
    }), pattern);
  }

  const audioRunId = 'non-image-evidence-run';
  await source.session.beginRun('register non-image metadata', audioRunId, 'non-image-owner');
  const audio = createOriginalMediaEvidence({
    kind: 'audio',
    sha256: 'a'.repeat(64),
    mimeType: 'audio/wav',
    bytes: 128,
    originalName: 'voice.wav',
    mediaRef: `media-artifact:sha256:${'a'.repeat(64)}`,
    sourceRef: {
      entry: 'local-attachment', sourceId: 'non-image:audio',
      trust: source.authority.trust, profileId: source.authority.profileId,
      workspaceId: source.authority.workspaceId, sessionId: source.authority.sessionId,
      runId: audioRunId,
    },
    occurredAt: '2026-08-10T00:30:00.000Z',
  });
  assert.equal(await source.session.registerMediaEvidence([audio], audioRunId), 1);
  await source.session.completeRun('non-image metadata durable', audioRunId);
  await assert.rejects(materializeMediaEvidenceReferences({
    input: 'audio is not an image', evidenceIds: [audio.id], session: source.session,
    artifacts: source.artifacts, authority: source.authority,
  }), /不是可注入模型的图片/u);
});

test('rejects tampered CAS bytes and reference count or identity abuse', async () => {
  const source = await fixture();
  const item = source.evidence[0]!;
  await assert.rejects(materializeMediaEvidenceReferences({
    input: 'duplicates', evidenceIds: [item.id, item.id], session: source.session,
    artifacts: source.artifacts, authority: source.authority,
  }), /必须唯一/u);
  await assert.rejects(materializeMediaEvidenceReferences({
    input: 'too many',
    evidenceIds: Array.from({ length: 9 }, (_, index) => (
      `media-evidence:sha256:${index.toString(16).padStart(64, '0')}`
    )),
    session: source.session,
    artifacts: source.artifacts,
    authority: source.authority,
  }), /最多 8 个/u);

  await writeFile(path.join(source.artifactRoot, item.sha256), Buffer.alloc(item.bytes, 0x61));
  await assert.rejects(materializeMediaEvidenceReferences({
    input: 'tampered', evidenceIds: [item.id], session: source.session,
    artifacts: source.artifacts, authority: source.authority,
  }), /摘要不匹配/u);
});

test('rejects ambiguous structured user input and total inline bytes above 20MiB', async () => {
  const source = await fixture();
  const id = source.evidence[0]!.id;
  for (const input of [
    [{ role: 'assistant', content: 'no user' }],
    [{ role: 'user', content: 'one' }, { role: 'user', content: 'two' }],
  ]) {
    await assert.rejects(materializeMediaEvidenceReferences({
      input: input as AgentInputItem[], evidenceIds: [id], session: source.session,
      artifacts: source.artifacts, authority: source.authority,
    }), /恰好包含一个当前 user/u);
  }

  const runId = 'oversized-evidence-run';
  await source.session.beginRun('register oversized metadata', runId, 'oversized-owner');
  const oversized = [0, 1, 2].map((index) => createOriginalMediaEvidence({
    kind: 'image',
    sha256: `${index + 1}`.repeat(64),
    mimeType: 'image/png',
    bytes: 7 * 1024 * 1024,
    originalName: `oversized-${index}.png`,
    mediaRef: `media-artifact:sha256:${`${index + 1}`.repeat(64)}`,
    sourceRef: {
      entry: 'local-attachment', sourceId: `oversized:${index}`,
      trust: source.authority.trust, profileId: source.authority.profileId,
      workspaceId: source.authority.workspaceId, sessionId: source.authority.sessionId,
      runId,
    },
    occurredAt: `2026-08-10T01:00:0${index}.000Z`,
  }));
  assert.equal(await source.session.registerMediaEvidence(oversized, runId), 3);
  await source.session.completeRun('oversized metadata durable', runId);
  await assert.rejects(materializeMediaEvidenceReferences({
    input: 'do not allocate', evidenceIds: oversized.map((item) => item.id),
    session: source.session, artifacts: source.artifacts, authority: source.authority,
  }), /合计超过 20MB/u);

  const currentInline = Buffer.alloc(14 * 1024 * 1024, 0x61).toString('base64');
  const countingArtifacts = new CountingMediaArtifactStore(source.artifactRoot);
  await assert.rejects(materializeMediaEvidenceReferences({
    input: [{
      role: 'user',
      content: [{
        type: 'input_file', filename: 'current.bin',
        file: `data:application/octet-stream;base64,${currentInline}`,
      }],
    }] as AgentInputItem[],
    evidenceIds: [oversized[0]!.id],
    session: source.session,
    artifacts: countingArtifacts,
    authority: source.authority,
  }), /合计超过 20MB/u);
  assert.equal(countingArtifacts.reads, 0);

  await assert.rejects(materializeMediaEvidenceReferences({
    input: [{
      role: 'user',
      content: Array.from({ length: 8 }, (_, index) => ({
        type: 'input_image',
        image: `data:image/png;base64,${Buffer.from([index]).toString('base64')}`,
      })),
    }] as AgentInputItem[],
    evidenceIds: [id],
    session: source.session,
    artifacts: countingArtifacts,
    authority: source.authority,
  }), /合计最多 8 个/u);
  assert.equal(countingArtifacts.reads, 0);

  await assert.rejects(materializeMediaEvidenceReferences({
    input: [{
      role: 'user',
      content: [{ type: 'input_image', image: 'data:image/png;base64,not-base64!' }],
    }] as AgentInputItem[],
    evidenceIds: [id],
    session: source.session,
    artifacts: source.artifacts,
    authority: source.authority,
  }), /base64/u);
  await assert.rejects(materializeMediaEvidenceReferences({
    input: [{
      role: 'user',
      content: [{ type: 'input_image', image: 'https://example.invalid/private.png' }],
    }] as AgentInputItem[],
    evidenceIds: [id],
    session: source.session,
    artifacts: source.artifacts,
    authority: source.authority,
  }), /canonical base64 data URL/u);
});
