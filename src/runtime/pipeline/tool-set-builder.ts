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
  type CapabilitySource,
  type EffectiveCapabilityItem,
  type EffectiveCapabilitySnapshot,
  type ProgressiveCapabilityGroup,
} from './capability-resolver.js';
import { toolDescriptor } from '../tool-policy.js';

type InvokableTool = Tool & {
  invoke: (
    context: RunContext<unknown>,
    input: string,
    details: unknown,
  ) => Promise<unknown>;
};

const MAX_INDEXED_NAMES_PER_SOURCE = 12;

function connectorActionKey(capability: string, action: string): string {
  return `${capability}\u0000${action}`;
}

function connectorActionKeys(catalog: unknown): string[] {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return [];
  const connectors = (catalog as Record<string, unknown>).connectors;
  if (!Array.isArray(connectors)) return [];
  const keys: string[] = [];
  for (const connector of connectors) {
    if (!connector || typeof connector !== 'object' || Array.isArray(connector)) continue;
    const actions = (connector as Record<string, unknown>).actions;
    if (!Array.isArray(actions)) continue;
    for (const action of actions) {
      if (!action || typeof action !== 'object' || Array.isArray(action)) continue;
      const value = action as Record<string, unknown>;
      if (typeof value.capability !== 'string' || typeof value.name !== 'string') continue;
      keys.push(connectorActionKey(value.capability, value.name));
    }
  }
  return keys;
}

function requestedConnectorAction(argumentsJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  if (typeof value.capability !== 'string' || typeof value.action !== 'string') return undefined;
  return connectorActionKey(value.capability, value.action);
}

function capabilitySource(name: string): CapabilitySource {
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
  hiddenCapabilityGroups(
    authorizedTools: readonly Tool[],
    modelTools: readonly Tool[],
  ): ProgressiveCapabilityGroup[] {
    const visible = new Set(modelTools.map((candidate) => candidate.name));
    const grouped = new Map<CapabilitySource, string[]>();
    for (const candidate of authorizedTools) {
      if (visible.has(candidate.name)) continue;
      const source = capabilitySource(candidate.name);
      const names = grouped.get(source) ?? [];
      names.push(candidate.name);
      grouped.set(source, names);
    }
    return [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([source, values]) => {
        const names = [...new Set(values)].sort();
        return {
          source,
          count: names.length,
          names: names.slice(0, MAX_INDEXED_NAMES_PER_SOURCE),
          truncated: names.length > MAX_INDEXED_NAMES_PER_SOURCE,
        };
      });
  }

  progressiveGateway(tools: Tool[]): Tool[] {
    const byName = new Map(tools.map((candidate) => [candidate.name, candidate]));
    const discoveredNames = new Set<string>();
    const discoveredConnectorActions = new Set<string>();
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
    const connectorInspector = byName.get('inspect_mimi_capabilities') as InvokableTool | undefined;
    const connectorInvokerEntry = entries.find((entry) => entry.name === 'invoke_capability');
    return [
      tool({
        name: 'inspect_runtime_capabilities',
        description: '查询本轮 Host 已授权的完整能力目录；初始隐藏不等于撤权。按 source 或精确 name 查询，精确结果会返回调用 schema。',
        parameters: z.object({
          source: z.enum(['builtin', 'mcp', 'computer', 'memory', 'goal', 'skill', 'connector']).optional(),
          name: z.string().trim().min(1).max(200).optional(),
          query: z.string().trim().min(1).max(100).optional(),
        }).strict(),
        execute: async ({ source, name, query }, context, details) => {
          if (name && !byName.has(name)) throw new Error(`能力未授权或不存在：${name}`);
          const normalizedQuery = query?.toLowerCase();
          const directMatches = entries.filter((entry) =>
            (!source || entry.source === source)
            && (!name || entry.name === name)
            && (!normalizedQuery
              || `${entry.name} ${entry.description}`.toLowerCase().includes(normalizedQuery)));
          const connectorCatalog = query
            && !name
            && (!source || source === 'connector')
            && connectorInspector?.invoke
            && connectorInvokerEntry
            ? await connectorInspector.invoke(
                context as RunContext<unknown>,
                JSON.stringify({ query }),
                details,
              )
            : undefined;
          const connectorMatched = connectorCatalog !== undefined
            && connectorCatalog !== null
            && typeof connectorCatalog === 'object'
            && !Array.isArray(connectorCatalog)
            && (connectorCatalog as Record<string, unknown>).filterMatched === true
            && Number((connectorCatalog as Record<string, unknown>).actions) > 0;
          const matches = connectorMatched
            && connectorInvokerEntry
            && !directMatches.some((entry) => entry.name === connectorInvokerEntry.name)
            ? [...directMatches, connectorInvokerEntry]
            : directMatches;
          if (name) {
            for (const match of matches) discoveredNames.add(match.name);
          }
          if (connectorMatched && connectorInvokerEntry) {
            discoveredNames.add(connectorInvokerEntry.name);
            for (const key of connectorActionKeys(connectorCatalog)) {
              discoveredConnectorActions.add(key);
            }
          }
          return {
            authorizedCount: entries.length,
            matchedCount: matches.length,
            capabilities: matches.slice(0, 100).map((entry) => ({
              name: entry.name,
              source: entry.source,
              effect: entry.effect,
              ...(name || (connectorMatched && entry.name === connectorInvokerEntry?.name) ? {
                description: entry.description,
                parameters: entry.parameters,
                invokeWith: 'invoke_runtime_capability',
              } : {}),
            })),
            ...(connectorCatalog === undefined ? {} : { connectorCatalog }),
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
          if (!discoveredNames.has(name)) {
            throw new Error(
              `能力 ${name} 尚未通过 inspect_runtime_capabilities 精确发现；`
              + '先按精确 name 查询并取得调用 schema，再调用。',
            );
          }
          if (name === 'invoke_capability' && connectorInspector?.invoke) {
            const actionKey = requestedConnectorAction(argumentsJson);
            if (!actionKey || !discoveredConnectorActions.has(actionKey)) {
              throw new Error(
                'Connector action 尚未通过能力目录精确发现；'
                + '先用 inspect_runtime_capabilities 的 connector query 取得精确 capability/action 和参数示例。',
              );
            }
          }
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
    const gatewayOnly = new Set([
      'inspect_mimi_capabilities',
      'invoke_capability',
    ]);
    const core = new Set([
      'read_file',
      'write_file',
      'edit_file',
      'apply_patch',
      'list_directory',
      'search_files',
      'inspect_changes',
      'run_shell',
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
    return tools.filter((tool) => core.has(tool.name) && !gatewayOnly.has(tool.name));
  }

  snapshot(input: {
    runId: string;
    policyRevision: string;
    tools: readonly Tool[];
    authorizedTools?: readonly Tool[];
    skills?: readonly string[];
    observedAt?: string;
    items?: readonly EffectiveCapabilityItem[];
  }): Readonly<EffectiveCapabilitySnapshot> {
    return createEffectiveCapabilitySnapshot({
      runId: input.runId,
      policyRevision: input.policyRevision,
      toolNames: input.tools.map((tool) => tool.name),
      hiddenTools: input.authorizedTools
        ? this.hiddenCapabilityGroups(input.authorizedTools, input.tools)
        : [],
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
