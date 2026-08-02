import type { Tool } from '@openai/agents';
import type { ExecutionCallRecord } from '../../core/execution-ledger.js';

type InvokableTool = Tool & {
  name: string;
  invoke: (
    context: unknown,
    input: string,
    details?: { toolCall?: { callId?: string } },
  ) => Promise<unknown>;
};

interface ObservedCall {
  toolName: string;
  callId: string;
  argumentsJson: string;
  status: 'succeeded' | 'failed';
  output?: unknown;
  error?: string;
}

function invokable(candidate: Tool): candidate is InvokableTool {
  return 'invoke' in candidate && typeof candidate.invoke === 'function';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function semanticFailure(value: unknown): string | undefined {
  const output = record(value);
  if (!output) return undefined;
  const failed = output.mimiStatus === 'tool_input_rejected'
    || output.mimiStatus === 'action_uncertain'
    || output.outcome === 'failed'
    || output.outcome === 'uncertain'
    || output.status === 'failed'
    || output.status === 'uncertain';
  if (!failed) return undefined;
  const message = [output.message, output.error, output.code]
    .find((candidate) => typeof candidate === 'string' && candidate.trim());
  return typeof message === 'string' ? message.slice(0, 2_000) : '工具返回结构化失败';
}

/** Captures every model-visible tool result without turning reads into replay-protected effects. */
export class RunFactCollector {
  private readonly observed: ObservedCall[] = [];
  private sequence = 0;

  wrap(tools: readonly Tool[]): Tool[] {
    return tools.map((candidate) => {
      if (!invokable(candidate)) return candidate;
      const invoke = candidate.invoke.bind(candidate);
      return {
        ...candidate,
        invoke: async (context, input, details) => {
          const callId = details?.toolCall?.callId ?? `observed:${++this.sequence}`;
          try {
            const output = await invoke(context, input, details);
            const error = semanticFailure(output);
            this.observed.push({
              toolName: candidate.name,
              callId,
              argumentsJson: input,
              status: error ? 'failed' : 'succeeded',
              output,
              ...(error ? { error } : {}),
            });
            return output;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.observed.push({
              toolName: candidate.name,
              callId,
              argumentsJson: input,
              status: 'failed',
              error: message.slice(0, 2_000),
            });
            throw error;
          }
        },
      } as Tool;
    });
  }

  calls(sessionId: string, runId: string): ExecutionCallRecord[] {
    return this.observed.map((call) => ({ sessionId, runId, ...call }));
  }
}

export function mergeRunCalls(
  observed: readonly ExecutionCallRecord[],
  ledger: readonly ExecutionCallRecord[],
): ExecutionCallRecord[] {
  const remaining = [...observed];
  const merged = ledger.map((durable) => {
    const match = remaining.findIndex((candidate) => (
      candidate.callId === durable.callId
      || candidate.callId === durable.modelCallId
      || durable.modelCallIds?.includes(candidate.callId)
    ));
    if (match < 0) return durable;
    const [modelFact] = remaining.splice(match, 1);
    return {
      ...durable,
      ...(modelFact?.output !== undefined ? { output: modelFact.output } : {}),
      ...(durable.error === undefined && modelFact?.error ? { error: modelFact.error } : {}),
    };
  });
  return [...merged, ...remaining];
}
