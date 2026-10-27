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
    const engine = options.environment?.MIMI_TTS_ENGINE === 'chattts' ? 'chattts' : 'kokoro';
    const voice = options.environment?.MIMI_TTS_VOICE ?? 'chattts:male-1';
    return { stdout: `engine=${engine} voice=${voice}`, stderr: '' };
  };
  const speech = new SpeechOutput(config, root, runner);

  const original = '  # 标题\n原样播报 `code`。\n';
  const first = await speech.synthesize(original, { voice: 'zf_xiaoxiao', speed: 1.2 });
  const second = await speech.synthesize('第二段', { engine: 'chattts', voice: 'chattts:young-lively' });
  const third = await speech.synthesize('第三段', { voice: 'chattts:mature-steady' });

  assert.equal(calls[0]?.text, original);
  assert.equal(calls[0]?.environment?.MIMI_TTS_ENGINE, 'kokoro');
  assert.equal(calls[0]?.environment?.MIMI_TTS_LANGUAGE, 'zh');
  assert.equal(calls[0]?.environment?.MIMI_TTS_VOICE, 'zf_xiaoxiao');
  assert.equal(calls[0]?.environment?.MIMI_TTS_SPEED, '1.2');
  assert.equal(calls[1]?.environment?.MIMI_TTS_VOICE, 'chattts:young-lively');
  assert.equal(calls[1]?.environment?.MIMI_TTS_CHATTTS_SEED, undefined);
  assert.equal(calls[2]?.environment?.MIMI_TTS_ENGINE, 'chattts');
  assert.equal(calls[2]?.environment?.MIMI_TTS_VOICE, 'chattts:mature-steady');
  assert.equal(first.engine, 'kokoro');
  assert.equal(second.engine, 'chattts');
  assert.equal(second.voice, 'chattts:young-lively');
  assert.equal(third.voice, 'chattts:mature-steady');
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.file, second.file);
  assert.equal(await readFile(first.file, 'utf8'), 'wav-fixture');

  const speechTool = createSpeechTools(speech)[0];
  if (!speechTool || !('invoke' in speechTool)) throw new Error('speech tool is not callable');
  const toolText = '  模型决定的原文  ';
  const synthesized = await speechTool.invoke(
    new RunContext({}),
    JSON.stringify({ action: 'synthesize', input: toolText, voice: 'zf_xiaoxiao' }),
  );
  assert.match(JSON.stringify(synthesized), /kokoro/);
  assert.equal(calls[3]?.text, toolText);
  const voices = await speechTool.invoke(
    new RunContext({}),
    JSON.stringify({ action: 'voices' }),
  );
  assert.match(JSON.stringify(voices), /chattts:male-1/);
  assert.match(JSON.stringify(voices), /chattts:female-3/);
  assert.match(JSON.stringify(voices), /chattts:young-lively/);
  assert.match(JSON.stringify(voices), /ChatTTS Young Lively Female/);
  assert.match(JSON.stringify(voices), /chattts:mature-steady/);
  assert.match(JSON.stringify(voices), /ChatTTS Mature Steady Female/);
  assert.match(JSON.stringify(voices), /"gender":"male"/);
  assert.doesNotMatch(JSON.stringify(voices), /chattts:male-2/);
  assert.doesNotMatch(JSON.stringify(voices), /chattts:female-young/);
  assert.doesNotMatch(JSON.stringify(voices), /jm_kumo/);
  assert.doesNotMatch(JSON.stringify(voices), /chattts:seed-/);
  assert.doesNotMatch(JSON.stringify(voices), /\/bin\/echo/);
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

test('routes mixed Chinese and Latin text to ChatTTS without relying on character ratios', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-speech-'));
  let environment: NodeJS.ProcessEnv | undefined;
  const runner: SpeechCommandRunner = async (_command, args, options) => {
    environment = options.environment;
    await writeFile(args[2]!, 'wav-fixture');
    return { stdout: 'engine=chattts voice=chattts:male-1', stderr: '' };
  };
  const speech = new SpeechOutput(config, root, runner);
  const text = [
    '今天完成了开源贡献汇总。',
    'Cua RFC 2807 application-composite AX scope and PR 2894 are under review.',
    'Multica PR 6707 and PR 6708 are waiting for maintainer feedback.',
  ].join(' ');

  const audio = await speech.synthesize(text);

  assert.equal(environment?.MIMI_TTS_ENGINE, 'chattts');
  assert.equal(environment?.MIMI_TTS_LANGUAGE, 'zh');
  assert.equal(audio.engine, 'chattts');
  assert.equal(audio.language, 'zh');
});

test('routes English and Japanese text to Kokoro in auto mode', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-speech-'));
  const environments: NodeJS.ProcessEnv[] = [];
  const runner: SpeechCommandRunner = async (_command, args, options) => {
    environments.push(options.environment ?? {});
    await writeFile(args[2]!, 'wav-fixture');
    return { stdout: 'engine=kokoro voice=am_echo', stderr: '' };
  };
  const speech = new SpeechOutput(config, root, runner);

  const english = await speech.synthesize('The latest pull requests are ready for review.');
  const japanese = await speech.synthesize('今日はレビューを進めます。');

  assert.equal(environments[0]?.MIMI_TTS_ENGINE, 'kokoro');
  assert.equal(environments[0]?.MIMI_TTS_LANGUAGE, 'en');
  assert.equal(english.language, 'en');
  assert.equal(environments[1]?.MIMI_TTS_ENGINE, 'kokoro');
  assert.equal(environments[1]?.MIMI_TTS_LANGUAGE, 'ja');
  assert.equal(japanese.language, 'ja');
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
      return { stdout: 'engine=chattts', stderr: '' };
    }
    playback.push(path.basename(args[0]!));
    if (playback.length === 1) {
      startedFirst();
      await firstReleased;
    }
    return { stdout: '', stderr: '' };
  };
  const speech = new SpeechOutput(config, root, runner);
  const first = await speech.synthesize('第一段');
  const second = await speech.synthesize('第二段');

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
  assert.equal(speech.status().voices, 15);
  assert.deepEqual(speech.listVoices().map((voice) => voice.id), [
    'chattts:male-1',
    'chattts:male-3',
    'chattts:female-3',
    'chattts:young-lively',
    'chattts:mature-steady',
    'zf_xiaoxiao',
    'zf_xiaoyi',
    'zm_yunjian',
    'zm_yunyang',
    'am_echo',
    'breeze:zh-narrator',
    'breeze:zh-lively',
    'breeze:zh-male',
    'breeze:en-narrator',
    'breeze:en-warm',
  ]);
  assert.equal(speech.listVoices().filter((voice) => voice.engine === 'chattts').length, 5);
  assert.equal(speech.listVoices().filter((voice) => voice.engine === 'breeze').length, 5);
  assert.ok(speech.listVoices().some((voice) => (
    voice.id === 'chattts:male-1' && voice.gender === 'male'
  )));
  assert.ok(speech.listVoices().some((voice) => (
    voice.id === 'chattts:young-lively' && voice.gender === 'female'
  )));
  assert.ok(speech.listVoices().some((voice) => (
    voice.id === 'chattts:mature-steady' && voice.gender === 'female'
  )));
  assert.ok(speech.listVoices().some((voice) => voice.id === 'zm_yunyang'));
});


test('rejects long ChatTTS before dispatch or render receipts, including auto and voice selection', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-speech-limit-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }); });
  let calls = 0;
  const speech = new SpeechOutput(config, root, async (_command, args) => {
    calls++; await writeFile(args[2]!, 'wav-fixture'); return { stdout: 'engine=chattts', stderr: '' };
  });
  for (const options of [{}, { engine: 'chattts' as const }, { voice: 'chattts:male-1' }]) {
    await assert.rejects(speech.synthesize('中'.repeat(301), options), /300.*未启动合成/);
  }
  assert.equal(calls, 0);
  assert.deepEqual(await speech.inspect(), []);
  await speech.synthesize('中'.repeat(300), { engine: 'chattts' });
  assert.equal(calls, 1);
  await speech.synthesize('中'.repeat(301), { engine: 'kokoro' });
  assert.equal(calls, 2);
});


test('speech tool delivers speak and play as persisted conversation audio without OS playback', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-speech-player-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }); });
  const commands: string[] = [];
  const speech = new SpeechOutput(config, root, async (command, args) => {
    commands.push(command); assert.equal(args.length, 3, 'must not invoke system playback');
    await writeFile(args[2]!, 'wav-fixture'); return { stdout: 'engine=chattts', stderr: '' };
  });
  const speechTool = createSpeechTools(speech)[0]!;
  if (!('invoke' in speechTool)) throw new Error('missing tool');
  const args = { action: 'speak', input: '原文不应被缩写', engine: 'chattts', voice: 'chattts:female-1' };
  const rejected = await speechTool.invoke(new RunContext({}), JSON.stringify(args)) as any;
  assert.equal(rejected.disposition?.dispatchStarted, false);
  assert.deepEqual(rejected.issues.map((issue: any) => issue.path), ['voice']);
  assert.equal(commands.length, 0);
  const corrected = { ...args, voice: 'chattts:young-lively' };
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
