import type { ConnectorCapability } from './connectors.js';
import type { RunFailureRecord } from '../core/run-failure.js';

export type DeadLetterCategory =
  | 'provider'
  | 'configuration'
  | 'dependency'
  | 'worker_runtime'
  | 'authorization'
  | 'external_unavailable'
  | 'uncertain_side_effect'
  | 'cancelled_or_superseded'
  | 'legacy_failure'
  | 'unknown';

export interface DeadLetterClassification {
  category: DeadLetterCategory;
  disposition: 'retry_after_fix' | 'archive_safe' | 'external_blocked' | 'manual_verify' | 'investigate';
  count: number;
}

export interface DigestClassification {
  age: 'fresh' | 'aging' | 'stale';
  count: number;
}

export interface ReadinessUnknownClassification {
  connector: string;
  reason: 'startup_grace' | 'legacy_missing_status' | 'stale_status';
  disposition: 'observe' | 'connector_fix_required';
}

export interface OperationalClassificationSnapshot {
  deadLetters: DeadLetterClassification[];
  digest: DigestClassification[];
  readinessUnknown: ReadinessUnknownClassification[];
  unclassifiedDeadLetters: number;
}

export function classifyDeadLetterFailure(
  failure: RunFailureRecord | undefined,
): Omit<DeadLetterClassification, 'count'> {
  if (!failure) return { category: 'unknown', disposition: 'investigate' };
  if (failure.code.startsWith('historical.')) {
    return { category: 'legacy_failure', disposition: 'investigate' };
  }
  if (failure.disposition.kind === 'uncertain') {
    return { category: 'uncertain_side_effect', disposition: 'manual_verify' };
  }
  if (failure.disposition.phase === 'provider') {
    return { category: 'provider', disposition: 'retry_after_fix' };
  }
  if (failure.disposition.kind === 'policy_denied') {
    return { category: 'authorization', disposition: 'external_blocked' };
  }
  if (failure.code.startsWith('dependency.')) {
    return { category: 'dependency', disposition: 'retry_after_fix' };
  }
  if (failure.code.startsWith('worker.') || failure.code.startsWith('task.lease')) {
    return { category: 'worker_runtime', disposition: 'retry_after_fix' };
  }
  if (failure.code.startsWith('connector.')) {
    return { category: 'external_unavailable', disposition: 'external_blocked' };
  }
  if (failure.code.startsWith('cancelled.') || failure.code.startsWith('superseded.')) {
    return { category: 'cancelled_or_superseded', disposition: 'archive_safe' };
  }
  if (failure.disposition.kind === 'transient') {
    return { category: 'external_unavailable', disposition: 'retry_after_fix' };
  }
  return { category: 'configuration', disposition: 'retry_after_fix' };
}

export function aggregateDeadLetters(
  rows: readonly { failure?: RunFailureRecord; count: number }[],
): DeadLetterClassification[] {
  const totals = new Map<string, DeadLetterClassification>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.count) || row.count < 0) throw new Error('dead letter count 无效');
    const classified = classifyDeadLetterFailure(row.failure);
    const key = `${classified.category}:${classified.disposition}`;
    const current = totals.get(key) ?? { ...classified, count: 0 };
    current.count += row.count;
    totals.set(key, current);
  }
  return [...totals.values()].sort((left, right) =>
    right.count - left.count || left.category.localeCompare(right.category));
}

export function classifyDigestAges(
  occurredAt: readonly string[],
  now = Date.now(),
): DigestClassification[] {
  const counts: Record<DigestClassification['age'], number> = { fresh: 0, aging: 0, stale: 0 };
  for (const value of occurredAt) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) throw new Error('Digest occurredAt 无效');
    const age = now - timestamp;
    if (age < 24 * 60 * 60_000) counts.fresh += 1;
    else if (age < 7 * 24 * 60 * 60_000) counts.aging += 1;
    else counts.stale += 1;
  }
  return (['fresh', 'aging', 'stale'] as const)
    .filter((age) => counts[age] > 0)
    .map((age) => ({ age, count: counts[age] }));
}

export function classifyReadinessUnknown(
  connectors: readonly ConnectorCapability[],
  daemonStartedAt: string,
  now = Date.now(),
  startupGraceMs = 60_000,
): ReadinessUnknownClassification[] {
  const startedAt = Date.parse(daemonStartedAt);
  const inGrace = Number.isFinite(startedAt) && now - startedAt < startupGraceMs;
  return connectors.filter((connector) => connector.enabled && connector.online
    && (connector.readiness.inbound === 'unknown' || connector.readiness.outbound === 'unknown'))
    .map((connector) => {
      const stale = connector.readiness.stale === true;
      return {
        connector: connector.id,
        reason: stale ? 'stale_status' as const
          : inGrace ? 'startup_grace' as const : 'legacy_missing_status' as const,
        disposition: inGrace && !stale ? 'observe' as const : 'connector_fix_required' as const,
      };
    }).sort((left, right) => left.connector.localeCompare(right.connector));
}

export function operationalClassification(input: {
  deadLetters: readonly { failure?: RunFailureRecord; count: number }[];
  digestOccurredAt: readonly string[];
  connectors: readonly ConnectorCapability[];
  daemonStartedAt: string;
  now?: number;
}): OperationalClassificationSnapshot {
  const deadLetters = aggregateDeadLetters(input.deadLetters);
  const readinessUnknown = classifyReadinessUnknown(
    input.connectors,
    input.daemonStartedAt,
    input.now,
  );
  return {
    deadLetters,
    digest: classifyDigestAges(input.digestOccurredAt, input.now),
    readinessUnknown,
    unclassifiedDeadLetters: deadLetters
      .filter((item) => item.category === 'unknown')
      .reduce((total, item) => total + item.count, 0),
  };
}
