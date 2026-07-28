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
    return { kind: 'rate_limit', retryable: true, status, code };
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
      if (state.openedAt !== undefined && this.now() - state.openedAt >= this.config.openMs) {
        state.state = 'half_open';
        state.probeInFlight = false;
        state.halfOpenSuccesses = 0;
      } else {
        throw new Error(`Provider ${provider} 熔断中，拒绝形成重试风暴`);
      }
    }
    if (state.state === 'half_open') {
      if (state.probeInFlight) throw new Error(`Provider ${provider} 半开探测已在进行`);
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
    delete state.lastFailure;
  }

  failure(provider: string, error: unknown): ProviderFault {
    const fault = classifyProviderFault(error);
    const state = this.providerState(provider);
    state.probeInFlight = false;
    state.failures += 1;
    state.lastFailure = fault.kind;
    const immediate = fault.kind === 'rate_limit' || fault.kind === 'insufficient_balance';
    if (state.state === 'half_open' || immediate || state.failures >= this.config.failureThreshold) {
      state.state = 'open';
      state.openedAt = this.now();
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
        retryAt: new Date(openedAt + this.config.openMs).toISOString(),
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
