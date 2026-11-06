import { speechTempo } from './speech-tempo.js';
import { breezeRequest } from './breeze-request.js';
import { chmod, open, readFile, unlink, writeFile } from 'node:fs/promises';

/**
 * Client for the local Breeze TTS 2 form/PCM API (including the MLX server).
 * Voice design uses `instruction`; saved server voices use `voice_id`.
 */
export const BREEZE_DEFAULT_BASE_URL = 'http://127.0.0.1:8080';

export interface BreezeSpeechRequest {
  text: string;
  instructions?: string;
  voiceId?: string;
  referenceAudio?: { audio: Uint8Array; text: string };
  speed?: number;
  timeoutMs: number;
  signal?: AbortSignal;
  onAudioReady?: () => Promise<void>;
}

export interface BreezeHealth {
  ok: boolean;
  sampleRate?: number;
}

export class BreezeTtsError extends Error {
  readonly name = 'BreezeTtsError';
}

export function normalizeBreezeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new BreezeTtsError('Breeze TTS 服务地址不能为空');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BreezeTtsError(`Breeze TTS 服务地址无效：${trimmed}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BreezeTtsError(`Breeze TTS 服务地址必须使用 http 或 https：${trimmed}`);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, '')}`;
}

function connectionHint(baseUrl: string): string {
  return `Breeze TTS 服务不可达：${baseUrl}。先启动本地服务并检查 /health；MLX 独立部署步骤见 docs/BREEZE_TTS.md`;
}

function pcmWavHeader(bytes: number, headers: Headers): Buffer {
  if (headers.get('x-sample-rate') !== '24000' || headers.get('x-sample-format') !== 's16le') {
    throw new BreezeTtsError('Breeze TTS PCM 格式无效：需要 24000 Hz、s16le 单声道音频');
  }
  if (bytes % 2 !== 0 || bytes > 0xffff_ffff - 36) {
    throw new BreezeTtsError('Breeze TTS PCM 数据长度无效');
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + bytes, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes, 40);
  return header;
}

export class BreezeTtsClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.baseUrl = normalizeBreezeBaseUrl(baseUrl);
  }

  async health(signal?: AbortSignal): Promise<BreezeHealth> {
    const response = await this.send(`${this.baseUrl}/health`, {
      method: 'GET',
      signal: this.signalFor(5_000, signal),
    });
    if (!response.ok) return { ok: false };
    const body = await response.json().catch(() => undefined) as
      { sample_rate?: unknown; sampleRate?: unknown } | undefined;
    const rate = body?.sample_rate ?? body?.sampleRate;
    return typeof rate === 'number' && rate > 0 ? { ok: true, sampleRate: rate } : { ok: true };
  }

  /** Synthesize `request.text` and write the resulting WAV to `output`. */
  async synthesizeToFile(request: BreezeSpeechRequest, output: string): Promise<void> {
    const response = await this.stream(request);
    const contentType = response.headers.get('content-type') ?? '';
    const mediaType = contentType.split(';')[0]?.trim().toLowerCase();
    if (mediaType === 'audio/pcm') {
      let header: Buffer;
      try { header = pcmWavHeader(0, response.headers); }
      catch (error) { await response.body?.cancel(); throw error; }
      const file = await open(output, 'wx', 0o600).catch(async error => { await response.body?.cancel(); throw error; });
      const reader = response.body!.getReader();
      let bytes = 0;
      try {
        await file.writeFile(header);
        while (true) {
          request.signal?.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          if (!value.length) continue;
          if (bytes + value.length > 0xffff_ffff - 36) throw new BreezeTtsError('PCM 数据过大');
          await file.writeFile(value);
          if (bytes === 0) await request.onAudioReady?.();
          bytes += value.length;
        }
        if (!bytes) throw new BreezeTtsError('Breeze TTS 返回了空音频');
        await file.write(pcmWavHeader(bytes, response.headers), 0, 44, 0);
      } catch (error) {
        // A partial live stream is never exposed as a completed WAV artifact.
        await unlink(output).catch(() => {});
        throw error;
      } finally {
        await reader.cancel().catch(() => {});
        await file.close();
      }
      return;
    }
    const audio: Buffer = Buffer.from(await response.arrayBuffer());
    if (audio.byteLength === 0) throw new BreezeTtsError('Breeze TTS 返回了空音频');
    if ((mediaType !== 'audio/wav' && mediaType !== 'audio/x-wav')
      || audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF'
      || audio.toString('ascii', 8, 12) !== 'WAVE') {
      throw new BreezeTtsError('Breeze TTS 返回了不支持或无效的音频，不能保存为 WAV');
    }
    await writeFile(output, audio, { mode: 0o600 });
    await chmod(output, 0o600);
  }

  /** A single request; callers must cancel the body when playback stops. */
  async stream(request: BreezeSpeechRequest): Promise<Response> {
    if (request.speed !== undefined && (!Number.isFinite(request.speed) || request.speed < 0.5 || request.speed > 2)) throw new BreezeTtsError('语速必须在 0.5 到 2 之间');
    const signal = request.signal;
    if (request.voiceId && request.referenceAudio) throw new BreezeTtsError('参考音频和已保存音色不能同时使用');
    const body = request.referenceAudio ? new FormData() : new URLSearchParams();
    body.set('text', request.text);
    // One speaker for the whole request: the local service pins its reference and
    // seed across pieces, and fails instead of silently redesigning a later voice.
    // Pair longer passages with a larger audio budget; never disable context limits.
    body.set('stable_voice', '1');
    body.set('split_chars', '750');
    body.set('max_new_tokens', '1200');
    body.set('seed', '42');
    if (request.referenceAudio) {
      (body as FormData).set('ref_audio', new Blob([new Uint8Array(request.referenceAudio.audio)], { type: 'audio/wav' }), 'reference.wav');
      body.set('ref_text', request.referenceAudio.text);
      body.set('cfg_scale', '0'); body.set('seed', '42');
    }
    if (request.voiceId) {
      body.set('voice_id', request.voiceId);
      // The MLX API replaces missing/blank instructions with its default. Scale 0
      // selects ref_clone_tata (reference + plain text), including on the KV-prefix path.
      body.set('cfg_scale', '0');
      body.set('seed', '42');
    }
    else if (!request.referenceAudio && request.instructions) body.set('instruction', request.instructions);
    const response = await breezeRequest(`${this.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      body,
    }, (url, init) => this.send(String(url), init ?? {}), Math.max(1000, request.timeoutMs), signal);
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500).trim();
      throw new BreezeTtsError(
        `Breeze TTS 合成失败：HTTP ${response.status}${detail ? ` — ${detail}` : ''}`,
      );
    }
    if (response.headers.get('x-breeze-stable-voice') !== '1') {
      await response.body?.cancel();
      throw new BreezeTtsError('Breeze 服务尚未加载单音色连续朗读修复，请更新独立语音服务后再试');
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('audio/')) {
      const detail = (await response.text().catch(() => '')).slice(0, 500).trim();
      throw new BreezeTtsError(
        `Breeze TTS 返回了非音频响应（${contentType || 'unknown'}）${detail ? `：${detail}` : ''}`,
      );
    }
    return speechTempo(response, request.speed ?? 1, signal);
  }

  async registerVoice(id: string, file: string, transcript: string, signal?: AbortSignal): Promise<string> {
    return this.registerVoiceAudio(id, await readFile(file), transcript, signal);
  }

  async registerVoiceAudio(id: string, audio: Uint8Array, transcript: string, signal?: AbortSignal): Promise<string> {
    const form = new FormData();
    form.set('name', id);
    form.set('ref_text', transcript);
    form.set('ref_audio', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'reference.wav');
    const response = await breezeRequest(`${this.baseUrl}/v1/voices`, { method: 'POST', body: form },
      (url, init) => this.send(String(url), init ?? {}), 120000, signal);
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500).trim();
      throw new BreezeTtsError(`保存音色失败：HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
    }
    const value = await response.json() as { id?: unknown; saved?: unknown };
    if (value.id !== id || value.saved !== true) throw new BreezeTtsError('服务没有确认持久化音色');
    return id;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      const cause = (error as { cause?: { code?: unknown } }).cause;
      const code = typeof cause?.code === 'string' ? cause.code : undefined;
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === undefined) {
        throw new BreezeTtsError(connectionHint(this.baseUrl));
      }
      throw new BreezeTtsError(`${connectionHint(this.baseUrl)}（${code}）`);
    }
  }

  private signalFor(timeoutMs: number, signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(Math.max(1_000, timeoutMs));
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }
}
