import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  runFinalizationRecordSchema,
  type RunFinalizationRecord,
  type RunOutcome,
} from './run-finalization.js';
import { AtomicJsonStore } from './state-file.js';

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

interface RunCommitJournalFile {
  version: 1;
  entries: Record<string, RunCommitJournalEntry>;
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
  // Preserve fields written by newer MimiAgent builds when users switch branches.
  // This branch cannot interpret media anchors, but dropping them during an update
  // would turn a compatible journal into data loss.
  finalization: runFinalizationRecordSchema.extend({
    mediaAnchors: z.array(z.unknown()).max(100).optional(),
    mediaAnchorsTruncated: z.literal(true).optional(),
  }).optional(),
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
  private readonly state: AtomicJsonStore<RunCommitJournalFile>;

  constructor(file: string) {
    this.state = new AtomicJsonStore(file, {
      defaultValue: () => ({
        version: 1,
        entries: Object.create(null) as Record<string, RunCommitJournalEntry>,
      }),
      decode: (value) => {
        const parsed = journalSchema.parse(value);
        return {
          version: 1,
          entries: Object.assign(
            Object.create(null),
            parsed.entries,
          ) as Record<string, RunCommitJournalEntry>,
        };
      },
      recoverCorrupt: false,
    });
  }

  async prepare(input: Omit<RunCommitJournalEntry, 'id' | 'phase' | 'updatedAt'>): Promise<RunCommitJournalEntry> {
    const id = runCommitJournalId(input.sessionId, input.runId);
    return this.state.update((journal) => {
      const existing = journal.entries[id];
      if (existing) {
        const conflicts = existing.answerDigest !== input.answerDigest
          || existing.executionKey !== input.executionKey
          || existing.outcome !== input.outcome
          || JSON.stringify(existing.runtimeActions) !== JSON.stringify(input.runtimeActions)
          || JSON.stringify(existing.finalization) !== JSON.stringify(input.finalization);
        if (conflicts) {
          const hasDurableProgress = existing.phase !== 'prepared';
          if (hasDurableProgress) {
            throw new Error(`Run ${input.runId} 已存在不同的提交计划，拒绝覆盖`);
          }
          const replacement: RunCommitJournalEntry = {
            id,
            ...input,
            outcome: input.outcome ?? 'completed',
            phase: 'prepared',
            updatedAt: new Date().toISOString(),
          };
          journal.entries[id] = replacement;
          return { ...replacement };
        }
        return { ...existing };
      }
      const entry: RunCommitJournalEntry = {
        id,
        ...input,
        phase: 'prepared',
        updatedAt: new Date().toISOString(),
      };
      journal.entries[id] = entry;
      return { ...entry };
    });
  }

  async advance(
    sessionId: string,
    runId: string,
    phase: RunCommitPhase,
  ): Promise<RunCommitJournalEntry> {
    const id = runCommitJournalId(sessionId, runId);
    return this.state.update((journal) => {
      const entry = journal.entries[id];
      if (!entry) throw new Error(`Run ${runId} 缺少提交日志`);
      const currentIndex = PHASE_ORDER.indexOf(entry.phase);
      const nextIndex = PHASE_ORDER.indexOf(phase);
      if (nextIndex < currentIndex) return { ...entry };
      entry.phase = phase;
      entry.updatedAt = new Date().toISOString();
      return { ...entry };
    });
  }

  async acknowledgeTask(
    sessionId: string,
    executionKey: string,
  ): Promise<RunCommitJournalEntry | undefined> {
    return this.state.update((journal) => {
      const entries = Object.values(journal.entries).filter((candidate) =>
        candidate.sessionId === sessionId
        && candidate.executionKey === executionKey
        && candidate.phase !== 'finalized');
      if (!entries.length) return undefined;
      const updatedAt = new Date().toISOString();
      for (const entry of entries) {
        if (PHASE_ORDER.indexOf(entry.phase) < PHASE_ORDER.indexOf('task_committed')) {
          entry.phase = 'task_committed';
        }
        entry.updatedAt = updatedAt;
      }
      return { ...entries.at(-1)! };
    });
  }

  async finalizeExecution(
    sessionId: string,
    executionKey: string,
  ): Promise<RunCommitJournalEntry | undefined> {
    return this.state.update((journal) => {
      const entries = Object.values(journal.entries).filter((candidate) =>
        candidate.sessionId === sessionId && candidate.executionKey === executionKey);
      if (!entries.length) return undefined;
      const updatedAt = new Date().toISOString();
      for (const entry of entries) {
        entry.phase = 'finalized';
        entry.updatedAt = updatedAt;
      }
      return { ...entries.at(-1)! };
    });
  }

  async get(sessionId: string, runId: string): Promise<RunCommitJournalEntry | undefined> {
    const entry = (await this.state.read()).entries[runCommitJournalId(sessionId, runId)];
    return entry ? this.cloneEntry(entry) : undefined;
  }

  async findByExecutionKey(
    sessionId: string,
    executionKey: string,
  ): Promise<RunCommitJournalEntry | undefined> {
    const entry = Object.values((await this.state.read()).entries).filter((candidate) =>
      candidate.sessionId === sessionId && candidate.executionKey === executionKey).at(-1);
    return entry ? this.cloneEntry(entry) : undefined;
  }

  async recoverable(): Promise<RunCommitJournalEntry[]> {
    return Object.values((await this.state.read()).entries)
      .filter((entry) => entry.phase !== 'finalized')
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map((entry) => this.cloneEntry(entry));
  }

  private cloneEntry(entry: RunCommitJournalEntry): RunCommitJournalEntry {
    return {
      ...entry,
      runtimeActions: entry.runtimeActions.map((action) => ({ ...action })),
      ...(entry.finalization ? {
        finalization: {
          ...entry.finalization,
          toolManifest: entry.finalization.toolManifest.map((call) => ({ ...call })),
        },
      } : {}),
    };
  }
}
