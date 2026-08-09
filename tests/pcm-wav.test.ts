import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MediaArtifactStore } from '../src/runtime/media-artifact-store.js';
import { parsePcm16Wav } from '../src/runtime/pcm-wav.js';

interface WavFixtureOptions {
  encoding?: number;
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  byteRate?: number;
  blockAlign?: number;
  fmtChunks?: number;
  dataChunks?: number;
  trailing?: Buffer;
}

function riffChunk(kind: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(kind, 0, 4, 'ascii');
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([
    header,
    payload,
    ...(payload.length % 2 ? [Buffer.alloc(1)] : []),
  ]);
}

function wavFixture(options: WavFixtureOptions = {}): Buffer {
  const channels = options.channels ?? 1;
  const sampleRate = options.sampleRate ?? 16_000;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const blockAlign = options.blockAlign ?? channels * (bitsPerSample / 8);
  const byteRate = options.byteRate ?? sampleRate * blockAlign;
  const format = Buffer.alloc(16);
  format.writeUInt16LE(options.encoding ?? 1, 0);
  format.writeUInt16LE(channels, 2);
  format.writeUInt32LE(sampleRate, 4);
  format.writeUInt32LE(byteRate, 8);
  format.writeUInt16LE(blockAlign, 12);
  format.writeUInt16LE(bitsPerSample, 14);
  const data = Buffer.alloc(byteRate / 10, 0x11);
  const body = Buffer.concat([
    ...Array.from({ length: options.fmtChunks ?? 1 }, () => riffChunk('fmt ', format)),
    ...Array.from({ length: options.dataChunks ?? 1 }, () => riffChunk('data', data)),
  ]);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WAVE', 8, 4, 'ascii');
  return Buffer.concat([header, body, options.trailing ?? Buffer.alloc(0)]);
}

async function parseFixture(bytes: Buffer) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-pcm-wav-'));
  const file = path.join(root, 'fixture.wav');
  await writeFile(file, bytes);
  const handle = await open(file, 'r');
  try {
    return await parsePcm16Wav(handle, bytes.length);
  } finally {
    await handle.close();
  }
}

test('PCM WAV parser accepts one exact PCM16 fmt/data pair and returns authoritative metadata', async () => {
  const bytes = wavFixture();
  assert.deepEqual(await parseFixture(bytes), {
    durationMs: 100,
    sampleRate: 16_000,
    channels: 1,
    dataBytes: 3_200,
  });
});

test('PCM WAV parser rejects float/extensible, inconsistent format, duplicate chunks and polyglot tails', async () => {
  const invalid = [
    ['float', wavFixture({ encoding: 3 })],
    ['extensible', wavFixture({ encoding: 0xfffe })],
    ['byte-rate', wavFixture({ byteRate: 31_999 })],
    ['block-align', wavFixture({ blockAlign: 4 })],
    ['duplicate-fmt', wavFixture({ fmtChunks: 2 })],
    ['duplicate-data', wavFixture({ dataChunks: 2 })],
    ['polyglot-tail', wavFixture({ trailing: Buffer.from('polyglot') })],
  ] as const;
  for (const [label, bytes] of invalid) {
    await assert.rejects(parseFixture(bytes), /PCM WAV|PCM16 WAV/u, label);
  }
});

test('audio/wav ingress applies the PCM parser before publishing a CAS artifact', async () => {
  const invalid = [
    ['float', wavFixture({ encoding: 3 })],
    ['extensible', wavFixture({ encoding: 0xfffe })],
    ['byte-rate', wavFixture({ byteRate: 31_999 })],
    ['block-align', wavFixture({ blockAlign: 4 })],
    ['duplicate-fmt', wavFixture({ fmtChunks: 2 })],
    ['duplicate-data', wavFixture({ dataChunks: 2 })],
    ['polyglot-tail', wavFixture({ trailing: Buffer.from('polyglot') })],
  ] as const;
  for (const [label, bytes] of invalid) {
    const root = await mkdtemp(path.join(os.tmpdir(), `mimi-pcm-ingress-${label}-`));
    const artifactRoot = path.join(root, 'artifacts');
    await writeFile(path.join(root, 'clip.wav'), bytes);
    const store = new MediaArtifactStore(artifactRoot);
    await assert.rejects(
      store.stageBatch([{ path: 'clip.wav', kind: 'audio' }], root, { eventId: `event-${label}` }),
      /附件容器截断、损坏或含尾随 polyglot 数据/u,
      label,
    );
    const entries = await readdir(artifactRoot);
    assert.deepEqual(entries.filter((entry) => /^[a-f0-9]{64}$/u.test(entry)), [], label);
  }

  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-pcm-ingress-valid-'));
  const artifactRoot = path.join(root, 'artifacts');
  const bytes = wavFixture();
  await writeFile(path.join(root, 'clip.wav'), bytes);
  const batch = await new MediaArtifactStore(artifactRoot).stageBatch(
    [{ path: 'clip.wav', kind: 'audio' }],
    root,
    { eventId: 'event-valid' },
  );
  assert.equal(batch.attachments[0]?.sha256, createHash('sha256').update(bytes).digest('hex'));
  await batch.rollback();
});
