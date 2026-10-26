import type { Tool } from '@openai/agents';
import { z } from 'zod';
import { tool } from '../tool-factory.js';
import {
  completionCriterionSchema,
  type CompletionContract,
} from '../core/completion.js';
import type { Goal, PlanStore } from '../core/plan.js';
import { RunFailureError } from './run-failure.js';

export interface PlanToolOptions {
  beforeGoalSet?: () => void | Promise<void>;
  completionContract?: () => CompletionContract | undefined;
  onGoalSet?: (goal: Goal) => void | Promise<void>;
  verifyExternalReceiptRef?: (reference: string) => boolean | Promise<boolean>;
}

function planToolError(error: unknown): string {
  const original = error !== null && typeof error === 'object' && 'originalError' in error
    ? error.originalError
    : undefined;
  const issues = original !== null && typeof original === 'object' && 'issues' in original
    && Array.isArray(original.issues)
    ? original.issues
      .map((issue) => {
        if (issue === null || typeof issue !== 'object') return '';
        const path = 'path' in issue && Array.isArray(issue.path) ? issue.path.join('.') : '';
        const message = 'message' in issue && typeof issue.message === 'string' ? issue.message : '';
        return [path, message].filter(Boolean).join(': ');
      })
      .filter(Boolean)
    : [];
  if (issues.length > 0) {
    return `update_plan 参数不合法：${issues.join('；')}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `update_plan 执行失败：${message}`;
}

export function createPlanTools(store: PlanStore, options: PlanToolOptions = {}): Tool[] {
  const completion = z.discriminatedUnion('kind', [
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
  ]);
  const step = z.object({
    id: z.string().min(1),
    description: z.string().min(1),
    status: z.enum(['pending', 'running', 'completed', 'failed']),
    completion: completion.optional(),
  }).strict().superRefine((value, context) => {
    if (value.status === 'completed' && !value.completion) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'completed step 必须提供结构化 completion 证据',
        path: ['completion'],
      });
    }
    if (value.status !== 'completed' && value.completion) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '只有 completed step 可以携带 completion 证据',
        path: ['completion'],
      });
    }
  });
  return [
    tool({
      name: 'update_plan',
      description: '为多步骤任务创建或更新执行计划。completed 不是自由标签：内部步骤必须附带真实 evidenceRefs；外部事务必须附带正式工具返回的 action-intent:* 或 execution:* receiptRefs，并由 Host 验证为 confirmed。已完成步骤不能静默删除、重开或替换证据；需要重做时创建新的 Goal/Plan revision。简单问题无需使用。',
      parameters: z.object({ steps: z.array(step).max(20) }),
      errorFunction: (_context, error) => planToolError(error),
      execute: async ({ steps }) => {
        for (const candidate of steps) {
          if (candidate.status !== 'completed' || candidate.completion?.kind !== 'external_action') continue;
          if (!options.verifyExternalReceiptRef) {
            throw new Error(`Plan step ${candidate.id} 是外部事务，但当前 Host 没有回执验证器`);
          }
          for (const reference of candidate.completion.receiptRefs) {
            if (!await options.verifyExternalReceiptRef(reference)) {
              throw new Error(
                `Plan step ${candidate.id} 的外部事务回执 ${reference} 不存在、未 confirmed 或不属于当前执行账本`,
              );
            }
          }
        }
        return store.update(steps);
      },
    }),
    tool({
      name: 'show_plan',
      description: '查看当前会话的任务计划。',
      parameters: z.object({}),
      execute: async () => store.get(),
    }),
    tool({
      name: 'set_goal',
      description: '在 prepare_task 已冻结 Completion Contract 后，一次性创建需要跨多轮或跨重启继续的持久 Goal。已有未完成 Goal 时拒绝覆盖。',
      parameters: z.object({
        objective: z.string().min(1).max(2_000),
        acceptanceCriteria: z.array(completionCriterionSchema).min(1).max(8),
      }),
      execute: async ({ objective, acceptanceCriteria }) => {
        const contract = options.completionContract?.();
        if (!contract) {
          throw new RunFailureError(
            'goal_contract_missing',
            '创建 Goal 前必须先调用 prepare_task 冻结 Completion Contract',
            {
              phase: 'pre_dispatch',
              kind: 'state_conflict',
              retryable: false,
              dispatchStarted: false,
            },
          );
        }
        if (JSON.stringify(contract.criteria) !== JSON.stringify(acceptanceCriteria)) {
          throw new RunFailureError(
            'goal_acceptance_mismatch',
            'set_goal 的 acceptanceCriteria 必须等于已冻结 Completion Contract criteria',
            {
              phase: 'pre_dispatch',
              kind: 'validation',
              retryable: false,
              dispatchStarted: false,
            },
          );
        }
        await options.beforeGoalSet?.();
        const goal = await store.createGoal({
          objective,
          completionContract: contract,
        });
        await options.onGoalSet?.(goal);
        return goal;
      },
    }),
    tool({
      name: 'update_goal',
      description: '使用 goalId + expectedRevision CAS 保存长期 Goal 状态、下一步和检查点；cancelled 是明确终态。',
      parameters: z.object({
        goalId: z.string().min(1),
        expectedRevision: z.number().int().positive(),
        status: z.enum(['active', 'paused', 'completed', 'failed', 'cancelled']).optional(),
        nextAction: z.string().max(2_000).optional(),
        checkpoint: z.string().max(8_000).optional(),
      }),
      execute: async ({ goalId, expectedRevision, ...update }) => {
        if (update.status === 'completed') {
          throw new Error('Goal 不能由模型直接标记 completed；请调用 finish_task 通过 Completion Gate');
        }
        if (update.status === 'cancelled') {
          return store.cancelGoal({ goalId, expectedRevision, checkpoint: update.checkpoint });
        }
        return store.checkpoint(update, { goalId, expectedRevision });
      },
    }),
    tool({
      name: 'show_goal',
      description: '查看当前会话的长期 Goal、检查点和计划。',
      parameters: z.object({}),
      execute: async () => ({ goal: await store.getGoal(), steps: await store.get() }),
    }),
  ];
}
