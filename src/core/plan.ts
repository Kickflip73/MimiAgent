import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertSessionId } from './session-id.js';
import { AtomicJsonStore } from './state-file.js';
import {
  completionContractSchema,
  completionCriterionSchema,
  type CompletionContract,
  type CompletionCriterion,
} from './completion.js';
import { RunFailureError } from '../runtime/run-failure.js';

export interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  completion?: {
    kind: 'internal';
    evidenceRefs: string[];
    verification: 'confirmed' | 'observed' | 'business_ok';
  } | {
    kind: 'external_action';
    receiptRefs: string[];
    verification: 'confirmed' | 'observed' | 'business_ok';
  };
}

export type GoalStatus = 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface Goal {
  id?: string;
  revision?: number;
  objective: string;
  status: GoalStatus;
  acceptanceCriteria?: CompletionCriterion[];
  completionContract?: CompletionContract;
  completionEvidence?: string;
  nextAction?: string;
  checkpoint?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VersionedGoal extends Goal {
  id: string;
  revision: number;
}

interface TaskState {
  steps: PlanStep[];
  goal?: VersionedGoal;
}

type StoredPlans = Record<string, PlanStep[] | TaskState>;
type Plans = Record<string, TaskState>;
type PlanListener = (sessionId: string, steps: PlanStep[]) => void | Promise<void>;

const planStepSchema = z.object({
  id: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  completion: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('internal'),
      evidenceRefs: z.array(z.string().min(1).max(500)).min(1).max(20),
      verification: z.enum(['confirmed', 'observed', 'business_ok']),
    }).strict(),
    z.object({
      kind: z.literal('external_action'),
      receiptRefs: z.array(z.string().min(1).max(500)).min(1).max(20),
      verification: z.enum(['confirmed', 'observed', 'business_ok']),
    }).strict(),
  ]).optional(),
});
const goalSchema = z.object({
  id: z.string().min(1).optional(),
  revision: z.number().int().positive().optional(),
  objective: z.string(),
  status: z.enum(['active', 'paused', 'completed', 'failed', 'cancelled']),
  acceptanceCriteria: z.array(completionCriterionSchema).max(8).optional(),
  completionContract: completionContractSchema.optional(),
  completionEvidence: z.string().optional(),
  nextAction: z.string().optional(),
  checkpoint: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const taskStateSchema = z.object({ steps: z.array(planStepSchema).default([]), goal: goalSchema.optional() });
const storedPlansSchema = z.record(z.string(), z.union([z.array(planStepSchema), taskStateSchema]));

function decodePlans(value: unknown): Plans {
  const stored = storedPlansSchema.parse(value) as StoredPlans;
  return Object.assign(Object.create(null), Object.fromEntries(Object.entries(stored).map(([session, state]) => [
    session,
    Array.isArray(state) ? { steps: state } : {
      steps: state.steps ?? [],
      goal: state.goal ? normalizeGoal(session, state.goal) : undefined,
    },
  ]))) as Plans;
}

function normalizeGoal(sessionId: string, goal: Goal): VersionedGoal {
  return {
    ...goal,
    id: goal.id ?? `legacy-${createHash('sha256')
      .update(`${sessionId}\0${goal.createdAt}\0${goal.objective}`)
      .digest('hex')
      .slice(0, 24)}`,
    revision: goal.revision ?? 1,
  };
}

function goalConflict(code: string, message: string): RunFailureError {
  return new RunFailureError(code, message, {
    phase: 'pre_dispatch',
    kind: 'state_conflict',
    retryable: false,
    dispatchStarted: false,
  });
}

function assertGoalVersion(
  goal: VersionedGoal,
  expected: { goalId: string; expectedRevision: number } | undefined,
): void {
  if (!expected) return;
  if (goal.id !== expected.goalId || goal.revision !== expected.expectedRevision) {
    throw goalConflict(
      'goal_revision_conflict',
      `Goal revision 已变化：expected ${expected.goalId}@${expected.expectedRevision}，current ${goal.id}@${goal.revision}`,
    );
  }
}

export class PlanStore {
  private readonly state: AtomicJsonStore<Plans>;
  private listeners = new Set<PlanListener>();

  constructor(
    file: string,
    private sessionId: string,
  ) {
    assertSessionId(sessionId);
    this.state = new AtomicJsonStore(file, {
      defaultValue: () => Object.create(null) as Plans,
      decode: decodePlans,
      recoverCorrupt: true,
    });
  }

  useSession(sessionId: string): void {
    assertSessionId(sessionId);
    this.sessionId = sessionId;
  }

  async get(): Promise<PlanStep[]> {
    const sessionId = this.sessionId;
    return (await this.state.read())[sessionId]?.steps ?? [];
  }

  async update(steps: PlanStep[]): Promise<PlanStep[]> {
    const sessionId = this.sessionId;
    const updated = await this.mutate((plans) => {
      const previous = plans[sessionId]?.steps ?? [];
      for (const completed of previous.filter((step) => step.status === 'completed')) {
        const candidate = steps.find((step) => step.id === completed.id);
        if (!candidate || candidate.status !== 'completed') {
          throw new Error(`Plan step ${completed.id} 已完成，不能静默删除或重新打开；需要新的 Goal/Plan revision`);
        }
        if (completed.completion
          && JSON.stringify(candidate.completion) !== JSON.stringify(completed.completion)) {
          throw new Error(`Plan step ${completed.id} 的完成证据已锁定，不能静默替换`);
        }
      }
      plans[sessionId] = { ...plans[sessionId], steps };
      return steps;
    });
    await this.notify(sessionId, updated);
    return updated;
  }

  onChange(listener: PlanListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getGoal(): Promise<VersionedGoal | undefined> {
    const sessionId = this.sessionId;
    return (await this.state.read())[sessionId]?.goal;
  }

  async setGoal(
    objective: string,
    acceptanceCriteria?: CompletionCriterion[],
    completionContract?: CompletionContract,
  ): Promise<VersionedGoal> {
    const sessionId = this.sessionId;
    const goal = await this.mutate((plans) => {
      const now = new Date().toISOString();
      const goal: VersionedGoal = {
        id: randomUUID(),
        revision: 1,
        objective: objective.trim(),
        status: 'active',
        ...(acceptanceCriteria?.length ? { acceptanceCriteria } : {}),
        ...(completionContract ? { completionContract } : {}),
        createdAt: now,
        updatedAt: now,
      };
      plans[sessionId] = { steps: [], goal };
      return goal;
    });
    await this.notify(sessionId, []);
    return goal;
  }

  async createGoal(input: {
    objective: string;
    completionContract: CompletionContract;
    status?: Extract<GoalStatus, 'active' | 'paused'>;
    checkpoint?: string;
    nextAction?: string;
  }): Promise<VersionedGoal> {
    const sessionId = this.sessionId;
    const objective = input.objective.trim();
    const completionContract = completionContractSchema.parse(input.completionContract);
    if (!objective || completionContract.objective.trim() !== objective) {
      throw new RunFailureError(
        'goal_contract_objective_mismatch',
        'Goal objective 必须与 Completion Contract objective 完全一致',
        {
          phase: 'pre_dispatch',
          kind: 'validation',
          retryable: false,
          dispatchStarted: false,
        },
      );
    }
    const goal = await this.mutate((plans) => {
      const existing = plans[sessionId]?.goal;
      if (existing && (existing.status === 'active' || existing.status === 'paused')) {
        throw goalConflict(
          'goal_already_active',
          `当前 Session 已有未完成 Goal ${existing.id}@${existing.revision}，拒绝覆盖`,
        );
      }
      const now = new Date().toISOString();
      const created: VersionedGoal = {
        id: randomUUID(),
        revision: 1,
        objective,
        status: input.status ?? 'active',
        acceptanceCriteria: completionContract.criteria,
        completionContract,
        ...(input.checkpoint?.trim() ? { checkpoint: input.checkpoint.trim() } : {}),
        ...(input.nextAction?.trim() ? { nextAction: input.nextAction.trim() } : {}),
        createdAt: now,
        updatedAt: now,
      };
      plans[sessionId] = { steps: [], goal: created };
      return created;
    });
    await this.notify(sessionId, []);
    return goal;
  }

  async setGoalAcceptance(criteria: CompletionCriterion[]): Promise<VersionedGoal | undefined> {
    const sessionId = this.sessionId;
    return this.mutate((plans) => {
      const state = plans[sessionId];
      if (!state?.goal || state.goal.status === 'completed') return undefined;
      state.goal = {
        ...state.goal,
        revision: state.goal.revision + 1,
        acceptanceCriteria: criteria,
        updatedAt: new Date().toISOString(),
      };
      return state.goal;
    });
  }

  async setGoalCompletionContract(contract: CompletionContract): Promise<VersionedGoal | undefined> {
    const sessionId = this.sessionId;
    return this.mutate((plans) => {
      const state = plans[sessionId];
      if (!state?.goal || state.goal.status === 'completed') return undefined;
      if (state.goal.completionContract
        && JSON.stringify(state.goal.completionContract) !== JSON.stringify(contract)) {
        throw new Error('当前 Goal 的 Completion Contract 已锁定，拒绝覆盖');
      }
      state.goal = {
        ...state.goal,
        revision: state.goal.revision + 1,
        completionContract: contract,
        acceptanceCriteria: contract.criteria,
        updatedAt: new Date().toISOString(),
      };
      return state.goal;
    });
  }

  async completeGoalFromGate(evidence: string, expectedCreatedAt: string): Promise<VersionedGoal | undefined> {
    const sessionId = this.sessionId;
    return this.mutate((plans) => {
      const state = plans[sessionId];
      if (!state?.goal || state.goal.status === 'completed') return state?.goal;
      if (state.goal.createdAt !== expectedCreatedAt) return state.goal;
      const now = new Date().toISOString();
      state.goal = {
        ...state.goal,
        revision: state.goal.revision + 1,
        status: 'completed',
        completionEvidence: evidence.trim().slice(0, 8_000),
        checkpoint: evidence.trim().slice(0, 8_000),
        nextAction: '验收已通过',
        updatedAt: now,
      };
      return state.goal;
    });
  }

  async checkpoint(update: {
    status?: GoalStatus;
    nextAction?: string;
    checkpoint?: string;
  }, expected?: { goalId: string; expectedRevision: number }): Promise<VersionedGoal> {
    const sessionId = this.sessionId;
    return this.mutate((plans) => {
      const state = plans[sessionId];
      if (!state?.goal) throw new Error('当前会话没有 Goal，请先使用 set_goal');
      assertGoalVersion(state.goal, expected);
      if (state.goal.status === 'completed' || state.goal.status === 'cancelled') {
        throw goalConflict('goal_terminal', `Goal ${state.goal.id} 已是终态 ${state.goal.status}`);
      }
      state.goal = {
        ...state.goal,
        ...update,
        revision: state.goal.revision + 1,
        nextAction: update.nextAction?.trim() || state.goal.nextAction,
        checkpoint: update.checkpoint?.trim() || state.goal.checkpoint,
        updatedAt: new Date().toISOString(),
      };
      plans[sessionId] = state;
      return state.goal;
    });
  }

  async cancelGoal(input: {
    goalId: string;
    expectedRevision: number;
    checkpoint?: string;
  }): Promise<VersionedGoal> {
    const sessionId = this.sessionId;
    return this.mutate((plans) => {
      const state = plans[sessionId];
      if (!state?.goal) {
        throw goalConflict('goal_missing', '当前会话没有可取消的 Goal');
      }
      assertGoalVersion(state.goal, input);
      if (state.goal.status === 'completed') {
        throw goalConflict('goal_already_completed', `Goal ${state.goal.id} 已完成，不能取消`);
      }
      if (state.goal.status === 'cancelled') return state.goal;
      state.goal = {
        ...state.goal,
        status: 'cancelled',
        revision: state.goal.revision + 1,
        checkpoint: input.checkpoint?.trim() || state.goal.checkpoint,
        nextAction: '已取消，不再自动恢复',
        updatedAt: new Date().toISOString(),
      };
      return state.goal;
    });
  }

  async resumePrompt(): Promise<string> {
    const [goal, steps] = await Promise.all([this.getGoal(), this.get()]);
    if (!goal) throw new Error('当前会话没有可恢复的 Goal');
    if (goal.status === 'completed') throw new Error('当前 Goal 已完成');
    const plan = steps.map((step) => `[${step.status}] ${step.id}. ${step.description}`).join('\n');
    return [
      `继续执行当前长期目标：${goal.objective}`,
      `Goal：${goal.id}@${goal.revision}`,
      goal.checkpoint ? `上次检查点：${goal.checkpoint}` : '',
      goal.nextAction ? `下一步：${goal.nextAction}` : '',
      plan ? `当前计划：\n${plan}` : '',
      '请从未完成处继续，自主执行并在关键阶段更新 Goal checkpoint 和计划状态。',
    ].filter(Boolean).join('\n\n');
  }

  async clear(sessionId = this.sessionId): Promise<void> {
    assertSessionId(sessionId);
    await this.state.update((plans) => {
      delete plans[sessionId];
    });
    await this.notify(sessionId, []);
  }

  private mutate<T>(mutation: (plans: Plans) => T): Promise<T> {
    return this.state.update(mutation);
  }

  private async notify(sessionId: string, steps: PlanStep[]): Promise<void> {
    const snapshot = steps.map((step) => ({ ...step }));
    await Promise.all([...this.listeners].map((listener) => listener(sessionId, snapshot)));
  }

}
