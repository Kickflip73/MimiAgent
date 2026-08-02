import { Buffer } from 'node:buffer';
import type { RunStreamEvent } from '@openai/agents';
import type { RuntimeEvent } from '../runtime/hooks.js';
import { projectRunStreamEvent } from '../runtime/stream-projection.js';
import type { MimiStreamEvent, MimiStreamTaskState, TaskRecord } from './types.js';

type WithoutTransport<T> = T extends unknown ? Omit<T, 'sequence' | 'eventId'> : never;
export type PendingMimiStreamEvent = WithoutTransport<MimiStreamEvent>;
type PendingStreamEvent = PendingMimiStreamEvent;

const STREAM_TEXT_BYTES = 32 * 1024;
const STREAM_DETAIL_BYTES = 4 * 1024;
const STREAM_PAGE_BYTES = 256 * 1024;
const STREAM_PAGE_EVENTS = 100;
const STREAM_RESULT_BYTES = 384 * 1024;
const STREAM_EFFECTS_BYTES = 64 * 1024;

export interface MimiLiveEventPage {
  events: MimiStreamEvent[];
  nextSequence: number;
  hasMore: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffix = '…';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  let result = '';
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > budget) break;
    result += character;
    used += bytes;
  }
  return `${result}${suffix}`;
}

function truncateJsonString(value: string, maxBytes: number): string {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes) return value;
  const suffix = '…';
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${value.slice(0, middle)}${suffix}`;
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let prefix = value.slice(0, low);
  const finalCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) prefix = prefix.slice(0, -1);
  return `${prefix}${suffix}`;
}

function boundedEvent(event: PendingStreamEvent): PendingStreamEvent {
  if (event.kind === 'answer' || event.kind === 'reasoning') {
    return { ...event, text: truncateUtf8(event.text, STREAM_TEXT_BYTES) };
  }
  if (event.kind === 'plan') {
    return {
      kind: 'plan',
      steps: event.steps.slice(0, 20).map((step) => ({
        ...step,
        id: truncateUtf8(step.id, 256),
        description: truncateUtf8(step.description, 1_024),
      })),
    };
  }
  return {
    ...event,
    title: truncateUtf8(event.title, 1_024),
    detail: event.detail === undefined ? undefined : truncateUtf8(event.detail, STREAM_DETAIL_BYTES),
    fullDetail: event.fullDetail === undefined ? undefined : truncateUtf8(event.fullDetail, STREAM_TEXT_BYTES),
    next: truncateUtf8(event.next, 1_024),
  };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function oversizedPlaceholder(event: MimiStreamEvent): MimiStreamEvent {
  return {
    sequence: event.sequence,
    eventId: event.eventId,
    kind: 'status',
    tone: 'failure',
    title: '流式事件过大',
    detail: '详情已从实时视图省略，权威结果仍保存在 Session 中。',
    next: '继续处理',
  };
}

function boundedResult(result: unknown): unknown {
  if (typeof result === 'string') return truncateJsonString(result, STREAM_RESULT_BYTES);
  const source = record(result);
  if (!source) return undefined;
  const bounded: Record<string, unknown> = {};
  if (typeof source.answer === 'string') bounded.answer = truncateJsonString(source.answer, STREAM_RESULT_BYTES);
  if (source.effects !== undefined) {
    try {
      bounded.effects = serializedBytes(source.effects) <= STREAM_EFFECTS_BYTES
        ? source.effects
        : { invalid: 'RuntimeEffect payload exceeds the IPC limit' };
    } catch {
      bounded.effects = { invalid: 'RuntimeEffect payload is not serializable' };
    }
  }
  return Object.keys(bounded).length ? bounded : undefined;
}

export function mimiStreamTaskState(task: TaskRecord | undefined): MimiStreamTaskState | undefined {
  if (!task) return undefined;
  return {
    id: task.id,
    status: task.status,
    result: boundedResult(task.result),
    error: task.error === undefined ? undefined : truncateJsonString(task.error, 16 * 1024),
  };
}

export function mimiStreamEvent(event: RunStreamEvent): PendingStreamEvent | undefined {
  const projection = projectRunStreamEvent(event);
  if (!projection) return undefined;
  if (projection.kind !== 'status') return projection;
  const { nextMotion: _nextMotion, ...transport } = projection;
  return transport;
}

export function mimiRuntimeStreamEvent(event: RuntimeEvent): PendingStreamEvent | undefined {
  if (event.type !== 'plan_updated') return undefined;
  return {
    kind: 'plan',
    steps: event.steps.slice(0, 20).map((step) => ({
      ...step,
      id: step.id.slice(0, 100),
      description: step.description.slice(0, 1_000),
    })),
  };
}

export class MimiLiveEvents {
  private readonly streams = new Map<string, MimiStreamEvent[]>();
  private sequence = 0;

  constructor(private readonly maxEventsPerRun = 4_096, private readonly maxRuns = 32) {}

  publish(eventId: string, event: PendingStreamEvent): void {
    let events = this.streams.get(eventId);
    if (!events) {
      events = [];
      this.streams.set(eventId, events);
      while (this.streams.size > this.maxRuns) this.streams.delete(this.streams.keys().next().value!);
    }
    events.push({
      ...boundedEvent(event),
      sequence: ++this.sequence,
      eventId: truncateUtf8(eventId, 256),
    } as MimiStreamEvent);
    if (events.length > this.maxEventsPerRun) events.splice(0, events.length - this.maxEventsPerRun);
  }

  after(eventId: string, sequence: number): MimiStreamEvent[] {
    return this.page(eventId, sequence).events;
  }

  recent(eventId: string, limit = 8): MimiStreamEvent[] {
    const count = Math.max(1, Math.min(STREAM_PAGE_EVENTS, Math.trunc(limit)));
    return (this.streams.get(eventId) ?? []).slice(-count);
  }

  page(
    eventId: string,
    sequence: number,
    maxBytes = STREAM_PAGE_BYTES,
    maxEvents = STREAM_PAGE_EVENTS,
  ): MimiLiveEventPage {
    const candidates = (this.streams.get(eventId) ?? []).filter((event) => event.sequence > sequence);
    const byteLimit = Math.max(4 * 1_024, Math.trunc(maxBytes));
    const countLimit = Math.max(1, Math.trunc(maxEvents));
    const events: MimiStreamEvent[] = [];
    let bytes = 0;
    for (const candidate of candidates) {
      const event = serializedBytes(candidate) <= byteLimit ? candidate : oversizedPlaceholder(candidate);
      const eventBytes = serializedBytes(event);
      if (events.length >= countLimit || bytes + eventBytes > byteLimit) break;
      events.push(event);
      bytes += eventBytes;
    }
    const nextSequence = events.at(-1)?.sequence ?? sequence;
    return {
      events,
      nextSequence,
      hasMore: candidates.some((event) => event.sequence > nextSequence),
    };
  }
}
