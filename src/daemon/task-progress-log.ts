import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { sanitizeSensitiveText } from '../core/data-sanitizer.js';
import type { PendingMimiStreamEvent } from './live-events.js';

const MAX_LOG_TAIL_BYTES = 1024 * 1024;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_PROGRESS_EVENTS = 20;

const taskProgressStepSchema = z.object({
  id: z.string(),
  description: z.string(),
  status: z.string(),
}).strict();

const taskProgressEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answer'), text: z.string() }).strict(),
  z.object({ kind: z.literal('plan'), steps: z.array(taskProgressStepSchema) }).strict(),
  z.object({
    kind: z.literal('status'),
    tone: z.enum(['agent', 'thinking', 'tool', 'success', 'failure']),
    title: z.string(),
    detail: z.string().optional(),
    next: z.string(),
  }).strict(),
]);

const taskProgressLogEntrySchema = z.object({
  at: z.string().datetime(),
  event: taskProgressEventSchema,
}).strict();

type PersistedTaskProgressEvent = z.infer<typeof taskProgressEventSchema>;
export type TaskProgressEvent = { at: string } & PersistedTaskProgressEvent;

export interface TaskProgressSnapshot {
  logPath: string;
  logBytes: number;
  logUpdatedAt: string;
  recentEvents: TaskProgressEvent[];
  latestActivity?: string;
}

function compact(value: string, maxChars: number): string {
  const sanitized = sanitizeSensitiveText(value)?.replace(/\s+/g, ' ').trim() ?? '';
  if (sanitized.length <= maxChars) return sanitized;
  return `${sanitized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function persistedEvent(event: PendingMimiStreamEvent): PersistedTaskProgressEvent | undefined {
  if (event.kind === 'reasoning') return undefined;
  if (event.kind === 'answer') {
    return { kind: 'answer', text: compact(event.text, 2_000) };
  }
  if (event.kind === 'plan') {
    return {
      kind: 'plan',
      steps: event.steps.slice(0, 20).map((step) => ({
        id: compact(step.id, 256),
        description: compact(step.description, 1_000),
        status: step.status,
      })),
    };
  }
  return {
    kind: 'status',
    tone: event.tone,
    title: compact(event.title, 1_024),
    ...(event.detail ? { detail: compact(event.detail, 2_000) } : {}),
    next: compact(event.next, 1_024),
  };
}

function activity(event: TaskProgressEvent): string | undefined {
  if (event.kind === 'status') {
    return [event.title, event.detail].filter(Boolean).join(' · ');
  }
  if (event.kind === 'answer') return event.text ? `最新输出 · ${event.text}` : undefined;
  const active = event.steps.find((step) => step.status === 'running')
    ?? [...event.steps].reverse().find((step) => step.status === 'completed')
    ?? event.steps.at(-1);
  return active ? `${active.status} · ${active.description}` : undefined;
}

function safeTaskFileName(taskId: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(taskId)) return taskId;
  return createHash('sha256').update(taskId).digest('hex');
}

async function readTaskProgressLog(logPath: string): Promise<TaskProgressSnapshot | undefined> {
  let file;
  try {
    file = await open(logPath, 'r');
    const stats = await file.stat();
    const length = Math.min(stats.size, MAX_LOG_TAIL_BYTES);
    const offset = Math.max(0, stats.size - length);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, offset);
    let text = buffer.toString('utf8');
    if (offset > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    const entries = text.split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = taskProgressLogEntrySchema.safeParse(JSON.parse(line));
          return parsed.success ? [parsed.data] : [];
        } catch {
          return [];
        }
      })
      .slice(-MAX_PROGRESS_EVENTS);
    const recentEvents = entries.map(({ at, event }) => ({ at, ...event }) as TaskProgressEvent);
    const latestActivity = [...recentEvents].reverse()
      .map(activity)
      .find((candidate): candidate is string => Boolean(candidate));
    return {
      logPath,
      logBytes: stats.size,
      logUpdatedAt: stats.mtime.toISOString(),
      recentEvents,
      ...(latestActivity ? { latestActivity } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

export class TaskProgressLog {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly root: string,
    private readonly maxLogBytes = MAX_LOG_BYTES,
  ) {}

  path(taskId: string): string {
    return path.join(this.root, `${safeTaskFileName(taskId)}.jsonl`);
  }

  append(taskId: string, event: PendingMimiStreamEvent): Promise<void> {
    const projected = persistedEvent(event);
    if (!projected) return Promise.resolve();
    const previous = this.pending.get(taskId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const logPath = this.path(taskId);
      try {
        if ((await stat(logPath)).size >= this.maxLogBytes) {
          await rm(`${logPath}.previous`, { force: true });
          await rename(logPath, `${logPath}.previous`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await appendFile(logPath, `${JSON.stringify({
        at: new Date().toISOString(),
        event: projected,
      })}\n`, { encoding: 'utf8', mode: 0o600 });
    });
    this.pending.set(taskId, next);
    void next.then(
      () => { if (this.pending.get(taskId) === next) this.pending.delete(taskId); },
      () => { if (this.pending.get(taskId) === next) this.pending.delete(taskId); },
    );
    return next;
  }

  async inspect(taskId: string): Promise<TaskProgressSnapshot | undefined> {
    await this.pending.get(taskId);
    return readTaskProgressLog(this.path(taskId));
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending.values()]);
  }
}
