import type { RuntimeEffect } from '../control.js';
import type { ExecutionCallRecord } from '../../core/execution-ledger.js';
import {
  classifyRunOutcome,
  constrainRunAnswer,
  runEvidenceRefs,
  type RunFinalizationRecord,
  type RunOutcome,
} from '../../core/run-finalization.js';

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
  complete(answer: string, usage?: RunCommitUsage): Promise<RuntimeEffect[]>;
  fail(
    error: unknown,
    interrupted: boolean,
    usage?: RunCommitUsage,
    interruptedAnswer?: string,
  ): Promise<RunFinalizationRecord | undefined>;
}

export class RunCommitCoordinator {
  constructor(private readonly port: RunCommitCoordinatorPort) {}

  complete(input: RunCommitInput): Promise<RuntimeEffect[]> {
    return this.port.complete(input.answer, input.usage);
  }

  decide(input: RunCommitDecisionInput): RunCommitDecision {
    return decideRunCommit(input);
  }

  fail(input: RunFailureInput): Promise<RunFinalizationRecord | undefined> {
    return this.port.fail(input.error, input.interrupted, input.usage, input.interruptedAnswer);
  }
}
