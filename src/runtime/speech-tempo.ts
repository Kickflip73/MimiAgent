import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** atempo changes duration without changing the voice's pitch; all buffers are bounded. */
export async function speechTempo(response: Response, speed: number, signal?: AbortSignal): Promise<Response> {
  if (speed === 1) return response;
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error('语速必须在 0.5 到 2 之间');
  if (!response.body) throw new Error('语音响应没有音频');
  if (signal?.aborted) { await response.body.cancel(); signal.throwIfAborted(); }
  const pcm = response.headers.get('content-type')?.split(';')[0] === 'audio/pcm';
  if (pcm && (response.headers.get('x-sample-rate') !== '24000' || response.headers.get('x-sample-format') !== 's16le')) {
    await response.body?.cancel();
    throw new Error('变速需要 24 kHz s16le PCM');
  }
  const command = await access('/opt/homebrew/bin/ffmpeg', constants.X_OK).then(() => '/opt/homebrew/bin/ffmpeg', () => 'ffmpeg');
  const child = spawn(command, ['-hide_banner', '-loglevel', 'error', ...(pcm ? ['-f', 's16le', '-ar', '24000', '-ac', '1'] : []),
    // Flush atempo's analysis window with silence so its final real phoneme is retained.
    '-i', 'pipe:0', '-af', `apad=pad_dur=0.15,atempo=${speed}`, '-f', 's16le', '-ar', '24000', '-ac', '1', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let errorText = '';
  child.stderr.on('data', chunk => { errorText = (errorText + String(chunk)).slice(-1000); });
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`语速处理失败：${errorText || code}`)));
  });
  void completion.catch(() => {});
  const abort = () => { child.kill('SIGKILL'); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
  const feeding = pipeline(source, child.stdin).catch(error => { abort(); throw error; });
  void feeding.catch(() => {});
  async function* output() {
    try {
      for await (const chunk of child.stdout) yield chunk as Buffer;
      await feeding;
      await completion;
      signal?.throwIfAborted();
    } finally {
      abort(); source.destroy();
      signal?.removeEventListener('abort', abort);
    }
  }
  const outputStream = Readable.from(output());
  // Cancellation can arrive before the iterator's first pull.
  outputStream.once('close', () => { abort(); source.destroy(); signal?.removeEventListener('abort', abort); });
  return new Response(Readable.toWeb(outputStream) as ReadableStream<Uint8Array>, {
    headers: { 'content-type': 'audio/pcm', 'x-sample-rate': '24000', 'x-sample-format': 's16le' },
  });
}
