import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { sanitizeSensitiveText } from '../core/data-sanitizer.js';

export type SqliteRow = Record<string, string | number | null | undefined>;

export function optionalText(value: string | number | null | undefined): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export function parseOptionalJson<T>(value: string | number | null | undefined): T | undefined {
  return typeof value === 'string' ? JSON.parse(value) as T | null ?? undefined : undefined;
}

export function managementLimit(value: number, fallback = 50): number {
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(200, value)) : fallback;
}

export function errorSummary(error: unknown, limit = 500): string {
  return (sanitizeSensitiveText(error instanceof Error ? error.message : String(error)) ?? '')
    .replace(/\s+/g, ' ').trim().slice(0, limit) || '未知错误';
}

export function hashedStateKey(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

export class SqliteDomain {
  constructor(protected readonly database: DatabaseSync) {}

  protected transaction<T>(operation: () => T): T {
    if (this.database.isTransaction) return operation();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  protected audit(type: string, entityId: string, data: unknown, timestamp: string): void {
    this.database.prepare(
      'INSERT INTO audit_events (id, event_type, entity_id, data_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(randomUUID(), type, entityId, JSON.stringify(data ?? null), timestamp);
  }

  protected attentionState(key: string): SqliteRow['value'] {
    return (this.database.prepare('SELECT value FROM attention_state WHERE key = ?')
      .get(key) as SqliteRow | undefined)?.value;
  }

  protected upsertAttentionState(key: string, value: string, timestamp: string): void {
    this.database.prepare(`
      INSERT INTO attention_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(key, value, timestamp);
  }
}
