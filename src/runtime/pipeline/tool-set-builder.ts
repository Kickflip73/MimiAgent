import { tool, type AgentInputItem, type RunContext, type Tool } from '@openai/agents';
import { z } from 'zod';
import type { AgentPermissionMode, SecurityProfile } from '../../config.js';
import type { AgentMode } from '../instructions.js';
import {
  toolsForMode,
  toolsForRunPolicy,
  toolsForSecurity,
  type RunToolPolicy,
} from '../tool-policy.js';
import {
  createEffectiveCapabilitySnapshot,
  type EffectiveCapabilityItem,
  type EffectiveCapabilitySnapshot,
} from './capability-resolver.js';
import { toolDescriptor } from '../tool-policy.js';

type InvokableTool = Tool & {
  invoke: (
    context: RunContext<unknown>,
    input: string,
    details: unknown,
  ) => Promise<unknown>;
};

function capabilitySource(name: string): 'builtin' | 'mcp' | 'computer' | 'memory' | 'goal' | 'skill' | 'connector' {
  if (name.startsWith('computer_')) return 'computer';
  if (name.startsWith('memory_') || ['remember', 'forget'].includes(name)) return 'memory';
  if (name.includes('goal') || name.includes('plan') || ['prepare_task', 'finish_task'].includes(name)) return 'goal';
  if (name.includes('skill')) return 'skill';
  if (['inspect_mimi_capabilities', 'invoke_capability', 'connector_action', 'send_owner_message']
    .includes(name)) return 'connector';
  if (!toolDescriptor(name)) return 'mcp';
  return 'builtin';
}

export function isPersonalMessageFallbackTool(name: string): boolean {
  return name === 'run_shell'
    || name === 'computer_observe'
    || name === 'computer_act'
    || /(?:^|[_-])(?:mcp|cua|computer|desktop|browser)(?:[_-]|$)/iu.test(name);
}

export function withoutPersonalMessageDesktopFallback(tools: Tool[]): Tool[] {
  return tools.filter((tool) => !isPersonalMessageFallbackTool(tool.name));
}

export function withoutPersonalMessageFallbackHistory(items: AgentInputItem[]): AgentInputItem[] {
  const turns: AgentInputItem[][] = [];
  let current: AgentInputItem[] = [];
  for (const item of items) {
    if ('role' in item && item.role === 'user' && current.length) {
      turns.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length) turns.push(current);
  return turns.flatMap((turn, index) => {
    if (index === turns.length - 1) return turn;
    const usedFallback = turn.some((item) => {
      const value = item as unknown as Record<string, unknown>;
      return (value.type === 'function_call' || value.type === 'function_call_result')
        && typeof value.name === 'string'
        && isPersonalMessageFallbackTool(value.name);
    });
    return usedFallback ? [] : turn;
  });
}

export class ToolSetBuilder {
  progressiveGateway(tools: Tool[]): Tool[] {
    const byName = new Map(tools.map((candidate) => [candidate.name, candidate]));
    const entries = tools.map((candidate) => {
      const value = candidate as unknown as Record<string, unknown>;
      const descriptor = toolDescriptor(candidate.name);
      return {
        name: candidate.name,
        source: capabilitySource(candidate.name),
        effect: descriptor?.sideEffect ? 'side-effect' as const : 'read' as const,
        description: typeof value.description === 'string' ? value.description : '',
        parameters: value.parameters,
      };
    });
    return [
      tool({
        name: 'inspect_runtime_capabilities',
        description: '查询本轮 Host 已授权的完整能力目录；初始隐藏不等于撤权。按 source 或精确 name 查询，精确结果会返回调用 schema。',
        parameters: z.object({
          source: z.enum(['builtin', 'mcp', 'computer', 'memory', 'goal', 'skill', 'connector']).optional(),
          name: z.string().trim().min(1).max(200).optional(),
          query: z.string().trim().min(1).max(100).optional(),
        }).strict(),
        execute: ({ source, name, query }) => {
          if (name && !byName.has(name)) throw new Error(`能力未授权或不存在：${name}`);
          const normalizedQuery = query?.toLowerCase();
          const matches = entries.filter((entry) =>
            (!source || entry.source === source)
            && (!name || entry.name === name)
            && (!normalizedQuery
              || `${entry.name} ${entry.description}`.toLowerCase().includes(normalizedQuery)));
          return {
            authorizedCount: entries.length,
            matchedCount: matches.length,
            capabilities: matches.slice(0, 100).map((entry) => ({
              name: entry.name,
              source: entry.source,
              effect: entry.effect,
              ...(name ? {
                description: entry.description,
                parameters: entry.parameters,
                invokeWith: 'invoke_runtime_capability',
              } : {}),
            })),
            truncated: matches.length > 100,
          };
        },
      }),
      tool({
        name: 'invoke_runtime_capability',
        description: '调用 inspect_runtime_capabilities 精确返回的一项本轮授权能力；实际工具仍执行原 Host Policy、参数 schema 与 ExecutionLedger。',
        parameters: z.object({
          name: z.string().trim().min(1).max(200),
          argumentsJson: z.string().min(1).max(100_000),
        }).strict(),
        execute: async ({ name, argumentsJson }, context, details) => {
          const selected = byName.get(name) as InvokableTool | undefined;
          if (!selected?.invoke) throw new Error(`能力未授权、不可调用或不存在：${name}`);
          return selected.invoke(context as RunContext<unknown>, argumentsJson, details);
        },
      }),
    ];
  }

  modelFacing(
    tools: Tool[],
    policy?: RunToolPolicy,
    additionalNames: readonly string[] = [],
  ): Tool[] {
    const core = new Set([
      'read_file',
      'write_file',
      'edit_file',
      'apply_patch',
      'list_directory',
      'search_files',
      'inspect_changes',
      'run_shell',
      'inspect_mimi_capabilities',
      'invoke_capability',
      'inspect_runtime_capabilities',
      'invoke_runtime_capability',
      'read_context_artifact',
      'list_skills',
      'use_skill',
      'read_skill_resource',
      'memory_search',
      'remember',
      'update_plan',
      'show_plan',
      'delegate_background_task',
      'list_background_tasks',
      'inspect_background_task',
      'runtime_status',
      'switch_model',
      'switch_mode',
      'switch_session',
      'new_session',
      'clear_session',
      'prepare_task',
      'finish_task',
      'finish_mimi_silently',
      ...(policy?.allowedTools ?? []),
      ...additionalNames,
    ]);
    return tools.filter((tool) => core.has(tool.name));
  }

  snapshot(input: {
    runId: string;
    policyRevision: string;
    tools: readonly Tool[];
    skills?: readonly string[];
    observedAt?: string;
    items?: readonly EffectiveCapabilityItem[];
  }): Readonly<EffectiveCapabilitySnapshot> {
    return createEffectiveCapabilitySnapshot({
      runId: input.runId,
      policyRevision: input.policyRevision,
      toolNames: input.tools.map((tool) => tool.name),
      skillNames: input.skills,
      observedAt: input.observedAt,
      items: input.items,
    });
  }

  scoped(
    tools: Tool[],
    permissionMode: AgentPermissionMode,
    securityProfile: SecurityProfile,
    policy: RunToolPolicy | undefined,
    computerEnabled: boolean,
  ): Tool[] {
    return toolsForRunPolicy(
      toolsForSecurity(securityProfile, tools),
      policy,
    ).filter((tool) => computerEnabled
      || (tool.name !== 'computer_observe' && tool.name !== 'computer_act'));
  }

  final(
    mode: AgentMode,
    baseTools: Tool[],
    teamTools: Tool[],
    subAgentTools: Tool[],
    permissionMode: AgentPermissionMode,
    securityProfile: SecurityProfile,
    policy?: RunToolPolicy,
  ): Tool[] {
    const modeTools = toolsForRunPolicy(
      toolsForSecurity(
        securityProfile,
        toolsForMode(mode, baseTools, teamTools),
      ),
      policy,
    );
    const delegated = toolsForRunPolicy(
      toolsForSecurity(securityProfile, subAgentTools),
      policy,
    );
    return [...modeTools, ...delegated];
  }
}
