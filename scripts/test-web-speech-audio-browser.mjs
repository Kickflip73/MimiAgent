// Optional Chromium audio-render regression. No microphone, speakers, model or user state.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MimiWebServer } from '../dist/web/server.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MIMI_PLAYWRIGHT_PATH || 'playwright');
const server = new MimiWebServer({}, 0); await server.start();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/audio-fixture', route => route.fulfill({ contentType: 'text/html', body: '<main>Audio render test</main>' }));
  await page.goto(server.address + '/audio-fixture');
  const result = await page.evaluate(async () => {
    const { createPcmPlayback, pcmDecoder } = await import('/speech-stream.js');
    const rate = 24000, count = 48000, pcm = new Int16Array(count);
    for (let i = 0; i < count; i++) pcm[i] = Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / rate));
    const context = new OfflineAudioContext(1, count + 2400, rate);
    const player = createPcmPlayback(context), decoder = pcmDecoder();
    const bytes = new Uint8Array(pcm.buffer);
    for (let at = 0; at < bytes.length; at += 997) player.push(decoder.push(bytes.subarray(at, at + 997)));
    decoder.finish(); player.finish();
    const rendered = (await context.startRendering()).getChannelData(0);
    let maxError = 0, joins = 0;
    // Startup/final 5 ms fades are intentional; all inner joins must match the original PCM.
    for (let i = 120; i < count - 120; i++) maxError = Math.max(maxError, Math.abs(rendered[960 + i] - pcm[i] / 32768));
    for (let i = 4800; i < count; i += 4800) {
      if (Math.abs(rendered[960 + i] - pcm[i] / 32768) < 1e-5) joins++;
    }
    const live = new AudioContext({ sampleRate: 24000 }); const sampleRate = live.sampleRate; await live.close();
    return { maxError, joins, sampleRate, endTime: player.endTime };
  });
  assert.ok(result.maxError < 1e-5, JSON.stringify(result));
  assert.equal(result.joins, 9); assert.equal(result.sampleRate, 24000);
  console.log(JSON.stringify(result));
} finally { await browser.close(); await server.close(); }
