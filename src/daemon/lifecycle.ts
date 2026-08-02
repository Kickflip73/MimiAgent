import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AtomicJsonStore } from '../core/state-file.js';

export type DaemonLifecyclePhase =
  | 'starting'
  | 'online'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'unknown_ungraceful';

export type DaemonLifecycleStopReason =
  | 'owner_shutdown'
  | 'signal'
  | 'runtime_failure'
  | 'cleanup_failure'
  | 'missing_terminal_receipt';

export interface DaemonLifecycleEpoch {
  epochId: string;
  buildVersion: string;
  pid: number;
  workerId: string;
  workspaceRoot: string;
  supervisor: 'launchd' | 'detached' | 'foreground';
  phase: DaemonLifecyclePhase;
  startedAt: string;
  updatedAt: string;
  recoveredFromEpochId?: string;
  reason?: DaemonLifecycleStopReason;
  signal?: 'SIGINT' | 'SIGTERM';
  exitCode?: number;
  error?: string;
}

interface DaemonLifecycleFile {
  version: 1;
  epochs: DaemonLifecycleEpoch[];
}

const phaseSchema = z.enum([
  'starting',
  'online',
  'stopping',
  'stopped',
  'failed',
  'unknown_ungraceful',
]);
const reasonSchema = z.enum([
  'owner_shutdown',
  'signal',
  'runtime_failure',
  'cleanup_failure',
  'missing_terminal_receipt',
]);
const epochSchema = z.object({
  epochId: z.string().min(1),
  buildVersion: z.string().min(1),
  pid: z.number().int().positive(),
  workerId: z.string().min(1),
  workspaceRoot: z.string().min(1),
  supervisor: z.enum(['launchd', 'detached', 'foreground']),
  phase: phaseSchema,
  startedAt: z.string(),
  updatedAt: z.string(),
  recoveredFromEpochId: z.string().min(1).optional(),
  reason: reasonSchema.optional(),
  signal: z.enum(['SIGINT', 'SIGTERM']).optional(),
  exitCode: z.number().int().optional(),
  error: z.string().max(4_000).optional(),
}).strict();
const lifecycleFileSchema = z.object({
  version: z.literal(1),
  epochs: z.array(epochSchema),
}).strict();

const ACTIVE_PHASES = new Set<DaemonLifecyclePhase>(['starting', 'online', 'stopping']);
const ALLOWED_TRANSITIONS: Readonly<Record<DaemonLifecyclePhase, ReadonlySet<DaemonLifecyclePhase>>> = {
  starting: new Set(['online', 'stopping', 'failed', 'unknown_ungraceful']),
  online: new Set(['stopping', 'failed', 'unknown_ungraceful']),
  stopping: new Set(['stopped', 'failed', 'unknown_ungraceful']),
  stopped: new Set(),
  failed: new Set(),
  unknown_ungraceful: new Set(),
};

export interface DaemonLifecycleBegin {
  buildVersion: string;
  pid: number;
  workerId: string;
  workspaceRoot: string;
  supervisor: DaemonLifecycleEpoch['supervisor'];
}

export interface DaemonLifecycleTransition {
  reason?: DaemonLifecycleStopReason;
  signal?: DaemonLifecycleEpoch['signal'];
  exitCode?: number;
  error?: string;
}

export class DaemonMutationGate {
  private activeCount = 0;
  private accepting = true;
  private readonly idleWaiters = new Set<() => void>();

  get active(): number {
    return this.activeCount;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) throw new Error('MimiAgent 正在关闭，不再接受新的管理事务');
    this.activeCount += 1;
    try {
      return await operation();
    } finally {
      this.activeCount -= 1;
      if (this.activeCount === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    }
  }

  beginShutdown(): boolean {
    if (this.activeCount > 0) return false;
    this.accepting = false;
    return true;
  }

  async closeAndWait(): Promise<void> {
    this.accepting = false;
    if (this.activeCount === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }
}

export class DaemonLifecycleStore {
  private readonly state: AtomicJsonStore<DaemonLifecycleFile>;
  private readonly historyLimit: number;

  constructor(file: string, options: { historyLimit?: number } = {}) {
    this.historyLimit = Math.max(2, options.historyLimit ?? 20);
    this.state = new AtomicJsonStore(file, {
      defaultValue: () => ({ version: 1, epochs: [] }),
      decode: (value) => lifecycleFileSchema.parse(value),
      recoverCorrupt: false,
      pretty: true,
    });
  }

  async begin(input: DaemonLifecycleBegin): Promise<DaemonLifecycleEpoch> {
    return this.state.update((journal) => {
      const now = new Date().toISOString();
      const previous = journal.epochs.at(-1);
      let recoveredFromEpochId: string | undefined;
      if (previous && ACTIVE_PHASES.has(previous.phase)) {
        previous.phase = 'unknown_ungraceful';
        previous.reason = 'missing_terminal_receipt';
        previous.updatedAt = now;
        recoveredFromEpochId = previous.epochId;
      }
      const epoch: DaemonLifecycleEpoch = {
        epochId: randomUUID(),
        ...input,
        phase: 'starting',
        startedAt: now,
        updatedAt: now,
        ...(recoveredFromEpochId ? { recoveredFromEpochId } : {}),
      };
      journal.epochs.push(epoch);
      journal.epochs.splice(0, Math.max(0, journal.epochs.length - this.historyLimit));
      return { ...epoch };
    });
  }

  async transition(
    epochId: string,
    phase: DaemonLifecyclePhase,
    update: DaemonLifecycleTransition = {},
  ): Promise<DaemonLifecycleEpoch> {
    return this.state.updateWhen((journal) => {
      const epoch = journal.epochs.find((candidate) => candidate.epochId === epochId);
      if (!epoch) throw new Error(`Daemon lifecycle epoch 不存在：${epochId}`);
      if (epoch.phase === phase) return { result: { ...epoch }, changed: false };
      if (!ALLOWED_TRANSITIONS[epoch.phase].has(phase)) {
        throw new Error(`Daemon lifecycle 不允许 ${epoch.phase} -> ${phase}`);
      }
      epoch.phase = phase;
      epoch.updatedAt = new Date().toISOString();
      if (update.reason !== undefined) epoch.reason = update.reason;
      if (update.signal !== undefined) epoch.signal = update.signal;
      if (update.exitCode !== undefined) epoch.exitCode = update.exitCode;
      if (update.error !== undefined) epoch.error = update.error.slice(0, 4_000);
      return { result: { ...epoch }, changed: true };
    });
  }

  async latest(): Promise<DaemonLifecycleEpoch | undefined> {
    const epoch = (await this.state.read()).epochs.at(-1);
    return epoch ? { ...epoch } : undefined;
  }

  async history(): Promise<DaemonLifecycleEpoch[]> {
    return (await this.state.read()).epochs.map((epoch) => ({ ...epoch }));
  }
}
