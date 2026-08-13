import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, string | number | null | undefined>;
type HistoricalTaskRoute = { type: string; executor: string; workspaceAccess: string };

function failureCodePart(value: unknown): string {
  return String(value ?? 'unknown').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 40)
    || 'unknown';
}

function hasStructuredFailure(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const failure = (result as Record<string, unknown>).failure;
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)) return false;
  const value = failure as Record<string, unknown>;
  const disposition = value.disposition;
  if (!disposition || typeof disposition !== 'object' || Array.isArray(disposition)) return false;
  const facts = disposition as Record<string, unknown>;
  return typeof value.code === 'string'
    && /^[a-z0-9][a-z0-9._-]{0,159}$/.test(value.code)
    && ['pre_dispatch', 'dispatch', 'provider', 'runtime'].includes(String(facts.phase))
    && [
      'validation', 'policy_denied', 'state_conflict', 'unsupported', 'transient',
      'failed_safe', 'uncertain', 'terminal', 'unclassified',
    ].includes(String(facts.kind))
    && typeof facts.retryable === 'boolean'
    && typeof facts.dispatchStarted === 'boolean';
}

function parsedResult(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null) return {};
  return typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : { historicalResult: parsed };
}

function historicalTerminalRows(database: DatabaseSync): Row[] {
  return database.prepare(`
    SELECT id, type, executor, status, result_json FROM tasks
    WHERE status IN ('failed', 'dead_letter') ORDER BY id
  `).all() as Row[];
}

function backfillHistoricalFailureRecords(
  database: DatabaseSync,
  timestamp: string,
): { historicalTerminalTasks: number; backfilledFailureRecords: number; reclassifiedHistoricalDeadLetters: number } {
  const rows = historicalTerminalRows(database);
  const updateFailure = database.prepare(`
    UPDATE tasks SET result_json = ?, updated_at = ? WHERE id = ?
  `);
  let backfilledFailureRecords = 0;
  for (const row of rows) {
    const result = parsedResult(row.result_json);
    if (hasStructuredFailure(result)) continue;
    const status = String(row.status);
    result.failure = {
      code: `historical.${failureCodePart(row.type)}.${failureCodePart(row.executor)}.retained_${status}`,
      disposition: {
        phase: 'runtime',
        kind: 'unclassified',
        retryable: false,
        dispatchStarted: false,
      },
    };
    backfilledFailureRecords += Number(updateFailure.run(
      JSON.stringify(result), timestamp, String(row.id),
    ).changes);
  }
  const reclassifiedHistoricalDeadLetters = Number(database.prepare(`
    UPDATE tasks SET status = 'failed'
    WHERE status = 'dead_letter'
      AND json_extract(result_json, '$.failure.code') LIKE 'historical.%.retained_dead_letter'
      AND json_extract(result_json, '$.failure.disposition.kind') = 'unclassified'
      AND json_extract(result_json, '$.failure.disposition.retryable') = 0
      AND json_extract(result_json, '$.failure.disposition.dispatchStarted') = 0
  `).run().changes);
  return { historicalTerminalTasks: rows.length, backfilledFailureRecords, reclassifiedHistoricalDeadLetters };
}

export function needsTaskFailureFactsRepairV16(database: DatabaseSync): boolean {
  return historicalTerminalRows(database).some((row) => !hasStructuredFailure(parsedResult(row.result_json)))
    || Boolean(database.prepare(`
      SELECT 1 FROM tasks WHERE status = 'dead_letter'
        AND json_extract(result_json, '$.failure.code') LIKE 'historical.%.retained_dead_letter'
      LIMIT 1
    `).get());
}

export function repairTaskFailureFactsV16(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    const timestamp = new Date().toISOString();
    const counts = backfillHistoricalFailureRecords(database, timestamp);
    const integrity = database.prepare('PRAGMA integrity_check').get() as Row | undefined;
    const foreignKeys = database.prepare('PRAGMA foreign_key_check').all() as Row[];
    if (integrity?.integrity_check !== 'ok' || foreignKeys.length > 0) {
      throw new Error('v16 Task failure facts 修复完整性检查失败');
    }
    database.prepare(`
      INSERT INTO audit_events (id, event_type, entity_id, data_json, created_at)
      VALUES (?, 'migration.task_failure_facts_v16', 'schema:v16', ?, ?)
    `).run(randomUUID(), JSON.stringify({
      ...counts,
      integrity: 'ok',
      foreignKeyViolations: 0,
    }), timestamp);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function healthDigestGroup(payloadJson: unknown): string | undefined {
  if (typeof payloadJson !== 'string') return undefined;
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const health = payload.connectorHealth;
    if (!health || typeof health !== 'object' || Array.isArray(health)) return undefined;
    const record = health as Record<string, unknown>;
    if (typeof record.connectorId !== 'string' || typeof record.status !== 'string') return undefined;
    const status = record.status === 'offline' ? 'unavailable' : record.status;
    if (!['unavailable', 'stale', 'unknown', 'recovered'].includes(status)) return undefined;
    return `${record.connectorId}\0${status}`;
  } catch {
    return undefined;
  }
}

export type HistoricalHealthDigestCompactionV16 = {
  pendingHealthDigestItems: number;
  retainedHealthGroups: number;
  collapsibleHealthDigestItems: number;
  unclassifiedHealthDigestItems: number;
};

function pendingHealthDigestRows(database: DatabaseSync): Row[] {
  return database.prepare(`
    SELECT digest_items.id, events.payload_json
    FROM digest_items JOIN events ON events.id = digest_items.event_id
    WHERE digest_items.digested_at IS NULL AND events.source = 'system:connector-health'
    ORDER BY digest_items.occurred_at DESC, digest_items.id DESC
  `).all() as Row[];
}

function classifyHistoricalHealthDigestCompactionV16(database: DatabaseSync): {
  report: HistoricalHealthDigestCompactionV16;
  collapsibleIds: string[];
} {
  const rows = pendingHealthDigestRows(database);
  const retainedGroups = new Set<string>();
  const collapsibleIds: string[] = [];
  let unclassifiedHealthDigestItems = 0;
  for (const row of rows) {
    const group = healthDigestGroup(row.payload_json);
    if (!group) {
      unclassifiedHealthDigestItems += 1;
      continue;
    }
    if (!retainedGroups.has(group)) {
      retainedGroups.add(group);
      continue;
    }
    collapsibleIds.push(String(row.id));
  }
  return {
    report: {
      pendingHealthDigestItems: rows.length,
      retainedHealthGroups: retainedGroups.size,
      collapsibleHealthDigestItems: collapsibleIds.length,
      unclassifiedHealthDigestItems,
    },
    collapsibleIds,
  };
}

function hasHistoricalHealthDigestCompactionV16(database: DatabaseSync): boolean {
  return Boolean(database.prepare(`
    SELECT 1 FROM audit_events
    WHERE event_type='migration.health_digest_compaction_v16' AND entity_id='schema:v16'
    LIMIT 1
  `).get());
}

export function analyzeHistoricalHealthDigestCompactionV16(
  database: DatabaseSync,
): HistoricalHealthDigestCompactionV16 {
  return classifyHistoricalHealthDigestCompactionV16(database).report;
}

export function needsHistoricalHealthDigestCompactionV16(database: DatabaseSync): boolean {
  return !hasHistoricalHealthDigestCompactionV16(database)
    && analyzeHistoricalHealthDigestCompactionV16(database).collapsibleHealthDigestItems > 0;
}

export function repairHistoricalHealthDigestCompactionV16(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    if (hasHistoricalHealthDigestCompactionV16(database)) {
      database.exec('COMMIT');
      return;
    }
    const before = classifyHistoricalHealthDigestCompactionV16(database);
    if (before.collapsibleIds.length === 0) {
      database.exec('COMMIT');
      return;
    }
    const timestamp = new Date().toISOString();
    const finishDigest = database.prepare(`
      UPDATE digest_items SET digested_at = ? WHERE id = ? AND digested_at IS NULL
    `);
    let collapsedHealthDigestItems = 0;
    for (const id of before.collapsibleIds) {
      collapsedHealthDigestItems += Number(finishDigest.run(timestamp, id).changes);
    }
    if (collapsedHealthDigestItems !== before.collapsibleIds.length) {
      throw new Error('v16 历史连接器健康 Digest 压缩计数不一致');
    }
    const after = analyzeHistoricalHealthDigestCompactionV16(database);
    const integrity = database.prepare('PRAGMA integrity_check').get() as Row | undefined;
    const foreignKeys = database.prepare('PRAGMA foreign_key_check').all() as Row[];
    if (integrity?.integrity_check !== 'ok' || foreignKeys.length > 0) {
      throw new Error('v16 历史连接器健康 Digest 压缩完整性检查失败');
    }
    database.prepare(`
      INSERT INTO audit_events (id, event_type, entity_id, data_json, created_at)
      VALUES (?, 'migration.health_digest_compaction_v16', 'schema:v16', ?, ?)
    `).run(randomUUID(), JSON.stringify({
      before: before.report,
      after: {
        pendingHealthDigestItems: after.pendingHealthDigestItems,
        collapsedHealthDigestItems,
      },
      integrity: 'ok',
      foreignKeyViolations: 0,
    }), timestamp);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export type ExistingTaskExecutorOwnershipV16Repair =
  | 'task-failure-facts-v16'
  | 'health-digest-compaction-v16';

export function pendingTaskExecutorOwnershipV16Repairs(
  database: DatabaseSync,
): ExistingTaskExecutorOwnershipV16Repair[] {
  return [
    ...(needsTaskFailureFactsRepairV16(database) ? ['task-failure-facts-v16' as const] : []),
    ...(needsHistoricalHealthDigestCompactionV16(database)
      ? ['health-digest-compaction-v16' as const]
      : []),
  ];
}

export function repairExistingTaskExecutorOwnershipV16(database: DatabaseSync): void {
  if (needsTaskFailureFactsRepairV16(database)) repairTaskFailureFactsV16(database);
  if (needsHistoricalHealthDigestCompactionV16(database)) {
    repairHistoricalHealthDigestCompactionV16(database);
  }
}

export function hasTaskExecutorOwnershipV16(database: DatabaseSync): boolean {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'tasks_executor_ready_idx'
  `).get());
}

export function upgradeTaskExecutorOwnershipV16(
  database: DatabaseSync,
  validRoute: (route: HistoricalTaskRoute) => boolean,
): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    const before = database.prepare(`
      SELECT id, type, executor, workspace_access, status FROM tasks ORDER BY id
    `).all() as Row[];
    const knownLegacyBriefings = before.filter((row) => (
      row.type === 'briefing'
      && row.status === 'queued'
      && row.executor === 'session_actor'
      && row.workspace_access === 'write'
    ));
    const timestamp = new Date().toISOString();
    const updated = database.prepare(`
      UPDATE tasks SET executor = 'isolated_worker', workspace_access = 'read', updated_at = ?
      WHERE type = 'briefing' AND status = 'queued'
        AND executor = 'session_actor' AND workspace_access = 'write'
    `).run(timestamp);
    if (Number(updated.changes) !== knownLegacyBriefings.length) {
      throw new Error('v16 Briefing executor 迁移计数不一致');
    }
    const pendingHealth = database.prepare(`
      SELECT digest_items.id, events.payload_json
      FROM digest_items JOIN events ON events.id = digest_items.event_id
      WHERE digest_items.digested_at IS NULL AND events.source = 'system:connector-health'
      ORDER BY digest_items.occurred_at DESC, digest_items.id DESC
    `).all() as Row[];
    const retainedHealthGroups = new Set<string>();
    let collapsedHealthDigestItems = 0;
    let unclassifiedHealthDigestItems = 0;
    const finishDigest = database.prepare(`
      UPDATE digest_items SET digested_at = ? WHERE id = ? AND digested_at IS NULL
    `);
    for (const row of pendingHealth) {
      const group = healthDigestGroup(row.payload_json);
      if (!group) {
        unclassifiedHealthDigestItems += 1;
        continue;
      }
      if (!retainedHealthGroups.has(group)) {
        retainedHealthGroups.add(group);
        continue;
      }
      collapsedHealthDigestItems += Number(finishDigest.run(timestamp, String(row.id)).changes);
    }
    const failureFacts = backfillHistoricalFailureRecords(database, timestamp);
    database.exec(`
      CREATE INDEX IF NOT EXISTS tasks_executor_ready_idx
        ON tasks(executor, status, not_before, priority DESC, created_at ASC);
    `);
    const after = database.prepare(`
      SELECT id, type, executor, workspace_access, status FROM tasks ORDER BY id
    `).all() as Row[];
    const unresolved = after.filter((row) => !validRoute({
      type: String(row.type),
      executor: String(row.executor),
      workspaceAccess: String(row.workspace_access),
    }));
    const integrity = database.prepare('PRAGMA integrity_check').get() as Row | undefined;
    const foreignKeys = database.prepare('PRAGMA foreign_key_check').all() as Row[];
    if (integrity?.integrity_check !== 'ok' || foreignKeys.length > 0) {
      throw new Error('v16 Task executor 迁移完整性检查失败');
    }
    database.prepare(`
      INSERT INTO audit_events (id, event_type, entity_id, data_json, created_at)
      VALUES (?, 'migration.task_executor_v16', 'schema:v16', ?, ?)
    `).run(randomUUID(), JSON.stringify({
      before: {
        knownLegacyBriefings: knownLegacyBriefings.length,
        pendingHealthDigestItems: pendingHealth.length,
      },
      after: {
        migratedBriefings: Number(updated.changes),
        unresolvedHistoricalCombinations: unresolved.length,
        pendingHealthDigestItems: pendingHealth.length - collapsedHealthDigestItems,
        collapsedHealthDigestItems,
        unclassifiedHealthDigestItems,
        ...failureFacts,
      },
      integrity: 'ok',
      foreignKeyViolations: 0,
    }), timestamp);
    database.exec('PRAGMA user_version = 16; COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
