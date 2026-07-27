import type { AgentInputItem, Tool } from '@openai/agents';
import type { AgentPermissionMode, SecurityProfile } from '../../config.js';
import type { AgentMode } from '../instructions.js';
import {
  toolsForMode,
  toolsForPermission,
  toolsForRunPolicy,
  type RunToolPolicy,
} from '../tool-policy.js';

export function requiresPersonalConnectorOnly(input: string): boolean {
  const messageIntent = /(?:消息|聊天|会话|未读|待处理|收件|回复|发送|联系人)/iu.test(input);
  const personalChannel = /(?:大象|daxiang|个人\s*(?:QQ|微信)|personal-(?:daxiang|qq|wechat))/iu.test(input);
  const developmentIntent = /(?:代码|实现|修复|开发|设计|方案|测试|Connector|Adapter|通道)/iu.test(input);
  const explicitDesktopIntent = /(?:桌面|客户端|界面|GUI|CUA|无障碍|屏幕|窗口)/iu.test(input);
  return messageIntent && personalChannel && !developmentIntent && !explicitDesktopIntent;
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
  scoped(
    tools: Tool[],
    permissionMode: AgentPermissionMode,
    securityProfile: SecurityProfile,
    policy: RunToolPolicy | undefined,
    computerEnabled: boolean,
  ): Tool[] {
    return toolsForRunPolicy(
      toolsForPermission(permissionMode, tools, {}, securityProfile),
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
      toolsForPermission(
        permissionMode,
        toolsForMode(mode, baseTools, teamTools),
        {},
        securityProfile,
      ),
      policy,
    );
    const delegated = toolsForRunPolicy(
      toolsForPermission(permissionMode, subAgentTools, {}, securityProfile),
      policy,
    );
    return [...modeTools, ...delegated];
  }
}
