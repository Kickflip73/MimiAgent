import { z } from 'zod';
import type { ExecutionCallRecord } from '../../core/execution-ledger.js';
import {
  contextUsageSnapshotSchema,
  createRunFinalization,
  runFinalizationRecordSchema,
  type RunFinalizationRecord,
} from '../../core/run-finalization.js';
import { runAnswerDigest } from '../../core/run-commit-journal.js';
import {
  runtimeActionSchema,
  type RuntimeAction,
} from '../control.js';
import { incompleteCompletionAnswer } from '../completion-coordinator.js';
import {
  containsActiveEphemeralValue,
  redactActiveEphemeralText,
  type ActiveEphemeralOwnerInput,
} from '../ephemeral-owner-input.js';
import type {
  ActiveRun,
  ContextUsageSnapshot,
  MimiAgent,
} from '../mimi-agent.js';
import {
  isTerminalRunInterruption,
  RunInterruptedError,
  TerminalRunInterruptedError,
} from '../run-outcome.js';
import { mergeRunCalls } from './run-fact-collector.js';
import { decideRunCommit } from './run-commit-decision.js';

export type RunCommitUsage = Pick<ContextUsageSnapshot,
  'lastRequestInputTokens' | 'lastRequestOutputTokens' | 'runInputTokens' | 'runOutputTokens' | 'runTotalTokens'>;

export interface RunCommitInput {
  answer: string;
  usage?: RunCommitUsage;
}

export interface RunFailureInput {
  error: unknown;
  interrupted: boolean;
  usage?: RunCommitUsage;
  interruptedAnswer?: string;
}

const completedExecutionReceiptSchema = z.object({
  runId: z.string().min(1).max(200),
  answer: z.string(),
  // Optional only when decoding receipts written before finalization manifests.
  finalization: runFinalizationRecordSchema.optional(),
  usage: contextUsageSnapshotSchema.optional(),
  actions: z.array(runtimeActionSchema).max(20).default([]),
  delivery: z.object({
    suppressed: z.literal(true),
    reason: z.string().trim().min(1).max(500).optional(),
  }).strict().optional(),
}).strict();

export class RunCommitCoordinator {
  constructor(private readonly port: MimiAgent) {}

  async complete(input: RunCommitInput) {
    const run = this.port.activeRun;
    if (!run) throw new Error('没有正在运行的任务可完成');
    const safeAnswer = redactActiveEphemeralText(input.answer, run.ephemeralSensitiveAccess);
    let gate;
    if (run.completionRequired) {
      const evaluated = await this.evaluate(
        run,
      );
      gate = evaluated.gate;
      await run.session.updateRunCompletion({
        completionContract: run.completionContract,
        completionReport: run.completionReport,
        completionGate: gate,
      }, run.runId);
    }
    const evidenceRunId = run.options?.executionKey ?? run.runId;
    const executionCalls = mergeRunCalls(
      run.facts.calls(run.sessionId, evidenceRunId),
      await this.port.components.state.executionLedger.store.listCalls(run.sessionId, evidenceRunId),
    );
    const decision = decideRunCommit({
      draft: gate && gate.decision !== 'pass' ? incompleteCompletionAnswer(gate) : safeAnswer,
      calls: executionCalls,
      ...run.facts.mediaEvidenceFacts(),
      ...(gate ? { completionDecision: gate.decision } : {}),
      ...(gate && gate.decision !== 'pass' ? { reason: gate.reason } : {}),
    });
    const committedAnswer = decision.answer;
    this.port.activeRun = undefined;
    const validUsage = this.port.validUsage(input.usage, run.scope.modelBinding);
    const executionKey = run.options?.executionKey;
    let completed;
    let actions: RuntimeAction[] = [];
    let finalization: RunFinalizationRecord | undefined;
    try {
      actions = await this.port.runtimeActions.actionsForCompletedRun({
        pendingActions: run.pendingActions,
        sessionId: run.sessionId,
        executionKey,
        retainExecutionLedger: run.options?.retainExecutionLedger === true,
      });
      finalization = createRunFinalization({
        runId: run.runId,
        ...decision,
        answer: committedAnswer,
        ...(gate ? { completionDecision: gate.decision } : {}),
        calls: executionCalls,
      });
      await this.port.components.state.runCommits.prepare({
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
          await this.port.components.state.executionLedger.store.commitReceipt<unknown>(
            run.sessionId, executionKey, receipt,
          ),
        );
        if (JSON.stringify(persisted) !== JSON.stringify(receipt)) {
          throw new Error(`Execution ${executionKey} 已存在不同的完成回执，拒绝覆盖`);
        }
      }
      await this.port.components.state.runCommits.advance(run.sessionId, run.runId, 'receipt_committed');
      await this.port.components.state.traces.record(run.sessionId, 'run_finalization', finalization);
      completed = await run.session.completeRun(committedAnswer, run.runId, finalization);
      if (completed?.runId !== run.runId || completed.status !== 'completed') {
        throw new Error(`Run ${run.runId} 已失效，拒绝用旧结果完成当前 Session`);
      }
      await this.port.components.state.runCommits.advance(run.sessionId, run.runId, 'session_committed');
      if (gate?.decision === 'pass' && run.goalCreatedAt) {
        await this.port.components.state.goalsAndPlans.store.completeGoalFromGate(
          gate.reason, run.goalCreatedAt,
        );
      }
      await this.port.components.state.runCommits.advance(run.sessionId, run.runId, 'goal_committed');
      const cause = run.options?.cause;
      if (cause?.source !== 'mimi:memory-maintenance' && cause?.source !== 'attention:briefing') {
        await this.port.components.memory.recordEpisode({
          sessionId: run.sessionId,
          runId: run.runId,
          input: run.input,
          answer: committedAnswer,
          occurredAt: completed.updatedAt,
        }, this.port.runContexts.forRun(run, cause)).catch(async (error) => {
          await this.port.components.state.traces.record(run.sessionId, 'memory_episode_error', {
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
    if (!finalization) throw new Error(`Run ${run.runId} 未生成最终提交事实`);
    this.port.applyManifestActual(validUsage);
    await this.port.components.computer?.endRun(run.runId);
    await this.port.hooks.emit({ type: 'run_end', sessionId: run.sessionId, answer: committedAnswer });
    if (!run.options?.retainExecutionLedger) {
      await this.port.components.state.executionLedger.store
        .clearRun(run.sessionId, executionKey ?? run.runId).catch(() => undefined);
    }
    run.releaseOwner();
    const effects = await this.port.runtimeActions.apply(
      actions,
      run.sessionId,
      run.options?.retainExecutionLedger ? executionKey : undefined,
    );
    await this.port.components.state.runCommits.advance(run.sessionId, run.runId, 'effects_applied');
    if (!run.options?.retainExecutionLedger) {
      await this.port.components.state.runCommits.advance(run.sessionId, run.runId, 'finalized');
    }
    return { answer: committedAnswer, effects, finalization };
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
      await this.port.components.state.executionLedger.store.listCalls(run.sessionId, executionRunId),
    );
    const decision = decideRunCommit({
      draft: safeInterruptedAnswer ?? '',
      calls,
      sdk: input.interrupted ? 'interrupted' : 'failed',
      reason: errorMessage,
      ...run.facts.mediaEvidenceFacts(),
    });
    const finalization = createRunFinalization({
      runId: run.runId,
      ...decision,
      calls,
    });
    await this.port.components.state.runCommits.prepare({
      sessionId: run.sessionId,
      runId: run.runId,
      ...(run.options?.executionKey ? { executionKey: run.options.executionKey } : {}),
      answerDigest: finalization.answerDigest,
      outcome: finalization.outcome,
      runtimeActions: [],
      finalization,
    });
    await this.port.components.state.traces.record(run.sessionId, 'run_finalization', finalization);
    this.port.activeRun = undefined;
    await this.port.components.computer?.endRun(run.runId).catch(() => undefined);
    run.releaseOwner();
    this.port.applyManifestActual(this.port.validUsage(input.usage, run.scope.modelBinding));
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
    await this.port.components.state.runCommits.advance(run.sessionId, run.runId, 'session_committed');
    await this.port.hooks.emit({
      type: 'run_error',
      sessionId: run.sessionId,
      error: errorMessage,
      interrupted: decision.outcome === 'interrupted',
    });
    if (!run.options?.retainExecutionLedger) {
      await this.port.components.state.runCommits.advance(run.sessionId, run.runId, 'finalized');
    }
    return finalization;
  }

  evaluate(
    run: ActiveRun,
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
      plans: this.port.components.state.goalsAndPlans.store,
      team: this.port.components.state.team.store,
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
    await this.port.components.state.runCommits.acknowledgeTask(sessionId, executionKey);
    await this.port.components.state.executionLedger.store.clearRun(sessionId, executionKey);
    await this.port.components.state.runCommits.finalizeExecution(sessionId, executionKey);
  }

  async reopenExecutionLedger(sessionId: string, executionKey: string): Promise<void> {
    await this.port.components.state.executionLedger.store.clearReceipt(sessionId, executionKey);
    await this.port.components.state.runCommits.finalizeExecution(sessionId, executionKey);
  }

  async completedExecution(
    sessionId: string,
    executionKey: string,
  ) {
    const stored = await this.port.components.state.executionLedger.store
      .getReceipt<unknown>(sessionId, executionKey);
    if (!stored) return undefined;
    const legacyReceipt = completedExecutionReceiptSchema.parse(stored);
    const journal = await this.port.components.state.runCommits.findByExecutionKey(sessionId, executionKey);
    const receipt = {
      ...legacyReceipt,
      actions: legacyReceipt.actions ?? [],
      finalization: legacyReceipt.finalization
        ?? journal?.finalization
        ?? createRunFinalization({
          runId: legacyReceipt.runId,
          answer: legacyReceipt.answer,
          calls: await this.port.components.state.executionLedger.store.listCalls(sessionId, executionKey),
        }),
    };
    if (journal && journal.answerDigest !== runAnswerDigest(receipt.answer)) {
      throw new Error(`Execution ${executionKey} 的完成回执与提交日志摘要不一致`);
    }
    if (journal?.finalization
      && JSON.stringify(journal.finalization) !== JSON.stringify(receipt.finalization)) {
      throw new Error(`Execution ${executionKey} 的工具事实与提交日志不一致`);
    }
    await this.port.components.state.sessions.open(sessionId).reconcileCompletedRun(
      receipt.answer,
      receipt.runId,
      receipt.finalization,
    );
    if (journal) {
      await this.port.components.state.runCommits.advance(sessionId, receipt.runId, 'session_committed');
    }
    const effects = await this.port.runtimeActions.apply(receipt.actions ?? [], sessionId, executionKey);
    if (journal) await this.port.components.state.runCommits.advance(sessionId, receipt.runId, 'effects_applied');
    return { ...receipt, effects };
  }
}
