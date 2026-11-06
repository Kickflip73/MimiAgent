import { classifyRunOutcome } from '../src/core/run-finalization.js';
import { decideRunCommit } from '../src/runtime/pipeline/run-commit-coordinator.js';
import assert from 'node:assert/strict';
import { RunContext } from '@openai/agents';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TtsConfig } from '../src/config.js';
import {
  SpeechOutput,
  type SpeechCommandRunner,
} from '../src/runtime/speech-output.js';
import { createSpeechTools } from '../src/runtime/speech-tools.js';

const config: TtsConfig = {
  enabled: true,
  command: '/bin/echo',
  playbackCommand: '/bin/echo',
  synthesisTimeoutMs: 10_000,
  playbackTimeoutMs: 10_000,
};

test('synthesizes the exact caller text with an explicit voice and unique WAV output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-speech-'));
  const calls: Array<{ args: readonly string[]; environment?: NodeJS.ProcessEnv; text?: string }> = [];
  const runner: SpeechCommandRunner = async (_command, args, options) => {
    const text = args.length === 3 ? await readFile(args[0]!, 'utf8') : undefined;
    calls.push({ args, environment: options.environment, text });
    if (args.length === 3) await writeFile(args[2]!, 'wav-fixture');
    const engine = 'kokoro';
    const voice = options.environment?.MIMI_TTS_VOICE ?? 'chattts:male-1';
    return { stdout: `engine=${engine} voice=${voice}`, stderr: '' };
  };
  const speech = new SpeechOutput(config, root, runner);

  const original = '  # 标题\n原样播报 `code`。\n';
  const first = await speech.synthesize(original, { voice: 'zf_xiaoxiao', speed: 1.2, textMode: 'verbatim' });
  const second = await speech.synthesize('第二段', { engine: 'kokoro', voice: 'zf_xiaoyi' });
  const third = await speech.synthesize('第三段', { voice: 'zm_yunyang' });

  assert.equal(calls[0]?.text, original);
  assert.equal(calls[0]?.environment?.MIMI_TTS_ENGINE, 'kokoro');
  assert.equal(calls[0]?.environment?.MIMI_TTS_LANGUAGE, 'zh');
  assert.equal(calls[0]?.environment?.MIMI_TTS_VOICE, 'zf_xiaoxiao');
  assert.equal(calls[0]?.environment?.MIMI_TTS_SPEED, '1.2');
  assert.equal(calls[1]?.environment?.MIMI_TTS_VOICE, 'zf_xiaoyi');
  assert.equal(calls[1]?.environment?.MIMI_TTS_CHATTTS_SEED, undefined);
  assert.equal(calls[2]?.environment?.MIMI_TTS_ENGINE, 'kokoro');
  assert.equal(calls[2]?.environment?.MIMI_TTS_VOICE, 'zm_yunyang');
  assert.equal(first.engine, 'kokoro');
  assert.equal(second.engine, 'kokoro');
  assert.equal(second.voice, 'zf_xiaoyi');
  assert.equal(third.voice, 'zm_yunyang');
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.file, second.file);
  assert.equal(await readFile(first.file, 'utf8'), 'wav-fixture');

  const speechTool = createSpeechTools(speech)[0];
  if (!speechTool || !('invoke' in speechTool)) throw new Error('speech tool is not callable');
  const toolText = '  模型决定的原文  ';
  const synthesized = await speechTool.invoke(
    new RunContext({}),
    JSON.stringify({ action: 'synthesize', input: toolText, voice: 'zf_xiaoxiao', textMode: 'verbatim' }),
  );
  assert.match(JSON.stringify(synthesized), /kokoro/);
  assert.equal(calls[3]?.text, toolText);
  const voices = await speechTool.invoke(
    new RunContext({}),
    JSON.stringify({ action: 'voices' }),
  );
  assert.doesNotMatch(JSON.stringify(voices), /chattts/i);
  assert.match(JSON.stringify(voices), /macos:Tingting/);
  await speechTool.invoke(
    new RunContext({}),
    JSON.stringify({ action: 'play', input: first.id }),
  );
  await assert.rejects(
    speech.synthesize('旧版伪音色', { voice: 'chattts:seed-7' }),
    /未知 TTS 音色/,
  );
  await assert.rejects(
    speech.synthesize('已删除音色', { voice: 'chattts:male-2' }),
    /未知 TTS 音色/,
  );
  await assert.rejects(
    speech.synthesize('已删除日文音色', { voice: 'jm_kumo' }),
    /未知 TTS 音色/,
  );
});

test('macOS uses installed language voices and native speed without launching the Python renderer', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-native-'));
  const calls: Array<readonly string[]> = [];
  const speech = new SpeechOutput(config, root, async (command, args) => {
    assert.equal(command, '/usr/bin/say'); calls.push(args);
    await writeFile(args[args.indexOf('-o') + 1]!, 'wav-fixture');
    return { stdout: '', stderr: '' };
  });
  for (const text of ['中文 and English.', 'Hello there.', 'こんにちは。']) await speech.synthesize(text, { speed: 1.2 });
  assert.deepEqual(calls.map(args => args[1]), ['Tingting', 'Samantha', 'Kyoko']);
  assert.ok(calls.every(args => args[3] === '210'));
});

test('serializes playback in call order without blocking synthesis', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-speech-'));
  const playback: string[] = [];
  let releaseFirst!: () => void;
  let startedFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => { startedFirst = resolve; });
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const runner: SpeechCommandRunner = async (_command, args) => {
    if (args.length === 3) {
      await writeFile(args[2]!, 'wav-fixture');
      return { stdout: 'engine=kokoro', stderr: '' };
    }
    playback.push(path.basename(args[0]!));
    if (playback.length === 1) {
      startedFirst();
      await firstReleased;
    }
    return { stdout: '', stderr: '' };
  };
  const speech = new SpeechOutput(config, root, runner);
  const first = await speech.synthesize('第一段', { engine: 'kokoro' });
  const second = await speech.synthesize('第二段', { engine: 'kokoro' });

  const playingFirst = speech.play(first);
  const playingSecond = speech.play(second);
  await firstStarted;
  assert.deepEqual(playback, [path.basename(first.file)]);
  releaseFirst();
  await Promise.all([playingFirst, playingSecond]);
  assert.deepEqual(playback, [path.basename(first.file), path.basename(second.file)]);
});

test('honors the global switch and exposes only atomic speech tools', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-speech-'));
  const speech = new SpeechOutput({ ...config, enabled: false }, root, async () => ({ stdout: '', stderr: '' }));

  await assert.rejects(speech.synthesize('不会执行'), /TTS 已关闭/);
  await speech.setEnabled(true);
  assert.equal(speech.status().enabled, true);
  assert.deepEqual(createSpeechTools(speech).map((candidate) => candidate.name), [
    'speech',
  ]);
  assert.deepEqual(new Set(speech.listVoices().map(v => v.engine)), new Set(['macos', 'kokoro', 'breeze']));
  assert.doesNotMatch(JSON.stringify(speech.listVoices()), /chattts/i);
});

test('removed ChatTTS engines and voices are rejected before any render, even for short text', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-removed-'));
  let calls = 0;
  const speech = new SpeechOutput(config, root, async () => { calls++; return { stdout: '', stderr: '' }; });
  for (const options of [{ engine: 'chattts' }, { voice: 'chattts:male-1' }]) {
    await assert.rejects(speech.synthesize('你好', options as any));
    await assert.rejects(speech.synthesize('中'.repeat(1000), options as any));
  }
  assert.equal(calls, 0);
  assert.deepEqual(await speech.inspect(), []);
});

test('speech tool delivers speak and play as persisted conversation audio without OS playback', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-speech-player-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }); });
  const commands: string[] = [];
  const speech = new SpeechOutput(config, root, async (command, args) => {
    commands.push(command); assert.equal(args.length, 3, 'must not invoke system playback');
    await writeFile(args[2]!, 'wav-fixture'); return { stdout: 'engine=kokoro', stderr: '' };
  });
  const speechTool = createSpeechTools(speech)[0]!;
  if (!('invoke' in speechTool)) throw new Error('missing tool');
  const args = { action: 'speak', input: '原文不应被缩写', engine: 'chattts', voice: 'zf_xiaoyi' };
  const rejected = await speechTool.invoke(new RunContext({}), JSON.stringify(args)) as any;
  assert.equal(rejected.disposition?.dispatchStarted, false);
  assert.deepEqual(rejected.issues.map((issue: any) => issue.path), ['engine']);
  assert.equal(commands.length, 0);
  const corrected = { ...args, engine: 'kokoro' };
  const audio = await speechTool.invoke(new RunContext({}), JSON.stringify(corrected)) as any;
  assert.equal(audio.playback, 'conversation');
  const reopened = new SpeechOutput(config, root, async () => { throw new Error('must not launch a renderer or player'); });
  const playTool = createSpeechTools(reopened)[0]!;
  if (!('invoke' in playTool)) throw new Error('missing tool');
  const playback = await playTool.invoke(new RunContext({}), JSON.stringify({ action: 'play', input: audio.id })) as any;
  assert.equal(playback.file, audio.file);
  assert.equal(playback.playback, 'conversation');
  assert.equal(commands.length, 1);
  const calls = [
    {sessionId:'s',runId:'r',toolName:'speech',callId:'bad',argumentsJson:JSON.stringify(args),status:'failed' as const,output:rejected},
    {sessionId:'s',runId:'r',toolName:'speech',callId:'good',argumentsJson:JSON.stringify(corrected),status:'succeeded' as const,output:audio},
  ];
  assert.equal(classifyRunOutcome({sdk:'completed',calls}), 'completed');
  assert.match(decideRunCommit({draft:'语音已准备好。',calls}).answer, /\[语音\]\(/);
  assert.equal(classifyRunOutcome({sdk:'completed',calls:[calls[0]!]}), 'failed');
  assert.equal(classifyRunOutcome({sdk:'completed',calls:[calls[0]!,{...calls[1]!,argumentsJson:JSON.stringify({...corrected,input:'different task'})}]}), 'partial');
});
