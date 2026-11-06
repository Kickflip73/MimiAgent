import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('PCM decoder preserves samples across every network byte boundary and rejects truncation', async () => {
  const source = await readFile(new URL('../src/web/assets/speech-stream.js', import.meta.url), 'utf8');
  const { pcmDecoder } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const pcm = Buffer.from([0, 128, 255, 127, 0, 0, 0, 64]);
  for (let at = 0; at <= pcm.length; at++) {
    const decoder = pcmDecoder();
    assert.deepEqual([...decoder.push(pcm.subarray(0, at)), ...decoder.push(pcm.subarray(at))], [-1, 32767 / 32768, 0, 0.5]);
    decoder.finish();
  }
  const broken = pcmDecoder(); broken.push(pcm.subarray(0, 3));
  assert.throws(() => broken.finish(), /不完整/);
  assert.throws(() => pcmDecoder().finish(), /不完整/);
});

test('player starts audio before stream EOF and stop cancels fetch and scheduled audio', async (t) => {
  const original = { document: globalThis.document, AudioContext: (globalThis as any).AudioContext,
    MutationObserver: globalThis.MutationObserver, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, original));
  let click!: () => Promise<void>, started!: () => void, signal!: AbortSignal;
  const firstPlayback = new Promise<void>(resolve => { started = resolve; });
  let stopped = 0, closed = 0;
  Object.assign(globalThis, {
    document: { body: {}, querySelectorAll: () => [], createElement: () => ({ isConnected: true,
      addEventListener: (_: string, fn: () => Promise<void>) => { click = fn; }, setAttribute() {} }) },
    MutationObserver: class { observe() {} disconnect() {} },
    AudioContext: class {
      currentTime = 0;
      async resume() {}
      async close() { closed++; }
      createGain() { return { connect() {}, disconnect() {}, gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} } }; }
      createBuffer(_channels: number, length: number, rate: number) { return { duration: length / rate, copyToChannel() {} }; }
      createBufferSource() { return { connect() {}, disconnect() {}, start() { started(); }, stop() { stopped++; } }; }
    },
    fetch: async (_: unknown, options: RequestInit) => {
      signal = options.signal!;
      return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(38400)); } }), {
        headers: { 'x-sample-rate': '24000', 'x-sample-format': 's16le' },
      });
    },
  });
  const source = await readFile(new URL('../src/web/assets/speech-stream.js', import.meta.url), 'utf8');
  const { speechButton } = await import(`data:text/javascript;base64,${Buffer.from(source + '\n// player test').toString('base64')}`);
  const states: string[] = [];
  speechButton('hello', {}, { onState: (message: string) => states.push(message) });
  const playing = click();
  await firstPlayback;
  assert.equal(states[0], '正在准备语音；可点击取消', 'startup must not imply another request is occupying the engine');
  assert.equal(signal.aborted, false);
  const stopping = click(); states.push('保存成功');
  await stopping; await playing;
  assert.equal(states.at(-1), '保存成功', 'a cancelled async playback must not overwrite a newer UI result');
  assert.equal(signal.aborted, true);
  assert.equal(stopped, 4);
  assert.equal(closed, 1);
});

test('Agent stream autoplay uses the Send gesture and never submits a second synthesis', async t => {
  const original = { document: globalThis.document, AudioContext: (globalThis as any).AudioContext,
    MutationObserver: globalThis.MutationObserver, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, original));
  let played!: () => void, readerController!: ReadableStreamDefaultController<Uint8Array>;
  const playback = new Promise<void>(resolve => { played = resolve; });
  const urls: string[] = [];
  const create = () => ({ isConnected: true, append() {}, addEventListener() {}, setAttribute() {}, textContent: '' });
  Object.assign(globalThis, {
    document: { body: {}, querySelectorAll: () => [], createElement: create },
    MutationObserver: class { observe() {} disconnect() {} },
    AudioContext: class {
      state = 'suspended'; currentTime = 0;
      async resume() { this.state = 'running'; }
      async close() { this.state = 'closed'; }
      createGain() { return { connect() {}, disconnect() {}, gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} } }; }
      createBuffer(_channels: number, length: number, rate: number) { return { duration: length / rate, copyToChannel() {} }; }
      createBufferSource() { return { connect() {}, disconnect() {}, start() { played(); }, stop() {} }; }
    },
    fetch: async (url: string) => {
      urls.push(url);
      return new Response(new ReadableStream({ start(c) { readerController = c; c.enqueue(new Uint8Array(38400)); } }), {
        headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000', 'x-sample-format': 's16le' },
      });
    },
  });
  const source = await readFile(new URL('../src/web/assets/speech-stream.js', import.meta.url), 'utf8');
  const { armSpeechPlayback, liveSpeechPlayer, stopSpeech } = await import(`data:text/javascript;base64,${Buffer.from(source + '\n// auto playback test').toString('base64')}`);
  liveSpeechPlayer('story', 'old-id', true);
  await Promise.resolve(); assert.equal(urls.length, 0, 'opening an existing conversation must not autoplay');
  armSpeechPlayback('story');
  liveSpeechPlayer('story', 'live-id', true);
  await playback;
  assert.ok(readerController, 'audio started before synthesis EOF');
  assert.deepEqual(urls, ['/api/speech/live?session=story&id=live-id']);
  stopSpeech();
});

test('reply read-aloud reports startup and service failures visibly and remains retryable', async t => {
  const original = { document: globalThis.document, AudioContext: (globalThis as any).AudioContext,
    MutationObserver: globalThis.MutationObserver, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, original));
  const source = await readFile(new URL('../src/web/assets/speech-stream.js', import.meta.url), 'utf8');
  for (const scenario of ['constructor', 'resume', 'json', 'proxy']) {
    let click!: () => Promise<void>;
    const errors: string[] = [], states: string[] = [], attributes: Record<string, string> = {};
    Object.assign(globalThis, {
      document: { body: {}, querySelectorAll: () => [], createElement: () => ({ isConnected: true,
        addEventListener: (_: string, fn: () => Promise<void>) => { click = fn; },
        setAttribute: (name: string, value: string) => { attributes[name] = value; } }) },
      MutationObserver: class { observe() {} disconnect() {} },
      AudioContext: class {
        currentTime = 0;
        constructor() { if (scenario === 'constructor') throw new Error('音频设备不可用'); }
        async resume() { if (scenario === 'resume') throw new Error('浏览器拒绝启用声音'); }
        async close() {}
      },
      fetch: async () => scenario === 'proxy' ? new Response('<h1>Bad Gateway</h1>', { status: 502 })
        : Response.json({ error: '保存的音色不存在或尚未就绪' }, { status: 503 }),
    });
    const { speechButton } = await import(`data:text/javascript;base64,${Buffer.from(source + '\n// failure ' + scenario).toString('base64')}`);
    speechButton('你好', {}, { onError: (message: string) => errors.push(message), onState: (message: string) => states.push(message) });
    await click();
    assert.equal(errors.length, 1, `${scenario}: errors must reach the visible reply notification`);
    assert.match(attributes['aria-label']!, /朗读失败/);
    assert.equal(attributes['aria-pressed'], 'false');
    assert.ok(states.at(-1)?.includes(errors[0]!));
    if (scenario === 'proxy') assert.match(errors[0]!, /502/);
    if (scenario === 'json') assert.match(errors[0]!, /保存的音色不存在/);
    await click();
    assert.equal(errors.length, 2, 'a failed attempt must not remain active');
  }
});

test('reply read-aloud replaces a closed pre-unlocked audio context instead of failing every click', async t => {
  const original = { document: globalThis.document, AudioContext: (globalThis as any).AudioContext,
    MutationObserver: globalThis.MutationObserver, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, original));
  let click!: () => Promise<void>, requests = 0;
  const contexts: Array<{ state: string }> = [];
  Object.assign(globalThis, {
    document: { body: {}, querySelectorAll: () => [], createElement: () => ({ isConnected: true,
      addEventListener: (_: string, fn: () => Promise<void>) => { click = fn; }, setAttribute() {} }) },
    MutationObserver: class { observe() {} disconnect() {} },
    AudioContext: class {
      state = 'suspended'; currentTime = 0;
      constructor() { contexts.push(this); }
      async resume() { if (this.state === 'closed') throw new Error('Cannot resume a closed AudioContext'); this.state = 'running'; }
      async close() { this.state = 'closed'; }
    },
    fetch: async () => { requests++; return Response.json({ error: 'test service error' }, { status: 503 }); },
  });
  const source = await readFile(new URL('../src/web/assets/speech-stream.js', import.meta.url), 'utf8');
  const { armSpeechPlayback, speechButton } = await import(`data:text/javascript;base64,${Buffer.from(source + '\n// closed context').toString('base64')}`);
  armSpeechPlayback('session'); contexts[0]!.state = 'closed';
  speechButton('hello'); await click();
  assert.equal(contexts.length, 2);
  assert.equal(requests, 1, 'manual playback reaches synthesis using a new context');
});


test('PCM playback buffers jitter, joins samples without gaps, fades only exposed edges and drains a short final tail', async () => {
  const source = await readFile(new URL('../src/web/assets/speech-stream.js', import.meta.url), 'utf8');
  const { createPcmPlayback } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const scheduled: Array<{ at: number; data: Float32Array }> = [], events: Array<[string, number, number?]> = [];
  let stops = 0;
  const context = {
    currentTime: 0, destination: {},
    createGain: () => ({ connect() {}, disconnect() {}, gain: {
      setValueAtTime: (value: number, at: number) => events.push(['set', at, value]),
      linearRampToValueAtTime: (value: number, at: number) => events.push(['ramp', at, value]),
      cancelScheduledValues: (at: number) => events.push(['cancel', at]),
    } }),
    createBuffer: (_channels: number, length: number, rate: number) => ({ data: new Float32Array(length), duration: length / rate,
      copyToChannel(data: Float32Array) { this.data.set(data); } }),
    createBufferSource: () => ({ buffer: undefined as any, connect() {}, disconnect() {},
      start(at: number) { scheduled.push({ at, data: this.buffer.data }); }, stop() { stops++; } }),
  };
  const states: string[] = [], player = createPcmPlayback(context, (state: string) => states.push(state));
  const samples = Float32Array.from({ length: 24001 }, (_, i) => Math.sin(i / 20) / 4);
  for (let i = 0; i < 19200; i += 1200) {
    player.push(samples.subarray(i, i + 1200));
    if (i < 18000) assert.equal(scheduled.length, 0, 'tiny packets must not start individual playbacks');
  }
  context.currentTime = 0.5;
  player.push(samples.subarray(19200)); player.finish();
  assert.deepEqual(scheduled.flatMap(chunk => Array.from(chunk.data)), Array.from(samples));
  for (let i = 1; i < scheduled.length; i++) assert.ok(Math.abs(scheduled[i]!.at - scheduled[i - 1]!.at - scheduled[i - 1]!.data.length / 24000) < 1e-9);
  assert.equal(events.filter(event => event[0] === 'cancel').length, scheduled.length - 1);
  context.currentTime = player.endTime + 0.2;
  const count = scheduled.length;
  player.push(new Float32Array(19200)); assert.equal(scheduled.length, count, 'after starvation, accumulate a larger cushion');
  player.push(new Float32Array(19200)); assert.ok(scheduled.length > count);
  assert.ok(scheduled[count]!.at > context.currentTime);
  assert.ok(states.includes('正在缓冲语音…'));
  player.stop(); assert.equal(stops, scheduled.length);
  player.push(new Float32Array(48000)); assert.equal(scheduled.length, stops);
});

test('slow PCM supply increases startup buffering without waiting for full generation', async () => {
  const source = await readFile(new URL('../src/web/assets/speech-stream.js', import.meta.url), 'utf8');
  const { createPcmPlayback } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const starts: Array<{ at: number; duration: number }> = [];
  const context = {
    currentTime: 0, destination: {},
    createGain: () => ({ connect() {}, disconnect() {}, gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} } }),
    createBuffer: (_c: number, n: number, r: number) => ({ duration: n / r, copyToChannel() {} }),
    createBufferSource: () => ({ buffer: undefined as any, connect() {}, disconnect() {}, stop() {},
      start(at: number) { starts.push({ at, duration: this.buffer.duration }); } }),
  };
  const player = createPcmPlayback(context);
  for (let i = 0; i < 80; i++) { context.currentTime = (i + 1) * 0.075; player.push(new Float32Array(1440)); }
  player.finish();
  assert.ok(starts[0]!.at > 2 && starts[0]!.at < context.currentTime);
  for (let i = 1; i < starts.length; i++) assert.ok(Math.abs(starts[i]!.at - starts[i - 1]!.at - starts[i - 1]!.duration) < 1e-8);
});

test('playback drains the output-device clock before closing and manual stop remains immediate', async () => {
  const source = await readFile(new URL('../src/web/assets/speech-stream.js', import.meta.url), 'utf8');
  const { drainSpeechOutput } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  let output = 0.8, waits = 0;
  const context = { currentTime: 1.1, getOutputTimestamp: () => ({ contextTime: output }) };
  await drainSpeechOutput(context, 1, () => false, async () => { waits++; output += 0.05; });
  assert.ok(waits >= 4, 'rendering finished but the physical device still had 200 ms to play');
  waits = 0;
  await drainSpeechOutput(context, 2, () => true, async () => { waits++; });
  assert.equal(waits, 0);
  await drainSpeechOutput({ currentTime: 2, baseLatency: 0.02, outputLatency: 0.3 }, 1, () => false,
    async (ms: number) => { assert.ok(ms >= 370); waits++; });
  assert.equal(waits, 1);
});
