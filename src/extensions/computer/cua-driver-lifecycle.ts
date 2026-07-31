import { execFile, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_MONITOR_INTERVAL_MS = 10_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_PROBE_INTERVAL_MS = 250;
const MAX_RETRY_DELAY_MS = 60_000;

export type CuaDriverLifecycleState =
  | 'starting'
  | 'ready'
  | 'recovering'
  | 'unavailable'
  | 'stopped';

export interface CuaDriverLifecycleStatus {
  configured: true;
  state: CuaDriverLifecycleState;
  ready: boolean;
  managed: boolean;
  launchAttempts: number;
  recoveries: number;
  consecutiveFailures: number;
  lastCheckedAt?: string;
  lastReadyAt?: string;
  lastFailure?: string;
  nextRetryAt?: string;
  transportReady?: boolean;
  operationalReadiness?: 'unknown' | 'ready' | 'degraded';
  operationalCheckedAt?: string;
  lastOperationalFailure?: string;
}

interface CuaDriverLifecycleOptions {
  monitorIntervalMs?: number;
  startupTimeoutMs?: number;
  probeIntervalMs?: number;
  launcher?: () => Promise<void>;
  probe?: () => Promise<void>;
}

function boundedError(error: unknown): string {
  const candidate = error as NodeJS.ErrnoException & {
    stderr?: string | Buffer;
    cause?: unknown;
  };
  const message = [
    error instanceof Error ? error.message : String(error),
    typeof candidate.stderr === 'string'
      ? candidate.stderr
      : Buffer.isBuffer(candidate.stderr) ? candidate.stderr.toString('utf8') : '',
    candidate.cause && candidate.cause !== error ? boundedError(candidate.cause) : '',
  ].filter(Boolean).join(': ');
  return message.slice(0, 1_000);
}

export function isCuaDriverUnavailable(error: unknown): boolean {
  return /daemon is not running|daemon.*not.*running|connection refused|econnrefused|enotconn|cua-driver\.sock|socket.*(?:missing|not found|closed)/iu
    .test(boundedError(error));
}

export function resolveCuaDriverAppBundle(command: string): string | undefined {
  let normalized: string;
  try {
    normalized = realpathSync(command);
  } catch {
    normalized = path.resolve(command);
  }
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const bundle = normalized.slice(0, markerIndex);
  return bundle.endsWith('.app') ? bundle : undefined;
}

async function defaultLaunch(command: string): Promise<void> {
  const appBundle = process.platform === 'darwin'
    ? resolveCuaDriverAppBundle(command)
    : undefined;
  if (appBundle) {
    await execFileAsync('/usr/bin/open', [
      '-n',
      '-g',
      '-a',
      appBundle,
      '--args',
      'serve',
    ], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, ['serve'], {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

export class CuaDriverLifecycle {
  private state: CuaDriverLifecycleState = 'starting';
  private launchAttempts = 0;
  private recoveries = 0;
  private consecutiveFailures = 0;
  private lastCheckedAt?: string;
  private lastReadyAt?: string;
  private lastFailure?: string;
  private nextRetryAt?: string;
  private operation?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private monitoring = false;

  private readonly monitorIntervalMs: number;
  private readonly startupTimeoutMs: number;
  private readonly probeIntervalMs: number;
  private readonly launch: () => Promise<void>;
  private readonly probeDriver: () => Promise<void>;

  constructor(
    readonly command: string,
    private readonly timeoutMs: number,
    options: CuaDriverLifecycleOptions = {},
  ) {
    this.monitorIntervalMs = positiveDuration(
      options.monitorIntervalMs,
      DEFAULT_MONITOR_INTERVAL_MS,
    );
    this.startupTimeoutMs = positiveDuration(
      options.startupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS,
    );
    this.probeIntervalMs = positiveDuration(
      options.probeIntervalMs,
      DEFAULT_PROBE_INTERVAL_MS,
    );
    this.launch = options.launcher ?? (() => defaultLaunch(command));
    this.probeDriver = options.probe ?? (() => this.rawProbe());
  }

  async start(): Promise<CuaDriverLifecycleStatus> {
    if (this.monitoring) return this.status();
    this.monitoring = true;
    await this.ensureReady().catch(() => undefined);
    this.schedule();
    return this.status();
  }

  async ensureReady(): Promise<void> {
    if (this.operation) return this.operation;
    const operation = this.ensureReadyOnce();
    this.operation = operation;
    try {
      await operation;
    } finally {
      if (this.operation === operation) this.operation = undefined;
    }
  }

  requestRecovery(): void {
    void this.ensureReady().catch(() => undefined);
  }

  stop(): void {
    this.monitoring = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRetryAt = undefined;
    this.state = 'stopped';
  }

  status(): CuaDriverLifecycleStatus {
    return {
      configured: true,
      state: this.state,
      ready: this.state === 'ready',
      managed: this.monitoring,
      launchAttempts: this.launchAttempts,
      recoveries: this.recoveries,
      consecutiveFailures: this.consecutiveFailures,
      ...(this.lastCheckedAt ? { lastCheckedAt: this.lastCheckedAt } : {}),
      ...(this.lastReadyAt ? { lastReadyAt: this.lastReadyAt } : {}),
      ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
      ...(this.nextRetryAt ? { nextRetryAt: this.nextRetryAt } : {}),
    };
  }

  private async ensureReadyOnce(): Promise<void> {
    this.lastCheckedAt = new Date().toISOString();
    try {
      await this.probeDriver();
      this.markReady(false);
      return;
    } catch (error) {
      this.lastFailure = boundedError(error);
      if (!isCuaDriverUnavailable(error)) {
        this.consecutiveFailures += 1;
        this.state = 'unavailable';
        throw new Error(`Cua Driver 健康检查失败：${this.lastFailure}`, { cause: error });
      }
      this.state = 'recovering';
    }

    this.launchAttempts += 1;
    try {
      await this.launch();
      const deadline = Date.now() + this.startupTimeoutMs;
      let lastError: unknown;
      while (Date.now() < deadline) {
        try {
          await this.probeDriver();
          this.markReady(true);
          return;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, this.probeIntervalMs));
        }
      }
      throw lastError ?? new Error('Cua Driver 启动后未在截止时间内就绪');
    } catch (error) {
      this.consecutiveFailures += 1;
      this.state = 'unavailable';
      this.lastFailure = boundedError(error);
      throw new Error(`Cua Driver 自动恢复失败：${this.lastFailure}`, { cause: error });
    }
  }

  private markReady(recovered: boolean): void {
    if (recovered) this.recoveries += 1;
    this.state = 'ready';
    this.consecutiveFailures = 0;
    this.lastFailure = undefined;
    this.nextRetryAt = undefined;
    this.lastReadyAt = new Date().toISOString();
  }

  private schedule(): void {
    if (!this.monitoring) return;
    if (this.timer) clearTimeout(this.timer);
    const backoff = this.consecutiveFailures === 0
      ? this.monitorIntervalMs
      : Math.min(
          MAX_RETRY_DELAY_MS,
          1_000 * (2 ** Math.min(this.consecutiveFailures - 1, 6)),
        );
    const delay = Math.max(this.monitorIntervalMs, backoff);
    this.nextRetryAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.ensureReady()
        .catch(() => undefined)
        .finally(() => this.schedule());
    }, delay);
    this.timer.unref();
  }

  private async rawProbe(): Promise<void> {
    const { stdout } = await execFileAsync(
      this.command,
      ['call', 'health_report', '{}'],
      {
        encoding: 'utf8',
        timeout: this.timeoutMs,
        maxBuffer: 1024 * 1024,
      },
    );
    const parsed = JSON.parse(stdout) as unknown;
    const envelope = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    if (envelope.isError === true) throw new Error('Cua Driver health_report 返回错误');
    const structured = envelope.structuredContent
      && typeof envelope.structuredContent === 'object'
      && !Array.isArray(envelope.structuredContent)
      ? envelope.structuredContent as Record<string, unknown>
      : envelope;
    if (typeof structured.overall === 'string' && structured.overall !== 'ok') {
      throw new Error(`Cua Driver health_report 状态异常：${structured.overall}`);
    }
  }
}

const lifecycles = new Map<string, CuaDriverLifecycle>();

export function sharedCuaDriverLifecycle(
  command: string,
  timeoutMs: number,
): CuaDriverLifecycle {
  const key = path.resolve(command);
  const existing = lifecycles.get(key);
  if (existing) return existing;
  const lifecycle = new CuaDriverLifecycle(key, timeoutMs);
  lifecycles.set(key, lifecycle);
  return lifecycle;
}
