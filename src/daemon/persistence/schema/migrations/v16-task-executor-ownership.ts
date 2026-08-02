import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { validTaskRoute } from '../../../task-routing.js';
import type { TaskExecutor, TaskType, TaskWorkspaceAccess } from '../../../types.js';

type Row = Record<string, string | number | null | undefined>;

export function hasTaskExecutorOwnershipV16(database: DatabaseSync): boolean {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'tasks_executor_ready_idx'
  `).get());
}

export function upgradeTaskExecutorOwnershipV16(database: DatabaseSync): void {
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
    database.exec(`
      CREATE INDEX IF NOT EXISTS tasks_executor_ready_idx
        ON tasks(executor, status, not_before, priority DESC, created_at ASC);
    `);
    const after = database.prepare(`
      SELECT id, type, executor, workspace_access, status FROM tasks ORDER BY id
    `).all() as Row[];
    const unresolved = after.filter((row) => !validTaskRoute({
      type: String(row.type) as TaskType,
      executor: String(row.executor) as TaskExecutor,
      workspaceAccess: String(row.workspace_access) as TaskWorkspaceAccess,
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
      before: { knownLegacyBriefings: knownLegacyBriefings.length },
      after: {
        migratedBriefings: Number(updated.changes),
        unresolvedHistoricalCombinations: unresolved.length,
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
