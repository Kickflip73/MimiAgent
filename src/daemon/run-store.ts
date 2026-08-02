import type { DatabaseSync } from 'node:sqlite';
import { sanitizeSensitiveData, sanitizeSensitiveText } from '../core/data-sanitizer.js';
import type { HostRunRecord, MimiRunSummary, MimiSessionActivity } from './types.js';
import { optionalText as optional, type SqliteRow as Row } from './sqlite-domain.js';

function fromRow(row: Row): HostRunRecord {
  return sanitizeSensitiveData({
    id: String(row.id),
    taskId: String(row.task_id),
    attemptNo: Number(row.attempt_no),
    workerId: String(row.worker_id),
    sessionKey: String(row.session_key),
    status: String(row.status) as HostRunRecord['status'],
    startedAt: String(row.started_at),
    completedAt: optional(row.completed_at),
    answer: typeof row.answer_json === 'string' ? JSON.parse(row.answer_json) : undefined,
    error: optional(row.error),
  });
}

export class RunStore {
  constructor(private readonly database: DatabaseSync) {}

  get(id: string): HostRunRecord | undefined {
    const row = this.database.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(limit = 50): HostRunRecord[] {
    return (this.database.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?')
      .all(limit) as Row[]).map(fromRow);
  }

  listSummaries(requestedLimit = 50): MimiRunSummary[] {
    const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(200, requestedLimit)) : 50;
    return (this.database.prepare(`
      SELECT id, task_id, attempt_no, session_key, status, started_at, completed_at,
        answer_json IS NOT NULL AS answer_available, error
      FROM runs ORDER BY started_at DESC, rowid DESC LIMIT ?
    `).all(limit) as Row[]).map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      attemptNo: Number(row.attempt_no),
      sessionKey: String(row.session_key),
      status: String(row.status) as HostRunRecord['status'],
      startedAt: String(row.started_at),
      completedAt: optional(row.completed_at),
      answerAvailable: Number(row.answer_available) === 1,
      error: optional(row.error)?.slice(0, 500),
    }));
  }

  sessionActivity(sessionKey: string, requestedLimit = 20): MimiSessionActivity[] {
    const limit = Math.max(1, Math.min(100, Math.trunc(requestedLimit)));
    return (this.database.prepare(`
      SELECT t.id AS task_id, t.trigger_event_id AS event_id, e.source, e.type,
        t.status AS task_status, e.occurred_at,
        r.status AS run_status, r.started_at, r.completed_at, r.answer_json, r.error
      FROM runs r JOIN tasks t ON t.id = r.task_id JOIN events e ON e.id = t.authority_event_id
      WHERE r.session_key = ? AND NOT EXISTS (
        SELECT 1 FROM runs newer WHERE newer.task_id = r.task_id AND (
          newer.started_at > r.started_at OR (newer.started_at = r.started_at AND newer.id > r.id)
        )
      )
      ORDER BY r.started_at DESC, r.id DESC LIMIT ?
    `).all(sessionKey, limit) as Row[]).map((row) => {
      const rawAnswer = sanitizeSensitiveData(
        typeof row.answer_json === 'string' ? JSON.parse(row.answer_json) : undefined,
      );
      const answer = rawAnswer === undefined
        ? undefined
        : (typeof rawAnswer === 'string' ? rawAnswer : JSON.stringify(rawAnswer)).slice(0, 2_000);
      return {
        taskId: String(row.task_id),
        eventId: optional(row.event_id),
        source: String(row.source),
        type: String(row.type),
        taskStatus: String(row.task_status) as MimiSessionActivity['taskStatus'],
        runStatus: String(row.run_status) as MimiSessionActivity['runStatus'],
        occurredAt: String(row.occurred_at),
        startedAt: String(row.started_at),
        completedAt: optional(row.completed_at),
        answer,
        error: sanitizeSensitiveText(optional(row.error))?.slice(0, 1_000),
      };
    });
  }
}
