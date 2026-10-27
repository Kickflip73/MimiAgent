import { chmod, writeFile } from 'node:fs/promises';

/**
 * Client for the local Breeze TTS 2 server (breeze-server.exe).
 *
 * Breeze exposes an OpenAI-compatible `POST /v1/audio/speech`. With
 * `response_format: "wav"` it answers with a 16-bit mono WAV at 24 kHz, which is
 * exactly the format the speech renderer writes. Voice design happens through
 * `instructions`, cloning through a saved `voice` id.
 */
export const BREEZE_DEFAULT_BASE_URL = 'http://127.0.0.1:8080';

export interface BreezeSpeechRequest {
  text: string;
  instructions?: string;
  voiceId?: string;
  timeoutMs: number;
  signal?: AbortSignal;
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
  return `Breeze TTS 服务不可达：${baseUrl}。先启动本地服务：breeze-server breeze-tts-2-q8_0.gguf --host 127.0.0.1 --port 8080`;
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
    const body: Record<string, unknown> = {
      model: 'breeze-tts-2',
      input: request.text,
      response_format: 'wav',
      ...(request.voiceId ? { voice: request.voiceId } : {}),
      ...(request.instructions ? { instructions: request.instructions } : {}),
    };
    const response = await this.send(`${this.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.signalFor(request.timeoutMs, request.signal),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500).trim();
      throw new BreezeTtsError(
        `Breeze TTS 合成失败：HTTP ${response.status}${detail ? ` — ${detail}` : ''}`,
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('audio/')) {
      const detail = (await response.text().catch(() => '')).slice(0, 500).trim();
      throw new BreezeTtsError(
        `Breeze TTS 返回了非音频响应（${contentType || 'unknown'}）${detail ? `：${detail}` : ''}`,
      );
    }
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.byteLength === 0) throw new BreezeTtsError('Breeze TTS 返回了空音频');
    await writeFile(output, audio, { mode: 0o600 });
    await chmod(output, 0o600);
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
