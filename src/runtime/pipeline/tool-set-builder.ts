import type { AgentInputItem, Tool } from '@openai/agents';
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
