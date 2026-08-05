import type { DatabaseSync } from 'node:sqlite';
import type {
  EventRouteReceipt,
  ImmutableEvent,
  ImmutableEventInput,
  MimiEventSummary,
} from './types.js';
import { managementLimit } from './sqlite-domain.js';

type Row = Record<string, string | number | null | undefined>;

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: string | number | null | undefined): T | undefined {
  if (typeof value !== 'string') return undefined;
  return JSON.parse(value) as T;
}

function optional(value: string | number | null | undefined): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function eventFromRow(row: Row): ImmutableEvent {
  return {
    id: String(row.id),
    externalId: String(row.external_id),
    source: String(row.source),
    type: String(row.type),
    trust: String(row.trust) as ImmutableEvent['trust'],
    actor: parseJson(row.actor_json) ?? undefined,
    conversation: parseJson(row.conversation_json) ?? undefined,
    payload: parseJson(row.payload_json),
    subjectType: optional(row.subject_type) as ImmutableEvent['subjectType'],
    subjectId: optional(row.subject_id),
    correlationId: optional(row.correlation_id),
    causationEventId: optional(row.causation_event_id),
    profileId: String(row.profile_id),
    replyRoute: parseJson(row.reply_route_json) ?? undefined,
    occurredAt: String(row.occurred_at),
    receivedAt: String(row.received_at),
    createdAt: String(row.created_at),
  };
}

export function listEventSummaries(database: DatabaseSync, requestedLimit = 50): MimiEventSummary[] {
  return (database.prepare(`
    SELECT id, external_id, source, type, trust, subject_type, subject_id,
      profile_id, occurred_at, received_at, created_at
    FROM events ORDER BY received_at DESC, rowid DESC LIMIT ?
  `).all(managementLimit(requestedLimit)) as Row[]).map((row) => ({
    id: String(row.id),
    externalId: String(row.external_id).slice(0, 500),
    source: String(row.source).slice(0, 200),
    type: String(row.type),
    trust: String(row.trust) as ImmutableEvent['trust'],
    subjectType: optional(row.subject_type) as ImmutableEvent['subjectType'],
    subjectId: optional(row.subject_id),
    profileId: String(row.profile_id).slice(0, 100),
    occurredAt: String(row.occurred_at),
    receivedAt: String(row.received_at),
    createdAt: String(row.created_at),
  }));
}

function receiptFromRow(row: Row): EventRouteReceipt {
  return {
    eventId: String(row.event_id),
    routerVersion: String(row.router_version),
    decision: String(row.decision) as EventRouteReceipt['decision'],
    taskIds: parseJson<string[]>(row.task_ids_json) ?? [],
    reasonCode: String(row.reason_code),
    routedAt: String(row.routed_at),
  };
}

export class EventStore {
  constructor(private readonly database: DatabaseSync) {}

  append(input: ImmutableEventInput, createdAt: string): { event: ImmutableEvent; inserted: boolean } {
    const inserted = this.database.prepare(`
      INSERT INTO events (
        id, external_id, source, type, trust, actor_json, conversation_json, payload_json,
        subject_type, subject_id, correlation_id, causation_event_id, profile_id,
        reply_route_json, occurred_at, received_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, external_id) DO NOTHING
    `).run(
      input.id,
      input.externalId,
      input.source,
      input.type,
      input.trust,
      json(input.actor),
      json(input.conversation),
      json(input.payload),
      input.subjectType ?? null,
      input.subjectId ?? null,
      input.correlationId ?? null,
      input.causationEventId ?? null,
      input.profileId,
      json(input.replyRoute),
      input.occurredAt,
      input.receivedAt,
      createdAt,
    );
    const event = this.getBySource(input.source, input.externalId);
    if (!event) throw new Error(`Event 写入失败：${input.source}/${input.externalId}`);
    return { event, inserted: Number(inserted.changes) === 1 };
  }

  get(id: string): ImmutableEvent | undefined {
    const row = this.database.prepare('SELECT * FROM events WHERE id = ?').get(id) as Row | undefined;
    return row ? eventFromRow(row) : undefined;
  }

  getBySource(source: string, externalId: string): ImmutableEvent | undefined {
    const row = this.database.prepare('SELECT * FROM events WHERE source = ? AND external_id = ?')
      .get(source, externalId) as Row | undefined;
    return row ? eventFromRow(row) : undefined;
  }

  getReceipt(eventId: string): EventRouteReceipt | undefined {
    const row = this.database.prepare('SELECT * FROM event_route_receipts WHERE event_id = ?')
      .get(eventId) as Row | undefined;
    return row ? receiptFromRow(row) : undefined;
  }

  insertReceipt(receipt: EventRouteReceipt): EventRouteReceipt {
    this.database.prepare(`
      INSERT INTO event_route_receipts (
        event_id, router_version, decision, task_ids_json, reason_code, routed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      receipt.eventId,
      receipt.routerVersion,
      receipt.decision,
      json(receipt.taskIds),
      receipt.reasonCode,
      receipt.routedAt,
    );
    return this.getReceipt(receipt.eventId)!;
  }
}
