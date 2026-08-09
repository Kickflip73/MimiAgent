import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MimiStore } from '../src/daemon/store.js';
import {
  MAX_GENERATED_IMAGE_BYTES,
  MediaArtifactStore,
  mediaArtifactOwner,
  sessionMediaArtifactOwner,
} from '../src/runtime/media-artifact-store.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

test('generated image bytes use the bounded CAS lifecycle without attachment Evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-generated-image-cas-'));
  const artifacts = path.join(root, 'artifacts');
  const store = new MediaArtifactStore(artifacts);
  const batch = await store.stageGeneratedImage({
    data: png,
    mediaType: 'image/png',
    originalName: 'generated.png',
  });
  assert.equal(batch.attachments.length, 1);
  const attachment = batch.attachments[0]!;
  assert.deepEqual(attachment, {
    kind: 'image',
    name: 'generated.png',
    mediaType: 'image/png',
    bytes: png.length,
    sha256: createHash('sha256').update(png).digest('hex'),
    artifactRef: `media-artifact:sha256:${createHash('sha256').update(png).digest('hex')}`,
  });
  assert.deepEqual(await store.read(attachment), png);

  await batch.commit(sessionMediaArtifactOwner('generated-session'));
  await store.verify(attachment);
  assert.ok((await readdir(path.join(artifacts, '.refs'))).some((name) => name.startsWith('session-')));
  assert.equal((await readdir(artifacts)).some((name) => name.startsWith('.staging-')), false);
});

test('generated image staging rolls back MIME mismatches and malformed containers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-generated-image-reject-'));
  const artifacts = path.join(root, 'artifacts');
  const store = new MediaArtifactStore(artifacts, { gcGraceMs: 0 });
  await assert.rejects(store.stageGeneratedImage({
    data: png,
    mediaType: 'image/jpeg',
    originalName: 'declared.jpg',
  }), /MIME.*不一致/);
  await assert.rejects(store.stageGeneratedImage({
    data: png.subarray(0, png.length - 12),
    mediaType: 'image/png',
    originalName: 'truncated.png',
  }), /容器截断、损坏/);
  await assert.rejects(store.stageGeneratedImage({
    data: png,
    mediaType: 'IMAGE\/PNG',
    originalName: 'uppercase.png',
  }), /MIME.*小写/);
  await assert.rejects(store.stageGeneratedImage({
    data: png,
    mediaType: 'image/png',
    originalName: '../private.png',
  }), /媒体原始名称/);
  assert.deepEqual(await readdir(path.join(artifacts, '.claims')), []);
  await store.collectGarbage({ liveReferenceIds: [] });
  assert.equal(
    (await readdir(artifacts)).filter((name) => /^[a-f0-9]{64}$/u.test(name)).length,
    0,
  );
});

test('generated image staging rejects empty and oversized byte payloads before creating CAS state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-generated-image-limit-'));
  const artifacts = path.join(root, 'artifacts');
  const store = new MediaArtifactStore(artifacts);
  await assert.rejects(store.stageGeneratedImage({
    data: new Uint8Array(),
    mediaType: 'image/png',
    originalName: 'empty.png',
  }), /不能为空/);
  await assert.rejects(store.stageGeneratedImage({
    data: new Uint8Array(MAX_GENERATED_IMAGE_BYTES + 1),
    mediaType: 'image/png',
    originalName: 'oversized.png',
  }), /超过.*bytes/);
  await assert.rejects(access(artifacts), { code: 'ENOENT' });
});

test('GC removes stale unbound generated claims without collecting a Session-owned blob', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-generated-image-unbound-gc-'));
  const artifacts = path.join(root, 'artifacts');
  const store = new MediaArtifactStore(artifacts, { gcGraceMs: 0 });
  const abandoned = await store.stageGeneratedImage({
    data: png,
    mediaType: 'image/png',
    originalName: 'abandoned.png',
  });
  const durable = await store.stageGeneratedImage({
    data: png,
    mediaType: 'image/png',
    originalName: 'durable.png',
  });
  const owner = sessionMediaArtifactOwner('generated-survivor');
  await durable.commit(owner);
  assert.equal((await readdir(path.join(artifacts, '.claims'))).length, 1);

  const collected = await store.collectGarbage({ liveReferenceIds: [] });
  assert.equal(collected.staleClaims, 1);
  assert.deepEqual(await readdir(path.join(artifacts, '.claims')), []);
  await store.verify(abandoned.attachments[0]!);

  await store.releaseOwner(owner);
  await store.collectGarbage({ liveReferenceIds: [] });
  await assert.rejects(store.verify(abandoned.attachments[0]!), /不存在或不可访问/);
});

function waveFixture(payloadBytes = 140 * 1024): Buffer {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 4, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(24_000, 12);
  fmt.writeUInt32LE(48_000, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const data = Buffer.alloc(8 + payloadBytes, 0x31);
  data.write('data', 0, 4, 'ascii');
  data.writeUInt32LE(payloadBytes, 4);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 4, 'ascii');
  riff.writeUInt32LE(4 + fmt.length + data.length, 4);
  riff.write('WAVE', 8, 4, 'ascii');
  return Buffer.concat([riff, fmt, data]);
}

test('Event prune cannot collect a shared blob until the Session owner releases it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-owner-lifecycle-'));
  const artifacts = path.join(root, 'artifacts');
  await writeFile(path.join(root, 'photo.png'), png);
  let now = new Date('2026-08-10T00:00:00.000Z');
  const store = new MediaArtifactStore(artifacts, {
    gcGraceMs: 1_000,
    now: () => now,
  });
  const batch = await store.stageBatch([{ path: 'photo.png', kind: 'image' }], root, {
    eventId: 'session:foo',
    sessionId: 'foo',
  });
  await batch.commit(mediaArtifactOwner('event', 'session:foo'));
  const attachment = batch.attachments[0]!;
  const sessionOwner = sessionMediaArtifactOwner('foo');
  const lease = await store.acquireEvidenceOwner(sessionOwner, [attachment.evidence!]);
  await lease.commit();
  assert.deepEqual(
    (await readdir(path.join(artifacts, '.refs'))).map((name) => name.split('-')[0]).sort(),
    ['event', 'session'],
  );

  await store.releaseOwner(mediaArtifactOwner('event', 'session:foo'));
  now = new Date(now.getTime() + 2_000);
  await store.collectGarbage({ now, liveReferenceIds: [] });
  await store.verify(attachment);

  await store.releaseOwner(sessionOwner);
  await store.collectGarbage({ now, liveReferenceIds: [] });
  await store.verify(attachment);
  now = new Date(now.getTime() + 1_001);
  const collected = await store.collectGarbage({ now, liveReferenceIds: [] });
  assert.equal(collected.deleted, 1);
  await assert.rejects(store.verify(attachment), /不存在或不可访问/);
});

test('startup GC reconciles prune-committed Event owners even if release did not run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-prune-restart-'));
  const artifacts = path.join(root, 'artifacts');
  await writeFile(path.join(root, 'photo.png'), png);
  let now = new Date('2026-08-10T01:00:00.000Z');
  const store = new MediaArtifactStore(artifacts, { gcGraceMs: 100, now: () => now });
  const batch = await store.stageBatch([{ path: 'photo.png', kind: 'image' }], root, {
    eventId: 'event-pruned-before-release',
  });
  await batch.commit(mediaArtifactOwner('event', 'event-pruned-before-release'));
  const attachment = batch.attachments[0]!;
  const sessionOwner = sessionMediaArtifactOwner('session-survivor');
  const lease = await store.acquireEvidenceOwner(sessionOwner, [attachment.evidence!]);
  await lease.commit();

  // Simulate restart after SQLite prune committed but before releaseOwner(eventId).
  now = new Date(now.getTime() + 1_000);
  const restarted = new MediaArtifactStore(artifacts, { gcGraceMs: 100, now: () => now });
  const first = await restarted.collectGarbage({ now, liveReferenceIds: [] });
  assert.equal(first.orphanEventOwners, 0);
  await restarted.verify(attachment);
  now = new Date(now.getTime() + 101);
  const second = await restarted.collectGarbage({ now, liveReferenceIds: [] });
  assert.equal(second.orphanEventOwners, 1);
  await restarted.verify(attachment);
  await restarted.releaseOwner(sessionOwner);
  await restarted.collectGarbage({ now, liveReferenceIds: [] });
  now = new Date(now.getTime() + 101);
  assert.equal((await restarted.collectGarbage({ now, liveReferenceIds: [] })).deleted, 1);
});

test('reopen promotes a crash-surviving claim when its durable Event is live', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-claim-reopen-'));
  const artifacts = path.join(root, 'artifacts');
  await writeFile(path.join(root, 'photo.png'), png);
  let now = new Date('2026-08-10T01:30:00.000Z');
  const staging = new MediaArtifactStore(artifacts, { gcGraceMs: 100, now: () => now });
  const batch = await staging.stageBatch([{ path: 'photo.png', kind: 'image' }], root, {
    eventId: 'event-live-after-stage-crash',
  });
  // SQLite commits the immutable Event, then the process dies before batch.commit().
  const databaseFile = path.join(root, 'mimi.db');
  const durable = new MimiStore(databaseFile);
  durable.appendEvent({
    id: 'event-live-after-stage-crash',
    externalId: 'event-live-after-stage-crash',
    source: 'local-cli',
    type: 'command.received',
    trust: 'owner',
    payload: { attachments: batch.attachments },
    profileId: 'owner',
    occurredAt: now.toISOString(),
    receivedAt: now.toISOString(),
  });
  durable.close();
  // Do not call commit/rollback: this is the process-death window after claims are fsynced.
  now = new Date(now.getTime() + 101);
  const reopened = new MediaArtifactStore(artifacts, { gcGraceMs: 100, now: () => now });
  const reopenedDatabase = new MimiStore(databaseFile);
  const repaired = await reopened.collectGarbage({
    now,
    liveReferenceIds: reopenedDatabase.listEventIds(),
  });
  assert.ok(reopenedDatabase.getImmutableEvent('event-live-after-stage-crash'));
  reopenedDatabase.close();
  assert.equal(repaired.staleClaims, 1);
  assert.deepEqual(
    (await readdir(path.join(artifacts, '.refs'))).map((name) => name.split('-')[0]),
    ['event'],
  );
  await reopened.verify(batch.attachments[0]!);
});

test('parallel rollback cannot remove a CAS claimed and committed by another batch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-rollback-race-'));
  const artifacts = path.join(root, 'artifacts');
  await writeFile(path.join(root, 'photo.png'), png);
  const store = new MediaArtifactStore(artifacts, { gcGraceMs: 0 });
  const first = await store.stageBatch([{ path: 'photo.png', kind: 'image' }], root, {
    eventId: 'event-rollback',
  });
  const second = await store.stageBatch([{ path: 'photo.png', kind: 'image' }], root, {
    eventId: 'event-commit',
  });
  await Promise.all([
    first.rollback(),
    second.commit(mediaArtifactOwner('event', 'event-commit')),
  ]);
  await store.collectGarbage({ liveReferenceIds: ['event-commit'] });
  await store.verify(second.attachments[0]!);
});

test('EEXIST CAS symlinks are rejected without chmod following the external target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-eexist-symlink-'));
  const artifacts = path.join(root, 'artifacts');
  const external = path.join(root, 'external-owner-file');
  await writeFile(path.join(root, 'photo.png'), png);
  await writeFile(external, 'owner data');
  await chmod(external, 0o640);
  await mkdir(artifacts, { mode: 0o700 });
  const sha256 = createHash('sha256').update(png).digest('hex');
  await symlink(external, path.join(artifacts, sha256));
  const before = (await stat(external)).mode & 0o777;
  await assert.rejects(
    new MediaArtifactStore(artifacts).stageBatch(
      [{ path: 'photo.png', kind: 'image' }],
      root,
      { eventId: 'event-symlink' },
    ),
    /ELOOP|symbolic link|符号链接/i,
  );
  assert.equal((await stat(external)).mode & 0o777, before);
});

test('readChunks consumes one verified fd and rejects pathname replacement before completion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-stream-toctou-'));
  const artifacts = path.join(root, 'artifacts');
  const original = waveFixture();
  await writeFile(path.join(root, 'clip.wav'), original);
  const store = new MediaArtifactStore(artifacts);
  const [attachment] = await store.stage([{ path: 'clip.wav', kind: 'audio' }], root);
  const iterator = store.readChunks(attachment!);
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.deepEqual(first.value, original.subarray(0, first.value.length));
  const artifact = path.join(artifacts, attachment!.sha256);
  await rename(artifact, `${artifact}.verified-inode`);
  await writeFile(artifact, Buffer.alloc(original.length, 0x72));
  await assert.rejects(async () => {
    while (!(await iterator.next()).done) {
      // Consume the complete range; terminal verification must still run.
    }
  }, /验证与消费之间被替换/);
});

test('missing CAS errors expose only the bounded attachment name, never its physical path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-path-firewall-'));
  const artifacts = path.join(root, 'artifacts');
  await writeFile(path.join(root, 'photo.png'), png);
  const store = new MediaArtifactStore(artifacts);
  const [attachment] = await store.stage([{ path: 'photo.png', kind: 'image' }], root);
  await rm(path.join(artifacts, attachment!.sha256));
  await assert.rejects(store.verify(attachment!), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /artifact 不存在或不可访问/iu);
    assert.doesNotMatch(error.message, new RegExp(root, 'u'));
    assert.doesNotMatch(error.message, /\/private\/|\/Users\//u);
    return true;
  });
});

test('global quota rejects new unique blobs before CAS publication', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-quota-'));
  const artifacts = path.join(root, 'artifacts');
  await writeFile(path.join(root, 'one.txt'), '12345');
  await writeFile(path.join(root, 'two.txt'), 'abcdef');
  const store = new MediaArtifactStore(artifacts, { maxStoreBytes: 5 });
  await store.stage([{ path: 'one.txt', kind: 'file' }], root, { eventId: 'event-one' });
  await assert.rejects(
    store.stageBatch([{ path: 'two.txt', kind: 'file' }], root, { eventId: 'event-two' }),
    /全局配额不足/,
  );
});

test('a stale live-Event snapshot only marks an owner and a later live snapshot cancels deletion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-event-snapshot-race-'));
  const artifacts = path.join(root, 'artifacts');
  await writeFile(path.join(root, 'photo.png'), png);
  let now = new Date('2026-08-10T03:00:00.000Z');
  const store = new MediaArtifactStore(artifacts, { gcGraceMs: 100, now: () => now });
  const batch = await store.stageBatch([{ path: 'photo.png', kind: 'image' }], root, {
    eventId: 'event-concurrent-commit',
  });
  await batch.commit(mediaArtifactOwner('event', 'event-concurrent-commit'));
  assert.equal((await store.collectGarbage({ now, liveReferenceIds: [] })).orphanEventOwners, 0);
  now = new Date(now.getTime() + 101);
  assert.equal((await store.collectGarbage({
    now,
    liveReferenceIds: ['event-concurrent-commit'],
  })).orphanEventOwners, 0);
  await store.verify(batch.attachments[0]!);
});

test('unowned legacy CAS files are reported and preserved without a controlled tombstone', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-legacy-unowned-'));
  const artifacts = path.join(root, 'artifacts');
  const store = new MediaArtifactStore(artifacts, { gcGraceMs: 0 });
  await store.collectGarbage({ liveReferenceIds: [] });
  const legacy = Buffer.from('legacy-live-media');
  const sha256 = createHash('sha256').update(legacy).digest('hex');
  await writeFile(path.join(artifacts, sha256), legacy);
  const result = await store.collectGarbage({
    now: new Date('2030-01-01T00:00:00.000Z'),
    liveReferenceIds: [],
  });
  assert.equal(result.unownedPreserved, 1);
  assert.deepEqual(await readFile(path.join(artifacts, sha256)), legacy);
});

test('owner commit failure retains its lease until startup reconciliation promotes it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-owner-commit-failure-'));
  const artifacts = path.join(root, 'artifacts');
  await writeFile(path.join(root, 'photo.png'), png);
  const store = new MediaArtifactStore(artifacts);
  const batch = await store.stageBatch([{ path: 'photo.png', kind: 'image' }], root, {
    eventId: 'event-owner-commit-failure',
  });
  await batch.commit(mediaArtifactOwner('event', 'event-owner-commit-failure'));
  const owner = sessionMediaArtifactOwner('session-owner-commit-failure');
  const lease = await store.acquireEvidenceOwner(owner, [batch.attachments[0]!.evidence!]);
  const referenceName = (await readdir(path.join(artifacts, '.refs')))
    .find((name) => name.startsWith('session-'))!;
  const shaDirectory = path.join(artifacts, '.refs', referenceName, batch.attachments[0]!.sha256);
  const external = path.join(root, 'external-marker-target');
  await writeFile(external, 'do not follow');
  await symlink(external, path.join(shaDirectory, 'committed'));
  await assert.rejects(lease.commit(), /ELOOP|symbolic link/i);
  assert.ok((await readdir(shaDirectory)).some((name) => name.startsWith('lease-')));
  await rm(path.join(shaDirectory, 'committed'), { force: true });
  await new MediaArtifactStore(artifacts).reconcileEvidenceOwner(
    owner,
    [batch.attachments[0]!.evidence!],
  );
  assert.deepEqual(await readdir(shaDirectory), ['committed']);
});

test('truncated and polyglot image and audio containers fail before publication', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-container-integrity-'));
  const artifacts = path.join(root, 'artifacts');
  const jpeg = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, ...Buffer.alloc(9),
    0xff, 0xda, 0x00, 0x08, ...Buffer.alloc(6), 0x01, 0x02,
    0xff, 0xd9,
  ]);
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  const wave = waveFixture(8);
  const valid = new Map<string, Buffer>([
    ['ok.png', png], ['ok.jpg', jpeg], ['ok.gif', gif], ['ok.wav', wave],
  ]);
  for (const [name, bytes] of valid) await writeFile(path.join(root, name), bytes);
  await new MediaArtifactStore(artifacts).stage([
    { path: 'ok.png', kind: 'image' },
    { path: 'ok.jpg', kind: 'image' },
    { path: 'ok.gif', kind: 'image' },
    { path: 'ok.wav', kind: 'audio' },
  ], root);

  const invalid = new Map<string, Buffer>([
    ['truncated.png', png.subarray(0, png.length - 12)],
    ['polyglot.png', Buffer.concat([png, Buffer.from('tail')])],
    ['truncated.jpg', jpeg.subarray(0, jpeg.length - 2)],
    ['polyglot.jpg', Buffer.concat([jpeg, Buffer.from('tail'), Buffer.from([0xff, 0xd9])])],
    ['truncated.gif', gif.subarray(0, gif.length - 1)],
    ['polyglot.gif', Buffer.concat([gif, Buffer.from('tail')])],
    ['polyglot.wav', Buffer.concat([wave, Buffer.from('tail')])],
  ]);
  for (const [name, bytes] of invalid) {
    await writeFile(path.join(root, name), bytes);
    await assert.rejects(
      new MediaArtifactStore(artifacts).stageBatch([{
        path: name,
        kind: name.endsWith('.wav') ? 'audio' : 'image',
      }], root),
      /容器截断、损坏或含尾随 polyglot/,
    );
  }
});

test('zero-dimension no-IDAT PNG and header-only PDF fail closed before publication', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-minimal-false-positive-'));
  const artifacts = path.join(root, 'artifacts');
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type: string, payload: Buffer) => {
    const typeBytes = Buffer.from(type, 'ascii');
    const output = Buffer.alloc(12 + payload.length);
    output.writeUInt32BE(payload.length, 0);
    typeBytes.copy(output, 4);
    payload.copy(output, 8);
    // Keep the exact fixture compact while retaining a valid CRC.
    return { output, crcInput: Buffer.concat([typeBytes, payload]) };
  };
  const ihdrPayload = Buffer.alloc(13);
  const ihdr = chunk('IHDR', ihdrPayload);
  const iend = chunk('IEND', Buffer.alloc(0));
  // PNG uses CRC32; calculate it locally so the rejection is about IHDR/IDAT semantics.
  const crc32 = (data: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  ihdr.output.writeUInt32BE(crc32(ihdr.crcInput), ihdr.output.length - 4);
  iend.output.writeUInt32BE(crc32(iend.crcInput), iend.output.length - 4);
  await writeFile(path.join(root, 'empty.png'), Buffer.concat([pngSignature, ihdr.output, iend.output]));
  await writeFile(path.join(root, 'header.pdf'), '%PDF-1.4\n%%EOF');
  await assert.rejects(
    new MediaArtifactStore(artifacts).stageBatch([{ path: 'empty.png', kind: 'image' }], root),
    /容器截断、损坏/,
  );
  await assert.rejects(
    new MediaArtifactStore(artifacts).stageBatch([{ path: 'header.pdf', kind: 'file' }], root),
    /PDF 暂不支持：缺少有界结构解析器/,
  );
});

test('unparsed AAC, MP3, FLAC and Ogg signatures fail closed before CAS publication', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-unparsed-streams-'));
  const artifacts = path.join(root, 'artifacts');
  const unsupported = new Map<string, Buffer>([
    ['truncated.aac', Buffer.from([0xff, 0xf1, 0x50, 0x80])],
    ['truncated.mp3', Buffer.from('ID3\x04\x00\x00', 'latin1')],
    ['truncated.flac', Buffer.from('fLaC\x00\x00', 'latin1')],
    ['truncated.ogg', Buffer.from('OggS\x00\x02', 'latin1')],
  ]);
  for (const [name, bytes] of unsupported) {
    await writeFile(path.join(root, name), bytes);
    await assert.rejects(
      new MediaArtifactStore(artifacts).stageBatch([{ path: name, kind: 'file' }], root),
      /暂不支持：缺少有界结构解析器/,
    );
  }
  assert.equal(
    (await readdir(artifacts)).filter((name) => /^[a-f0-9]{64}$/.test(name)).length,
    0,
  );
});

test('dead lock witness is recovered immediately even when its recorded PID is alive', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-dead-lock-'));
  const artifacts = path.join(root, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(root, 'note.txt'), 'hello');
  const installKilledMarker = async (marker: '.mutation.lock' | '.mutation.reap') => {
    const script = [
      "const fs=require('node:fs'); const net=require('node:net');",
      `const root=${JSON.stringify(artifacts)}; const marker=${JSON.stringify(marker)};`,
      "const token='killed-owner'; const server=net.createServer(s=>s.end(token));",
      "server.listen(0,'127.0.0.1',()=>{",
      " const port=server.address().port;",
      // Record the still-alive parent PID to simulate PID reuse; the token witness is authoritative.
      " fs.writeFileSync(root+'/'+marker,JSON.stringify({pid:process.ppid,token,witnessPort:port}));",
      " process.stdout.write('ready\\n');",
      "});",
      "setInterval(()=>{},1000);",
    ].join('');
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise<void>((resolve, reject) => {
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.includes('ready\n')) resolve();
      });
      child.once('error', reject);
    });
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  };
  await installKilledMarker('.mutation.lock');
  const startedAt = Date.now();
  const store = new MediaArtifactStore(artifacts, { lockTimeoutMs: 3_000 });
  await store.stage(
    [{ path: 'note.txt', kind: 'file' }],
    root,
    { eventId: 'event-after-kill' },
  );
  assert.ok(Date.now() - startedAt < 3_000);
  await installKilledMarker('.mutation.reap');
  await store.collectGarbage({ liveReferenceIds: ['event-after-kill'] });
});

test('a connected witness with a temporarily blocked event loop is never reaped', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-live-blocked-lock-'));
  const artifacts = path.join(root, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(root, 'note.txt'), 'hello');
  const script = [
    "const fs=require('node:fs'); const net=require('node:net');",
    `const root=${JSON.stringify(artifacts)};`,
    "const token='live-blocked-owner'; const server=net.createServer(s=>s.end(token));",
    "server.listen(0,'127.0.0.1',()=>{",
    " const witnessPort=server.address().port;",
    " fs.writeFileSync(root+'/.mutation.lock',JSON.stringify({pid:process.pid,token,witnessPort}));",
    " process.stdout.write('ready\\n',()=>{",
    "  const until=Date.now()+1200; while(Date.now()<until){}",
    "  server.close(()=>process.exit(0));",
    " });",
    "});",
  ].join('');
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.includes('ready\n')) resolve();
    });
    child.once('error', reject);
  });
  const store = new MediaArtifactStore(artifacts, { lockTimeoutMs: 500 });
  await assert.rejects(
    store.stage([{ path: 'note.txt', kind: 'file' }], root, { eventId: 'must-not-steal' }),
    /mutation lock 获取超时/,
  );
  await assert.rejects(stat(path.join(artifacts, '.mutation.reap')), { code: 'ENOENT' });
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  await store.stage([{ path: 'note.txt', kind: 'file' }], root, { eventId: 'after-owner-exit' });
});

test('a contender cannot enter before a live owner exits its delayed async critical section', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-media-lock-critical-barrier-'));
  const artifacts = path.join(root, 'artifacts');
  const ownerExited = path.join(root, 'owner-callback-exited');
  const moduleUrl = new URL('../src/runtime/media-artifact-store.ts', import.meta.url).href;
  const script = [
    "import { writeFile } from 'node:fs/promises';",
    `const { MediaArtifactStore }=await import(${JSON.stringify(moduleUrl)});`,
    `const store=new MediaArtifactStore(${JSON.stringify(artifacts)},{lockTimeoutMs:5000});`,
    "await store.withMutationLock(async()=>{",
    " process.stdout.write('entered\\n');",
    " const until=Date.now()+2000; while(Date.now()<until){}",
    " await new Promise(resolve=>setTimeout(resolve,300));",
    ` await writeFile(${JSON.stringify(ownerExited)},'exited');`,
    "});",
  ].join('');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  let errorOutput = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { errorOutput += chunk; });
  await new Promise<void>((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.includes('entered\n')) resolve();
    });
    child.once('error', reject);
  });

  const contenderStore = new MediaArtifactStore(artifacts, { lockTimeoutMs: 5_000 });
  const withMutationLock = (contenderStore as unknown as {
    withMutationLock<T>(operation: () => Promise<T>): Promise<T>;
  }).withMutationLock.bind(contenderStore);
  const contender = withMutationLock(async () => {
    // This is the first contender operation after lock acquisition. ENOENT proves it
    // entered while the owner's callback was still in its awaited critical section.
    await access(ownerExited);
  });
  const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
  const [contenderResult, childResult] = await Promise.allSettled([contender, exit]);
  assert.equal(childResult.status, 'fulfilled');
  assert.equal(childResult.status === 'fulfilled' ? childResult.value : undefined, 0, errorOutput);
  if (contenderResult.status === 'rejected') throw contenderResult.reason;
});
