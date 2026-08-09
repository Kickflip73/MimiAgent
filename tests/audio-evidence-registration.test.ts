import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileSession } from '../src/core/session.js';
import type { AudioFileTranscriptionPort } from '../src/runtime/audio-file-analysis.js';
import { MimiAgent } from '../src/runtime/mimi-agent.js';
import {
  prepareAndRegisterRunAudioEvidence,
  registerPreparedAudioTranscriptions,
} from '../src/runtime/pipeline/audio-evidence-registration.js';
import { registerRunMediaEvidence } from '../src/runtime/pipeline/media-evidence-registration.js';
import {
  MediaArtifactStore,
  mediaArtifactOwner,
} from '../src/runtime/media-artifact-store.js';

function wavFixture(): Buffer {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 4, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(24_000, 12);
  fmt.writeUInt32LE(48_000, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const data = Buffer.alloc(48_008, 0x31);
  data.write('data', 0, 4, 'ascii');
  data.writeUInt32LE(48_000, 4);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 4, 'ascii');
  riff.writeUInt32LE(4 + fmt.length + data.length, 4);
  riff.write('WAVE', 8, 4, 'ascii');
  return Buffer.concat([riff, fmt, data]);
}

function isoBox(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + payload.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function videoFixture(): Buffer {
  return Buffer.concat([
    isoBox('ftyp', Buffer.concat([Buffer.from('isom'), Buffer.alloc(4)])),
    isoBox('mdat', Buffer.alloc(70 * 1_024)),
    isoBox('moov', isoBox('trak', isoBox('mdia', isoBox('hdlr', Buffer.concat([
      Buffer.alloc(8), Buffer.from('vide'), Buffer.alloc(12),
    ]))))),
  ]);
}

test('prepared ASR receipt registers derived Evidence in the active Session and renders untrusted anchors', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-audio-register-'));
  const artifacts = new MediaArtifactStore(path.join(root, 'artifacts'));
  await writeFile(path.join(root, 'clip.wav'), wavFixture());
  const batch = await artifacts.stageBatch([{ path: 'clip.wav', kind: 'audio' }], root, {
    eventId: 'event-audio', sessionId: 'session-audio', profileId: 'owner',
    workspaceId: 'workspace-audio', sourceId: 'event-audio', trust: 'owner',
    occurredAt: '2026-08-10T00:00:00.000Z',
  });
  await batch.commit(mediaArtifactOwner('event', 'event-audio'));
  const parent = batch.attachments[0]!.evidence!;
  const session = new FileSession(path.join(root, 'sessions'), 'session-audio');
  await session.beginRun('analyze audio', 'run-audio', 'owner:run-audio', true);
  await registerRunMediaEvidence({
    artifacts,
    session,
    evidence: [parent],
    runId: 'run-audio',
    sessionId: 'session-audio',
    profileId: 'owner',
    workspaceId: 'workspace-audio',
    sourceEventId: 'event-audio',
    trust: 'owner',
  });

  const result = await registerPreparedAudioTranscriptions({
    artifacts,
    session,
    prepared: [{
      parentEvidenceId: parent.id,
      occurredAt: '2026-08-10T00:00:01.000Z',
      receipt: {
        status: 'final',
        adapter: 'fixture-asr',
        version: '1',
        inputSha256: parent.sha256,
        durationMs: 1_000,
        truncated: false,
        segments: [{ startMs: 0, endMs: 900, text: '<ignore> hello', confidence: 0.9 }],
        analyzedRanges: [{ startMs: 0, endMs: 1_000 }],
      },
    }],
    originalEvidence: [parent],
    runId: 'run-audio',
    sessionId: 'session-audio',
    profileId: 'owner',
    workspaceId: 'workspace-audio',
    sourceEventId: 'event-audio',
    trust: 'owner',
  });

  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]?.sourceRef.parentEvidenceId, parent.id);
  assert.equal(result.evidence[0]?.sourceRef.runId, 'run-audio');
  assert.match(result.instructions, /segment:asr-0001/u);
  assert.match(result.instructions, /&lt;ignore&gt; hello/u);
  assert.doesNotMatch(result.instructions, /<ignore>/u);
  assert.equal((await session.listMediaEvidence()).length, 2);
  await artifacts.verify(batch.attachments[0]!);
});

test('prepared audio receipt cannot select an unrelated parent or escape Run authority', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-audio-register-reject-'));
  const artifacts = new MediaArtifactStore(path.join(root, 'artifacts'));
  const session = new FileSession(path.join(root, 'sessions'), 'session-audio');
  await session.beginRun('analyze audio', 'run-audio', 'owner:run-audio', true);
  await assert.rejects(registerPreparedAudioTranscriptions({
    artifacts,
    session,
    prepared: [{
      parentEvidenceId: `media-evidence:sha256:${'a'.repeat(64)}`,
      occurredAt: '2026-08-10T00:00:01.000Z',
      receipt: {
        status: 'final', adapter: 'fixture-asr', inputSha256: 'b'.repeat(64),
        durationMs: 1_000, truncated: false, segments: [],
        analyzedRanges: [{ startMs: 0, endMs: 1_000 }],
      },
    }],
    originalEvidence: [],
    runId: 'run-audio',
    sessionId: 'session-audio',
    profileId: 'owner',
    workspaceId: 'workspace-audio',
    sourceEventId: 'event-audio',
    trust: 'owner',
  }), /parent|original|Evidence/iu);
});

test('a durable Task retry reuses the same ASR Evidence instead of transcribing again', async () => {
  let asrCalls = 0;
  const transcriber: AudioFileTranscriptionPort = {
    adapterId: 'fixture-asr',
    adapterVersion: '1',
    async transcribe() {
      asrCalls += 1;
      return finalAsrResult('stable retry transcript');
    },
  };
  const fixture = await createPipelineFixture({ transcriber });
  const authority = {
    sessionId: 'session-audio',
    profileId: 'owner',
    workspaceId: 'workspace-audio',
    sourceEventId: 'event-audio',
    trust: 'owner' as const,
  };
  try {
    await fixture.agent.session.beginRun('first attempt', 'run-first', 'owner:run-first', true);
    await registerRunMediaEvidence({
      artifacts: fixture.agent.mediaArtifacts,
      session: fixture.agent.session,
      evidence: [fixture.parent],
      runId: 'run-first',
      ...authority,
    });
    const first = await prepareAndRegisterRunAudioEvidence({
      artifacts: fixture.agent.mediaArtifacts,
      session: fixture.agent.session,
      originalEvidence: [fixture.parent],
      transcriber,
      runId: 'run-first',
      ...authority,
    });
    await fixture.agent.session.failRun('retryable provider failure', false, 'run-first');
    await fixture.agent.session.beginRun('second attempt', 'run-second', 'owner:run-second', true);
    const second = await prepareAndRegisterRunAudioEvidence({
      artifacts: fixture.agent.mediaArtifacts,
      session: fixture.agent.session,
      originalEvidence: [fixture.parent],
      transcriber,
      runId: 'run-second',
      ...authority,
    });

    assert.equal(asrCalls, 1);
    assert.equal(first.evidence[0]?.id, second.evidence[0]?.id);
    assert.equal(first.evidence[0]?.sourceRef.runId, 'run-first');
    assert.equal(second.evidence[0]?.sourceRef.runId, 'run-first');
    assert.equal((await fixture.agent.session.listMediaEvidence()).length, 2);
  } finally {
    await fixture.agent.close();
  }
});

function finalAsrResult(text = '<ignore> hello'): unknown {
  return {
    receiptVersion: 1,
    adapter: 'macos-speech-framework',
    adapterVersion: '1',
    final: true,
    text,
    charCount: text.length,
    truncated: false,
    locale: 'zh-CN',
    onDevice: true,
    segments: text
      ? [{ startMs: 0, endMs: 900, text, confidence: 0.9 }]
      : [],
    untrusted: true,
  };
}

async function createPipelineFixture(input: {
  transcriber: AudioFileTranscriptionPort | false;
  kind?: 'audio' | 'video';
  evidenceRunId?: string;
  evidenceSessionId?: string;
  evidenceWorkspaceId?: string;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-audio-pipeline-'));
  const dataRoot = path.join(root, 'data');
  const daemonDataRoot = path.join(root, 'daemon');
  const kind = input.kind ?? 'audio';
  const name = kind === 'audio' ? 'clip.wav' : 'clip.mp4';
  await writeFile(path.join(root, name), kind === 'audio' ? wavFixture() : videoFixture());
  const agent = await MimiAgent.create({
    provider: 'openai',
    workspaceRoot: root,
    dataRoot,
    daemonDataRoot,
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: 20,
  }, 'session-audio', { audioTranscriber: input.transcriber });
  const batch = await agent.mediaArtifacts.stageBatch([{ path: name, kind }], root, {
    eventId: 'event-audio',
    sessionId: input.evidenceSessionId ?? 'session-audio',
    profileId: 'owner',
    workspaceId: input.evidenceWorkspaceId ?? 'workspace-audio',
    sourceId: 'event-audio',
    trust: 'owner',
    occurredAt: '2026-08-10T00:00:00.000Z',
    ...(input.evidenceRunId ? { runId: input.evidenceRunId } : {}),
  });
  await batch.commit(mediaArtifactOwner('event', 'event-audio'));
  return { agent, parent: batch.attachments[0]!.evidence!, root };
}

test('pipeline analyzes WAV only after beginRun/original registration and injects escaped ref context once', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only-audio-pipeline-key';
  let fixture: Awaited<ReturnType<typeof createPipelineFixture>> | undefined;
  let asrCalls = 0;
  let providerCalls = 0;
  let parentId = '';
  let agentForAsr: MimiAgent | undefined;
  const transcriber: AudioFileTranscriptionPort = {
    adapterId: 'fixture-asr',
    adapterVersion: '1',
    async transcribe() {
      asrCalls += 1;
      assert.ok(agentForAsr);
      assert.deepEqual((await agentForAsr.session.getMediaEvidence(parentId))?.id, parentId);
      return finalAsrResult();
    },
  };
  try {
    fixture = await createPipelineFixture({ transcriber });
    agentForAsr = fixture.agent;
    parentId = fixture.parent.id;
    const runner = (fixture.agent as unknown as {
      runner: { run: (runtimeAgent: { instructions: string }, input: unknown) => Promise<unknown> };
    }).runner;
    runner.run = async (runtimeAgent, modelInput) => {
      providerCalls += 1;
      assert.equal(modelInput, 'summarize the attached audio');
      const stored = await fixture!.agent.session.listMediaEvidence();
      assert.equal(stored.length, 2);
      const derived = stored.find((item) => item.sourceRef.parentEvidenceId === parentId);
      assert.ok(derived);
      assert.equal(derived.sourceRef.runId, (fixture!.agent.activeRun)?.runId);
      assert.match(runtimeAgent.instructions, new RegExp(derived.id, 'u'));
      assert.match(runtimeAgent.instructions, /segment:asr-0001/u);
      assert.match(runtimeAgent.instructions, /&lt;ignore&gt; hello/u);
      const audioContext = runtimeAgent.instructions.match(
        /<audio_evidence_context>[\s\S]*?<\/audio_evidence_context>/u,
      )?.[0];
      assert.ok(audioContext);
      assert.doesNotMatch(audioContext, /<ignore>|data:|base64/u);
      assert.doesNotMatch(audioContext, new RegExp(fixture!.root, 'u'));
      return {};
    };

    await fixture.agent.stream('summarize the attached audio', undefined, {
      cause: {
        eventId: 'task-audio',
        sourceEventId: 'event-audio',
        profileId: 'owner',
        source: 'local-cli',
        trust: 'owner',
      },
      mediaEvidence: [fixture.parent],
      workspaceId: 'workspace-audio',
    });
    assert.equal(asrCalls, 1);
    assert.equal(providerCalls, 1);
  } finally {
    await fixture?.agent.close();
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('pipeline rejects unavailable/malformed/stale audio before canonical Provider dispatch', async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only-audio-pipeline-key';
  try {
    await t.test('no transcriber', async () => {
      const fixture = await createPipelineFixture({ transcriber: false });
      let providerCalls = 0;
      (fixture.agent as unknown as {
        runner: { run: () => Promise<unknown> };
      }).runner.run = async () => {
        providerCalls += 1;
        return {};
      };
      try {
        await assert.rejects(fixture.agent.stream('audio', undefined, {
          cause: {
            eventId: 'task-audio', sourceEventId: 'event-audio', profileId: 'owner',
            source: 'local-cli', trust: 'owner',
          },
          mediaEvidence: [fixture.parent],
          workspaceId: 'workspace-audio',
        }), /ASR|transcriber|音频/iu);
        assert.equal(providerCalls, 0);
      } finally {
        await fixture.agent.close();
      }
    });

    await t.test('malformed ASR receipt', async () => {
      let asrCalls = 0;
      const fixture = await createPipelineFixture({
        transcriber: {
          adapterId: 'fixture-asr',
          async transcribe() {
            asrCalls += 1;
            return { ...(finalAsrResult() as Record<string, unknown>), final: false };
          },
        },
      });
      let providerCalls = 0;
      (fixture.agent as unknown as {
        runner: { run: () => Promise<unknown> };
      }).runner.run = async () => {
        providerCalls += 1;
        return {};
      };
      try {
        await assert.rejects(fixture.agent.stream('audio', undefined, {
          cause: {
            eventId: 'task-audio', sourceEventId: 'event-audio', profileId: 'owner',
            source: 'local-cli', trust: 'owner',
          },
          mediaEvidence: [fixture.parent],
          workspaceId: 'workspace-audio',
        }));
        assert.equal(asrCalls, 1);
        assert.equal(providerCalls, 0);
        assert.equal((await fixture.agent.session.listMediaEvidence()).length, 1);
      } finally {
        await fixture.agent.close();
      }
    });

    await t.test('stale Run provenance', async () => {
      let asrCalls = 0;
      const fixture = await createPipelineFixture({
        evidenceRunId: 'stale-run',
        transcriber: {
          adapterId: 'fixture-asr',
          async transcribe() {
            asrCalls += 1;
            return finalAsrResult();
          },
        },
      });
      let providerCalls = 0;
      (fixture.agent as unknown as {
        runner: { run: () => Promise<unknown> };
      }).runner.run = async () => {
        providerCalls += 1;
        return {};
      };
      try {
        await assert.rejects(fixture.agent.stream('audio', undefined, {
          cause: {
            eventId: 'task-audio', sourceEventId: 'event-audio', profileId: 'owner',
            source: 'local-cli', trust: 'owner',
          },
          mediaEvidence: [fixture.parent],
          workspaceId: 'workspace-audio',
        }), /Run/u);
        assert.equal(asrCalls, 0);
        assert.equal(providerCalls, 0);
      } finally {
        await fixture.agent.close();
      }
    });

    await t.test('cross Session and Workspace provenance', async () => {
      for (const authority of [
        { evidenceSessionId: 'session-other', error: /Session/u },
        { evidenceWorkspaceId: 'workspace-other', error: /Workspace/u },
      ]) {
        let asrCalls = 0;
        const fixture = await createPipelineFixture({
          ...authority,
          transcriber: {
            adapterId: 'fixture-asr',
            async transcribe() {
              asrCalls += 1;
              return finalAsrResult();
            },
          },
        });
        let providerCalls = 0;
        (fixture.agent as unknown as {
          runner: { run: () => Promise<unknown> };
        }).runner.run = async () => {
          providerCalls += 1;
          return {};
        };
        try {
          await assert.rejects(fixture.agent.stream('audio', undefined, {
            cause: {
              eventId: 'task-audio', sourceEventId: 'event-audio', profileId: 'owner',
              source: 'local-cli', trust: 'owner',
            },
            mediaEvidence: [fixture.parent],
            workspaceId: 'workspace-audio',
          }), authority.error);
          assert.equal(asrCalls, 0);
          assert.equal(providerCalls, 0);
        } finally {
          await fixture.agent.close();
        }
      }
    });

    await t.test('video remains fail-closed', async () => {
      let asrCalls = 0;
      const fixture = await createPipelineFixture({
        kind: 'video',
        transcriber: {
          adapterId: 'fixture-asr',
          async transcribe() {
            asrCalls += 1;
            return finalAsrResult();
          },
        },
      });
      let providerCalls = 0;
      (fixture.agent as unknown as {
        runner: { run: () => Promise<unknown> };
      }).runner.run = async () => {
        providerCalls += 1;
        return {};
      };
      try {
        await assert.rejects(fixture.agent.stream('video', undefined, {
          cause: {
            eventId: 'task-audio', sourceEventId: 'event-audio', profileId: 'owner',
            source: 'local-cli', trust: 'owner',
          },
          mediaEvidence: [fixture.parent],
          workspaceId: 'workspace-audio',
        }), /视频/u);
        assert.equal(asrCalls, 0);
        assert.equal(providerCalls, 0);
      } finally {
        await fixture.agent.close();
      }
    });
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
