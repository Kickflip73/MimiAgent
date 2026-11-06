import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import { BreezeTtsClient } from '../src/runtime/breeze-tts.js';
import { SpeechOutput } from '../src/runtime/speech-output.js';
import { createSpeechTools } from '../src/runtime/speech-tools.js';
import { mimiRuntimeStreamEvent } from '../src/daemon/live-events.js';

const config = { enabled: true, command: '/bin/echo', playbackCommand: '/bin/echo', synthesisTimeoutMs: 10000, playbackTimeoutMs: 1000, breezeUrl: 'http://127.0.0.1:8080' };
const headers = { 'content-type': 'audio/pcm', 'x-sample-rate': '24000', 'x-sample-format': 's16le', 'x-breeze-stable-voice': '1' };

test('Agent speak publishes playable audio before its tool finishes, with one synthesis and a final reusable WAV', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-live-')); t.after(() => rm(root, { recursive: true, force: true }));
  let upstream!: ReadableStreamDefaultController<Uint8Array>, calls = 0, finished = false;
  const client = new BreezeTtsClient(config.breezeUrl, async () => {
    calls++;
    return new Response(new ReadableStream({ start(c) { upstream = c; c.enqueue(new Uint8Array([0, 64])); } }), { headers });
  });
  let ready!: (value: string) => void;
  const available = new Promise<string>(resolve => { ready = resolve; });
  const speech = new SpeechOutput(config, root, undefined, client);
  const tool = createSpeechTools(speech, autoplay => {
    assert.equal(autoplay, true);
    return { sessionId: 'story', runId: 'run-one', onReady: async id => { ready(id); } };
  })[0]!;
  assert.equal(tool.type, 'function'); if (tool.type !== 'function') return;
  const generation = tool.invoke(new RunContext({}), JSON.stringify({ action: 'speak', input: '小兔子睡着了。', engine: 'breeze' })).then(value => { finished = true; return value as any; });
  const id = await available;
  // Long-running renders are judged by current progress, not when the story began.
  const ledgerPath = path.join(root, 'renders.json');
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  Object.values(ledger.entries).forEach((entry: any) => { entry.audio.createdAt = new Date(0).toISOString(); });
  await writeFile(ledgerPath, JSON.stringify(ledger));
  const otherProcess = new SpeechOutput(config, root, undefined, client);
  await assert.rejects(otherProcess.live('another-session', id, new AbortController().signal), /当前会话/);
  const reader = (await otherProcess.live('story', id, new AbortController().signal)).body!.getReader();
  assert.deepEqual([...((await reader.read()).value ?? [])], [0, 64]);
  assert.equal(finished, false, 'tool result must still be pending when the first audio is playable');
  assert.equal((await speech.inspect(id))[0]?.status, 'started');
  await reader.cancel(); // Browser disconnect must not abort or duplicate the durable tool render.
  upstream.enqueue(new Uint8Array([0, 32])); upstream.close();
  const audio = await generation;
  assert.equal(audio.id, id); assert.equal(audio.playback, 'conversation'); assert.equal(calls, 1);
  const wav = await readFile(audio.file);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(40), 4);
  assert.deepEqual(wav.subarray(44), Buffer.from([0, 64, 0, 32]));
  const replay = await otherProcess.live('story', id, new AbortController().signal);
  assert.deepEqual(Buffer.from(await replay.arrayBuffer()), wav.subarray(44));
  assert.equal(calls, 1);
});

test('failed in-flight audio errors its reader and cannot be replayed as success or synthesized again', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-live-error-')); t.after(() => rm(root, { recursive: true, force: true }));
  let upstream!: ReadableStreamDefaultController<Uint8Array>, calls = 0, ready!: (id: string) => void;
  const available = new Promise<string>(resolve => { ready = resolve; });
  const client = new BreezeTtsClient(config.breezeUrl, async () => {
    calls++; return new Response(new ReadableStream({ start(c) { upstream = c; c.enqueue(new Uint8Array([0, 0])); } }), { headers });
  });
  const speech = new SpeechOutput(config, root, undefined, client);
  const generation = speech.synthesize('中断案例', { engine: 'breeze' }, undefined, { sessionId: 'owner', runId: 'one', onReady: async id => { ready(id); } });
  const failed = assert.rejects(generation, /未确认/);
  const id = await available;
  const reader = (await speech.live('owner', id, new AbortController().signal)).body!.getReader();
  await reader.read(); upstream.error(new Error('connection lost')); await failed;
  await assert.rejects(reader.read(), /中断/);
  await assert.rejects(speech.live('owner', id, new AbortController().signal), /未确认/);
  await assert.rejects(speech.synthesize('中断案例', { engine: 'breeze' }), /未确认/);
  assert.equal(calls, 1);
});

test('speech events preserve compact identity without inserting audio bytes or interrupting textual answers', async () => {
  const event = mimiRuntimeStreamEvent({ type: 'speech_ready', sessionId: 's', runId: 'r', audioId: '93355172-3311-421c-a6e2-ecf910572ad5', autoplay: true });
  assert.deepEqual(event, { kind: 'speech', audioId: '93355172-3311-421c-a6e2-ecf910572ad5', autoplay: true });
  const source = await readFile(new URL('../src/web/assets/execution.js', import.meta.url), 'utf8');
  const { projectEvent } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const run = { sequence: 0, answers: ['故事'], boundary: false, steps: [], speech: [] };
  projectEvent(run, { ...event, sequence: 1 }); projectEvent(run, { ...event, sequence: 1 });
  projectEvent(run, { kind: 'answer', text: '继续', sequence: 2 });
  assert.deepEqual(run.answers, ['故事继续']); assert.equal(run.steps.length, 0); assert.equal(run.speech.length, 1);
});

test('the main Agent binds early speech to the immutable active Session and run', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-live-agent-')); t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => root);
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0]) => {
    assert.equal(String(url), config.breezeUrl + '/v1/audio/speech');
    return new Response(new ReadableStream({ start(c) { upstream = c; c.enqueue(new Uint8Array([0, 64])); } }), { headers });
  });
  const { MimiAgent } = await import('../src/runtime/mimi-agent.js');
  const agent = await MimiAgent.create({ provider: 'openai', workspaceRoot: root, dataRoot: path.join(root, 'state'),
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'), historyLimit: 40, contextWindow: 128000, maxTurns: 10, tts: config });
  let ready!: (event: any) => void;
  const available = new Promise<any>(resolve => { ready = resolve; });
  agent.onRuntimeEvent(event => { if (event.type === 'speech_ready') ready(event); });
  const runner = (agent as any).runner;
  runner.run = async (runtimeAgent: any) => {
    const tool = runtimeAgent.tools.find((candidate: any) => candidate.name === 'speech');
    assert.ok(tool);
    const result = await tool.invoke(new RunContext({}), JSON.stringify({ action: 'speak', input: '小兔子在月光下睡着了。', engine: 'breeze' }));
    assert.equal(result.engine, 'breeze');
    return {};
  };
  const running = agent.stream('写一个睡前小故事，然后用 Breeze 读出来。');
  const event = await available;
  assert.equal(event.sessionId, agent.sessionId); assert.equal(event.runId, agent.activeRunId); assert.equal(event.autoplay, true);
  const web = new SpeechOutput(config, path.join(root, 'state/media/tts'));
  const reader = (await web.live(event.sessionId, event.audioId, new AbortController().signal)).body!.getReader();
  assert.deepEqual([...((await reader.read()).value ?? [])], [0, 64]);
  upstream.enqueue(new Uint8Array([0, 32])); upstream.close();
  await running;
  await reader.cancel();
  await agent.completeRun('测试故事已生成。');
  await agent.close();
});
