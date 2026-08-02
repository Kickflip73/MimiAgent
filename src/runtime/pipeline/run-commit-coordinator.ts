import { z } from 'zod';
import type { ComputerManager } from '../../extensions/computer/manager.js';
import type { ExecutionLedger, ExecutionCallRecord } from '../../core/execution-ledger.js';
import type { MemoryHub } from '../../core/memory.js';
import type { PlanStore } from '../../core/plan.js';
import {
  classifyRunOutcome,
  constrainRunAnswer,
  createRunFinalization,
  runEvidenceRefs,
  runFinalizationRecordSchema,
  type RunFinalizationRecord,
  type RunOutcome,
} from '../../core/run-finalization.js';
import { runAnswerDigest, type RunCommitJournal } from '../../core/run-commit-journal.js';
import type { FileSession } from '../../core/session.js';
import type { TeamTaskStore } from '../../core/team.js';
import type { TraceStore } from '../../core/trace.js';
import {
  runtimeActionSchema,
  type RuntimeAction,
  type RuntimeEffect,
} from '../control.js';
import { incompleteCompletionAnswer, type CompletionCoordinator } from '../completion-coordinator.js';
import {
  containsActiveEphemeralValue,
  redactActiveEphemeralText,
  type ActiveEphemeralOwnerInput,
} from '../ephemeral-owner-input.js';
import type { HookBus } from '../hooks.js';
import type {
  ActiveRun,
  CompletedExecutionReceipt,
  ContextUsageSnapshot,
} from '../mimi-agent.js';
import type { RunContextBuilder } from '../run-context-builder.js';
import type { RuntimeActionCoordinator } from '../runtime-action-coordinator.js';
import {
  isTerminalRunInterruption,
  RunInterruptedError,
  TerminalRunInterruptedError,
} from '../run-outcome.js';
import { mergeRunCalls } from './run-fact-collector.js';

export interface RunCommitUsage {
  lastRequestInputTokens?: number;
  lastRequestOutputTokens?: number;
  runInputTokens?: number;
  runOutputTokens?: number;
  runTotalTokens?: number;
}

export interface RunCommitInput {
  answer: string;
  usage?: RunCommitUsage;
}

export interface RunCommitDecisionInput {
  draft: string;
  calls: readonly ExecutionCallRecord[];
  sdk?: 'completed' | 'interrupted' | 'failed';
  completionDecision?: RunFinalizationRecord['completionDecision'];
  reason?: string;
  nextAction?: string;
}

export interface RunCommitDecision {
  answer: string;
  outcome: RunOutcome;
  reason?: string;
  nextAction?: string;
  evidenceRefs: string[];
}

function outputRecord(call: ExecutionCallRecord | undefined): Record<string, unknown> | undefined {
  if (!call) return undefined;
  return call.output !== null && typeof call.output === 'object' && !Array.isArray(call.output)
    ? call.output as Record<string, unknown>
    : undefined;
}

function defaultReason(outcome: RunOutcome, calls: readonly ExecutionCallRecord[]): string | undefined {
  if (outcome === 'completed') return undefined;
  if (outcome === 'blocked') {
    const blocker = calls.find((call) => call.toolName === 'request_background_task_input');
    const reason = outputRecord(blocker)?.reason;
    return typeof reason === 'string' && reason.trim()
      ? reason
      : '缺少继续执行所需的 owner 输入或外部状态';
  }
  if (outcome === 'uncertain') return '至少一个已派发动作没有可确认的业务结果，Host 已禁止自动重放';
  if (outcome === 'interrupted') return 'SDK Run 被取消、抢占或在正常结束前中断';
  if (outcome === 'failed') return '结构化执行事实只包含未解决的确定性失败';
  return '已形成有价值进展，但仍有失败、未验证交互或未满足的验收条件';
}

function defaultNextAction(outcome: RunOutcome, calls: readonly ExecutionCallRecord[]): string | undefined {
  if (outcome === 'completed') return undefined;
  if (outcome === 'blocked') {
    const blocker = calls.find((call) => call.toolName === 'request_background_task_input');
    const question = outputRecord(blocker)?.question;
    return typeof question === 'string' && question.trim()
      ? question
      : '补充缺失输入后从当前检查点继续';
  }
  if (outcome === 'uncertain') return '先读取同一业务对象核对结果；不得重放或换路';
  if (outcome === 'interrupted') return '从最后持久检查点继续，不重复已确认副作用';
  if (outcome === 'failed') return '修正结构化 validation/policy/state/unsupported 失败后重新发起';
  return '继续未完成部分并为业务结果补充结构化回读或回执';
}

export function decideRunCommit(input: RunCommitDecisionInput): RunCommitDecision {
  const outcome = classifyRunOutcome({
    sdk: input.sdk ?? 'completed',
    calls: input.calls,
    completionDecision: input.completionDecision,
  });
  const reason = input.reason ?? defaultReason(outcome, input.calls);
  const nextAction = input.nextAction ?? defaultNextAction(outcome, input.calls);
  const evidenceRefs = runEvidenceRefs(input.calls);
  return {
    answer: constrainRunAnswer({
      draft: input.draft,
      outcome,
      reason,
      nextAction,
      evidenceRefs,
    }),
    outcome,
    ...(reason ? { reason } : {}),
    ...(nextAction ? { nextAction } : {}),
    evidenceRefs,
  };
}

export interface RunFailureInput {
  error: unknown;
  interrupted: boolean;
  usage?: RunCommitUsage;
  interruptedAnswer?: string;
}

export interface RunCommitCoordinatorPort {
  readonly plans: PlanStore;
  readonly team: TeamTaskStore;
  readonly completion: CompletionCoordinator;
  readonly ledger: ExecutionLedger;
  readonly runCommits: RunCommitJournal;
  readonly traces: TraceStore;
  readonly runtimeActions: RuntimeActionCoordinator;
  readonly memory: MemoryHub;
  readonly runContexts: RunContextBuilder;
  readonly computer?: ComputerManager;
  readonly hooks: HookBus;
  activeRun?: ActiveRun;
  lastUsage?: ContextUsageSnapshot;
  lastCommittedAnswer?: string;
  lastFinalization?: RunFinalizationRecord;
  validUsage(usage: ContextUsageSnapshot | undefined, binding?: ActiveRun['scope']['modelBinding']): ContextUsageSnapshot | undefined;
  applyManifestActual(usage?: ContextUsageSnapshot): void;
  createSession(sessionId: string): FileSession;
}

const contextUsageSchema = z.object({
  lastRequestInputTokens: z.number().finite().nonnegative().optional(),
  lastRequestOutputTokens: z.number().finite().nonnegative().optional(),
  runInputTokens: z.number().finite().nonnegative().optional(),
  runOutputTokens: z.number().finite().nonnegative().optional(),
  runTotalTokens: z.number().finite().nonnegative().optional(),
  providerId: z.string().min(1).max(100).optional(),
  modelId: z.string().min(1).max(200).optional(),
  scenario: z.string().min(1).max(100).optional(),
  selectionReason: z.enum([
    'explicit-work-unit',
    'team-override',
    'session-preference',
    'scenario-route',
    'global-default',
    'safe-fallback',
  ]).optional(),
  cost: z.literal('unknown').optional(),
}).strict();

const completedExecutionReceiptSchema = z.object({
  runId: z.string().min(1).max(200),
  answer: z.string(),
  // Optional only when decoding receipts written before finalization manifests.
  finalization: runFinalizationRecordSchema.optional(),
  usage: contextUsageSchema.optional(),
  actions: z.array(runtimeActionSchema).max(20).default([]),
  delivery: z.object({
    suppressed: z.literal(true),
    reason: z.string().trim().min(1).max(500).optional(),
  }).strict().optional(),
}).strict();

export class RunCommitCoordinator {
  constructor(private readonly port: RunCommitCoordinatorPort) {}

  async complete(input: RunCommitInput): Promise<RuntimeEffect[]> {
    const run = this.port.activeRun;
    if (!run) throw new Error('没有正在运行的任务可完成');
    const safeAnswer = redactActiveEphemeralText(input.answer, run.ephemeralSensitiveAccess);
    let gate;
    if (run.completionRequired) {
      const evaluated = await this.evaluate(
        run,
        run.plans ?? this.port.plans,
        run.team ?? this.port.team,
      );
      gate = evaluated.gate;
      await run.session.updateRunCompletion({
        completionContract: run.completionContract,
        completionReport: run.completionReport,
        completionGate: gate,
      }, run.runId);
    }
    const evidenceRunId = run.options?.executionKey ?? run.runId;
    const initialExecutionCalls = mergeRunCalls(
      run.facts.calls(run.sessionId, evidenceRunId),
      await this.port.ledger.listCalls(run.sessionId, evidenceRunId),
    );
    const decision = decideRunCommit({
      draft: gate && gate.decision !== 'pass' ? incompleteCompletionAnswer(gate) : safeAnswer,
      calls: initialExecutionCalls,
      ...(gate ? { completionDecision: gate.decision } : {}),
      ...(gate && gate.decision !== 'pass' ? { reason: gate.reason } : {}),
    });
    const committedAnswer = decision.answer;
    this.port.activeRun = undefined;
    const validUsage = this.port.validUsage(input.usage, run.scope.modelBinding);
    const executionKey = run.options?.executionKey;
    let completed;
    let actions: RuntimeAction[] = [];
    try {
      actions = await this.port.runtimeActions.actionsForCompletedRun({
        pendingActions: run.pendingActions,
        sessionId: run.sessionId,
        executionKey,
        retainExecutionLedger: run.options?.retainExecutionLedger === true,
      });
      const executionCalls = mergeRunCalls(
        run.facts.calls(run.sessionId, executionKey ?? run.runId),
        await this.port.ledger.listCalls(run.sessionId, executionKey ?? run.runId),
      );
      const finalization = createRunFinalization({
        runId: run.runId,
        answer: committedAnswer,
        outcome: decision.outcome,
        ...(decision.reason ? { reason: decision.reason } : {}),
        ...(decision.nextAction ? { nextAction: decision.nextAction } : {}),
        evidenceRefs: decision.evidenceRefs,
        ...(gate ? { completionDecision: gate.decision } : {}),
        calls: executionCalls,
      });
      await this.port.runCommits.prepare({
        sessionId: run.sessionId,
        runId: run.runId,
        ...(executionKey ? { executionKey } : {}),
        answerDigest: runAnswerDigest(committedAnswer),
        outcome: decision.outcome,
        ...(gate ? { completionDecision: gate.decision } : {}),
        runtimeActions: actions.map((action) => ({ ...action })),
        finalization,
      });
      if (run.options?.retainExecutionLedger && executionKey) {
        const receipt = {
          runId: run.runId,
          answer: committedAnswer,
          finalization,
          usage: validUsage,
          actions,
          delivery: await run.options.completionDelivery?.(executionCalls),
        };
        const persisted = completedExecutionReceiptSchema.parse(
          await this.port.ledger.commitReceipt<unknown>(run.sessionId, executionKey, receipt),
        );
        if (JSON.stringify(persisted) !== JSON.stringify(receipt)) {
          throw new Error(`Execution ${executionKey} 已存在不同的完成回执，拒绝覆盖`);
        }
      }
      await this.port.runCommits.advance(run.sessionId, run.runId, 'receipt_committed');
      await this.port.traces.record(run.sessionId, 'run_finalization', finalization);
      completed = await run.session.completeRun(committedAnswer, run.runId, finalization);
      if (completed?.runId !== run.runId || completed.status !== 'completed') {
        throw new Error(`Run ${run.runId} 已失效，拒绝用旧结果完成当前 Session`);
      }
      await this.port.runCommits.advance(run.sessionId, run.runId, 'session_committed');
      if (gate?.decision === 'pass' && run.goalCreatedAt) {
        await this.port.plans.completeGoalFromGate(gate.reason, run.goalCreatedAt);
      }
      await this.port.runCommits.advance(run.sessionId, run.runId, 'goal_committed');
      const cause = run.options?.cause;
      if (cause?.source !== 'mimi:memory-maintenance' && cause?.source !== 'attention:briefing') {
        await this.port.memory.recordEpisode({
          sessionId: run.sessionId,
          runId: run.runId,
          input: run.input,
          answer: committedAnswer,
          occurredAt: completed.updatedAt,
        }, this.port.runContexts.forRun(run, cause)).catch(async (error) => {
          await this.port.traces.record(run.sessionId, 'memory_episode_error', {
            error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
          });
        });
      }
    } catch (error) {
      // Once a completion receipt exists it is recovery evidence. Clearing it
      // here would permit the model and side effects to run again after a crash.
      if (!this.port.activeRun) this.port.activeRun = run;
      throw error;
    }
    this.port.lastUsage = validUsage;
    this.port.applyManifestActual(validUsage);
    this.port.lastCommittedAnswer = committedAnswer;
    this.port.lastFinalization = (await this.port.runCommits.get(run.sessionId, run.runId))?.finalization;
    await this.port.computer?.endRun(run.runId);
    await this.port.hooks.emit({ type: 'run_end', sessionId: run.sessionId, answer: committedAnswer });
    if (!run.options?.retainExecutionLedger) {
      await this.port.ledger.clearRun(run.sessionId, executionKey ?? run.runId).catch(() => undefined);
    }
    run.releaseOwner();
    const effects = await this.port.runtimeActions.apply(
      actions,
      run.sessionId,
      run.options?.retainExecutionLedger ? executionKey : undefined,
    );
    await this.port.runCommits.advance(run.sessionId, run.runId, 'effects_applied');
    if (!run.options?.retainExecutionLedger) {
      await this.port.runCommits.advance(run.sessionId, run.runId, 'finalized');
    }
    return effects;
  }

  async fail(input: RunFailureInput): Promise<RunFinalizationRecord | undefined> {
    const run = this.port.activeRun;
    if (!run) return undefined;
    const safeError = this.redactError(input.error, run.ephemeralSensitiveAccess);
    const errorMessage = safeError instanceof Error ? safeError.message : String(safeError);
    const safeInterruptedAnswer = input.interrupted && input.interruptedAnswer
      ? redactActiveEphemeralText(input.interruptedAnswer, run.ephemeralSensitiveAccess)
      : undefined;
    const executionRunId = run.options?.executionKey ?? run.runId;
    const calls = mergeRunCalls(
      run.facts.calls(run.sessionId, executionRunId),
      await this.port.ledger.listCalls(run.sessionId, executionRunId),
    );
    const decision = decideRunCommit({
      draft: safeInterruptedAnswer ?? '',
      calls,
      sdk: 'interrupted',
      reason: errorMessage,
    });
    const finalization = createRunFinalization({
      runId: run.runId,
      answer: decision.answer,
      outcome: decision.outcome,
      reason: decision.reason,
      nextAction: decision.nextAction,
      evidenceRefs: decision.evidenceRefs,
      calls,
    });
    await this.port.runCommits.prepare({
      sessionId: run.sessionId,
      runId: run.runId,
      ...(run.options?.executionKey ? { executionKey: run.options.executionKey } : {}),
      answerDigest: finalization.answerDigest,
      outcome: finalization.outcome,
      runtimeActions: [],
      finalization,
    });
    await this.port.traces.record(run.sessionId, 'run_finalization', finalization);
    this.port.activeRun = undefined;
    await this.port.computer?.endRun(run.runId).catch(() => undefined);
    run.releaseOwner();
    this.port.lastUsage = this.port.validUsage(input.usage, run.scope.modelBinding);
    this.port.applyManifestActual(this.port.lastUsage);
    if (run.options?.retainExecutionLedger) {
      await run.session.rollbackRunItems(run.runId, safeInterruptedAnswer).catch(() => undefined);
    }
    if (input.interrupted && isTerminalRunInterruption(safeError)) {
      await run.session.clearRunCheckpoint(run.runId);
    } else {
      await run.session.failRun(
        errorMessage,
        decision.outcome === 'interrupted',
        run.runId,
        finalization,
      );
    }
    await this.port.runCommits.advance(run.sessionId, run.runId, 'session_committed');
    this.port.lastCommittedAnswer = decision.answer;
    this.port.lastFinalization = finalization;
    await this.port.hooks.emit({
      type: 'run_error',
      sessionId: run.sessionId,
      error: errorMessage,
      interrupted: decision.outcome === 'interrupted',
    });
    if (!run.options?.retainExecutionLedger) {
      await this.port.runCommits.advance(run.sessionId, run.runId, 'finalized');
    }
    return finalization;
  }

  evaluate(
    run: ActiveRun,
    plans: PlanStore,
    team: TeamTaskStore,
  ) {
    return this.port.completion.evaluate({
      sessionId: run.sessionId,
      runId: run.runId,
      ...(run.options?.executionKey ? { executionKey: run.options.executionKey } : {}),
      ...(run.recoveryRunId ? { recoveryRunId: run.recoveryRunId } : {}),
      ...(run.completionContract ? { completionContract: run.completionContract } : {}),
      ...(run.completionReport ? { completionReport: run.completionReport } : {}),
      requireDurableBlocker: run.requireDurableBlocker,
      goalOwned: Boolean(run.goalCreatedAt),
      planOwned: Boolean(run.planOwned),
      teamOwned: Boolean(run.teamOwned),
      plans,
      team,
    });
  }

  redactError(error: unknown, access: ActiveEphemeralOwnerInput | undefined): unknown {
    if (!access) return error;
    const originalMessage = error instanceof Error ? error.message : String(error);
    if (!containsActiveEphemeralValue(originalMessage, access)) return error;
    const message = redactActiveEphemeralText(originalMessage, access);
    if (error instanceof TerminalRunInterruptedError) return new TerminalRunInterruptedError(message);
    if (error instanceof RunInterruptedError) return new RunInterruptedError(message);
    if (error instanceof Error) {
      const sanitized = new Error(message);
      sanitized.name = error.name;
      return sanitized;
    }
    return message;
  }

  async finalizeExecutionLedger(sessionId: string, executionKey: string): Promise<void> {
    await this.port.runCommits.acknowledgeTask(sessionId, executionKey);
    await this.port.ledger.clearRun(sessionId, executionKey);
    await this.port.runCommits.finalizeExecution(sessionId, executionKey);
  }

  async reopenExecutionLedger(sessionId: string, executionKey: string): Promise<void> {
    await this.port.ledger.clearReceipt(sessionId, executionKey);
    await this.port.runCommits.finalizeExecution(sessionId, executionKey);
  }

  async completedExecution(
    sessionId: string,
    executionKey: string,
  ): Promise<CompletedExecutionReceipt | undefined> {
    const stored = await this.port.ledger.getReceipt<unknown>(sessionId, executionKey);
    if (!stored) return undefined;
    const legacyReceipt = completedExecutionReceiptSchema.parse(stored);
    const journal = await this.port.runCommits.findByExecutionKey(sessionId, executionKey);
    const receipt: CompletedExecutionReceipt = {
      ...legacyReceipt,
      actions: legacyReceipt.actions ?? [],
      finalization: legacyReceipt.finalization
        ?? journal?.finalization
        ?? createRunFinalization({
          runId: legacyReceipt.runId,
          answer: legacyReceipt.answer,
          calls: await this.port.ledger.listCalls(sessionId, executionKey),
        }),
    };
    if (journal && journal.answerDigest !== runAnswerDigest(receipt.answer)) {
      throw new Error(`Execution ${executionKey} 的完成回执与提交日志摘要不一致`);
    }
    if (journal?.finalization
      && JSON.stringify(journal.finalization) !== JSON.stringify(receipt.finalization)) {
      throw new Error(`Execution ${executionKey} 的工具事实与提交日志不一致`);
    }
    await this.port.createSession(sessionId).reconcileCompletedRun(
      receipt.answer,
      receipt.runId,
      receipt.finalization,
    );
    if (journal) await this.port.runCommits.advance(sessionId, receipt.runId, 'session_committed');
    const effects = await this.port.runtimeActions.apply(receipt.actions ?? [], sessionId, executionKey);
    if (journal) await this.port.runCommits.advance(sessionId, receipt.runId, 'effects_applied');
    return { ...receipt, effects };
  }
}
