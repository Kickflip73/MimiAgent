export type RunFailurePhase =
  | 'pre_dispatch'
  | 'dispatch'
  | 'provider'
  | 'runtime';

export type RunFailureKind =
  | 'validation'
  | 'policy_denied'
  | 'state_conflict'
  | 'unsupported'
  | 'transient'
  | 'failed_safe'
  | 'uncertain'
  | 'terminal'
  | 'unclassified';

export interface RunFailureDisposition {
  phase: RunFailurePhase;
  kind: RunFailureKind;
  retryable: boolean;
  dispatchStarted: boolean;
}

export interface RunFailureRecord {
  code: string;
  disposition: RunFailureDisposition;
}

export class RunFailureError extends Error {
  readonly name = 'RunFailureError';

  constructor(
    readonly code: string,
    message: string,
    readonly disposition: RunFailureDisposition,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function runFailureDisposition(error: unknown): RunFailureDisposition | undefined {
  if (error instanceof RunFailureError) return { ...error.disposition };
  if (!error || typeof error !== 'object') return undefined;
  const candidate = (error as { disposition?: unknown }).disposition;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const value = candidate as Record<string, unknown>;
  if (!['pre_dispatch', 'dispatch', 'provider', 'runtime'].includes(String(value.phase))
    || ![
      'validation', 'policy_denied', 'state_conflict', 'unsupported', 'transient',
      'failed_safe', 'uncertain', 'terminal', 'unclassified',
    ].includes(String(value.kind))
    || typeof value.retryable !== 'boolean'
    || typeof value.dispatchStarted !== 'boolean') return undefined;
  return {
    phase: value.phase as RunFailurePhase,
    kind: value.kind as RunFailureKind,
    retryable: value.retryable,
    dispatchStarted: value.dispatchStarted,
  };
}

export function runFailureRecord(value: unknown): RunFailureRecord | undefined {
  const disposition = runFailureDisposition(value);
  if (!disposition || !value || typeof value !== 'object') return undefined;
  const code = value instanceof RunFailureError
    ? value.code
    : (value as { code?: unknown }).code;
  if (typeof code !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,159}$/.test(code)) return undefined;
  return { code, disposition };
}
