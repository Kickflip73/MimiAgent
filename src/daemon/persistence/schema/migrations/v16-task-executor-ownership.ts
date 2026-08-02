import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, string | number | null | undefined>;
type HistoricalTaskRoute = { type: string; executor: string; workspaceAccess: string };

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
