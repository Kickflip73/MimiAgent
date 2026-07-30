import { createHash } from 'node:crypto';
import { tool, type Tool, type ToolOutputImage, type ToolOutputText } from '@openai/agents';
import { z } from 'zod';
import {
  TOOL_ACTION_INTENT,
  TOOL_LEDGER_ARGUMENTS,
} from '../../core/tool-metadata.js';
import { ComputerManager, type ComputerRunAuthority } from './manager.js';
import { computerActionSchema, computerObserveInputSchema } from './types.js';

type StructuredOutput = ToolOutputText | ToolOutputImage;

const observeToolParameters = z.object({
  scope: z.enum(['targets', 'window', 'region', 'desktop', 'driver', 'session']),
  query: z.string().optional(),
  limit: z.number().optional(),
  target: z.object({ bundleId: z.string().optional(), pid: z.number().optional(), windowId: z.number().optional() }).optional(),
  includeScreenshot: z.boolean().optional(),
  maxElements: z.number().optional(),
  maxDepth: z.number().optional(),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
  include: z.array(z.enum(['health', 'permissions', 'config', 'recording'])).optional(),
  promptForPermissions: z.boolean().optional(),
});

const actToolParameters = z.object({
  action: computerActionSchema,
});

function nonStrictToolSchema(schema: z.ZodType) {
  const converted = z.toJSONSchema(schema) as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  return {
    ...converted,
    type: 'object' as const,
    properties: converted.properties ?? {},
    required: converted.required ?? [],
    additionalProperties: true as const,
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
    description: '只读发现本机应用/窗口、观察目标窗口元素或按需获取局部图像。模型不支持图像输入时使用 targets 或 includeScreenshot=false 的语义观察。',
    parameters: nonStrictToolSchema(observeToolParameters),
    // The public schema intentionally contains optional fields. Keep SDK strict
    // conversion from rejecting otherwise valid schemas across patch releases;
    // the canonical discriminated schema is still enforced before execution.
    strict: false,
    execute: async (input, _context, details): Promise<unknown> => {
      const raw = input as Record<string, unknown>;
      const parsed = raw.scope === 'region'
        ? manager.bindLatestRegion(
            authority(),
            z.object({
              x: z.number(),
              y: z.number(),
              width: z.number(),
              height: z.number(),
            }).parse(raw.rect),
          )
        : computerObserveInputSchema.parse(input);
      const result = await manager.observe(authority(), parsed, details?.signal);
      if (!result || typeof result !== 'object') return result;
      const { observationId: _observationId, ...publicResult } = result as typeof result & {
        observationId?: string;
      };
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
    description: '执行一个原子电脑动作。UI 动作自动绑定本轮最新的有效窗口观察；launch_app 只需精确 bundleId，不依赖截图或既有观察。',
    parameters: nonStrictToolSchema(actToolParameters),
    strict: false,
    execute: (input, _context, details) => {
      const action = computerActionSchema.parse((input as Record<string, unknown>).action);
      return manager.act(authority(), manager.bindLatestAction(authority(), action), details?.signal);
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
      outcome: (result: unknown) => 'confirmed' | 'failed_safe' | 'uncertain';
    };
  };
  act[TOOL_LEDGER_ARGUMENTS] = computerLedgerArguments;
  act[TOOL_ACTION_INTENT] = (rawInput) => {
    const input = JSON.parse(rawInput) as Record<string, unknown>;
    const runAuthority = authority();
    const parsed = manager.bindLatestAction(
      runAuthority,
      computerActionSchema.parse(input.action),
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
      outcome: (result) => {
        if (!result || typeof result !== 'object') return 'confirmed';
        const status = (result as Record<string, unknown>).status;
        if (status === 'uncertain') return 'uncertain';
        if (status === 'background_unsupported') return 'failed_safe';
        return 'confirmed';
      },
    };
  };
  return [observe, act];
}
