import type { DatabaseSync } from 'node:sqlite';
import { sanitizeSensitiveData, sanitizeSensitiveText } from '../core/data-sanitizer.js';
import type { TaskStore } from './task-store.js';
import { classifyRunSource } from './run-source.js';
import type {
  HostRunRecord,
  ImmutableEvent,
  MimiRunSummary,
  MimiSessionActivity,
  TaskType,
} from './types.js';
import { managementLimit, optionalText as optional, type SqliteRow as Row } from './sqlite-domain.js';

export function listRunSummaries(
  database: DatabaseSync,
  requestedLimit = 50,
  order: 'started' | 'updated' = 'started',
): MimiRunSummary[] {
  const orderBy = order === 'updated' ? 'COALESCE(runs.completed_at, runs.started_at)' : 'runs.started_at';
  return (database.prepare(`
    SELECT runs.id, runs.task_id, runs.attempt_no, runs.session_key, runs.status,
      runs.started_at, runs.completed_at, runs.answer_json IS NOT NULL AS answer_available,
      runs.error, tasks.type, COALESCE(trigger.source, authority.source) AS source,
      COALESCE(trigger.trust, authority.trust) AS trust
    FROM runs JOIN tasks ON tasks.id = runs.task_id
    LEFT JOIN events trigger ON trigger.id = tasks.trigger_event_id
    JOIN events authority ON authority.id = tasks.authority_event_id
    ORDER BY ${orderBy} DESC, runs.rowid DESC LIMIT ?
  `).all(managementLimit(requestedLimit)) as Row[]).map((row) => {
    const source = String(row.source ?? '');
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      attemptNo: Number(row.attempt_no),
      sessionKey: String(row.session_key),
      status: String(row.status) as HostRunRecord['status'],
      startedAt: String(row.started_at),
      completedAt: optional(row.completed_at),
      answerAvailable: Number(row.answer_available) === 1,
      error: optional(row.error)?.slice(0, 500),
      source,
      sourceCategory: classifyRunSource({
        taskType: String(row.type) as TaskType,
        source,
        trust: String(row.trust) as ImmutableEvent['trust'],
      }),
    };
  });
}

export class RunStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly tasks: TaskStore,
  ) {}

  get(id: string): HostRunRecord | undefined {
    return this.tasks.getAttempt(id);
  }

  listSummaries(requestedLimit = 50): MimiRunSummary[] {
    return listRunSummaries(this.database, requestedLimit);
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
