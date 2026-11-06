import { setTimeout as delay } from 'node:timers/promises';

const lanes = new Map<string, { tail: Promise<void>; count: number }>();

/** Bound admission across local clients; the service gate also coordinates other processes. */
export async function breezeRequest(
  url: string, init: RequestInit, send: typeof fetch, idleMs: number, signal?: AbortSignal,
  queueMs = 10 * 60_000,
): Promise<Response> {
  const key = new URL(url).origin;
  const lane = lanes.get(key) ?? { tail: Promise.resolve(), count: 0 };
  if (lane.count >= 16) throw new Error('语音等待队列已满，请取消不需要的朗读后再试');
  lanes.set(key, lane); lane.count++;
  const previous = lane.tail;
  let unlock!: () => void;
  const turn = new Promise<void>(resolve => { unlock = resolve; });
  lane.tail = previous.then(() => turn);
  const queuedTail = lane.tail;
  let released = false;
  const release = () => {
    if (released) return;
    released = true; lane.count--; unlock();
    void queuedTail.then(() => { if (lane.tail === queuedTail) lanes.delete(key); });
  };
  const queueTimeout = AbortSignal.timeout(queueMs);
  const queued = signal ? AbortSignal.any([signal, queueTimeout]) : queueTimeout;
  let abortWait!: () => void;
  try {
    await Promise.race([previous, new Promise<never>((_, reject) => {
      abortWait = () => reject(queued.reason);
      queued.addEventListener('abort', abortWait, { once: true });
      if (queued.aborted) abortWait();
    })]);
  } catch (error) { release(); throw error; }
  finally { queued.removeEventListener('abort', abortWait); }

  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error('语音服务长时间没有返回音频，已停止等待；原文未缩短')), idleMs);
    timer.unref();
  };
  const abort = () => controller.abort(signal?.reason);
  const abortAdmission = () => controller.abort(queued.reason);
  const cleanup = () => {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    queued.removeEventListener('abort', abortAdmission); release();
  };
  controller.signal.addEventListener('abort', () => { void reader?.cancel().catch(() => {}); cleanup(); }, { once: true });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  queued.addEventListener('abort', abortAdmission, { once: true });
  let response: Response;
  try {
    while (true) {
      queued.throwIfAborted(); refresh();
      // Queue timeout applies until accepted, never to an already running generation.
      response = await send(url, { ...init, signal: controller.signal });
      if (response.status !== 409) break;
      const detail = await response.clone().json().catch(() => null) as { code?: string } | null;
      if (detail?.code !== 'busy') break;
      await response.body?.cancel();
      clearTimeout(timer);
      await delay(500, undefined, { signal: queued });
    }
    queued.removeEventListener('abort', abortAdmission);
    controller.signal.throwIfAborted();
    if (!response.body) { cleanup(); return response; }
    reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(destination) {
        try {
          refresh();
          const chunk = await reader!.read();
          controller.signal.throwIfAborted();
          if (chunk.done) { destination.close(); cleanup(); }
          else { refresh(); destination.enqueue(chunk.value); }
        } catch (error) { destination.error(controller.signal.aborted ? controller.signal.reason : error); cleanup(); }
      },
      async cancel(reason) {
        controller.abort(reason);
        try { await reader!.cancel(reason); } finally { cleanup(); }
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) { cleanup(); throw controller.signal.aborted ? controller.signal.reason : error; }
}
