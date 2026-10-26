import type { Tool } from '@openai/agents';
import { z } from 'zod';
import { tool } from '../tool-factory.js';
import {
  mimiPreferenceInstructionSchema,
  type PreferenceStore,
} from '../core/preferences.js';

export const MIMI_PREFERENCE_TOOL_NAMES = new Set([
  'list_mimi_preferences',
  'add_mimi_preference',
  'remove_mimi_preference',
]);

export function withoutMimiPreferenceTools(tools: Tool[]): Tool[] {
  return tools.filter((tool) => !MIMI_PREFERENCE_TOOL_NAMES.has(tool.name));
}

export function createMimiPreferenceTools(preferences: PreferenceStore): Tool[] {
  const list = tool({
    name: 'list_mimi_preferences',
    description: '列出 direct owner 要求 Mimi 在每次对话中默认遵循的稳定行为偏好。它们来自 ~/.mimi-agent/PREFERENCES.md，不是按需 Memory 或 Daemon Standing Orders。',
    parameters: z.object({}),
    execute: async () => ({
      file: preferences.file,
      preferences: await preferences.list(),
    }),
  });

  const add = tool({
    name: 'add_mimi_preference',
    description: '添加一条 Mimi-only 跨会话行为偏好。仅用于 owner 明确要求“以后每次都这样做”的稳定行为规则；事实、知识和经验仍使用 remember。相同规则幂等。',
    parameters: z.object({ instruction: mimiPreferenceInstructionSchema }),
    execute: async ({ instruction }) => preferences.add(instruction),
  });

  const remove = tool({
    name: 'remove_mimi_preference',
    description: '按完整文本删除一条 Mimi-only 行为偏好。删除前先调用 list_mimi_preferences 取得准确文本。',
    parameters: z.object({ instruction: mimiPreferenceInstructionSchema }),
    execute: async ({ instruction }) => preferences.remove(instruction),
  });

  return [list, add, remove];
}
