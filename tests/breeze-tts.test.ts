import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import type { TtsConfig } from '../src/config.js';
import {
  BREEZE_DEFAULT_BASE_URL,
  BreezeTtsClient,
  BreezeTtsError,
  normalizeBreezeBaseUrl,
} from '../src/runtime/breeze-tts.js';
import {
  SpeechOutput,
  SpeechRenderUncertainError,
  type SpeechCommandRunner,
} from '../src/runtime/speech-output.js';
import { createSpeechTools } from '../src/runtime/speech-tools.js';

interface CapturedRequest {
  method: string;
  url: string;
  contentType?: string;
  body: string;
}

const WAV = Buffer.from('RIFFbreeze-wav-fixture');

async function fakeBreeze(
  respond: (request: CapturedRequest) => { status: number; contentType: string; body: Buffer | string },
): Promise<{ server: Server; url: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const captured: CapturedRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(captured);
      const reply = respond(captured);
      response.writeHead(reply.status, { 'content-type': reply.contentType });
      response.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake breeze server did not bind');
  return { server, url: `http://127.0.0.1:${address.port}`, requests };
}

function breezeConfig(url: string): TtsConfig {
  return {
    enabled: true,
    command: path.join(os.tmpdir(), 'no-such-renderer'),
    playbackCommand: path.join(os.tmpdir(), 'no-such-player'),
    synthesisTimeoutMs: 10_000,
    playbackTimeoutMs: 10_000,
    breezeUrl: url,
  };
}

test('client posts the OpenAI-compatible speech request and writes the returned WAV', async (t) => {
  const fake = await fakeBreeze(() => ({ status: 200, contentType: 'audio/wav', body: WAV }));
  t.after(() => new Promise<void>((resolve) => fake.server.close(() => resolve())));
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-breeze-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const speech = new SpeechOutput(breezeConfig(fake.url), root, async () => {
    throw new Error('breeze must not shell out to a renderer command');
  });
  const audio = await speech.synthesize('你好，本地语音合成。', { voice: 'breeze:zh-narrator', language: 'zh' });

  assert.equal(audio.engine, 'breeze');
  assert.equal(audio.voice, 'breeze:zh-narrator');
  assert.equal(audio.format, 'wav');
  assert.equal(await readFile(audio.file, 'utf8'), WAV.toString('utf8'));

  assert.equal(fake.requests.length, 1);
  const sent = fake.requests[0]!;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, '/v1/audio/speech');
  assert.match(sent.contentType ?? '', /application\/json/);
  const payload = JSON.parse(sent.body) as Record<string, unknown>;
  assert.equal(payload.input, '你好，本地语音合成。');
  assert.equal(payload.response_format, 'wav');
  assert.equal(payload.model, 'breeze-tts-2');
  assert.match(String(payload.instructions), /中文女声|旁白/);
});

test('auto engine prefers breeze once a server URL is configured, without touching the renderer command', async (t) => {
  const fake = await fakeBreeze(() => ({ status: 200, contentType: 'audio/wav', body: WAV }));
  t.after(() => new Promise<void>((resolve) => fake.server.close(() => resolve())));
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-breeze-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  let rendererCalls = 0;
  const runner: SpeechCommandRunner = async () => {
    rendererCalls += 1;
    return { stdout: 'engine=kokoro', stderr: '' };
  };
  const speech = new SpeechOutput(breezeConfig(fake.url), root, runner);
  const audio = await speech.synthesize('Good evening.');
  assert.equal(audio.engine, 'breeze');
  assert.equal(rendererCalls, 0);
  assert.equal(audio.language, 'en');
});

test('an unreachable server is reported with the start-up command instead of a raw fetch error', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('probe server did not bind');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const client = new BreezeTtsClient(`http://127.0.0.1:${port}`);
  await assert.rejects(
    client.synthesizeToFile({ text: 'hi', timeoutMs: 2_000 }, path.join(os.tmpdir(), 'never.wav')),
    (error: unknown) => error instanceof BreezeTtsError
      && /先启动本地服务/.test(error.message)
      && /breeze-server/.test(error.message),
  );
});

test('a non-audio or failing response is surfaced and leaves an uncertain render receipt', async (t) => {
  const fake = await fakeBreeze(() => ({ status: 200, contentType: 'application/json', body: '{"error":"boom"}' }));
  t.after(() => new Promise<void>((resolve) => fake.server.close(() => resolve())));
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-breeze-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const speech = new SpeechOutput(breezeConfig(fake.url), root);
  await assert.rejects(
    speech.synthesize('会失败的合成'),
    (error: unknown) => error instanceof SpeechRenderUncertainError
      && /非音频响应/.test(error.message)
      && error.audio.engine === 'breeze',
  );
  const receipts = [...await speech.inspect()];
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.status, 'uncertain');
});

test('voices action exposes breeze presets with their design instructions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-breeze-'));
  const speech = new SpeechOutput(breezeConfig(BREEZE_DEFAULT_BASE_URL), root);
  const speechTool = createSpeechTools(speech)[0];
  if (!speechTool || !('invoke' in speechTool)) throw new Error('speech tool is not callable');
  const voices = JSON.stringify(await speechTool.invoke(new RunContext({}), JSON.stringify({ action: 'voices' })));
  assert.match(voices, /breeze:zh-narrator/);
  assert.match(voices, /breeze:en-narrator/);
  assert.match(voices, /"engine":"breeze"/);
  assert.match(voices, /instructions/);
});

test('base URL normalization rejects non-http schemes and trailing slashes', () => {
  assert.equal(normalizeBreezeBaseUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  assert.equal(normalizeBreezeBaseUrl('http://127.0.0.1:8080/api/'), 'http://127.0.0.1:8080/api');
  assert.throws(() => normalizeBreezeBaseUrl('file:///tmp/x'), BreezeTtsError);
  assert.throws(() => normalizeBreezeBaseUrl('not a url'), BreezeTtsError);
});
