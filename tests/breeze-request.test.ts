import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { breezeRequest } from '../src/runtime/breeze-request.js';

const url = 'http://127.0.0.1:18080/v1/audio/speech';
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await setImmediate(); }
  assert.ok(check(), 'expected state was not reached');
}

test('speech admission holds its slot through EOF; cancelled waiters never synthesize', async () => {
  let first!: ReadableStreamDefaultController<Uint8Array>, calls = 0;
  const send: typeof fetch = async () => {
    calls++;
    return calls === 1 ? new Response(new ReadableStream({ start(c) { first = c; c.enqueue(new Uint8Array([1, 2])); } })) : new Response('next');
  };
  const a = await breezeRequest(url, {}, send, 1000);
  const cancel = new AbortController();
  const b = breezeRequest(url, {}, send, 1000, cancel.signal);
  const rejected = assert.rejects(b, /cancel queued/);
  const c = breezeRequest(url, {}, send, 1000);
  cancel.abort(new Error('cancel queued')); await rejected;
  assert.equal(calls, 1);
  const aBody = a.arrayBuffer(); first.close(); await aBody;
  assert.equal(await (await c).text(), 'next'); assert.equal(calls, 2);
});

test('only explicit pre-admission busy responses wait; accepted/uncertain work is never replayed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const send: typeof fetch = async () => {
    calls++;
    return calls === 1 ? Response.json({ code: 'busy' }, { status: 409 }) : new Response('audio');
  };
  const pending = breezeRequest(url, {}, send, 1000);
  await until(() => calls === 1); await setImmediate(); await setImmediate();
  t.mock.timers.tick(500);
  assert.equal(await (await pending).text(), 'audio'); assert.equal(calls, 2);
  const response = await breezeRequest(url, {}, async () => { calls++; return Response.json({ code: 'voice_exists' }, { status: 409 }); }, 1000);
  assert.equal(response.status, 409); await response.text(); assert.equal(calls, 3);
  const failed = await breezeRequest(url, {}, async () => { calls++; return new Response(new ReadableStream({ pull(c) { c.error(new Error('broken stream')); } })); }, 1000);
  await assert.rejects(failed.arrayBuffer(), /broken stream/); assert.equal(calls, 4);
});

test('continuous progress outlives the idle timeout; a stalled stream releases its slot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const response = await breezeRequest(url, {}, async () => new Response(new ReadableStream({ start(c) { upstream = c; } })), 100);
  const reader = response.body!.getReader();
  for (let i = 0; i < 10; i++) {
    upstream.enqueue(new Uint8Array([i])); assert.equal((await reader.read()).value![0], i);
    t.mock.timers.tick(50); await setImmediate();
  }
  const waiting = reader.read(); const failure = assert.rejects(waiting, /长时间没有返回音频/);
  t.mock.timers.tick(101); await failure;
  assert.equal(await (await breezeRequest(url, {}, async () => new Response('next'), 100)).text(), 'next');
});

test('cancelling an accepted stream releases upstream and admits the next request', async () => {
  let cancelled = false;
  const stop = new AbortController();
  const response = await breezeRequest(url, {}, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })), 1000, stop.signal);
  const pending = response.arrayBuffer(); const failure = assert.rejects(pending, /stop playback/);
  stop.abort(new Error('stop playback')); await failure;
  assert.ok(cancelled);
  assert.equal(await (await breezeRequest(url, {}, async () => new Response('next'), 1000)).text(), 'next');
});

test('admission deadline cannot abort an accepted long story', async t => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const response = await breezeRequest(url, {}, async () => new Response(new ReadableStream({ start(c) { upstream = c; } })), 1000);
  deadline.abort(new Error('admission expired'));
  upstream.enqueue(new Uint8Array([1, 2, 3])); upstream.close();
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
});

test('queue capacity and waiting deadlines never submit excess synthesis work', async t => {
  const deadlines: AbortController[] = [];
  t.mock.method(AbortSignal, 'timeout', () => {
    const deadline = new AbortController(); deadlines.push(deadline); return deadline.signal;
  });
  let calls = 0;
  const send: typeof fetch = async () => { calls++; return new Response('audio'); };
  const running = await breezeRequest(url, {}, send, 1000);
  const waiters = Array.from({ length: 15 }, () => breezeRequest(url, {}, send, 1000));
  const failures = waiters.map(waiter => assert.rejects(waiter, /queue expired/));
  await assert.rejects(breezeRequest(url, {}, send, 1000), /队列已满/);
  for (const deadline of deadlines.slice(1)) deadline.abort(new Error('queue expired'));
  await Promise.all(failures);
  assert.equal(calls, 1);
  assert.equal(await running.text(), 'audio');
  assert.equal(await (await breezeRequest(url, {}, send, 1000)).text(), 'audio');
  assert.equal(calls, 2);
});
