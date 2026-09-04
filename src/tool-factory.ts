import { tool as sdkTool } from '@openai/agents';

const CAPTURED_TOOL_ERROR = Symbol('mimi.captured-tool-error');

export interface CapturedToolError {
  readonly [CAPTURED_TOOL_ERROR]: true;
  readonly error: unknown;
  readonly mimiStatus: 'tool_failed';
  readonly retryable: false;
  readonly code: 'tool_execution_failed';
  readonly message: string;
}

function captureToolError(_context: unknown, error: unknown): CapturedToolError {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  const result = {
    [CAPTURED_TOOL_ERROR]: true,
    mimiStatus: 'tool_failed',
    retryable: false,
    code: 'tool_execution_failed',
    message,
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

/**
 * Project-wide SDK Tool factory. Errors stay machine-readable until the Mimi
 * execution boundary records their real outcome; explicit handlers and null
 * keep their SDK semantics.
 */
export const tool = ((options: unknown) => {
  const value = options as Record<string, unknown>;
  return sdkTool({
    ...value,
    errorFunction: value.errorFunction === undefined ? captureToolError : value.errorFunction,
  } as never);
}) as typeof sdkTool;
