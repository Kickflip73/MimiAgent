import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import test from 'node:test';
import {
  prepareWavAudioTranscription,
  recoverStaleAudioSnapshots,
  type AudioFileTranscriptionPort,
} from '../src/runtime/audio-file-analysis.js';
import {
  MediaArtifactStore,
  mediaArtifactOwner,
} from '../src/runtime/media-artifact-store.js';

function wavFixture(durationMs = 1_000): Buffer {
  const sampleRate = 24_000;
  const payloadBytes = Math.floor(sampleRate * 2 * durationMs / 1_000);
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 4, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * 2, 16);
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

function runtime(
  execute: AudioFileTranscriptionPort['transcribe'],
): AudioFileTranscriptionPort {
  return {
    adapterId: 'macos-speech-file-asr',
    adapterVersion: '1',
    transcribe: execute,
  };
}

async function stagedWav() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-audio-analysis-'));
  const artifactRoot = path.join(root, 'artifacts');
  const source = path.join(root, 'clip.wav');
  const bytes = wavFixture();
  await writeFile(source, bytes);
  const artifacts = new MediaArtifactStore(artifactRoot);
  const batch = await artifacts.stageBatch([{ path: 'clip.wav', kind: 'audio' }], root, {
    eventId: 'event-audio',
    sessionId: 'session-audio',
    profileId: 'owner',
    workspaceId: 'workspace-audio',
    sourceId: 'event-audio',
    trust: 'owner',
    occurredAt: '2026-08-10T00:00:00.000Z',
  });
  await batch.commit(mediaArtifactOwner('event', 'event-audio'));
  return { root, artifactRoot, attachment: batch.attachments[0]!, bytes };
}

test('verified PCM WAV is copied to an ephemeral file and returns a ref-only final ASR receipt', async () => {
  const staged = await stagedWav();
  let temporaryPath = '';
  const transcriber = runtime(async (request) => {
    temporaryPath = request.filePath;
    assert.notEqual(path.dirname(temporaryPath), staged.artifactRoot);
    assert.deepEqual(await readFile(temporaryPath), staged.bytes);
    return {
      receiptVersion: 1,
      adapter: 'macos-speech-framework',
      adapterVersion: '1',
      final: true,
      text: 'hello world',
      charCount: 11,
      truncated: false,
      locale: 'en-US',
      onDevice: true,
      segments: [
        { startMs: 0, endMs: 400, text: 'hello', confidence: 0.9 },
        { startMs: 500, endMs: 900, text: 'world', confidence: 0.8 },
      ],
      untrusted: true,
    };
  });

  const prepared = await prepareWavAudioTranscription({
    attachment: staged.attachment,
    artifacts: new MediaArtifactStore(staged.artifactRoot),
    transcriber,
    occurredAt: '2026-08-10T00:00:01.000Z',
  });

  assert.equal(prepared.parentEvidenceId, staged.attachment.evidence?.id);
  assert.equal(prepared.receipt.status, 'final');
  assert.equal(prepared.receipt.inputSha256, staged.attachment.sha256);
  assert.equal(prepared.receipt.durationMs, 1_000);
  assert.deepEqual(prepared.receipt.analyzedRanges, [{ startMs: 0, endMs: 1_000 }]);
  assert.deepEqual(prepared.receipt.segments.map((segment) => segment.text), ['hello', 'world']);
  assert.doesNotMatch(JSON.stringify(prepared), /data:|base64|\/private\/|\/Users\//u);
  await assert.rejects(access(temporaryPath));
});

test('tampered CAS and unregistered or malformed transcription receipts fail before durable derivation', async () => {
  const staged = await stagedWav();
  const physical = path.join(staged.artifactRoot, staged.attachment.sha256);
  await writeFile(physical, Buffer.alloc(staged.attachment.bytes, 0x41));
  let calls = 0;
  await assert.rejects(prepareWavAudioTranscription({
    attachment: staged.attachment,
    artifacts: new MediaArtifactStore(staged.artifactRoot),
    transcriber: runtime(async () => {
      calls += 1;
      throw new Error('must not execute');
    }),
    occurredAt: '2026-08-10T00:00:01.000Z',
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'AudioPreparationError');
    assert.doesNotMatch(error.message, new RegExp(staged.root, 'u'));
    assert.doesNotMatch(error.message, /attachments|sha256|摘要|\/private\/|\/Users\//iu);
    return true;
  });
  assert.equal(calls, 0);

  const clean = await stagedWav();
  await assert.rejects(prepareWavAudioTranscription({
    attachment: clean.attachment,
    artifacts: new MediaArtifactStore(clean.artifactRoot),
    transcriber: runtime(async () => ({
      receiptVersion: 1, adapter: 'macos-speech-framework', adapterVersion: '1',
      final: true, text: 'leak', charCount: 4, truncated: false, locale: 'en-US',
      onDevice: true, segments: [], untrusted: true,
      audioPath: '/Users/owner/private.wav',
    } as never)),
    occurredAt: '2026-08-10T00:00:01.000Z',
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'AudioPreparationError');
    assert.doesNotMatch(error.message, new RegExp(clean.root, 'u'));
    assert.doesNotMatch(error.message, /\/private\/|\/Users\//u);
    return true;
  });

  const missing = await stagedWav();
  await rm(path.join(missing.artifactRoot, missing.attachment.sha256));
  await assert.rejects(prepareWavAudioTranscription({
    attachment: missing.attachment,
    artifacts: new MediaArtifactStore(missing.artifactRoot),
    transcriber: runtime(async () => { throw new Error('must not execute'); }),
    occurredAt: '2026-08-10T00:00:01.000Z',
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'AudioPreparationError');
    assert.doesNotMatch(error.message, new RegExp(missing.root, 'u'));
    assert.doesNotMatch(error.message, /attachments|\/private\/|\/Users\//u);
    return true;
  });
});

test('startup recovery removes private audio snapshots owned by a dead process only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-audio-recovery-'));
  const dead = path.join(root, 'dead-owner');
  const live = path.join(root, 'live-owner');
  await Promise.all([mkdir(dead), mkdir(live)]);
  await Promise.all([
    writeFile(path.join(dead, '.owner'), JSON.stringify({ schemaVersion: 1, pid: 2_147_483_647 })),
    writeFile(path.join(live, '.owner'), JSON.stringify({ schemaVersion: 1, pid: process.pid })),
    writeFile(path.join(dead, 'input.wav'), 'private-dead-audio'),
    writeFile(path.join(live, 'input.wav'), 'active-audio'),
  ]);

  assert.equal(await recoverStaleAudioSnapshots(root), 1);
  await assert.rejects(access(dead));
  assert.equal(await readFile(path.join(live, 'input.wav'), 'utf8'), 'active-audio');
  await rm(live, { recursive: true, force: true });
});
