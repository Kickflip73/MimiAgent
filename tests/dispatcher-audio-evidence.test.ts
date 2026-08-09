import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AttentionEngine } from '../src/daemon/attention.js';
import { MimiDispatcher } from '../src/daemon/dispatcher.js';
import { MimiStore } from '../src/daemon/store.js';
import { stageAttachments } from '../src/runtime/attachments.js';
import type { AudioFileTranscriptionPort } from '../src/runtime/audio-file-analysis.js';
import { MimiAgent } from '../src/runtime/mimi-agent.js';

function wavFixture(durationMs = 1_000): Buffer {
  const sampleRate = 24_000;
  const payloadBytes = sampleRate * 2 * durationMs / 1_000;
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

function transcriptionPort(
  transcribe: AudioFileTranscriptionPort['transcribe'],
): AudioFileTranscriptionPort {
  return { adapterId: 'macos-speech-file-asr', adapterVersion: '1', transcribe };
}

test('CLI audio attachment derives timestamped Evidence inside the canonical Run before Provider dispatch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-audio-'));
  const workspace = path.join(root, 'workspace');
  const dataRoot = path.join(root, 'data');
  const attachmentRoot = path.join(root, 'attachments');
  await mkdir(workspace, { recursive: true });
  const audio = wavFixture();
  await writeFile(path.join(workspace, 'clip.wav'), audio);
  const occurredAt = '2026-08-10T00:00:00.000Z';
  const eventId = 'audio-source-event';
  const staged = await stageAttachments(
    [{ path: 'clip.wav', kind: 'audio' }],
    workspace,
    attachmentRoot,
    {
      eventId,
      sourceId: eventId,
      sessionId: 'owner',
      profileId: 'owner',
      trust: 'owner',
      occurredAt,
    },
  );
  let temporaryPath = '';
  let asrCalls = 0;
  const transcriber = transcriptionPort(async (request) => {
    asrCalls += 1;
    temporaryPath = request.filePath;
    assert.deepEqual(await readFile(request.filePath), audio);
    return {
      receiptVersion: 1,
      adapter: 'macos-speech-framework',
      adapterVersion: '1',
      final: true,
      text: '今天下午三点提醒我喝水',
      charCount: 11,
      truncated: false,
      locale: 'zh-CN',
      onDevice: true,
      segments: [{
        startMs: 0,
        endMs: 900,
        text: '今天下午三点提醒我喝水',
        confidence: 0.9,
      }],
      untrusted: true,
    };
  });
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only-audio-pipeline-key';
  const agent = await MimiAgent.create({
    provider: 'openai',
    workspaceRoot: workspace,
    dataRoot,
    daemonDataRoot: root,
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: 20,
  }, 'owner', { audioTranscriber: transcriber });
  let providerCalls = 0;
  let providerInstructions = '';
  let providerInput: unknown;
  const runner = (agent as unknown as {
    runner: { run: (...args: unknown[]) => Promise<unknown> };
  }).runner;
  runner.run = async (runtimeAgent, modelInput) => {
    providerCalls += 1;
    providerInstructions = (runtimeAgent as { instructions: string }).instructions;
    providerInput = modelInput;
    return {
      rawResponses: [],
      runContext: { usage: {} },
      finalOutput: '好的，我会按音频内容处理。',
      completed: Promise.resolve(),
      cancelled: false,
      interruptions: [],
      async *[Symbol.asyncIterator]() {},
    };
  };
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const dispatcher = new MimiDispatcher(store, agent, attention, undefined, undefined, {
    attachmentRoot,
    maxAttempts: 1,
  });
  try {
    const routed = store.ingestEvent({
      id: eventId,
      externalId: eventId,
      source: 'local-cli',
      kind: 'command',
      trust: 'owner',
      profileId: 'owner',
      sessionKey: 'owner',
      priority: 100,
      occurredAt,
      receivedAt: occurredAt,
      payload: { prompt: '请按音频内容回答', attachments: staged },
    });
    assert.ok(routed.task);
    assert.equal(await dispatcher.processTaskById(routed.task.id), true);
    const terminal = store.getTask(routed.task.id);
    assert.equal(terminal?.status, 'completed', terminal?.error);
    assert.equal(asrCalls, 1);
    assert.equal(providerCalls, 1);
    assert.match(providerInstructions, /audio_evidence_context/u);
    assert.match(providerInstructions, /今天下午三点提醒我喝水/u);
    assert.match(providerInstructions, /segment:asr-0001/u);
    const audioContext = providerInstructions.match(
      /<audio_evidence_context>[\s\S]*?<\/audio_evidence_context>/u,
    )?.[0];
    assert.ok(audioContext);
    assert.doesNotMatch(audioContext, /\/private\/|\/Users\/|data:|base64/iu);
    assert.doesNotMatch(JSON.stringify(providerInput), /input_file|data:|base64/iu);
    const evidence = await agent.session.listMediaEvidence();
    assert.equal(evidence.length, 2);
    const original = evidence.find((item) => item.sourceRef.entry === 'local-attachment');
    const derived = evidence.find((item) => item.sourceRef.entry === 'derived-audio-slice');
    assert.ok(original);
    assert.ok(derived);
    assert.equal(derived.sourceRef.parentEvidenceId, original.id);
    assert.ok(derived.sourceRef.runId);
    assert.deepEqual(derived.transcriptSegments.map((item) => item.text), [
      '今天下午三点提醒我喝水',
    ]);
    const finalization = (terminal.result as {
      finalization?: {
        evidenceRefs: string[];
        mediaAnchors: Array<{ evidenceId: string; anchor: { kind: string } }>;
      };
    }).finalization;
    assert.ok(finalization);
    assert.deepEqual(finalization.evidenceRefs, [original.id, derived.id, original.mediaRef].sort());
    assert.ok(finalization.mediaAnchors.some((item) => (
      item.evidenceId === original.id && item.anchor.kind === 'whole'
    )));
    assert.ok(finalization.mediaAnchors.some((item) => (
      item.evidenceId === derived.id && item.anchor.kind === 'segment'
    )));
    assert.ok(finalization.mediaAnchors.some((item) => (
      item.evidenceId === derived.id && item.anchor.kind === 'time-range'
    )));
    assert.doesNotMatch(JSON.stringify(store.getImmutableEvent(eventId)), new RegExp(
      workspace.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
      'u',
    ));
    await assert.rejects(access(temporaryPath));
  } finally {
    await agent.close();
    store.close();
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('audio attachment without a local ASR port fails before Provider I/O', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-audio-blocked-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'clip.wav'), wavFixture());
  const attachmentRoot = path.join(root, 'attachments');
  const occurredAt = '2026-08-10T00:00:00.000Z';
  const staged = await stageAttachments(
    [{ path: 'clip.wav', kind: 'audio' }], workspace, attachmentRoot,
    {
      eventId: 'audio-blocked-event', sourceId: 'audio-blocked-event', sessionId: 'owner',
      profileId: 'owner', trust: 'owner', occurredAt,
    },
  );
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only-audio-blocked-key';
  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: workspace, dataRoot: path.join(root, 'data'),
    daemonDataRoot: root, skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40, maxTurns: 20,
  }, 'owner', { audioTranscriber: false });
  let providerCalls = 0;
  (agent as unknown as { runner: { run: () => Promise<never> } }).runner.run = async () => {
    providerCalls += 1;
    throw new Error('Provider must not run');
  };
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const dispatcher = new MimiDispatcher(store, agent, attention, undefined, undefined, {
    attachmentRoot, maxAttempts: 1,
  });
  try {
    const routed = store.ingestEvent({
      id: 'audio-blocked-event', externalId: 'audio-blocked-event', source: 'local-cli',
      kind: 'command', trust: 'owner', profileId: 'owner', sessionKey: 'owner', priority: 100,
      occurredAt, receivedAt: occurredAt,
      payload: { prompt: 'transcribe this', attachments: staged },
    });
    assert.ok(routed.task);
    assert.equal(await dispatcher.processTaskById(routed.task.id), true);
    assert.equal(store.getTask(routed.task.id)?.status, 'failed');
    assert.match(store.getTask(routed.task.id)?.error ?? '', /ASR|转写|audio/iu);
    assert.equal(providerCalls, 0);
  } finally {
    await agent.close();
    store.close();
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
