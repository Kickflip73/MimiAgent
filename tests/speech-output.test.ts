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
    return { stdout: 'engine=kokoro voice=zf_xiaobei', stderr: '' };
  };
  const speech = new SpeechOutput(config, root, runner);

  const original = '  # 标题\n原样播报 `code`。\n';
  const first = await speech.synthesize(original, { voice: 'zf_xiaobei', speed: 1.2 });
  const second = await speech.synthesize('第二段', { engine: 'chattts', voice: 'chattts:seed-7' });

  assert.equal(calls[0]?.text, original);
  assert.equal(calls[0]?.environment?.MIMI_TTS_ENGINE, 'kokoro');
  assert.equal(calls[0]?.environment?.MIMI_TTS_LANGUAGE, 'zh');
  assert.equal(calls[0]?.environment?.MIMI_TTS_VOICE, 'zf_xiaobei');
  assert.equal(calls[0]?.environment?.MIMI_TTS_SPEED, '1.2');
  assert.equal(calls[1]?.environment?.MIMI_TTS_CHATTTS_SEED, '7');
  assert.equal(first.engine, 'kokoro');
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.file, second.file);
  assert.equal(await readFile(first.file, 'utf8'), 'wav-fixture');

  const speechTool = createSpeechTools(speech)[0];
  if (!speechTool || !('invoke' in speechTool)) throw new Error('speech tool is not callable');
  const toolText = '  模型决定的原文  ';
  const synthesized = await speechTool.invoke(
    new RunContext({}),
    JSON.stringify({ action: 'synthesize', input: toolText, voice: 'zf_xiaobei' }),
  );
  assert.match(JSON.stringify(synthesized), /kokoro/);
  assert.equal(calls[2]?.text, toolText);
  const voices = await speechTool.invoke(
    new RunContext({}),
    JSON.stringify({ action: 'voices' }),
  );
  assert.match(JSON.stringify(voices), /chattts:seed-42/);
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
  assert.ok(speech.listVoices().some((voice) => voice.id === 'chattts:seed-42'));
  assert.ok(speech.listVoices().some((voice) => voice.id === 'zm_yunyang'));
});
