import type { AgentInputItem, Tool } from '@openai/agents';
import type { AgentPermissionMode, SecurityProfile } from '../../config.js';
import type { AgentMode } from '../instructions.js';
import {
  toolsForMode,
  toolsForPermission,
  toolsForRunPolicy,
  type RunToolPolicy,
} from '../tool-policy.js';
import {
  createEffectiveCapabilitySnapshot,
  type EffectiveCapabilityItem,
  type EffectiveCapabilitySnapshot,
} from './capability-resolver.js';

export function requiresPersonalConnectorOnly(input: string): boolean {
  const messageIntent = /(?:消息|聊天|会话|未读|待处理|收件|回复|发送|联系人)/iu.test(input);
  const personalChannel = /(?:大象|daxiang|个人\s*(?:QQ|微信)|personal-(?:daxiang|qq|wechat))/iu.test(input);
  const developmentIntent = /(?:代码|实现|修复|开发|设计|方案|测试|Connector|Adapter|通道)/iu.test(input);
  const explicitDesktopIntent = /(?:桌面|客户端|界面|GUI|CUA|无障碍|屏幕|窗口)/iu.test(input);
  return messageIntent && personalChannel && !developmentIntent && !explicitDesktopIntent;
}

export function requiresManagedGuiBoundary(input: string): boolean {
  const guiIntent = /(?:桌面|客户端|界面|GUI|CUA|无障碍|屏幕|窗口|应用|App|浏览器|Safari|Chrome|QQ|微信|大象|Mail|Messages|Notes|Calendar|日历|邮件|备忘录|提醒事项|快捷指令|Shortcuts)/iu
    .test(input);
  const guiAction = /(?:打开|启动|点击|输入|拖拽|滚动|选择|切换|关闭|新建|创建|更新|修改|删除|发送|运行|执行|操作|观察|截图|接管)/u
    .test(input);
  const developmentIntent = /(?:代码|实现|修复|开发|设计|方案|测试|用例|组件|模块|架构|文档|Connector|Adapter|通道|脚本)/iu
    .test(input);
  return guiIntent && guiAction && !developmentIntent;
}

export function assertShellCommandDoesNotBypassManagedGui(argumentsJson: string): void {
  let command: string | undefined;
  try {
    const input = JSON.parse(argumentsJson) as Record<string, unknown>;
    if (typeof input.command === 'string') command = input.command;
  } catch {
    return;
  }
  if (!command) return;
  const executable = /(?:^|[;&|]\s*|\b(?:sudo|env|command|exec|xargs|nohup)\s+)(?:\/[\w./-]+\/)?(?:osascript|shortcuts|open|automator|screencapture|say|pbcopy|pbpaste|cliclick)(?=\s|$)/iu;
  const managedConnector = /examples\/connectors\/macos-(?:browser|contacts|desktop|life|mail|messages|notes|shortcuts|voice)-connector\.mjs/iu;
  const automationApi = /\b(?:pyautogui|AppKit|ApplicationServices|AXUIElement|CGEvent|NSWorkspace|Quartz|ScriptingBridge|System Events|tell\s+application)\b/iu;
  if (!executable.test(command) && !managedConnector.test(command) && !automationApi.test(command)) return;
  throw new Error(
    'run_shell 不得直接执行 GUI、Apple Events、Shortcuts、应用启动或已托管的 macOS Connector；'
    + '请使用 Effective Capability Snapshot 中的正式 Connector、Browser 或 Computer 工具。',
  );
}

export function isPersonalMessageFallbackTool(name: string): boolean {
  return name === 'run_shell'
    || name === 'computer_observe'
    || name === 'computer_act'
    || /(?:^|[_-])(?:mcp|cua|computer|desktop|browser)(?:[_-]|$)/iu.test(name);
}

export function withoutUnmanagedGuiShell(tools: Tool[]): Tool[] {
  return tools.filter((tool) => tool.name !== 'run_shell');
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
