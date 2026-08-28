import { createHash } from 'node:crypto';
import { tool, type Tool, type ToolOutputImage, type ToolOutputText } from '@openai/agents';
import { z } from 'zod';
import { ActionFailedSafeError } from '../../core/action-intent.js';
import {
  TOOL_ACTION_INTENT,
  TOOL_LEDGER_ARGUMENTS,
} from '../../core/tool-metadata.js';
import { ComputerManager, type ComputerRunAuthority } from './manager.js';
import { computerActionSchema, type ComputerAction } from './types.js';

type StructuredOutput = ToolOutputText | ToolOutputImage;

function computerActionErrorResult(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  if (error instanceof ActionFailedSafeError
    || (error instanceof Error && error.name === 'ActionFailedSafeError')) {
    return JSON.stringify({
      mimiStatus: 'action_failed_safe',
      retryable: false,
      sideEffectsFrozen: false,
      message,
    });
  }
  return JSON.stringify({
    mimiStatus: 'action_uncertain',
    retryable: false,
    sideEffectsFrozen: true,
    message: `${message}；无法确认 Computer 动作是否越过副作用提交点`,
  });
}

function computerActionOutcome(result: unknown): 'confirmed' | 'failed_safe' | 'uncertain' {
  let value = result;
  if (Array.isArray(value)) {
    const text = value.find((item) => (
      item && typeof item === 'object' && !Array.isArray(item)
      && (item as Record<string, unknown>).type === 'text'
      && typeof (item as Record<string, unknown>).text === 'string'
    )) as Record<string, unknown> | undefined;
    value = text?.text;
  }
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return 'uncertain';
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'uncertain';
  const record = value as Record<string, unknown>;
  if (record.mimiStatus === 'action_failed_safe' || record.ok === false) return 'failed_safe';
  if (record.mimiStatus === 'action_uncertain') return 'uncertain';
  return 'confirmed';
}

const modelOptional = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

const observeToolParameters = z.object({
  app: modelOptional(z.string().min(1).max(500)),
  screenshot: modelOptional(z.boolean()),
}).strict();

const modelComputerActionSchema = z.object({
  type: z.enum([
    'launch_app', 'click', 'double_click', 'type_text', 'set_value', 'keypress', 'scroll', 'drag', 'wait',
  ]),
  bundleId: modelOptional(z.string().min(1).max(500).describe(
    'launch_app 必填；只使用 computer_observe 返回的 apps[].bundleId，不猜应用名',
  )),
  urls: modelOptional(z.array(z.string()).max(20)),
  newInstance: modelOptional(z.boolean()),
  elementIndex: modelOptional(z.number().int().nonnegative()),
  x: modelOptional(z.number().finite()),
  y: modelOptional(z.number().finite()),
  button: modelOptional(z.enum(['left', 'right', 'middle'])),
  axAction: modelOptional(z.enum(['press', 'show_menu', 'pick', 'confirm', 'cancel', 'open'])),
  text: modelOptional(z.string().max(10_000)),
  value: modelOptional(z.union([z.string().max(10_000), z.number().finite(), z.boolean()])),
  keys: modelOptional(z.array(z.string().min(1).max(30)).min(1).max(5)),
  deltaX: modelOptional(z.number().finite()),
  deltaY: modelOptional(z.number().finite()),
  path: modelOptional(z.array(z.object({ x: z.number().finite(), y: z.number().finite() }).strict()).min(2).max(20)),
  milliseconds: modelOptional(z.number().int().min(0).max(30_000)),
}).strict();

const actToolParameters = z.object({
  action: modelComputerActionSchema,
}).strict();

function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== null && item !== undefined)
    .map(([key, item]) => [key, withoutNulls(item)]));
}

interface InvalidModelActionResult {
  ok: false;
  reason: 'missing_launch_target' | 'invalid_action';
  retryable: true;
  message: string;
  next?: 'computer_observe';
}

function parseModelAction(value: unknown):
  | { success: true; action: ComputerAction }
  | { success: false; result: InvalidModelActionResult } {
  const cleaned = withoutNulls(value);
  const modelAction = cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned)
    ? cleaned as Record<string, unknown>
    : {};
  if (modelAction.type === 'launch_app' && typeof modelAction.bundleId !== 'string') {
    return {
      success: false,
      result: {
        ok: false,
        reason: 'missing_launch_target',
        retryable: true,
        next: 'computer_observe',
        message: 'launch_app 需要 computer_observe 返回的 apps[].bundleId；apps 为空时省略 app 重新列出应用',
      },
    };
  }
  const parsed = computerActionSchema.safeParse(modelAction);
  if (parsed.success) return { success: true, action: parsed.data };
  return {
    success: false,
    result: {
      ok: false,
      reason: 'invalid_action',
      retryable: true,
      message: parsed.error.issues[0]?.message ?? 'Computer 动作参数无效',
    },
  };
}

function withoutObservationHandle(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const {
    observationId: _observationId,
    target,
    frontmost: _frontmost,
    ...publicResult
  } = result as Record<string, unknown>;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return publicResult;
  const value = target as Record<string, unknown>;
  return {
    ...publicResult,
    app: {
      id: value.bundleId,
      name: value.appName,
      window: value.title,
    },
  };
}

export function computerLedgerArguments(rawInput: string): string {
  try {
    const value = JSON.parse(rawInput) as Record<string, unknown>;
    const action = value.action as Record<string, unknown> | undefined;
    delete value.observationId;
    delete value.authorizationId;
    if (action?.type === 'type_text' && typeof action.text === 'string') {
      action.textSha256 = createHash('sha256').update(action.text).digest('hex');
      action.textLength = action.text.length;
      delete action.text;
    }
    return JSON.stringify(value);
  } catch {
    return rawInput;
  }
}

export function createComputerTools(
  manager: ComputerManager,
  currentRun: () => ComputerRunAuthority | undefined,
): Tool[] {
  const authority = () => {
    const value = currentRun();
    if (!value) throw new Error('当前没有可绑定的 Computer Run');
    return value;
  };
  const observe = tool({
    name: 'computer_observe',
    description: '读取一个 app 的当前界面。传 app 名称或 bundleId；省略 app 时列出可用应用。默认返回紧凑 AX 状态，只有 AX 不足时再请求 screenshot。不会启动未运行的 app。',
    parameters: observeToolParameters,
    execute: async (input, _context, details): Promise<unknown> => {
      const raw = input as Record<string, unknown>;
      const app = typeof raw.app === 'string' ? raw.app.trim() : '';
      if (!app) return { apps: await manager.listApps(authority(), undefined, details?.signal) };
      const result = await manager.observeApp(
        authority(),
        app,
        raw.screenshot === true,
        details?.signal,
      );
      if (!result || typeof result !== 'object') return result;
      const publicResult = withoutObservationHandle(result) as Record<string, unknown>;
      if (!('screenshot' in publicResult) || !publicResult.screenshot) return publicResult;
      const { screenshot, ...metadata } = publicResult as typeof publicResult & {
        screenshot: { data: string; mediaType: string };
      };
      return [
        { type: 'text', text: JSON.stringify(metadata) } satisfies ToolOutputText,
        { type: 'image', image: { data: screenshot.data, mediaType: screenshot.mediaType }, detail: 'high' } satisfies ToolOutputImage,
      ] satisfies StructuredOutput[];
    },
  });
  const act = tool({
    name: 'computer_act',
    description: '执行一个原子电脑动作。Host 自动绑定最新窗口；打开 URL/文件直接使用 launch_app + urls，不要点击地址栏或拆成按键输入。launch_app 必须传 computer_observe 返回的精确 apps[].bundleId。动作后直接返回 fresh state，使用 state 继续；只有返回 next=computer_observe 时才再观察。',
    parameters: actToolParameters,
    errorFunction: (_context, error) => computerActionErrorResult(error),
    execute: async (input, _context, details) => {
      const parsedAction = parseModelAction((input as Record<string, unknown>).action);
      if (!parsedAction.success) return parsedAction.result;
      const action = parsedAction.action;
      const runAuthority = authority();
      const result = await manager.act(
        runAuthority,
        manager.bindLatestAction(runAuthority, action),
        details?.signal,
      );
      if (result.status === 'background_unsupported') {
        return { ok: false, reason: 'background_unsupported' };
      }
      if (!result.target) {
        return { ok: true, next: 'computer_observe' };
      }
      try {
        const state = await manager.observeTarget(
          runAuthority,
          result.target,
          false,
          details?.signal,
        );
        const publicState = withoutObservationHandle(state) as Record<string, unknown>;
        if (!('screenshot' in publicState) || !publicState.screenshot) {
          return { ok: true, state: publicState };
        }
        const { screenshot, ...metadata } = publicState as typeof publicState & {
          screenshot: { data: string; mediaType: string };
        };
        return [
          { type: 'text', text: JSON.stringify({ ok: true, state: metadata }) } satisfies ToolOutputText,
          { type: 'image', image: { data: screenshot.data, mediaType: screenshot.mediaType }, detail: 'high' } satisfies ToolOutputImage,
        ] satisfies StructuredOutput[];
      } catch (error) {
        return {
          ok: true,
          next: 'computer_observe',
          stateUnavailable: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        };
      }
    },
  }) as Tool & {
    [TOOL_LEDGER_ARGUMENTS]?: (rawInput: string) => string;
    [TOOL_ACTION_INTENT]?: (rawInput: string) => {
      actionFamily: string;
      targetRef: string;
      payload: unknown;
      selectedRoute: string;
      guarded?: {
        exactTarget: boolean;
        lowRisk: boolean;
        reversible: boolean;
        boundedLocal?: boolean;
      };
      targetEvidenceRef?: string;
      effect?: 'read' | 'write' | 'unknown';
      outcome?: (result: unknown) => 'confirmed' | 'failed_safe' | 'uncertain';
    };
  };
  act[TOOL_LEDGER_ARGUMENTS] = computerLedgerArguments;
  act[TOOL_ACTION_INTENT] = (rawInput) => {
    const input = JSON.parse(rawInput) as Record<string, unknown>;
    const parsedAction = parseModelAction(input.action);
    if (!parsedAction.success) {
      return {
        actionFamily: 'computer.invalid',
        targetRef: 'invalid',
        payload: computerLedgerArguments(rawInput),
        selectedRoute: 'computer-manager',
        effect: 'read',
      };
    }
    const runAuthority = authority();
    const parsed = manager.bindLatestAction(
      runAuthority,
      parsedAction.action,
    );
    const action = parsed.action as unknown as Record<string, unknown>;
    const observationId = 'observationId' in parsed ? parsed.observationId : undefined;
    const actionType = typeof action.type === 'string' ? action.type : 'unknown';
    const bundleId = actionType === 'launch_app' && typeof action.bundleId === 'string'
      ? action.bundleId
      : undefined;
    const urls = Array.isArray(action.urls) ? action.urls : [];
    const target = action.target && typeof action.target === 'object'
      ? JSON.stringify(action.target)
      : observationId ?? (bundleId ? `bundle:${bundleId}` : actionType);
    const boundedBackground = 'observationId' in parsed
      && (!('dispatch' in parsed.action) || parsed.action.dispatch === 'background');
    return {
      actionFamily: `computer.${actionType}`,
      targetRef: target,
      payload: computerLedgerArguments(rawInput),
      selectedRoute: 'computer-manager',
      ...(observationId ? { targetEvidenceRef: observationId } : {}),
      ...(boundedBackground ? {
        guarded: {
          exactTarget: true,
          lowRisk: false,
          reversible: false,
          boundedLocal: true,
        },
      } : bundleId && urls.length === 0 ? {
        guarded: {
          exactTarget: true,
          lowRisk: true,
          reversible: true,
        },
      } : {}),
      outcome: computerActionOutcome,
    };
  };
  return [observe, act];
}
