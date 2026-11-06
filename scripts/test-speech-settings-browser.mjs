// Optional browser regression, with an isolated store and synthetic audio only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MimiWebServer } from '../dist/web/server.js';
import { SpeechOutput } from '../dist/runtime/speech-output.js';
import { BreezeTtsClient } from '../dist/runtime/breeze-tts.js';
import { saveMedia, readMedia } from '../dist/runtime/media-input.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.MIMI_PLAYWRIGHT_PATH || 'playwright');
const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-voice-ui-'));
let failSave = false, generateCalls = 0, releaseGeneration;
const generationGate = new Promise(resolve => { releaseGeneration = resolve; });
const speech = new SpeechOutput({ enabled: true, command: '/bin/echo', playbackCommand: '/bin/echo', synthesisTimeoutMs: 1000, playbackTimeoutMs: 1000, breezeUrl: 'http://127.0.0.1:8080' }, path.join(root, 'speech'), undefined,
  new BreezeTtsClient('http://127.0.0.1:8080', async (url, init) => String(url).endsWith('/v1/voices')
    ? Response.json({ id: init.body.get('name'), saved: true })
    : new Response(new Uint8Array(48000), { headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000', 'x-sample-format': 's16le', 'x-breeze-stable-voice': '1' } })));
await speech.configure({ engine: 'breeze', voice: 'breeze:zh-narrator' });
const server = new MimiWebServer({
  speechManage: async (action, value, signal) => {
    if (action === 'voice_preview') { generateCalls++; await generationGate; }
    if (failSave && action === 'configure') throw new Error('测试保存失败');
    if (action === 'voice_clone_preview') { const media = await readMedia(path.join(root, 'media'), value.mediaId); return speech.previewVoice({ id: value.id, name: value.name, text: value.text, options: { engine: 'breeze' } }, media.data, signal); }
    return speech.manage(action, value, signal);
  },
  speechPreview: id => speech.previewAudio(id),
  speechStream: (text, signal, options) => speech.stream(text, options, signal),
  uploadMedia: (data, type) => saveMedia(path.join(root, 'media'), data, type),
}, 0, 'speech-test.invalid');
await server.start();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--host-resolver-rules=MAP speech-test.invalid 127.0.0.1', '--no-proxy-server'] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // Custom HTTP domains omit this API; the app must use its shared UUID helper.
  await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }));
  page.setDefaultTimeout(8000);
  await page.route('**/voice-fixture', route => route.fulfill({ contentType: 'text/html', body: `<link rel="stylesheet" href="/styles.css"><main id="root" style="max-width:780px;margin:40px auto;padding:0 24px"></main><script type="module">import { mountSpeechSettings } from '/speech-settings.js'; await mountSpeechSettings(document.querySelector('#root'));</script>` }));
  await page.route('**/speech-settings.js', async route => route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../src/web/assets/speech-settings.js', import.meta.url), 'utf8') }));
  await page.goto(server.address + '/voice-fixture');
  const panel = page.locator('.speech-settings');
  await panel.locator('.speech-engine-row').last().waitFor();
  assert.equal(await panel.locator('select:visible').count(), 0);
  assert.equal(await panel.locator('.speech-engine-row').count(), 3);
  assert.equal(await panel.locator('[data-speech="studio"]').isVisible(), false);
  const choose = async (engine, name) => {
    await panel.locator(`[data-engine="${engine}"] .picker-trigger`).click();
    await page.getByRole('option', { name, exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-speech="status"]').textContent === '已保存');
  };
  await choose('kokoro', 'Echo');
  assert.equal((await speech.catalog()).engineVoices.kokoro, 'am_echo');
  await page.getByRole('button', { name: '将 Kokoro 设为默认引擎', exact: true }).click();
  await page.getByRole('button', { name: 'Kokoro 已是默认引擎', exact: true }).waitFor();
  assert.equal(await panel.locator('[data-speech="breeze"]').isVisible(), false);
  await page.getByRole('button', { name: '将 Breeze 设为默认引擎', exact: true }).click();
  await page.getByRole('button', { name: 'Breeze 已是默认引擎', exact: true }).waitFor();
  await page.getByRole('button', { name: '语速', exact: true }).click();
  await page.getByRole('option', { name: '1.25× · 稍快', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-speech="speed"]').value === '1.25');
  failSave = true;
  await page.getByRole('button', { name: '语速', exact: true }).click();
  await page.getByRole('option', { name: '1.5× · 快速', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-speech="status"]').textContent.includes('未保存'));
  assert.equal(await panel.locator('[data-speech="speed"]').inputValue(), '1.25'); failSave = false;
  await page.getByRole('button', { name: '定制 Breeze 音色' }).click();
  await page.getByRole('button', { name: '生成音色', exact: true }).click();
  assert.equal(await panel.locator('[data-speech="name"]').evaluate(node => node === document.activeElement), true);
  assert.match(await panel.locator('[data-speech="studioStatus"]').textContent(), /名称/);
  await panel.locator('[data-speech="name"]').fill('温柔晚安');
  await panel.locator('[data-speech="description"]').fill('温柔自然的中文女声');
  await page.evaluate(() => {
    window.originalRandomValues = crypto.getRandomValues;
    crypto.getRandomValues = () => { throw new Error('测试：无法创建音色编号'); };
  });
  await page.getByRole('button', { name: '生成音色', exact: true }).click();
  assert.match(await panel.locator('[data-speech="studioStatus"]').textContent(), /无法创建音色编号/);
  assert.equal(await panel.locator('[data-speech="create"]').isEnabled(), true);
  assert.equal(generateCalls, 0);
  await page.evaluate(() => { crypto.getRandomValues = window.originalRandomValues; });

  await page.getByRole('button', { name: '生成音色', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '正在生成…', exact: true }).isDisabled(), true);
  assert.equal(await panel.locator('[data-speech="create"]').getAttribute('aria-busy'), 'true');
  await panel.locator('[data-speech="create"]').evaluate(button => button.click());
  releaseGeneration();
  await page.getByRole('button', { name: '试听新音色', exact: true }).waitFor();
  assert.equal(generateCalls, 1);
  assert.equal((await speech.catalog()).profiles.length, 0);
  assert.equal((await speech.catalog()).defaults.voice, 'breeze:zh-narrator');
  assert.equal(await page.getByRole('button', { name: '保存音色', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '试听新音色', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-speech="studioStatus"]').textContent.includes('朗读'));
  await page.getByRole('button', { name: '保存音色', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-speech="studioStatus"]').textContent.includes('已加入音色列表'));
  assert.equal((await speech.catalog()).profiles.length, 1);
  assert.equal((await speech.catalog()).defaults.voice, 'breeze:zh-narrator');
  await page.getByRole('button', { name: '上传声音', exact: true }).click();
  const wav = await page.evaluate(async () => {
    const { voiceSampleWav } = await import('/speech-settings.js');
    return Array.from(new Uint8Array(await voiceSampleWav({ duration: 2, length: 48000, sampleRate: 24000, numberOfChannels: 1, getChannelData: () => new Float32Array(48000).fill(0.1) }).arrayBuffer()));
  });
  await panel.locator('[data-speech="name"]').fill('上传音色');
  await panel.locator('[data-speech="file"]').setInputFiles({ name: 'sample.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav) });
  await panel.locator('[data-speech="referencePlayer"]').waitFor();
  await panel.locator('[data-speech="transcript"]').fill('这是一段测试声音');
  await page.getByRole('button', { name: '克隆音色', exact: true }).click();
  await page.getByRole('button', { name: '试听新音色', exact: true }).waitFor();
  assert.equal((await speech.catalog()).profiles.length, 1);
  await page.getByRole('button', { name: '放弃', exact: true }).click();
  assert.equal((await speech.catalog()).profiles.length, 1);
  await page.getByRole('button', { name: '录音克隆', exact: true }).click();
  await page.getByRole('button', { name: '录音麦克风', exact: true }).waitFor({ timeout: 3000 });
  await page.evaluate(() => {
    window.takes = []; const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => { const stream = await original(...args); window.takes.push(stream); return stream; };
  });
  await page.getByRole('button', { name: '开始录音', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-speech="device"]').options.length > 1);
  await page.getByRole('button', { name: '录音麦克风', exact: true }).click();
  await page.getByRole('option', { name: '系统默认麦克风', exact: true }).click();
  await page.waitForFunction(() => window.takes.length === 2);
  assert.equal(await page.evaluate(() => window.takes[0].getTracks().every(track => track.readyState === 'ended')), true);
  await page.waitForFunction(() => document.querySelector('[data-speech="recordState"]').textContent.startsWith('2 秒'));
  await page.getByRole('button', { name: '结束录音', exact: true }).click();
  await panel.locator('[data-speech="referencePlayer"]').waitFor();
  assert.equal(await page.evaluate(() => window.takes.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))), true);
  assert.equal(await page.getByRole('button', { name: '录音麦克风', exact: true }).isVisible(), true);
  await panel.locator('[data-speech="name"]').fill('录音音色');
  await page.getByRole('button', { name: '克隆音色', exact: true }).click();
  await page.getByRole('button', { name: '试听新音色', exact: true }).waitFor();
  assert.equal((await speech.catalog()).profiles.length, 1);
  await page.getByRole('button', { name: '试听新音色', exact: true }).click();
  await page.getByRole('button', { name: '保存音色', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-speech="studioStatus"]').textContent.includes('已加入音色列表'));
  assert.equal((await speech.catalog()).profiles.length, 2);
  await choose('breeze', '温柔晚安 · 定制');
  await page.getByRole('button', { name: '删除音色 温柔晚安', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await speech.catalog()).profiles.length, 2);
  await page.getByRole('button', { name: '删除音色 温柔晚安', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.speech-delete-confirm'));
  assert.equal((await speech.catalog()).profiles.length, 1);
  assert.equal((await speech.catalog()).defaults.voice, '');
  await page.getByRole('button', { name: '文字描述', exact: true }).click();
  await page.screenshot({ path: '/tmp/mimi-voice-settings-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/tmp/mimi-voice-settings-mobile.png', fullPage: true });
  // A silent take must leave a usable device selector and clear the error on retry.
  await page.getByRole('button', { name: '录音克隆', exact: true }).click();
  await page.evaluate(() => {
    window.originalMeter = AnalyserNode.prototype.getFloatTimeDomainData;
    AnalyserNode.prototype.getFloatTimeDomainData = function (samples) { samples.fill(0); };
  });
  await page.getByRole('button', { name: '开始录音', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-speech="recordState"]').textContent.includes('未检测到声音'));
  await page.getByRole('button', { name: '结束录音', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-speech="studioStatus"]').textContent.includes('没有录到声音'));
  await page.getByRole('button', { name: '录音麦克风', exact: true }).click();
  await page.getByRole('option', { name: '系统默认麦克风', exact: true }).click();
  await page.evaluate(() => { AnalyserNode.prototype.getFloatTimeDomainData = window.originalMeter; });
  await page.getByRole('button', { name: '开始录音', exact: true }).click();
  assert.equal(await panel.locator('[data-speech="studioStatus"]').textContent(), '');
  await page.getByRole('button', { name: '文字描述', exact: true }).click();
  // Removing the settings view also releases an active microphone.
  await page.getByRole('button', { name: '录音克隆', exact: true }).click();
  await page.getByRole('button', { name: '开始录音', exact: true }).click();
  await page.getByRole('button', { name: '结束录音', exact: true }).waitFor();
  await page.evaluate(() => document.querySelector('#root').replaceChildren());
  await page.waitForFunction(() => window.takes.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
  assert.deepEqual(errors, []);
  // Exercise a real insecure custom HTTP origin, not just a simulated missing API.
  const httpPage = await browser.newPage();
  httpPage.on('pageerror', error => errors.push(error.message));
  httpPage.setDefaultTimeout(8000);
  const httpFailures = [];
  httpPage.on('requestfailed', request => httpFailures.push({ url: request.url(), error: request.failure()?.errorText }));
  await httpPage.route('**/app.js', route => route.fulfill({ contentType: 'text/javascript', body: `import { mountSpeechSettings } from '/speech-settings.js'; document.body.replaceChildren(); const root = document.createElement('main'); document.body.append(root); await mountSpeechSettings(root);` }));
  await httpPage.route('**/speech-settings.js', async route => route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../src/web/assets/speech-settings.js', import.meta.url), 'utf8') }));
  await httpPage.goto(server.launchUrl);
  assert.equal(await httpPage.evaluate(() => isSecureContext), false);
  assert.equal(await httpPage.evaluate(() => typeof crypto.randomUUID), 'undefined');
  await httpPage.getByRole('button', { name: '定制 Breeze 音色' }).click().catch(async error => { console.error(JSON.stringify({ errors, httpFailures, body: await httpPage.locator('body').innerText() })); throw error; });
  await httpPage.locator('[data-speech="name"]').fill('HTTP 音色');
  await httpPage.locator('[data-speech="description"]').fill('自然温柔的女声');
  await httpPage.getByRole('button', { name: '生成音色', exact: true }).click();
  await httpPage.getByRole('button', { name: '试听新音色', exact: true }).waitFor();
  assert.equal((await speech.catalog()).profiles.length, 1);
  await httpPage.getByRole('button', { name: '放弃', exact: true }).click();
  assert.equal((await speech.catalog()).profiles.length, 1);
  assert.equal(generateCalls, 2);
  assert.deepEqual(errors, []);

  console.log('Voice UI: defaults, per-engine voices, save failure, description, upload, recording, preview, cleanup and mobile layout passed.');
} finally { await browser.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
