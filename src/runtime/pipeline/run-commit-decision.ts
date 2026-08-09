import type { ExecutionCallRecord } from '../../core/execution-ledger.js';
import {
  classifyRunOutcome,
  constrainRunAnswer,
  runEvidenceRefs,
  type RunFinalizationRecord,
  type RunMediaAnchor,
  type RunOutcome,
} from '../../core/run-finalization.js';

export interface RunCommitDecisionInput {
  draft: string;
  calls: readonly ExecutionCallRecord[];
  sdk?: 'completed' | 'interrupted' | 'failed';
  completionDecision?: RunFinalizationRecord['completionDecision'];
  reason?: string;
  nextAction?: string;
  evidenceRefs?: readonly string[];
  mediaAnchors?: readonly RunMediaAnchor[];
  mediaAnchorsTruncated?: true;
}

function outputRecord(call: ExecutionCallRecord | undefined): Record<string, unknown> | undefined {
  if (!call) return undefined;
  return call.output !== null && typeof call.output === 'object' && !Array.isArray(call.output)
    ? call.output as Record<string, unknown>
    : undefined;
}

const OUTCOME_DEFAULTS: Record<Exclude<RunOutcome, 'completed' | 'blocked'>, {
  reason: string;
  nextAction: string;
}> = {
  uncertain: { reason: '至少一个已派发动作没有可确认的业务结果，Host 已禁止自动重放', nextAction: '先读取同一业务对象核对结果；不得重放或换路' },
  interrupted: { reason: 'SDK Run 被取消、抢占或在正常结束前中断', nextAction: '从最后持久检查点继续，不重复已确认副作用' },
  failed: { reason: '结构化执行事实只包含未解决的确定性失败', nextAction: '修正结构化 validation/policy/state/unsupported 失败后重新发起' },
  partial: { reason: '已形成有价值进展，但仍有失败、未验证交互或未满足的验收条件', nextAction: '继续未完成部分并为业务结果补充结构化回读或回执' },
};

function outcomeDefaults(
  outcome: RunOutcome,
  calls: readonly ExecutionCallRecord[],
): Partial<{ reason: string; nextAction: string }> {
  if (outcome === 'completed') return {};
  if (outcome !== 'blocked') return OUTCOME_DEFAULTS[outcome];
  const blocker = outputRecord(calls.find((call) => call.toolName === 'request_background_task_input'));
  return {
    reason: typeof blocker?.reason === 'string' && blocker.reason.trim()
      ? blocker.reason : '缺少继续执行所需的 owner 输入或外部状态',
    nextAction: typeof blocker?.question === 'string' && blocker.question.trim()
      ? blocker.question : '补充缺失输入后从当前检查点继续',
  };
}

export function decideRunCommit(input: RunCommitDecisionInput) {
  const outcome = classifyRunOutcome({
    sdk: input.sdk ?? 'completed',
    calls: input.calls,
    completionDecision: input.completionDecision,
  });
  const defaults = outcomeDefaults(outcome, input.calls);
  const reason = input.reason ?? defaults.reason;
  const nextAction = input.nextAction ?? defaults.nextAction;
  const evidenceRefs = [...new Set([
    ...(input.evidenceRefs ?? []),
    ...runEvidenceRefs(input.calls),
  ])].slice(0, 100).sort();
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
    mediaAnchors: input.mediaAnchors ?? [],
    ...(input.mediaAnchorsTruncated ? { mediaAnchorsTruncated: true as const } : {}),
  };
}
