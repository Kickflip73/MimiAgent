import { createHash } from 'node:crypto';
import type { Tool } from '@openai/agents';
import { z } from 'zod';
import { tool } from '../../tool-factory.js';
import { ActionFailedSafeError } from '../../core/action-intent.js';
import {
  TOOL_ACTION_INTENT,
  TOOL_LEDGER_ARGUMENTS,
  type ToolActionIntentMetadata,
} from '../../core/tool-metadata.js';
import { BrowserRunManager } from './manager.js';

const locatorShape = {
  ref: z.union([z.string().max(2_000), z.number().int().nonnegative()]).optional(),
  role: z.string().max(1_000).optional(),
  name: z.string().max(1_000).optional(),
  label: z.string().max(1_000).optional(),
  text: z.string().max(1_000).optional(),
  testid: z.string().max(1_000).optional(),
  nth: z.number().int().min(0).max(10_000).optional(),
  page: z.string().max(500).optional(),
};

const observeParameters = z.object({
  operation: z.enum(['snapshot', 'read_page', 'read_element', 'find', 'extract', 'list_tabs']),
  source: z.literal('dom').optional(),
  format: z.enum(['html', 'json']).optional(),
  selector: z.string().max(2_000).optional(),
  field: z.enum(['text', 'attributes']).optional(),
  maxChars: z.number().int().min(1).max(16_000).optional(),
  chunkSize: z.number().int().min(1_000).max(16_000).optional(),
  start: z.number().int().min(0).max(10_000_000).optional(),
  ...locatorShape,
}).strict();

const actParameters = z.object({
  operation: z.enum([
    'navigate', 'back', 'click', 'type', 'fill', 'select', 'check', 'uncheck',
    'hover', 'focus', 'double_click', 'keys', 'scroll', 'new_tab', 'select_tab', 'close_tab',
  ]),
  url: z.string().min(1).max(8_000).optional(),
  value: z.string().max(20_000).optional(),
  key: z.string().max(100).optional(),
  direction: z.enum(['up', 'down']).optional(),
  amount: z.number().int().min(1).max(100_000).optional(),
  ...locatorShape,
}).strict();

const waitParameters = z.object({
  kind: z.enum(['selector', 'text', 'xhr', 'download']),
  value: z.string().min(1).max(2_000),
  timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
  page: z.string().max(500).optional(),
}).strict();

const assertParameters = z.object({
  kind: z.enum(['selector', 'text']),
  value: z.string().min(1).max(2_000),
  timeoutMs: z.number().int().min(100).max(30_000).default(5_000),
  page: z.string().max(500).optional(),
}).strict();

type BrowserAwareTool = Tool & {
  [TOOL_LEDGER_ARGUMENTS]?: (rawInput: string) => string;
  [TOOL_ACTION_INTENT]?: (rawInput: string) => ToolActionIntentMetadata;
};

function browserActionErrorResult(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  if (error instanceof ActionFailedSafeError
    || (error instanceof Error && error.name === 'ActionFailedSafeError')) {
    return JSON.stringify({
      mimiStatus: 'action_failed_safe',
      retryable: true,
      sideEffectsFrozen: false,
      message,
    });
  }
  return JSON.stringify({
    mimiStatus: 'action_uncertain',
    retryable: false,
    sideEffectsFrozen: true,
    message: `${message}；无法确认 Browser 动作是否越过副作用提交点`,
  });
}

function compactPayload(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null && value !== undefined));
}

function normalizeLocatorPayload(payload: Record<string, unknown>): void {
  const explicit = payload.selector !== undefined
    ? 'selector'
    : payload.ref !== undefined
      ? 'ref'
      : undefined;
  if (!explicit) return;
  for (const key of ['selector', 'ref', 'role', 'name', 'label', 'text', 'testid']) {
    if (key !== explicit) delete payload[key];
  }
}

function normalizeFormLabel(
  operation: z.infer<typeof actParameters>['operation'],
  payload: Record<string, unknown>,
): void {
  if (typeof payload.label !== 'string'
    || payload.selector !== undefined
    || payload.ref !== undefined
    || payload.role !== undefined
    || payload.name !== undefined
    || payload.text !== undefined
    || payload.testid !== undefined) return;
  const role = operation === 'select'
    ? 'combobox'
    : operation === 'check' || operation === 'uncheck'
      ? 'checkbox'
      : operation === 'fill' || operation === 'type'
        ? 'textbox'
        : undefined;
  if (!role) return;
  payload.role = role;
  payload.name = payload.label;
  delete payload.label;
}

function capabilityForObserve(operation: z.infer<typeof observeParameters>['operation']): string {
  if (operation === 'snapshot') return 'browser.page.snapshot';
  if (operation === 'find' || operation === 'read_element') return 'browser.element.read';
  if (operation === 'list_tabs') return 'browser.tabs.read';
  return 'browser.page.read';
}

function capabilityForAct(operation: z.infer<typeof actParameters>['operation']): string {
  if (operation === 'navigate' || operation === 'back') return 'browser.navigation.write';
  if (['new_tab', 'select_tab', 'close_tab'].includes(operation)) return 'browser.tabs.write';
  if (operation === 'keys') return 'browser.keyboard.write';
  if (operation === 'scroll') return 'browser.page.write';
  return 'browser.element.write';
}

export function browserLedgerArguments(rawInput: string): string {
  try {
    const value = JSON.parse(rawInput) as Record<string, unknown>;
    if ((value.operation === 'type' || value.operation === 'fill') && typeof value.value === 'string') {
      value.valueSha256 = createHash('sha256').update(value.value).digest('hex');
      value.valueLength = value.value.length;
      delete value.value;
    }
    return JSON.stringify(value);
  } catch {
    return rawInput;
  }
}

function sideEffectMetadata(
  tool: BrowserAwareTool,
  manager: BrowserRunManager,
  family: (input: Record<string, unknown>) => string,
  guarded: ToolActionIntentMetadata['guarded'],
): void {
  tool[TOOL_LEDGER_ARGUMENTS] = browserLedgerArguments;
  tool[TOOL_ACTION_INTENT] = (rawInput) => {
    const input = JSON.parse(browserLedgerArguments(rawInput)) as Record<string, unknown>;
    return {
      actionFamily: family(input),
      targetRef: manager.target,
      payload: input,
      selectedRoute: 'browser-connector',
      effect: 'write',
      guarded,
      outcome: (result) => {
        const serialized = JSON.stringify(result);
        if (/"outcome":"accepted"|"status":"uncertain"|action_uncertain/.test(serialized)) return 'uncertain';
        if (/failed_safe|capability_unavailable/.test(serialized)) return 'failed_safe';
        return 'confirmed';
      },
    };
  };
}

export function createBrowserTools(manager: BrowserRunManager): Tool[] {
  const open = tool({
    name: 'browser_open',
    description: '在后台打开一个由 Host 管理的浏览器会话。后续直接 browser_observe/browser_act；不要查询 Connector 目录或传 sessionRef。',
    parameters: z.object({ url: z.string().min(1).max(8_000) }).strict(),
    errorFunction: (_context, error) => browserActionErrorResult(error),
    execute: (input, _context, details) => manager.open(input, details?.signal),
  }) as BrowserAwareTool;
  sideEffectMetadata(open, manager, () => 'browser.open', {
    exactTarget: true, lowRisk: true, reversible: true, boundedLocal: true,
  });

  const observe = tool({
    name: 'browser_observe',
    description: '读取当前浏览器会话的 DOM、正文、元素或标签页。标准 snapshot 固定使用 DOM；稳定 ID/标签优先 selector，语义定位同时给 role+name 或 label，不要只给宽泛 role，也不要与 selector 混用。返回结果有 16 KiB 预算；大页面用 extract 的 start 分页。',
    parameters: observeParameters,
    execute: (input, _context, details) => {
      const payload = compactPayload(input);
      delete payload.operation;
      normalizeLocatorPayload(payload);
      if (input.operation === 'snapshot' && payload.source === undefined) payload.source = 'dom';
      if (input.operation === 'read_page' && payload.maxChars === undefined) payload.maxChars = 12_000;
      if (input.operation === 'extract' && payload.chunkSize === undefined) payload.chunkSize = 12_000;
      return manager.observe(input.operation, capabilityForObserve(input.operation), payload, details?.signal);
    },
  });

  const act = tool({
    name: 'browser_act',
    description: '在 Host 管理的浏览器会话中执行结构化动作。verified=true 的动作回执已验证底层状态，不要再读取 attributes；完成一组连贯表单动作后，用一次 browser_assert 或 browser_observe 验证业务结果。不重复不确定动作。',
    parameters: actParameters,
    errorFunction: (_context, error) => browserActionErrorResult(error),
    execute: (input, _context, details) => {
      const payload = compactPayload(input);
      delete payload.operation;
      normalizeFormLabel(input.operation, payload);
      normalizeLocatorPayload(payload);
      return manager.act(input.operation, capabilityForAct(input.operation), payload, details?.signal);
    },
  }) as BrowserAwareTool;
  sideEffectMetadata(act, manager, (input) => `browser.${String(input.operation ?? 'act')}`, {
    exactTarget: true, lowRisk: false, reversible: false, boundedLocal: true,
  });

  const wait = tool({
    name: 'browser_wait',
    description: '有界等待页面 selector、text、XHR 或下载事件；成功后返回新鲜证据。',
    parameters: waitParameters,
    execute: (input, _context, details) => manager.wait(input, details?.signal),
  });

  const assert = tool({
    name: 'browser_assert',
    description: '有界断言 selector 或文本已出现；只有底层等待成功才返回 verified=true。',
    parameters: assertParameters,
    execute: (input, _context, details) => manager.assert(input, details?.signal),
  });

  const close = tool({
    name: 'browser_close',
    description: '显式关闭本轮 Host-owned 浏览器会话。Run 结束时 Host 也会兜底清理。',
    parameters: z.object({}).strict(),
    errorFunction: (_context, error) => browserActionErrorResult(error),
    execute: (_input, _context, details) => manager.close(details?.signal),
  }) as BrowserAwareTool;
  sideEffectMetadata(close, manager, () => 'browser.close', {
    exactTarget: true, lowRisk: true, reversible: false, boundedLocal: true,
  });

  return [open, observe, act, wait, assert, close];
}
