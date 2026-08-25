import { createHash } from 'node:crypto';
import type { AgentInputItem } from '@openai/agents';
import { TerminalRunInterruptedError } from './run-outcome.js';

const MAX_CYCLE_PERIOD = 8;
const REQUIRED_REPETITIONS = 3;
const MAX_COMPLETED_CALLS = MAX_CYCLE_PERIOD * REQUIRED_REPETITIONS;

interface PendingToolCall {
  name: string;
  argumentsDigest: string;
}

export interface RepeatedToolCycle {
  period: number;
  repetitions: number;
  toolNames: string[];
}

export class RunNoProgressCycleError extends TerminalRunInterruptedError {
  readonly name = 'RunNoProgressCycleError';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(object[key])}`
  )).join(',')}}`;
}

function canonicalArguments(value: unknown): string {
  if (typeof value !== 'string') return stableJson(value);
  try {
    return stableJson(JSON.parse(value));
  } catch {
    return value;
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function currentUserTurn(input: readonly AgentInputItem[]): readonly AgentInputItem[] {
  let start = 0;
  for (let index = 0; index < input.length; index += 1) {
    if (record(input[index])?.role === 'user') start = index;
  }
  return input.slice(start);
}

/**
 * Detects an objective no-progress cycle in the current user turn. A cycle is
 * evidence-based: the same tool names, semantic arguments, and observed results
 * must repeat as an identical suffix three times. This does not impose a total
 * turn or tool-call limit and changing external state immediately breaks it.
 */
export function detectRepeatedToolCycle(
  input: readonly AgentInputItem[],
): RepeatedToolCycle | undefined {
  const pending = new Map<string, PendingToolCall>();
  const completed: Array<{ signature: string; name: string }> = [];
  for (const item of currentUserTurn(input)) {
    const value = record(item);
    if (!value) continue;
    if (value.type === 'function_call') {
      const callId = String(value.callId ?? value.call_id ?? '');
      const name = typeof value.name === 'string' ? value.name : 'unknown';
      if (callId) {
        pending.set(callId, {
          name,
          argumentsDigest: digest(canonicalArguments(value.arguments ?? null)),
        });
      }
      continue;
    }
    if (value.type !== 'function_call_result') continue;
    const callId = String(value.callId ?? value.call_id ?? '');
    const call = pending.get(callId);
    if (!call) continue;
    pending.delete(callId);
    completed.push({
      name: call.name,
      signature: digest(`${call.name}\u0000${call.argumentsDigest}\u0000${stableJson(value.output ?? null)}`),
    });
    if (completed.length > MAX_COMPLETED_CALLS) completed.shift();
  }

  for (let period = 1; period <= Math.min(MAX_CYCLE_PERIOD, Math.floor(completed.length / REQUIRED_REPETITIONS)); period += 1) {
    const tail = completed.slice(-period);
    const repeated = Array.from({ length: REQUIRED_REPETITIONS - 1 }, (_, index) => (
      completed.slice(-period * (index + 2), -period * (index + 1))
    ));
    if (repeated.every((block) => tail.every((entry, index) => (
      entry.signature === block[index]?.signature
    )))) {
      return {
        period,
        repetitions: REQUIRED_REPETITIONS,
        toolNames: tail.map((entry) => entry.name),
      };
    }
  }
  return undefined;
}

export function assertNoRepeatedToolCycle(input: readonly AgentInputItem[]): void {
  const repeatedCycle = detectRepeatedToolCycle(input);
  if (!repeatedCycle) return;
  const tools = [...new Set(repeatedCycle.toolNames)].join(' → ');
  throw new RunNoProgressCycleError(
    `检测到工具调用在相同参数和相同结果间重复循环（${tools}，周期 ${repeatedCycle.period}，已重复 ${repeatedCycle.repetitions} 次）；Run 已停止，避免继续空转`,
  );
}
