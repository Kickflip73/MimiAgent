import type { Tool } from '@openai/agents';
import { createHash } from 'node:crypto';
import {
  executionReceiptRef,
  type ExecutionLedger,
} from '../core/execution-ledger.js';
import {
  ACTION_INTENT_SCHEMA_VERSION,
  actionExecutionKey,
  actionPayloadDigest,
  ActionFailedSafeError,
  ActionIntentUncertainError,
  type ActionIntent,
} from '../core/action-intent.js';
import {
  TOOL_ACTION_INTENT,
  TOOL_LEDGER_ARGUMENTS,
  type ToolActionIntentMetadata,
} from '../core/tool-metadata.js';
import { isSideEffectTool } from './tool-policy.js';

export { TOOL_LEDGER_ARGUMENTS } from '../core/tool-metadata.js';

interface RunIdentity {
  sessionId: string;
  runId: string;
  semanticCallIds?: boolean;
  authorizeTool?: (
    toolName: string,
    argumentsJson: string,
  ) => Promise<{ code: string; message: string } | undefined>;
  authorizeSideEffect?: (toolName: string, argumentsJson: string) => Promise<void>;
  sanitizeResult?: <T>(value: T) => T;
  sanitizeError?: (error: unknown) => unknown;
  policyRevision?: string;
  guardedActionContext?: {
    ownerAuthenticated: boolean;
    exactTarget: boolean;
    lowRisk: boolean;
    reversible: boolean;
    boundedLocal?: boolean;
  };
}

type InvokableTool = Tool & {
  name: string;
  invoke: (
    runContext: unknown,
    input: string,
    details?: { toolCall?: { callId?: string } },
  ) => Promise<unknown>;
};

type LedgerAwareTool = Tool & {
  [TOOL_LEDGER_ARGUMENTS]?: (rawInput: string) => string;
  [TOOL_ACTION_INTENT]?: (rawInput: string) => ToolActionIntentMetadata;
};

function isInvokable(tool: Tool): tool is InvokableTool {
  return 'invoke' in tool && typeof tool.invoke === 'function';
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(object[key])}`
  )).join(',')}}`;
}

function semanticArguments(input: string): string {
  try {
    return stableJson(JSON.parse(input) as unknown);
  } catch {
    // The SDK/tool schema remains responsible for rejecting invalid JSON. Keep
    // a deterministic raw identity so the ledger never broadens execution.
    return input;
  }
}

function alreadyExecutedResult(result: unknown): unknown {
  const replay = {
    mimiStatus: 'already_executed',
    message: '相同操作已经成功执行且其后没有新的副作用；本次未重复执行，请使用 previousResult 继续回答。',
    previousResult: result,
  };
  return result && typeof result === 'object' && !Array.isArray(result)
    ? { ...result as Record<string, unknown>, ...replay }
    : replay;
}

function withActionIntentEvidence(receipt: {
  intent: ActionIntent;
  outcome: 'confirmed' | 'failed_safe' | 'uncertain';
  result?: unknown;
}): unknown {
  const evidence = {
    ref: `action-intent:${receipt.intent.executionKey}`,
    intentId: receipt.intent.intentId,
    actionFamily: receipt.intent.actionFamily,
    targetRef: receipt.intent.targetRef,
    route: receipt.intent.selectedRoute,
    outcome: receipt.outcome,
  };
  const result = receipt.result;
  return result && typeof result === 'object' && !Array.isArray(result)
    ? { ...result as Record<string, unknown>, mimiActionIntent: evidence }
    : { result, mimiActionIntent: evidence };
}

function withExecutionEvidence(result: unknown, ref: string): unknown {
  const evidence = { ref, outcome: 'succeeded' as const };
  return result && typeof result === 'object' && !Array.isArray(result)
    ? { ...result as Record<string, unknown>, mimiExecutionReceipt: evidence }
    : { result, mimiExecutionReceipt: evidence };
}

function uncertainActionFenceResult(
  error: ActionIntentUncertainError,
  scope?: Pick<UncertainActionFence, 'actionFamily' | 'targetRef'>,
): Record<string, unknown> {
  return {
    mimiStatus: 'action_uncertain',
    retryable: false,
    sideEffectsFrozen: true,
    sideEffectFenceScope: 'matching_action_family_and_target',
    ...(scope ? {
      frozenActionFamily: scope.actionFamily,
      frozenTargetRef: scope.targetRef,
    } : {}),
    message: `${error.message}。同一 action family 和目标的后续 ActionIntent 已冻结；仍可继续只读检查、执行不相关的恢复动作并向用户报告，不得重放或换路。`,
  };
}

interface UncertainActionFence {
  error: ActionIntentUncertainError;
  actionFamily: string;
  targetRef: string;
}

function matchesUncertainActionFence(
  fence: UncertainActionFence,
  action: ToolActionIntentMetadata,
): boolean {
  return fence.actionFamily === action.actionFamily
    && fence.targetRef === action.targetRef;
}

function failedSafeMessage(result: unknown): string {
  let value = result;
  if (typeof value === 'string') {
    const raw = value;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return raw.slice(0, 2_000);
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const candidate of [record.message, record.error]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.slice(0, 2_000);
    }
  }
  return '动作明确未执行，可修正参数后重试';
}

export function withExecutionLedger(
  tools: Tool[],
  ledger: ExecutionLedger,
  currentRun: () => RunIdentity | undefined,
): Tool[] {
  const semanticOccurrences = new Map<string, number>();
  let previousSemanticKey: string | undefined;
  let uncertainActionFence: UncertainActionFence | undefined;
  return tools.map((tool) => {
    if (!isInvokable(tool)) return tool;
    const sideEffect = isSideEffectTool(tool.name);
    const originalInvoke = tool.invoke.bind(tool);
    return {
      ...tool,
      invoke: async (runContext, input, details) => {
        const run = currentRun();
        const rejection = await run?.authorizeTool?.(tool.name, input);
        if (rejection) {
          return {
            mimiStatus: 'tool_input_rejected',
            retryable: true,
            code: rejection.code,
            message: rejection.message,
          };
        }
        const invokeSanitized = async () => {
          try {
            const result = await originalInvoke(runContext, input, details);
            return run?.sanitizeResult?.(result) ?? result;
          } catch (error) {
            throw run?.sanitizeError?.(error) ?? error;
          }
        };
        const action = (tool as LedgerAwareTool)[TOOL_ACTION_INTENT]?.(input);
        if (!sideEffect || action?.effect === 'read') return invokeSanitized();
        if (action && uncertainActionFence && matchesUncertainActionFence(uncertainActionFence, action)) {
          return uncertainActionFenceResult(uncertainActionFence.error, uncertainActionFence);
        }
        const sdkCallId = details?.toolCall?.callId;
        const ledgerInput = (tool as LedgerAwareTool)[TOOL_LEDGER_ARGUMENTS]?.(input) ?? input;
        const argumentsJson = run?.semanticCallIds ? semanticArguments(ledgerInput) : ledgerInput;
        const semanticKey = `${tool.name}\0${argumentsJson}`;
        const consecutiveDuplicate = run?.semanticCallIds && previousSemanticKey === semanticKey;
        const occurrence = run?.semanticCallIds
          ? consecutiveDuplicate
            ? semanticOccurrences.get(semanticKey) ?? 1
            : (semanticOccurrences.get(semanticKey) ?? 0) + 1
          : undefined;
        if (occurrence !== undefined) {
          semanticOccurrences.set(semanticKey, occurrence);
          previousSemanticKey = semanticKey;
        }
        const callId = run?.semanticCallIds
          ? createHash('sha256').update(`${semanticKey}\0${occurrence}`).digest('hex')
          : sdkCallId;
        const invokeAuthorized = async () => {
          await run?.authorizeSideEffect?.(tool.name, input);
          return invokeSanitized();
        };
        if (!run || !callId) return invokeAuthorized();
        if (action) {
          const payloadDigest = actionPayloadDigest(action.payload);
          const policyRevision = run.policyRevision ?? 'guarded:v1';
          const businessActionRef = action.businessActionRef ?? `${run.runId}:${callId}`;
          const executionKeyValue = actionExecutionKey(
            action.actionFamily,
            action.targetRef,
            payloadDigest,
            policyRevision,
            businessActionRef,
          );
          const intent: ActionIntent = {
            schemaVersion: ACTION_INTENT_SCHEMA_VERSION,
            intentId: `${run.runId}:${callId}`,
            businessActionRef,
            actionFamily: action.actionFamily,
            targetRef: action.targetRef,
            ...(action.targetEvidenceRef ? { targetEvidenceRef: action.targetEvidenceRef } : {}),
            payloadDigest,
            selectedRoute: action.selectedRoute,
            executionKey: executionKeyValue,
            policyRevision,
            status: 'not_started' as const,
          };
          try {
            const receipt = await ledger.executeActionIntent(
              run.sessionId,
              run.runId,
              intent,
              action.guarded
                ? {
                    ownerAuthenticated: run.guardedActionContext?.ownerAuthenticated === true,
                    ...action.guarded,
                    boundedLocal: action.guarded.boundedLocal === true
                      && run.guardedActionContext?.boundedLocal === true,
                  }
                : run.guardedActionContext ?? {
                    ownerAuthenticated: false,
                    exactTarget: false,
                    lowRisk: false,
                    reversible: false,
                  },
              undefined,
              async () => {
                const output = await ledger.executeOnce({
                  sessionId: run.sessionId,
                  runId: run.runId,
                  toolName: tool.name,
                  callId,
                  ...(sdkCallId && sdkCallId !== callId ? { modelCallId: sdkCallId } : {}),
                  argumentsJson,
                }, invokeAuthorized);
                const outcome = action.outcome?.(output) ?? 'confirmed';
                if (outcome === 'failed_safe') {
                  throw new ActionFailedSafeError(failedSafeMessage(output));
                }
                if (outcome === 'uncertain') throw new ActionIntentUncertainError('动作结果不确定');
                return output;
              },
            );
            return withActionIntentEvidence(receipt);
          } catch (error) {
            if (!(error instanceof ActionIntentUncertainError)) throw error;
            uncertainActionFence = {
              error,
              actionFamily: action.actionFamily,
              targetRef: action.targetRef,
            };
            return uncertainActionFenceResult(error, uncertainActionFence);
          }
        }
        const call = {
          sessionId: run.sessionId,
          runId: run.runId,
          toolName: tool.name,
          callId,
          ...(sdkCallId && sdkCallId !== callId ? { modelCallId: sdkCallId } : {}),
          argumentsJson,
        };
        const result = await ledger.executeOnce(call, invokeAuthorized);
        if (consecutiveDuplicate) return alreadyExecutedResult(result);
        return tool.name === 'connector_action' || tool.name === 'connector_capability'
          ? withExecutionEvidence(result, executionReceiptRef(call))
          : result;
      },
    } as Tool;
  });
}
