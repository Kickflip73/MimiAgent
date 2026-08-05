import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { sanitizeSensitiveData } from '../core/data-sanitizer.js';
import type { EventStore } from './event-store.js';
import type { TaskStore } from './task-store.js';
import type {
  MimiOutboxSummary,
  OutboxMessage,
  OutboxStatus,
  ReplyRoute,
} from './types.js';
import {
  errorSummary,
  hashedStateKey,
  managementLimit,
  optionalText as optional,
  SqliteDomain,
  type SqliteRow as Row,
} from './sqlite-domain.js';
const DEFAULT_OUTBOX_LEASE_MS = 180_000;

function fromRow(row: Row): OutboxMessage {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    channel: String(row.channel),
    target: optional(row.target),
    payload: typeof row.payload_json === 'string'
      ? sanitizeSensitiveData(JSON.parse(row.payload_json))
      : undefined,
    status: String(row.status) as OutboxStatus,
    attempts: Number(row.attempts),
    notBefore: String(row.not_before),
    leaseOwner: optional(row.lease_owner),
    leaseUntil: optional(row.lease_until),
    error: optional(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function failurePayload(message: OutboxMessage, error: unknown): Record<string, unknown> {
  const summary = errorSummary(error);
  return {
    type: 'delivery_dead_letter',
    taskId: message.taskId,
    outboxId: message.id,
    channel: message.channel.slice(0, 200),
    attempts: message.attempts,
    error: summary,
    text: `MimiAgent 未能确认结果是否已通过 ${message.channel.slice(0, 120)} 投递，task=${message.taskId.slice(0, 80)}，attempt=${message.attempts}。已进入 dead letter，不会自动重发。${summary} 请运行 mimi daemon outbox 核对后再决定重试或归档。`.slice(0, 1_000),
  };
}

export function listOutboxSummaries(
  database: DatabaseSync,
  requestedLimit = 50,
  order: 'created' | 'updated' = 'created',
): MimiOutboxSummary[] {
  const orderBy = order === 'updated' ? 'updated_at' : 'created_at';
  return (database.prepare(`
    SELECT id, task_id, channel, target, status, attempts, not_before, updated_at, error
    FROM outbox ORDER BY ${orderBy} DESC, rowid DESC LIMIT ?
  `).all(managementLimit(requestedLimit)) as Row[]).map((row) => ({
    id: String(row.id),
    taskId: String(row.task_id),
    channel: String(row.channel).slice(0, 200),
    target: optional(row.target)?.slice(0, 500),
    status: String(row.status) as OutboxStatus,
    attempts: Number(row.attempts),
    notBefore: String(row.not_before),
    updatedAt: String(row.updated_at),
    error: optional(row.error)?.slice(0, 500),
  }));
}

export class OutboxStore extends SqliteDomain {
  constructor(
    database: DatabaseSync,
    private readonly events: EventStore,
    private readonly tasks: TaskStore,
  ) {
    super(database);
  }

  private clearOwnerRoute(message: OutboxMessage): boolean {
    const task = this.tasks.get(message.taskId);
    const event = task ? this.events.get(task.authorityEventId) : undefined;
    if (!event) return false;
    const key = hashedStateKey('owner-route', event.profileId);
    const row = this.database.prepare('SELECT value FROM attention_state WHERE key = ?')
      .get(key) as Row | undefined;
    if (!row || typeof row.value !== 'string') return false;
    try {
      const route = JSON.parse(row.value) as ReplyRoute;
      if (route.channel !== message.channel || route.target !== message.target) return false;
    } catch {
      return false;
    }
    return Number(this.database.prepare('DELETE FROM attention_state WHERE key = ?').run(key).changes) === 1;
  }

  private recordDeadLetter(
    message: OutboxMessage,
    error: unknown,
    timestamp: string,
    facts: Record<string, unknown> = {},
  ): void {
    const fallback = message.channel !== 'system';
    const ownerRouteInvalidated = fallback ? this.clearOwnerRoute(message) : false;
    if (fallback) this.insert(message.taskId, { channel: 'system' }, failurePayload(message, error), timestamp);
    this.audit('outbox.dead_letter', message.id, {
      attempts: message.attempts, fallback, ownerRouteInvalidated, ...facts,
    }, timestamp);
  }

  private quarantine(id: string, error: unknown, timestamp: string): void {
    const summary = `持久 Outbox 解码失败，已隔离：${errorSummary(error, 1_000)}`;
    this.database.prepare(`
      UPDATE outbox SET status = 'dead_letter', error = ?, lease_owner = NULL,
        lease_until = NULL, updated_at = ? WHERE id = ?
    `).run(summary, timestamp, id);
    this.audit('outbox.quarantined', id, { error: summary }, timestamp);
  }

  insert(taskId: string, route: ReplyRoute, payload: unknown, timestamp: string): string {
    if (!this.tasks.get(taskId)) throw new Error(`Outbox Task 不存在：${taskId}`);
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO outbox (
        id, task_id, channel, target, payload_json, status, attempts,
        not_before, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(
      id, taskId, route.channel, route.target ?? null,
      JSON.stringify(payload ?? null), timestamp, timestamp, timestamp,
    );
    return id;
  }

  get(id: string): OutboxMessage | undefined {
    const row = this.database.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  claim(
    owner: string,
    leaseMs = DEFAULT_OUTBOX_LEASE_MS,
    at = new Date(),
    excludedRoutes: readonly ReplyRoute[] = [],
  ): OutboxMessage | undefined {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const expired = this.database.prepare(`
        SELECT * FROM outbox WHERE status = 'sending' AND lease_until <= ? ORDER BY created_at ASC
      `).all(timestamp) as Row[];
      for (const row of expired) {
        let message: OutboxMessage;
        try {
          message = fromRow(row);
        } catch (error) {
          this.quarantine(String(row.id), error, timestamp);
          continue;
        }
        const error = new Error('投递租约过期，结果不确定；为避免重复不会自动重放');
        const updated = this.database.prepare(`
          UPDATE outbox SET status = 'dead_letter', error = ?, lease_owner = NULL,
            lease_until = NULL, updated_at = ?
          WHERE id = ? AND status = 'sending' AND lease_until <= ?
        `).run(error.message, timestamp, message.id, timestamp);
        if (Number(updated.changes) !== 1) continue;
        this.recordDeadLetter(message, error, timestamp, {
          uncertain: true,
          reason: 'lease_expired',
        });
      }
      const exclusions = excludedRoutes.slice(0, 16);
      const exclusionSql = exclusions.length
        ? ` AND NOT (${exclusions.map(() => '(channel = ? AND COALESCE(target, \'\') = ?)').join(' OR ')})`
        : '';
      for (let scanned = 0; scanned < 100; scanned += 1) {
        const row = this.database.prepare(`
          SELECT * FROM outbox WHERE status = 'pending' AND not_before <= ?${exclusionSql}
          ORDER BY created_at ASC LIMIT 1
        `).get(timestamp, ...exclusions.flatMap((route) => [route.channel, route.target ?? ''])) as Row | undefined;
        if (!row) return undefined;
        try {
          fromRow(row);
        } catch (error) {
          this.quarantine(String(row.id), error, timestamp);
          continue;
        }
        const leaseUntil = new Date(at.getTime() + leaseMs).toISOString();
        const claimed = this.database.prepare(`
          UPDATE outbox SET status = 'sending', attempts = attempts + 1,
            lease_owner = ?, lease_until = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'
        `).run(owner, leaseUntil, timestamp, String(row.id));
        if (Number(claimed.changes) === 1) return this.get(String(row.id));
      }
      return undefined;
    });
  }

  complete(id: string, owner: string): void {
    const timestamp = new Date().toISOString();
    const result = this.database.prepare(`
      UPDATE outbox SET status = 'sent', lease_owner = NULL, lease_until = NULL,
        error = NULL, updated_at = ?
      WHERE id = ? AND status = 'sending' AND lease_owner = ?
    `).run(timestamp, id, owner);
    if (Number(result.changes) !== 1) throw new Error(`Outbox ${id} 租约已失效`);
  }

  fail(id: string, owner: string, error: unknown, maxAttempts = 8, at = new Date()): void {
    this.transaction(() => {
      const message = this.get(id);
      if (!message || message.status !== 'sending' || message.leaseOwner !== owner) {
        throw new Error(`Outbox ${id} 租约已失效`);
      }
      const terminal = message.attempts >= maxAttempts;
      const delay = Math.min(60 * 60_000, 1_000 * 2 ** Math.max(0, message.attempts - 1));
      const timestamp = at.toISOString();
      const updated = this.database.prepare(`
        UPDATE outbox SET status = ?, error = ?, not_before = ?, lease_owner = NULL,
          lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'sending' AND lease_owner = ?
      `).run(
        terminal ? 'dead_letter' : 'pending',
        errorSummary(error, 4_000),
        new Date(at.getTime() + (terminal ? 0 : delay)).toISOString(),
        timestamp,
        id,
        owner,
      );
      if (Number(updated.changes) !== 1) throw new Error(`Outbox ${id} 租约已失效`);
      if (terminal) this.recordDeadLetter(message, error, timestamp);
      else this.audit('outbox.retry', id, { attempts: message.attempts }, timestamp);
    });
  }

  listSummaries(requestedLimit = 50): MimiOutboxSummary[] {
    return listOutboxSummaries(this.database, requestedLimit);
  }

  retryDeadLetter(id: string, at = new Date()): OutboxMessage {
    return this.transaction(() => {
      const message = this.get(id);
      if (!message || message.status !== 'dead_letter') throw new Error(`Outbox ${id} 不是 dead letter`);
      const timestamp = at.toISOString();
      const updated = this.database.prepare(`
        UPDATE outbox SET status = 'pending', attempts = 0, not_before = ?,
          lease_owner = NULL, lease_until = NULL, error = NULL, updated_at = ?
        WHERE id = ? AND status = 'dead_letter'
      `).run(timestamp, timestamp, id);
      if (Number(updated.changes) !== 1) throw new Error(`Outbox ${id} dead letter 状态已变化`);
      this.audit('outbox.requeued', id, {
        previousAttempts: message.attempts,
        previousError: message.error,
      }, timestamp);
      return this.get(id)!;
    });
  }

  archiveDeadLetter(id: string, at = new Date()): OutboxMessage {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const updated = this.database.prepare(`
        UPDATE outbox SET status = 'archived', lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'dead_letter'
      `).run(timestamp, id);
      if (Number(updated.changes) !== 1) throw new Error(`Outbox ${id} 不是 dead letter`);
      this.audit('outbox.archived', id, {}, timestamp);
      return this.get(id)!;
    });
  }
}
