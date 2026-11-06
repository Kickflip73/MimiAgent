import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { speechTempo } from '../src/runtime/speech-tempo.js';
const headers = { 'content-type': 'audio/pcm', 'x-sample-rate': '24000', 'x-sample-format': 's16le' };

test('tempo streams the opening audio without waiting for more input or EOF', { skip: !existsSync('/opt/homebrew/bin/ffmpeg') }, async () => {
  const controller = new AbortController();
  const pcm = Buffer.alloc(48000);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / 24000)), i * 2);
  let input!: ReadableStreamDefaultController<Uint8Array>;
  const response = await speechTempo(new Response(new ReadableStream<Uint8Array>({ start(c) { input = c; } }), { headers }), 1.25, controller.signal);
  const reader = response.body!.getReader();
  const timer = setTimeout(() => controller.abort(new Error('tempo withheld the opening audio')), 3000);
  try {
    input.enqueue(pcm); // Deliberately withhold the next sentence and EOF until output arrives.
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.ok(first.value!.length > 0);
  } finally {
    clearTimeout(timer); controller.abort(); await reader.cancel().catch(() => {});
  }
});

test('Breeze atempo changes duration while preserving pitch', { skip: !existsSync('/opt/homebrew/bin/ffmpeg') }, async () => {
  const pcm = Buffer.alloc(96000);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / 24000)), i * 2);
  const response = await speechTempo(new Response(pcm, { headers }), 1.5, AbortSignal.timeout(5000));
  const result = Buffer.from(await response.arrayBuffer());
  const seconds = result.length / 48000;
  assert.ok(seconds > 1.38 && seconds < 1.5, `duration including end padding ${seconds}`);
  let crossings = 0;
  for (let i = 2; i < result.length; i += 2) if (result.readInt16LE(i - 2) < 0 && result.readInt16LE(i) >= 0) crossings++;
  let voicedEnd = result.length / 2;
  while (voicedEnd > 0 && Math.abs(result.readInt16LE((voicedEnd - 1) * 2)) < 500) voicedEnd--;
  assert.ok(Math.abs(crossings / (voicedEnd / 24000) - 440) < 5);
});

test('tempo cancellation releases its upstream body before any client read', { skip: !existsSync('/opt/homebrew/bin/ffmpeg') }, async () => {
  let cancel!: () => void;
  const cancelled = new Promise<void>(resolve => { cancel = resolve; });
  const response = await speechTempo(new Response(new ReadableStream({ cancel }), { headers }), 1.2);
  await response.body!.cancel();
  await Promise.race([cancelled, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('upstream was not cancelled')), 2000); timer.unref(); })]);
});
