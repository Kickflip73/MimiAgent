import { createHash } from 'node:crypto';

const MAX_MODEL_RESULT_BYTES = 16 * 1024;
const RESULT_PREVIEW_CHARS = 12_000;

export interface BrowserCapabilityRequest {
  capability: string;
  action: string;
  target: string;
  payload: Record<string, unknown>;
}

export interface BrowserCapabilityResult {
  connector: string;
  effect: 'read' | 'write' | 'unknown';
  result: unknown;
}

export type BrowserCapabilityExecutor = (
  request: BrowserCapabilityRequest,
  signal?: AbortSignal,
) => Promise<BrowserCapabilityResult>;

export interface BrowserOpenInput {
  url: string;
}

type BrowserSessionState = 'idle' | 'active' | 'uncertain' | 'closed';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stripInternalHandles(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 200).map(stripInternalHandles);
  const object = record(value);
  if (!object) return typeof value === 'string' && value.length > RESULT_PREVIEW_CHARS
    ? `${value.slice(0, RESULT_PREVIEW_CHARS)}\n[truncated]`
    : value;
  return Object.fromEntries(Object.entries(object)
    .filter(([key]) => !/^(?:sessionRef|opencliSession)$/i.test(key))
    .map(([key, item]) => [key, stripInternalHandles(item)]));
}

function boundedResult(value: unknown): unknown {
  const safe = stripInternalHandles(value);
  const encoded = JSON.stringify(safe);
  const bytes = Buffer.byteLength(encoded);
  if (bytes <= MAX_MODEL_RESULT_BYTES) return safe;
  const candidate = (preview: string) => ({
    truncated: true,
    originalBytes: bytes,
    preview,
    message: 'Browser result exceeded the model payload budget; narrow the selector or use extract pagination.',
  });
  let low = 0;
  let high = Math.min(encoded.length, RESULT_PREVIEW_CHARS);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(candidate(encoded.slice(0, middle)))) <= MAX_MODEL_RESULT_BYTES) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return candidate(encoded.slice(0, low));
}

function resultOutcome(value: unknown): string | undefined {
  const direct = record(value)?.outcome;
  return typeof direct === 'string' ? direct : undefined;
}

function safeHttpUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 8_000) {
    throw new Error('browser_url_invalid：URL 必须是 1..8000 字符的字符串');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('browser_url_invalid：URL 必须是绝对 http/https URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('browser_url_invalid：只允许不含内嵌凭证的绝对 http/https URL');
  }
  return parsed.toString();
}

export class BrowserRunManager {
  readonly target: string;
  private state: BrowserSessionState = 'idle';
  private closeAttempt?: Promise<unknown>;

  constructor(
    runId: string,
    private readonly executeCapability: BrowserCapabilityExecutor,
  ) {
    const digest = createHash('sha256').update(runId).digest('hex').slice(0, 16);
    this.target = `mimi-browser-${digest}`;
  }

  async open(input: BrowserOpenInput, signal?: AbortSignal): Promise<unknown> {
    if (this.state !== 'idle') {
      throw new Error('browser_session_exists：每个 Run 只允许一个 Host-owned Browser session 生命周期');
    }
    const url = safeHttpUrl(input.url);
    signal?.throwIfAborted();
    this.state = 'uncertain';
    let receipt: BrowserCapabilityResult;
    try {
      receipt = await this.execute('browser.session.write', 'open_session', {
        url,
        window: 'background',
      }, signal);
    } catch (error) {
      if (error instanceof Error && error.name === 'ActionFailedSafeError') this.state = 'idle';
      throw error;
    }
    const outcome = resultOutcome(receipt.result);
    this.state = outcome === 'accepted' ? 'uncertain' : 'active';
    return boundedResult({
      status: this.state,
      connector: receipt.connector,
      effect: receipt.effect,
      outcome: outcome ?? 'confirmed',
    });
  }

  async observe(
    operation: string,
    capability: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.requireSession();
    return boundedResult(await this.execute(capability, operation, payload, signal));
  }

  async act(
    operation: string,
    capability: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.requireSession();
    const boundedPayload = (operation === 'navigate' || operation === 'new_tab')
      && payload.url !== undefined
      ? { ...payload, url: safeHttpUrl(payload.url) }
      : payload;
    return boundedResult(await this.execute(capability, operation, boundedPayload, signal));
  }

  async wait(
    input: { kind: 'selector' | 'text' | 'xhr' | 'download'; value: string; timeoutMs: number; page?: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.observe('wait', 'browser.page.wait', input, signal);
  }

  async assert(
    input: { kind: 'selector' | 'text'; value: string; timeoutMs: number; page?: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const result = await this.wait(input, signal);
    return boundedResult({ verified: true, assertion: input, evidence: result });
  }

  close(signal?: AbortSignal): Promise<unknown> {
    if (this.state === 'idle') {
      return Promise.resolve({ closed: true, alreadyClosed: true });
    }
    if (this.state === 'closed') {
      return Promise.resolve({ closed: true, alreadyClosed: true });
    }
    if (!this.closeAttempt) this.closeAttempt = this.performClose(signal);
    return this.closeAttempt;
  }

  endRun(signal?: AbortSignal): Promise<unknown> {
    return this.close(signal);
  }

  private async performClose(signal?: AbortSignal): Promise<unknown> {
    try {
      const receipt = await this.execute('browser.session.write', 'close_session', {}, signal);
      if (resultOutcome(receipt.result) === 'accepted') {
        throw new Error('browser_session_close_uncertain：关闭请求结果不确定；不会自动重放');
      }
      this.state = 'closed';
      return boundedResult(receipt);
    } catch (error) {
      this.state = 'uncertain';
      throw error;
    }
  }

  private requireSession(): void {
    if (this.state === 'uncertain') {
      throw new Error('browser_session_uncertain：会话创建结果不确定；禁止继续页面动作，只允许 browser_close 清理');
    }
    if (this.state !== 'active') {
      throw new Error('browser_session_missing：先调用 browser_open 创建本轮 Host-owned session');
    }
  }

  private execute(
    capability: string,
    action: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<BrowserCapabilityResult> {
    return this.executeCapability({ capability, action, target: this.target, payload }, signal);
  }
}
