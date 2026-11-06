import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SpeechOutput } from '../src/runtime/speech-output.js';
import { BreezeTtsClient } from '../src/runtime/breeze-tts.js';
import { prepareSpeechText } from '../src/runtime/speech-text.js';
const config = { enabled: true, command: '/bin/echo', playbackCommand: '/bin/echo', synthesisTimeoutMs: 1000, playbackTimeoutMs: 1000, breezeUrl: 'http://127.0.0.1:8080' };

test('readable script expands table facts, dates, percentages and units without rewriting the original', () => {
  const text = '# 汇总\n2026-11-05，09:30，完成 85%。\n| 项目 | 内存 |\n| --- | --- |\n| MimiAgent | 24 GB |\n\n[来源](https://example.com)\n```js\nconsole.log(1);\n```';
  const result = prepareSpeechText(text);
  assert.match(result.text, /二零二六年十一月五日/);
  assert.match(result.text, /九点三十分/);
  assert.match(result.text, /百分之八十五/);
  assert.match(result.text, /项目: 咪咪助手；内存: 二十四吉字节/);
  assert.doesNotMatch(result.text, /console|https|```|\|/);
  assert.match(result.text, /来源/);
  assert.ok(result.warnings.length);
  assert.match(text, /console.log/);
  assert.match(prepareSpeechText('Node 3.12.0 和 RFC 123，OpenAI。').text, /3\.12\.0/);
});

test('settings persist, engine overrides clear incompatible defaults, and profiles retain independent voices', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-settings-')); t.after(() => rm(root, { recursive: true, force: true }));
  const speech = new SpeechOutput(config, root);
  await speech.configure({ engine: 'breeze', voice: 'breeze:zh-narrator', speed: 1.2 });
  const reopened = new SpeechOutput(config, root);
  assert.equal((await reopened.selection('你好')).speed, 1.2);
  const kokoro = await reopened.selection('hello', { engine: 'kokoro' });
  assert.equal(kokoro.engine, 'kokoro'); assert.equal(kokoro.voice, undefined);
  await Promise.all(['one', 'two'].map(id => speech.saveVoice({ id, name: id, options: { engine: 'kokoro', voice: 'am_echo', speed: 1.1 } })));
  assert.equal((await speech.catalog()).profiles.length, 2);
  const voice = await speech.selection('hello', { voice: 'saved:one', speed: 1.3 });
  assert.equal(voice.voice, 'am_echo'); assert.equal(voice.speed, 1.3);
  await speech.configure({ voice: 'saved:one' });
  assert.equal((await speech.selection('hello')).engine, 'kokoro');
  await speech.removeVoice('one');
  assert.equal((await speech.catalog()).defaults.voice, '');
  await assert.rejects(speech.selection('hello', { voice: 'saved:one' }));
  await assert.rejects(speech.saveVoice({ id: 'nested', name: 'nested', options: { voice: 'saved:two' } }));
  await assert.rejects(speech.selection('你好', { engine: 'kokoro', instructions: 'warm' }), /不支持描述/);
});

test('corrupt settings and obsolete engines do not silently fall back or discard state', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-settings-bad-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'speech-settings.json');
  for (const content of ['{bad', JSON.stringify({ version: 1, defaults: { engine: 'chattts' }, profiles: [] })]) {
    await writeFile(file, content);
    const speech = new SpeechOutput(config, root);
    await assert.rejects(speech.selection('你好'));
    if (content === '{bad') {
      const backup = (await readdir(root)).find(name => name.includes('.corrupt-') && !name.endsWith('corrupt-state'))!;
      assert.equal(await readFile(path.join(root, backup), 'utf8'), content);
      await assert.rejects(speech.selection('不能重置状态'));
      await rm(file + '.corrupt-state');
    } else assert.equal(await readFile(file, 'utf8'), content);
  }
});

test('voice generation persists a reference and refuses duplicate or uncertain external work', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-voice-')); t.after(() => rm(root, { recursive: true, force: true }));
  const requests: Array<RequestInit> = [];
  const client = new BreezeTtsClient(config.breezeUrl, async (url, options) => {
    requests.push(options!);
    if (String(url).endsWith('/v1/voices')) {
      const body = options!.body as FormData;
      assert.equal(body.get('ref_text'), '你好。');
      assert.ok(body.get('ref_audio') instanceof Blob);
      return Response.json({ id: body.get('name'), saved: true });
    }
    return new Response(new Uint8Array([0, 0, 1, 0]), { headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000', 'x-sample-format': 's16le', 'x-breeze-stable-voice': '1' } });
  });
  const speech = new SpeechOutput(config, root, undefined, client);
  const input = { id: 'warm', name: '温暖', options: { engine: 'breeze', instructions: '温暖女声' }, text: '你好。' };
  await speech.generateVoice(input);
  assert.equal(requests.length, 2);
  await assert.rejects(speech.generateVoice(input), /已存在/);
  assert.equal(requests.length, 2);
  const reopened = new SpeechOutput(config, root, undefined, client);
  const selection = await reopened.selection('再见。', { voice: 'saved:warm' });
  assert.match(selection.referenceId!, /^mimi_/);
  await reopened.synthesize('再见。', { voice: 'saved:warm' });
  assert.equal((requests[2]!.body as URLSearchParams).get('voice_id'), selection.referenceId);
});

test('voice registration failure stays uncertain across restarts and is not resubmitted', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-voice-uncertain-')); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const client = new BreezeTtsClient(config.breezeUrl, async url => {
    calls++;
    if (String(url).endsWith('/v1/voices')) return new Response('busy', { status: 409 });
    return new Response(new Uint8Array([0, 0]), { headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000', 'x-sample-format': 's16le', 'x-breeze-stable-voice': '1' } });
  });
  const { createSpeechTools } = await import('../src/runtime/speech-tools.js');
  const { RunContext } = await import('@openai/agents');
  const speech = new SpeechOutput(config, root, undefined, client);
  const tool = createSpeechTools(speech)[0]!;
  assert.equal(tool.type, 'function'); if (tool.type !== 'function') return;
  const result = await tool.invoke(new RunContext({}), JSON.stringify({ action: 'voice_generate', id: 'uncertain', name: 'test', engine: 'breeze', instructions: 'warm', input: 'hello' })) as any;
  assert.equal(result.mimiStatus, 'action_uncertain'); assert.equal(result.retryable, false);
  const reopened = new SpeechOutput(config, root, undefined, client);
  assert.equal((await reopened.catalog()).profiles[0]?.state, 'uncertain');
  await assert.rejects(reopened.generateVoice({ id: 'uncertain', name: 'test', options: { engine: 'breeze', instructions: 'warm' }, text: 'hello' }), /已存在/);
  await assert.rejects(reopened.selection('hello', { voice: 'saved:uncertain' }), /尚未就绪/);
  assert.equal(calls, 2);
});

test('historical ChatTTS audio can be reused without making its engine executable', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-legacy-voice-')); t.after(() => rm(root, { recursive: true, force: true }));
  const id = '93355172-3311-421c-a6e2-ecf910572ad5';
  const file = path.join(root, id + '.wav'); await writeFile(file, 'historical audio');
  await writeFile(path.join(root, 'renders.json'), JSON.stringify({ version: 1, entries: { legacy: { status: 'ready', audio: { id, file, engine: 'chattts', format: 'wav', language: 'zh', createdAt: '2026-11-01' } } } }));
  const speech = new SpeechOutput(config, root, async () => { throw new Error('no execution allowed'); });
  assert.equal((await speech.preparePlayback(id)).file, file);
  await assert.rejects(speech.synthesize('hello', { voice: 'chattts:male-1' }));
});

test('per-engine defaults survive switching, validate ownership and clear deleted profiles', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-engine-voices-')); t.after(() => rm(root, { recursive: true, force: true }));
  const speech = new SpeechOutput(config, root);
  await speech.configure({ engine: 'breeze', voice: 'breeze:zh-narrator', speed: 1.3, textMode: 'verbatim' });
  await speech.setEngineVoice({ engine: 'kokoro', voice: 'am_echo' });
  assert.equal((await speech.catalog()).defaults.engine, 'breeze');
  assert.equal((await speech.selection('hello', { engine: 'kokoro' })).voice, 'am_echo');
  await assert.rejects(speech.setEngineVoice({ engine: 'macos', voice: 'am_echo' }), /不属于/);
  await speech.saveVoice({ id: 'custom', name: 'Custom', options: { engine: 'breeze', voice: 'breeze:en-warm', speed: 0.8, textMode: 'readable' } });
  await speech.setEngineVoice({ engine: 'breeze', voice: 'saved:custom' });
  const selected = await speech.selection('hello');
  assert.equal(selected.voice, 'breeze:en-warm');
  assert.equal(selected.speed, 1.3); assert.equal(selected.textMode, 'verbatim');
  assert.equal((await new SpeechOutput(config, root).catalog()).engineVoices.kokoro, 'am_echo');
  await speech.removeVoice('custom');
  assert.equal((await speech.catalog()).engineVoices.breeze, undefined);
  assert.equal((await speech.catalog()).defaults.voice, '');
  await speech.configure({ engine: 'kokoro' });
  assert.equal((await speech.selection('hello')).voice, 'am_echo');
});

// The same conversion used by recording and upload is verified against the server boundary.
// @ts-expect-error Browser module.
import { voiceSampleWav } from '../src/web/assets/speech-settings.js';
import { validateVoiceSample } from '../src/runtime/speech-voice-sample.js';
async function referenceWav(seconds = 2) {
  const length = 24000 * seconds;
  return Buffer.from(await voiceSampleWav({ duration: seconds, sampleRate: 24000, length, numberOfChannels: 2,
    getChannelData: () => new Float32Array(length).fill(0.2) }).arrayBuffer());
}

test('reference validation rejects malformed and unbounded audio before any external side effect', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-clone-invalid-')); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const client = new BreezeTtsClient(config.breezeUrl, async () => { calls++; return Response.json({}); });
  const speech = new SpeechOutput(config, root, undefined, client);
  const valid = await referenceWav(); validateVoiceSample(valid);
  assert.equal(valid.readInt16LE(44), 6553);
  const malformed = Buffer.from(valid); malformed.writeUInt16LE(2, 22);
  for (const audio of [Buffer.from('not audio'), malformed, valid.subarray(0, valid.length - 1)]) {
    await assert.rejects(speech.cloneVoice({ id: 'sample', name: '声音', text: '你好。' }, audio), /参考声音/);
  }
  assert.throws(() => voiceSampleWav({ duration: 31 }), /1～30/);
  assert.equal(calls, 0); assert.equal((await speech.catalog()).profiles.length, 0);
});

test('cloning registers the actual bounded sample once and survives restart', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-clone-')); t.after(() => rm(root, { recursive: true, force: true }));
  const audio = await referenceWav(); let calls = 0;
  const client = new BreezeTtsClient(config.breezeUrl, async (_url, init) => {
    calls++; const form = init!.body as FormData;
    assert.deepEqual(Buffer.from(await (form.get('ref_audio') as Blob).arrayBuffer()), audio);
    assert.equal(form.get('ref_text'), '这是我的声音。');
    return Response.json({ id: form.get('name'), saved: true });
  });
  const speech = new SpeechOutput(config, root, undefined, client);
  const input = { id: 'cloned', name: '我的声音', text: '这是我的声音。' };
  await speech.cloneVoice(input, audio);
  assert.equal((await speech.catalog()).profiles[0]?.state, 'ready');
  assert.ok((await new SpeechOutput(config, root).selection('你好', { voice: 'saved:cloned' })).referenceId);
  await assert.rejects(speech.cloneVoice(input, audio), /已存在/); assert.equal(calls, 1);
});

test('clone failures stay uncertain and cannot be silently replayed', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-clone-failure-')); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const client = new BreezeTtsClient(config.breezeUrl, async () => { calls++; throw new Error('disconnected'); });
  const speech = new SpeechOutput(config, root, undefined, client), audio = await referenceWav();
  const input = { id: 'failed', name: '未确认', text: '你好' };
  await assert.rejects(speech.cloneVoice(input, audio), /未确认/);
  assert.equal((await speech.catalog()).profiles[0]?.state, 'uncertain');
  await assert.rejects(speech.cloneVoice(input, audio), /已存在/); assert.equal(calls, 1);
  await assert.rejects(speech.selection('你好', { voice: 'saved:failed' }), /尚未就绪/);
});


test('omitted Web speech overrides preserve stored engine, voice, speed and reading mode', async t => {
  const { speechOverridesSchema } = await import('../src/core/speech-settings.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-voice-overrides-')); t.after(() => rm(root, { recursive: true, force: true }));
  const speech = new SpeechOutput(config, root);
  await speech.configure({ engine: 'kokoro', voice: 'am_echo', speed: 1.4, textMode: 'verbatim' });
  assert.deepEqual(speechOverridesSchema.parse({}), {});
  assert.deepEqual(speechOverridesSchema.parse({ speed: 0.8 }), { speed: 0.8 });
  const selection = await speech.selection('hello', speechOverridesSchema.parse({}));
  assert.equal(selection.engine, 'kokoro'); assert.equal(selection.voice, 'am_echo');
  assert.equal(selection.speed, 1.4); assert.equal(selection.textMode, 'verbatim');
});

test('saved voice read-aloud reuses one reference across texts without redesigning its timbre', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-stable-voice-')); t.after(() => rm(root, { recursive: true, force: true }));
  const requests: URLSearchParams[] = [];
  const client = new BreezeTtsClient(config.breezeUrl, async (url, init) => {
    if (String(url).endsWith('/v1/voices')) return Response.json({ id: (init!.body as FormData).get('name'), saved: true });
    requests.push(init!.body as URLSearchParams);
    return new Response(new Uint8Array([0, 0, 1, 0]), { headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000', 'x-sample-format': 's16le', 'x-breeze-stable-voice': '1' } });
  });
  const speech = new SpeechOutput(config, root, undefined, client);
  await speech.generateVoice({ id: 'stable', name: '固定女声', text: '你好。', options: { engine: 'breeze', instructions: '活泼年轻的女声' } });
  assert.equal(requests[0]!.get('instruction'), '活泼年轻的女声');
  await speech.configure({ engine: 'breeze', voice: 'saved:stable', instructions: '活泼年轻的女声' });
  for (const text of ['第一段回答。', '另一段完全不同的回答。']) {
    await (await speech.stream(text, {}, new AbortController().signal)).arrayBuffer();
  }
  await speech.synthesize('Agent 朗读也保持音色。');
  const referenceId = (await speech.catalog()).profiles[0]!.referenceId;
  assert.equal(requests.length, 4);
  for (const request of requests.slice(1)) {
    assert.equal(request.get('voice_id'), referenceId);
    assert.equal(request.has('instruction'), false, 'saved references must not receive voice-design instructions');
    assert.equal(request.get('cfg_scale'), '0', 'Breeze fills omitted instructions; saved references must use its reference-only branch');
    assert.equal(request.get('seed'), '42');
  }
});

test('description preview never registers or changes the voice library until confirmation', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-preview-')); t.after(() => rm(root, { recursive: true, force: true }));
  let registrations = 0, syntheses = 0;
  const client = new BreezeTtsClient(config.breezeUrl, async (url, init) => {
    if (String(url).endsWith('/v1/voices')) { registrations++; return Response.json({ id: (init!.body as FormData).get('name'), saved: true }); }
    syntheses++; return new Response(new Uint8Array(48000), { headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000', 'x-sample-format': 's16le', 'x-breeze-stable-voice': '1' } });
  });
  const speech = new SpeechOutput(config, root, undefined, client), before = await speech.catalog();
  const input = { id: 'draft', name: '预览女声', text: '你好。', options: { engine: 'breeze', instructions: '温柔女声' } };
  const preview = await speech.previewVoice(input);
  assert.equal(preview.saved, false); assert.equal(registrations, 0);
  assert.deepEqual((await speech.catalog()).profiles, []); assert.deepEqual((await speech.catalog()).defaults, before.defaults);
  assert.ok((await speech.previewAudio('draft')).length > 44);
  await assert.rejects(speech.previewVoice(input), /已存在/); assert.equal(syntheses, 1);
  const reopened = new SpeechOutput(config, root, undefined, client);
  await reopened.confirmVoice('draft'); await reopened.confirmVoice('draft');
  assert.equal(registrations, 1); assert.equal((await speech.catalog()).profiles.length, 1);
  assert.deepEqual((await speech.catalog()).defaults, before.defaults);
});

test('clone previews send inline audio and discarded previews cannot be saved or played', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-preview-clone-')); t.after(() => rm(root, { recursive: true, force: true }));
  const audio = await referenceWav(); let calls = 0;
  const client = new BreezeTtsClient(config.breezeUrl, async (url, init) => {
    calls++; assert.ok(String(url).endsWith('/v1/audio/speech'));
    const body = init!.body as FormData;
    assert.ok(body.get('ref_audio') instanceof Blob); assert.equal(body.get('ref_text'), '原来的录音。'); assert.equal(body.get('cfg_scale'), '0');
    return new Response(new Uint8Array(48000), { headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000', 'x-sample-format': 's16le', 'x-breeze-stable-voice': '1' } });
  });
  const speech = new SpeechOutput(config, root, undefined, client);
  await speech.previewVoice({ id: 'clone', name: '试听', text: '原来的录音。', options: { engine: 'breeze' } }, audio);
  assert.equal(calls, 1); assert.deepEqual((await speech.catalog()).profiles, []);
  await speech.discardVoicePreview('clone'); await speech.discardVoicePreview('clone');
  await assert.rejects(speech.previewAudio('clone')); await assert.rejects(speech.confirmVoice('clone'));
  assert.equal((await readdir(root)).some(name => name.endsWith('.wav')), false);
});

test('concurrent confirmations register once and registration failures never auto-retry', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-preview-save-')); t.after(() => rm(root, { recursive: true, force: true }));
  let entered!: () => void, release!: () => void, calls = 0;
  const registered = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const client = new BreezeTtsClient(config.breezeUrl, async (url) => {
    if (String(url).endsWith('/v1/voices')) { calls++; entered(); await gate; throw new Error('offline'); }
    return new Response(new Uint8Array(48000), { headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000', 'x-sample-format': 's16le', 'x-breeze-stable-voice': '1' } });
  });
  const speech = new SpeechOutput(config, root, undefined, client);
  await speech.previewVoice({ id: 'race', name: '竞态', text: '你好', options: { engine: 'breeze', instructions: '温柔' } });
  const saving = assert.rejects(speech.confirmVoice('race'), /未确认/); await registered;
  await assert.rejects(speech.confirmVoice('race'), /未确认/); await assert.rejects(speech.discardVoicePreview('race'), /进行中/);
  release(); await saving;
  await assert.rejects(new SpeechOutput(config, root, undefined, client).confirmVoice('race'), /未确认/);
  assert.equal(calls, 1); assert.equal((await speech.catalog()).profiles.length, 0);
});

test('Agent previews produce playable receipts without saving voices', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-preview-agent-')); t.after(() => rm(root, { recursive: true, force: true }));
  const client = new BreezeTtsClient(config.breezeUrl, async () => new Response(new Uint8Array(48000), { headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000', 'x-sample-format': 's16le', 'x-breeze-stable-voice': '1' } }));
  const speech = new SpeechOutput(config, root, undefined, client);
  const { createSpeechTools } = await import('../src/runtime/speech-tools.js');
  const { speechHistoryFiles } = await import('../src/core/speech-media.js');
  const { RunContext } = await import('@openai/agents');
  const tool = createSpeechTools(speech)[0]!; if (tool.type !== 'function') throw new Error('missing tool');
  const args = { action: 'voice_preview', id: 'agent-draft', name: '测试', engine: 'breeze', input: '你好', instructions: '温柔' };
  const output = await tool.invoke(new RunContext({}), JSON.stringify(args)) as any;
  assert.equal(output.saved, false); assert.equal(output.previewId, 'agent-draft');
  assert.deepEqual(speechHistoryFiles([{ type: 'function_call', callId: 'p', name: 'speech', arguments: JSON.stringify(args) }, { type: 'function_call_result', callId: 'p', output }]), [output.file]);
  assert.equal((await speech.catalog()).profiles.length, 0);
});
