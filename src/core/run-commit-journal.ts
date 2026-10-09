import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import {
  runFinalizationRecordSchema,
  type RunFinalizationRecord,
  type RunOutcome,
} from './run-finalization.js';

export type RunCommitPhase =
  | 'prepared'
  | 'receipt_committed'
  | 'session_committed'
  | 'goal_committed'
  | 'task_committed'
  | 'effects_applied'
  | 'finalized';

export interface RunCommitJournalEntry {
  id: string;
  sessionId: string;
  runId: string;
  executionKey?: string;
  phase: RunCommitPhase;
  answerDigest: string;
  outcome?: RunOutcome;
  completionDecision?: 'pass' | 'continue' | 'blocked' | 'uncertain';
  runtimeActions: Array<Record<string, unknown>>;
  finalization?: RunFinalizationRecord;
  updatedAt: string;
}

const phaseSchema = z.enum([
  'prepared',
  'receipt_committed',
  'session_committed',
  'goal_committed',
  'task_committed',
  'effects_applied',
  'finalized',
]);
const entrySchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  runId: z.string(),
  executionKey: z.string().optional(),
  phase: phaseSchema,
  answerDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  outcome: z.enum(['completed', 'partial', 'blocked', 'interrupted', 'failed', 'uncertain']).optional(),
  completionDecision: z.enum(['pass', 'continue', 'blocked', 'uncertain']).optional(),
  runtimeActions: z.array(z.record(z.string(), z.unknown())),
  finalization: runFinalizationRecordSchema.optional(),
  updatedAt: z.string(),
});
const journalSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), entrySchema),
});

const PHASE_ORDER: readonly RunCommitPhase[] = [
  'prepared',
  'receipt_committed',
  'session_committed',
  'goal_committed',
  'task_committed',
  'effects_applied',
  'finalized',
];

export function runAnswerDigest(answer: string): string {
  return createHash('sha256').update(answer).digest('hex');
}

export function runCommitJournalId(sessionId: string, runId: string): string {
  return createHash('sha256').update(`${sessionId}\0${runId}`).digest('hex');
}

export class RunCommitJournal {
  private readonly databaseFile: string;
  private initialization?: Promise<void>;

  constructor(private readonly file: string) {
    this.file = path.resolve(file);
    this.databaseFile = `${this.file}.sqlite`;
  }

  /** May be awaited at startup; concurrent callers share initialization. */
  initialize(): Promise<void> {
    this.initialization ??= this.importLegacy().catch((error) => {
      this.initialization = undefined;
      throw error;
    });
    return this.initialization;
  }

  /** Import legacy evidence once; never rewrite or remove the original JSON. */
  private async importLegacy(): Promise<void> {
    await mkdir(path.dirname(this.databaseFile), { recursive: true, mode: 0o700 });
    const handle = await open(this.databaseFile, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    await handle.close();
    const database = new DatabaseSync(this.databaseFile, { timeout: 5_000 });
    try {
      await chmod(this.databaseFile, 0o600);
      // Concurrent first opens may race on the journal-mode transition, for
      // which SQLite does not always honor busy_timeout. Retry only setup DDL.
      const setupDeadline = Date.now() + 5_000;
      for (;;) {
        try {
          if (database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal') {
            database.exec('PRAGMA journal_mode=WAL');
          }
          database.exec(`PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS run_commits (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, execution_key TEXT,
          phase TEXT NOT NULL, updated_at TEXT NOT NULL, entry_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS run_commits_execution_idx
          ON run_commits(session_id, execution_key, sequence);
        CREATE INDEX IF NOT EXISTS run_commits_recovery_idx ON run_commits(phase, updated_at);`);
          break;
        } catch (error) {
          if ((error as { errcode?: number }).errcode !== 5 || Date.now() >= setupDeadline) throw error;
          await setTimeout(10);
        }
      }
      let imported = database.prepare("SELECT value FROM journal_meta WHERE key='legacy_import'").get();
      if (!imported) {
        // No transaction is held across an await: another initializer in the same
        // event loop must not block behind a writer awaiting its own continuation.
        const source = await readFile(this.file, 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        const entries = source === undefined ? [] : Object.entries(journalSchema.parse(JSON.parse(source)).entries);
        for (const [key, entry] of entries) {
          if (key !== entry.id || key !== runCommitJournalId(entry.sessionId, entry.runId)) {
            throw new Error('Run commit journal 的旧日志标识不一致，拒绝导入');
          }
        }
        database.exec('BEGIN IMMEDIATE');
        try {
          imported = database.prepare("SELECT value FROM journal_meta WHERE key='legacy_import'").get();
          if (!imported) {
            for (const [, entry] of entries) this.save(database, entry);
            database.prepare('INSERT INTO journal_meta(key, value) VALUES (?, ?)').run('legacy_import', JSON.stringify({
              version: 1, sourceDigest: source === undefined ? null : runAnswerDigest(source), entries: entries.length,
            }));
          }
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      }
    } finally {
      database.close();
    }
  }

  private async withJournal<T>(operation: (database: DatabaseSync) => T): Promise<T> {
    await this.initialize();
    const database = new DatabaseSync(this.databaseFile, { timeout: 5_000 });
    try {
      database.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      try {
        const result = operation(database);
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    } finally {
      database.close();
    }
  }

  private save(database: DatabaseSync, entry: RunCommitJournalEntry): void {
    database.prepare(`INSERT INTO run_commits(id, session_id, execution_key, phase, updated_at, entry_json)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      execution_key=excluded.execution_key, phase=excluded.phase,
      updated_at=excluded.updated_at, entry_json=excluded.entry_json`)
      .run(entry.id, entry.sessionId, entry.executionKey ?? null, entry.phase, entry.updatedAt, JSON.stringify(entry));
  }

  private decode(row: Record<string, unknown> | undefined): RunCommitJournalEntry | undefined {
    return row ? entrySchema.parse(JSON.parse(String(row.entry_json))) : undefined;
  }

  private byId(database: DatabaseSync, sessionId: string, runId: string): RunCommitJournalEntry | undefined {
    return this.decode(database.prepare('SELECT entry_json FROM run_commits WHERE id=?')
      .get(runCommitJournalId(sessionId, runId)));
  }

  async prepare(input: Omit<RunCommitJournalEntry, 'id' | 'phase' | 'updatedAt'>): Promise<RunCommitJournalEntry> {
    return this.withJournal((database) => {
      const existing = this.byId(database, input.sessionId, input.runId);
      if (existing) {
        const conflicts = existing.answerDigest !== input.answerDigest
          || existing.executionKey !== input.executionKey
          || existing.outcome !== input.outcome
          || JSON.stringify(existing.runtimeActions) !== JSON.stringify(input.runtimeActions)
          || JSON.stringify(existing.finalization) !== JSON.stringify(input.finalization);
        if (!conflicts) return existing;
        if (existing.phase !== 'prepared') {
          throw new Error(`Run ${input.runId} 已存在不同的提交计划，拒绝覆盖`);
        }
      }
      const entry: RunCommitJournalEntry = {
        id: runCommitJournalId(input.sessionId, input.runId), ...input,
        ...(existing ? { outcome: input.outcome ?? 'completed' } : {}),
        phase: 'prepared', updatedAt: new Date().toISOString(),
      };
      // Validate before committing new evidence, just as subsequent reads do.
      const validated = entrySchema.parse(entry);
      this.save(database, validated);
      return validated;
    });
  }

  async advance(sessionId: string, runId: string, phase: RunCommitPhase): Promise<RunCommitJournalEntry> {
    return this.withJournal((database) => {
      const entry = this.byId(database, sessionId, runId);
      if (!entry) throw new Error(`Run ${runId} 缺少提交日志`);
      if (PHASE_ORDER.indexOf(phase) <= PHASE_ORDER.indexOf(entry.phase)) return entry;
      entry.phase = phase;
      entry.updatedAt = new Date().toISOString();
      this.save(database, entry);
      return entry;
    });
  }

  async acknowledgeTask(sessionId: string, executionKey: string): Promise<RunCommitJournalEntry | undefined> {
    return this.updateExecution(sessionId, executionKey, 'task_committed');
  }

  async finalizeExecution(sessionId: string, executionKey: string): Promise<RunCommitJournalEntry | undefined> {
    return this.updateExecution(sessionId, executionKey, 'finalized');
  }

  private async updateExecution(
    sessionId: string, executionKey: string, phase: 'task_committed' | 'finalized',
  ): Promise<RunCommitJournalEntry | undefined> {
    return this.withJournal((database) => {
      const entries = database.prepare(`SELECT entry_json FROM run_commits
        WHERE session_id=? AND execution_key=? ORDER BY sequence`).all(sessionId, executionKey)
        .map((row) => this.decode(row)!);
      const selected = phase === 'task_committed' ? entries.filter((entry) => entry.phase !== 'finalized') : entries;
      for (const entry of selected) {
        if (PHASE_ORDER.indexOf(entry.phase) >= PHASE_ORDER.indexOf(phase)) continue;
        entry.phase = phase;
        entry.updatedAt = new Date().toISOString();
        this.save(database, entry);
      }
      return selected.at(-1);
    });
  }

  async get(sessionId: string, runId: string): Promise<RunCommitJournalEntry | undefined> {
    return this.withJournal((database) => this.byId(database, sessionId, runId));
  }

  async findByExecutionKey(sessionId: string, executionKey: string): Promise<RunCommitJournalEntry | undefined> {
    return this.withJournal((database) => this.decode(database.prepare(`SELECT entry_json FROM run_commits
      WHERE session_id=? AND execution_key=? ORDER BY sequence DESC LIMIT 1`).get(sessionId, executionKey)));
  }

  async recoverable(): Promise<RunCommitJournalEntry[]> {
    return this.withJournal((database) => database.prepare(`SELECT entry_json FROM run_commits
      WHERE phase != 'finalized' ORDER BY updated_at, sequence`).all().map((row) => this.decode(row)!));
  }
}
