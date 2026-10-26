import { ModelBehaviorError, tool as sdkTool, type Tool } from '@openai/agents';
import { z } from 'zod';

const CAPTURED_TOOL_ERROR = Symbol('mimi.captured-tool-error');

export interface CapturedToolError {
  readonly [CAPTURED_TOOL_ERROR]: true;
  readonly error: unknown;
  readonly mimiStatus: 'tool_failed';
  readonly retryable: false;
  readonly code: 'tool_execution_failed' | 'tool_input_invalid';
  readonly disposition?: { phase: 'pre_dispatch'; kind: 'validation'; dispatchStarted: false; toolName: string };
  readonly issues?: readonly Record<string, unknown>[];
  readonly message: string;
}

function captureToolError(error: unknown, toolName: string): CapturedToolError {
  const validation = error instanceof ModelBehaviorError && error.constructor.name === 'InvalidToolInputError' && 'toolInvocation' in error;
  const original = validation && 'originalError' in error ? error.originalError : undefined;
  const issues = original instanceof z.ZodError ? original.issues.slice(0, 10).map(issue => {
    const value = issue as unknown as Record<string, unknown>;
    const result: Record<string, unknown> = { path: issue.path.map(String).join('.').slice(0, 200), code: issue.code };
    // Do not echo received input or custom error messages (which may contain secrets).
    for (const key of ['minimum', 'maximum', 'inclusive', 'expected', 'format', 'origin']) {
      if (['string', 'number', 'boolean'].includes(typeof value[key])) result[key] = value[key];
    }
    return result;
  }) : validation ? [{ path: '', code: 'invalid_json', expected: 'JSON object matching the tool schema' }] : undefined;
  const message = validation ? '工具参数校验失败，尚未执行。请按 issues 修正参数后重试。' : (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  const result = {
    [CAPTURED_TOOL_ERROR]: true,
    mimiStatus: 'tool_failed',
    retryable: false,
    code: validation ? 'tool_input_invalid' : 'tool_execution_failed',
    message,
    ...(validation ? { issues, disposition: { phase: 'pre_dispatch', kind: 'validation', dispatchStarted: false, toolName } } : {}),
  } as CapturedToolError;
  Object.defineProperties(result, {
    error: { value: error, enumerable: false },
    toString: { value: () => message, enumerable: false },
  });
  return result;
}

export function isCapturedToolError(value: unknown): value is CapturedToolError {
  return value !== null
    && typeof value === 'object'
    && (value as Partial<CapturedToolError>)[CAPTURED_TOOL_ERROR] === true;
}

/** The SDK Run signal is not forwarded to Function Tool invocation details.
 * Bind each Run's tools without mutating tools reused by other Runs. Preserve
 * invocation-specific cancellation/timeouts as well as the owner's stop signal.
 */
export function withToolRunSignal(tools: readonly Tool[], signal?: AbortSignal): Tool[] {
  return tools.map(candidate => {
    if (!signal || candidate.type !== 'function') return candidate;
    return {
      ...candidate,
      invoke: (context, input, details) => {
        const invocationSignal = details?.signal && details.signal !== signal
          ? AbortSignal.any([signal, details.signal]) : signal;
        invocationSignal.throwIfAborted();
        return candidate.invoke(context, input, { ...details, signal: invocationSignal });
      },
    };
  });
}

/**
 * Project-wide SDK Tool factory. Errors stay machine-readable until the Mimi
 * execution boundary records their real outcome; explicit handlers and null
 * keep their SDK semantics.
 */
function exposeConstraints(target: Record<string, any>, original: Record<string, any>): void {
  const constraints = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems'];
  const hints = constraints.filter(key => original[key] !== undefined && target[key] !== original[key] && ![Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER].includes(original[key])).map(key => `${key}=${JSON.stringify(original[key])}`);
  if (original.type === 'integer' && target.type !== 'integer') hints.push('integer');
  if (hints.length) target.description = [target.description, `Constraints: ${hints.join(', ')}`].filter(Boolean).join(' ');
  for (const [key, value] of Object.entries(original.properties ?? {})) {
    if (target.properties?.[key]) exposeConstraints(target.properties[key], value as Record<string, any>);
  }
  if (target.items && original.items) exposeConstraints(target.items, original.items);
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    for (const [index, branch] of (original[keyword] ?? []).entries()) exposeConstraints(target[keyword]?.[index] ?? target, branch);
  }
}

export const tool = ((options: unknown) => {
  const value = options as Record<string, unknown>;
  const result = sdkTool({
    ...value,
    errorFunction: value.errorFunction === undefined ? (_context: unknown, error: unknown) => captureToolError(error, String(value.name)) : value.errorFunction,
  } as never);
  if (value.parameters instanceof z.ZodType) {
    try {
      exposeConstraints(result.parameters as Record<string, any>, z.toJSONSchema(value.parameters, { io: 'input', unrepresentable: 'any' }));
    } catch { /* Unsupported schemas retain the SDK representation and runtime validation. */ }
  }
  return result;
}) as typeof sdkTool;
