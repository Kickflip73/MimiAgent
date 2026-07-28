import type { ConnectorCapability } from './connectors.js';

export type DeadLetterCategory =
  | 'provider'
  | 'configuration'
  | 'dependency'
  | 'worker_runtime'
  | 'authorization'
  | 'external_unavailable'
  | 'uncertain_side_effect'
  | 'cancelled_or_superseded'
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

export function classifyDeadLetterError(error: string | undefined): Omit<DeadLetterClassification, 'count'> {
  const normalized = (error ?? '').toLowerCase();
  if (/uncertain|结果不确定|ack|确认失败|after dispatch/u.test(normalized)) {
    return { category: 'uncertain_side_effect', disposition: 'manual_verify' };
  }
  if (/429|rate.?limit|quota|balance|billing|余额|额度|provider/u.test(normalized)) {
    return { category: 'provider', disposition: 'retry_after_fix' };
  }
  if (/permission|unauthori[sz]ed|forbidden|access denied|权限|授权/u.test(normalized)) {
    return { category: 'authorization', disposition: 'external_blocked' };
  }
  if (/config|schema|invalid environment|配置|格式无效/u.test(normalized)) {
    return { category: 'configuration', disposition: 'retry_after_fix' };
  }
  if (/工具输出超过.*账本|执行账本.*限制|账本输出无效|invalid ledger output|contract violation|ledger.*corrupt|corrupt.*ledger/u.test(normalized)) {
    return { category: 'configuration', disposition: 'retry_after_fix' };
  }
  if (/not found|enoent|module|binary|dependency|缺少|不存在/u.test(normalized)) {
    return { category: 'dependency', disposition: 'retry_after_fix' };
  }
  if (/task worker.*(?:unexpected|exit|退出)|worker.*(?:code=|signal=)/u.test(normalized)) {
    return { category: 'worker_runtime', disposition: 'retry_after_fix' };
  }
  if (/offline|unavailable|timeout|timed out|econn|enotfound|离线|不可用|超时/u.test(normalized)) {
    return { category: 'external_unavailable', disposition: 'external_blocked' };
  }
  if (/cancel|supersed|取代|取消|task worker 被运行时回收|worker (?:was )?reclaimed/u.test(normalized)) {
    return { category: 'cancelled_or_superseded', disposition: 'archive_safe' };
  }
  return { category: 'unknown', disposition: 'investigate' };
}

export function aggregateDeadLetters(
  rows: readonly { error?: string; count: number }[],
): DeadLetterClassification[] {
  const totals = new Map<string, DeadLetterClassification>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.count) || row.count < 0) throw new Error('dead letter count 无效');
    const classified = classifyDeadLetterError(row.error);
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
  deadLetters: readonly { error?: string; count: number }[];
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
