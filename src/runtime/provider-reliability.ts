import { APIUserAbortError } from 'openai';
import { RunFailureError } from '../core/run-failure.js';

export type ProviderFaultKind =
  | 'rate_limit'
  | 'insufficient_balance'
  | 'network'
  | 'server'
  | 'other';

export type ProviderCircuitState = 'closed' | 'open' | 'half_open';

export interface ProviderFault {
  kind: ProviderFaultKind;
  retryable: boolean;
  status?: number;
  code?: string;
  retryAt?: string;
}

export interface ProviderCircuitConfig {
  failureThreshold: number;
  openMs: number;
  halfOpenSuccesses: number;
}

export interface ProviderHealthSnapshot {
  provider: string;
  state: ProviderCircuitState;
  failures: number;
  openedAt?: string;
  retryAt?: string;
  lastFailure?: ProviderFaultKind;
  lastSuccessAt?: string;
}

const DEFAULT_CONFIG: ProviderCircuitConfig = Object.freeze({
  failureThreshold: 2,
  openMs: 60_000,
  halfOpenSuccesses: 1,
});

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

/** Standard provider headers, without copying credentials or response bodies. */
export function providerRetryAt(error: unknown, now = Date.now()): string | undefined {
  const value = record(error);
  if (typeof value?.retryAt === 'string' && Number.isFinite(Date.parse(value.retryAt))) return value.retryAt;
  const headers = record(value?.headers ?? record(value?.response)?.headers);
  const header = (name: string): unknown => {
    if (typeof headers?.get === 'function') return headers.get(name);
    const key = Object.keys(headers ?? {}).find((key) => key.toLowerCase() === name);
    return key ? headers?.[key] : undefined;
  };
  const retryMs = header('retry-after-ms');
  const retry = header('retry-after');
  let at: number | undefined;
  if (retryMs !== undefined && retryMs !== null && Number.isFinite(Number(retryMs)) && Number(retryMs) >= 0) {
    at = now + Number(retryMs);
  } else if (typeof retry === 'string' || typeof retry === 'number') {
    at = Number.isFinite(Number(retry)) && Number(retry) >= 0
      ? now + Number(retry) * 1_000 : Date.parse(String(retry));
  }
  return at !== undefined && Number.isFinite(at) && Math.abs(at) <= 8.64e15
    ? new Date(Math.max(now, at)).toISOString() : undefined;
}

export function isProviderCancellation(error: unknown): boolean {
  if (error instanceof APIUserAbortError) return true;
  const seen = new Set<unknown>();
  let current = record(error);
  while (current && !seen.has(current)) {
    seen.add(current);
    if (['AbortError', 'APIUserAbortError', 'RunInterruptedError', 'TerminalRunInterruptedError'].includes(String(current.name))
      || current.code === 'ABORT_ERR') return true;
    current = record(current.cause);
  }
  return false;
}

export class ProviderCircuitOpenError extends RunFailureError {
  constructor(readonly provider: string, readonly retryAt: string, probing = false) {
    super('provider.circuit_open', probing
      ? `Provider ${provider} 半开探测已在进行，等待恢复`
      : `Provider ${provider} 熔断中，等待 ${retryAt} 后重试`, {
      phase: 'provider', kind: 'transient', retryable: true, dispatchStarted: false,
    });
  }
}

export function classifyProviderFault(error: unknown): ProviderFault {
  const value = record(error);
  const nested = record(value?.error);
  const statusCandidate = value?.status ?? value?.statusCode ?? nested?.status;
  const status = typeof statusCandidate === 'number' ? statusCandidate : undefined;
  const codeCandidate = value?.code ?? nested?.code;
  const code = typeof codeCandidate === 'string' ? codeCandidate : undefined;
  const message = error instanceof Error
    ? error.message
    : typeof value?.message === 'string' ? value.message : String(error);
  const normalized = `${code ?? ''} ${message}`.toLowerCase();
  if (status === 429 || /rate.?limit|too many requests|限流/u.test(normalized)) {
    return { kind: 'rate_limit', retryable: true, status, code, retryAt: providerRetryAt(error) };
  }
  if (status === 402
    || /insufficient.?balance|quota.?exceeded|billing|余额不足|额度不足/u.test(normalized)) {
    return { kind: 'insufficient_balance', retryable: false, status, code };
  }
  if (status !== undefined && status >= 500 && status <= 599) {
    return { kind: 'server', retryable: true, status, code };
  }
  if (/econnreset|econnrefused|enotfound|etimedout|fetch failed|network|socket|断网/u.test(normalized)) {
    return { kind: 'network', retryable: true, status, code };
  }
  return { kind: 'other', retryable: false, status, code };
}

interface ProviderState {
  state: ProviderCircuitState;
  failures: number;
  halfOpenSuccesses: number;
  openedAt?: number;
  retryAt?: number;
  lastFailure?: ProviderFaultKind;
  lastSuccessAt?: number;
  probeInFlight: boolean;
}

export class ProviderCircuitBreaker {
  private readonly states = new Map<string, ProviderState>();
  private readonly config: ProviderCircuitConfig;

  constructor(
    config: Partial<ProviderCircuitConfig> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.config = {
      failureThreshold: positive(config.failureThreshold ?? DEFAULT_CONFIG.failureThreshold, 'failureThreshold'),
      openMs: positive(config.openMs ?? DEFAULT_CONFIG.openMs, 'openMs'),
      halfOpenSuccesses: positive(config.halfOpenSuccesses ?? DEFAULT_CONFIG.halfOpenSuccesses, 'halfOpenSuccesses'),
    };
  }

  acquire(provider: string): void {
    const state = this.providerState(provider);
    if (state.state === 'open') {
      if (state.openedAt !== undefined && this.now() >= (state.retryAt ?? state.openedAt + this.config.openMs)) {
        state.state = 'half_open';
        state.probeInFlight = false;
        state.halfOpenSuccesses = 0;
      } else {
        throw new ProviderCircuitOpenError(provider, new Date(state.retryAt ?? this.now() + this.config.openMs).toISOString());
      }
    }
    if (state.state === 'half_open') {
      if (state.probeInFlight) throw new ProviderCircuitOpenError(provider, new Date(this.now() + this.config.openMs).toISOString(), true);
      state.probeInFlight = true;
    }
  }

  success(provider: string): void {
    const state = this.providerState(provider);
    state.lastSuccessAt = this.now();
    state.probeInFlight = false;
    if (state.state === 'half_open') {
      state.halfOpenSuccesses += 1;
      if (state.halfOpenSuccesses < this.config.halfOpenSuccesses) return;
    }
    state.state = 'closed';
    state.failures = 0;
    state.halfOpenSuccesses = 0;
    delete state.openedAt;
    delete state.retryAt;
    delete state.lastFailure;
  }

  cancel(provider: string): void {
    this.providerState(provider).probeInFlight = false;
  }

  failure(provider: string, error: unknown): ProviderFault {
    const fault = classifyProviderFault(error);
    const state = this.providerState(provider);
    state.probeInFlight = false;
    if (isProviderCancellation(error) || error instanceof ProviderCircuitOpenError) return fault;
    state.failures += 1;
    state.lastFailure = fault.kind;
    const immediate = fault.kind === 'rate_limit' || fault.kind === 'insufficient_balance';
    if (state.state === 'half_open' || immediate || state.failures >= this.config.failureThreshold) {
      state.state = 'open';
      state.openedAt = this.now();
      const retryAt = providerRetryAt(error, this.now());
      state.retryAt = Math.max(state.openedAt + this.config.openMs, retryAt ? Date.parse(retryAt) : 0);
    }
    return fault;
  }

  health(provider: string): ProviderHealthSnapshot {
    const state = this.providerState(provider);
    const openedAt = state.openedAt;
    return {
      provider,
      state: state.state,
      failures: state.failures,
      ...(openedAt === undefined ? {} : {
        openedAt: new Date(openedAt).toISOString(),
        retryAt: new Date(state.retryAt ?? openedAt + this.config.openMs).toISOString(),
      }),
      ...(state.lastFailure ? { lastFailure: state.lastFailure } : {}),
      ...(state.lastSuccessAt === undefined
        ? {}
        : { lastSuccessAt: new Date(state.lastSuccessAt).toISOString() }),
    };
  }

  private providerState(provider: string): ProviderState {
    const existing = this.states.get(provider);
    if (existing) return existing;
    const created: ProviderState = {
      state: 'closed',
      failures: 0,
      halfOpenSuccesses: 0,
      probeInFlight: false,
    };
    this.states.set(provider, created);
    return created;
  }
}

export interface ProviderCandidate {
  id: string;
  role: 'primary' | 'backup';
}

export interface ProviderFailoverOptions {
  sideEffectsStarted: () => boolean;
  deferSuccess?: boolean;
}

export class ProviderFailoverCoordinator {
  constructor(private readonly breaker: ProviderCircuitBreaker) {}

  async execute<T>(
    candidates: readonly ProviderCandidate[],
    operation: (provider: ProviderCandidate) => Promise<T>,
    options: ProviderFailoverOptions,
  ): Promise<{ provider: string; value: T; attempts: number }> {
    if (candidates.length < 1 || candidates.length > 2) {
      throw new Error('Provider 主备候选必须为 1～2 个');
    }
    let lastError: unknown;
    let attempts = 0;
    for (const candidate of candidates) {
      if (options.sideEffectsStarted()) {
        throw new Error('副作用已经开始，禁止切换 Provider 重放整轮');
      }
      try {
        this.breaker.acquire(candidate.id);
      } catch (error) {
        lastError = error;
        continue;
      }
      attempts += 1;
      try {
        const value = await operation(candidate);
        if (!options.deferSuccess) this.breaker.success(candidate.id);
        return { provider: candidate.id, value, attempts };
      } catch (error) {
        lastError = error;
        if (isProviderCancellation(error)) { this.breaker.cancel(candidate.id); throw error; }
        const fault = this.breaker.failure(candidate.id, error);
        if (options.sideEffectsStarted()) {
          throw new Error('副作用已经开始，禁止切换 Provider 重放整轮', { cause: error });
        }
        if (fault.kind === 'other') throw error;
      }
    }
    throw lastError ?? new Error('没有可用 Provider');
  }
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} 必须是正安全整数`);
  return value;
}
