import { isTerminalRunInterruption } from '../runtime/run-outcome.js';
import {
  runFailureDisposition,
  type RunFailureDisposition,
} from '../runtime/run-failure.js';

function errorStatus(error: unknown): number | undefined {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  return typeof value.status === 'number' ? value.status : undefined;
}

export function classifyRunFailure(error: unknown): RunFailureDisposition {
  const typed = runFailureDisposition(error);
  if (typed) return typed;
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  if (isTerminalRunInterruption(error)
    || value.name === 'ContextProtocolBudgetError'
    || value.name === 'MaxTurnsExceededError'
    || value.name === 'EphemeralSecretsExpiredError'
    || value.name === 'EphemeralSensitiveRunFailedError') {
    return {
      phase: 'runtime',
      kind: 'terminal',
      retryable: false,
      dispatchStarted: false,
    };
  }
  if (value.name === 'ActionIntentUncertainError') {
    return {
      phase: 'dispatch',
      kind: 'uncertain',
      retryable: false,
      dispatchStarted: true,
    };
  }
  const status = errorStatus(error);
  if (status !== undefined) {
    if (status >= 500 || status === 408 || status === 409 || status === 425) {
      return {
        phase: 'provider',
        kind: 'transient',
        retryable: true,
        dispatchStarted: false,
      };
    }
    if (status >= 400 && status < 500) {
      return {
        phase: 'provider',
        kind: 'validation',
        retryable: false,
        dispatchStarted: false,
      };
    }
  }
  if (['ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'ETIMEDOUT'].includes(String(value.code ?? ''))
    || ['APIConnectionError', 'APITimeoutError'].includes(String(value.name ?? ''))) {
    return {
      phase: 'provider',
      kind: 'transient',
      retryable: true,
      dispatchStarted: false,
    };
  }
  return {
    phase: 'runtime',
    kind: 'unclassified',
    retryable: false,
    dispatchStarted: false,
  };
}

export function eventFailureAttemptLimit(
  error: unknown,
  claimedAttempts: number,
  configuredMaxAttempts: number,
): number {
  return classifyRunFailure(error).retryable
    ? configuredMaxAttempts
    : Math.max(1, claimedAttempts);
}
