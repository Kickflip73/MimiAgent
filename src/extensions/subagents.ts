import { randomUUID } from 'node:crypto';
import { Agent, Runner, type Tool } from '@openai/agents';
import { z } from 'zod';
import { tool } from '../tool-factory.js';
import type { AgentMode } from '../core/agent-mode.js';
import { subAgentToolNames } from '../core/tool-role-policy.js';
import type {
  WorkUnitDescriptor,
  WorkUnitObservation,
  WorkUnitResult,
} from '../core/work-unit.js';
import { sanitizeSensitiveText } from '../core/data-sanitizer.js';
import {
  modelUsageRecord,
  reasoningModelSettings,
  type AgentModel,
  type ModelUsageRecord,
} from './model-port.js';
import {
  modelRequirementsSchema,
  modelTargetSchema,
  type RunModelBinding,
  type WorkUnitModelProfile,
} from '../core/model-routing.js';

function selectTools(tools: Tool[], names: readonly string[]): Tool[] {
  const allowed = new Set(names);
  return tools.filter((tool) => allowed.has(tool.name));
}

async function forwardEvent(
  callback: ((agent: string, eventType: string) => void | Promise<void>) | undefined,
  agent: string,
  eventType: string,
): Promise<void> {
  if (eventType === 'raw_model_stream_event') return;
  await callback?.(agent, eventType);
}

export interface SubAgentToolsOptions {
  mode: AgentMode;
  model: AgentModel;
  tools: Tool[];
  persistentInstructions?: string;
  parentRunId?: string;
  onEvent?: (agent: string, eventType: string) => void | Promise<void>;
  onWorkUnit?: (observation: WorkUnitObservation) => void | Promise<void>;
  modelForDelegation?: (
    role: 'researcher' | 'reviewer' | 'architect',
    profile: WorkUnitModelProfile,
    binding?: RunModelBinding,
  ) => AgentModel | Promise<AgentModel>;
  bindingForDelegation?: (
    role: 'researcher' | 'reviewer' | 'architect',
    profile: WorkUnitModelProfile,
  ) => RunModelBinding | Promise<RunModelBinding>;
  onModelBinding?: (
    role: 'researcher' | 'reviewer' | 'architect',
    binding: RunModelBinding,
    workUnitId: string,
  ) => void | Promise<void>;
}

interface RoutedSubAgentResult extends WorkUnitResult {
  modelBinding?: RunModelBinding;
  usage: ModelUsageRecord;
}

function observedSubAgentTool(
  role: 'researcher' | 'reviewer' | 'architect',
  toolName: string,
  toolDescription: string,
  instructions: string[],
  options: SubAgentToolsOptions,
): Tool {
  return tool({
    name: toolName,
    description: toolDescription,
    parameters: z.object({
      input: z.string().min(1).max(8_000),
      complexity: z.enum(['simple', 'normal', 'hard']).optional(),
      requirements: modelRequirementsSchema.optional(),
      modelTarget: modelTargetSchema.optional(),
    }).strict(),
    execute: async ({ input, complexity, requirements, modelTarget }) => {
      const id = `${options.parentRunId ?? 'run'}:${toolName}:${randomUUID()}`;
      const startedAt = new Date().toISOString();
      const profile: WorkUnitModelProfile = {
        complexity: complexity ?? (role === 'researcher' ? 'simple' : 'hard'),
        ...(requirements ? { requirements } : {}),
        ...(modelTarget ? { modelTarget } : {}),
      };
      const binding = await options.bindingForDelegation?.(role, profile);
      if (binding) await options.onModelBinding?.(role, binding, id);
      const selectedModel = options.modelForDelegation
        ? await options.modelForDelegation(role, profile, binding)
        : options.model;
      const agent = new Agent({
        name: `Nano ${role[0]!.toUpperCase()}${role.slice(1)}`,
        model: selectedModel,
        modelSettings: reasoningModelSettings(binding?.reasoning),
        instructions: [options.persistentInstructions, ...instructions].filter(Boolean).join('\n\n'),
        tools: selectTools(options.tools, subAgentToolNames(role)),
      });
      const runner = new Runner({
        workflowName: `MimiAgent SubAgent · ${role}`,
        tracingDisabled: true,
        traceIncludeSensitiveData: false,
      });
      await forwardEvent(options.onEvent, role, 'agent_updated_stream_event');
      const output = await runner.run(agent, input, { maxTurns: null });
      const descriptor: WorkUnitDescriptor = {
        id,
        kind: 'subagent',
        parentRunId: options.parentRunId ?? 'unbound-run',
        objective: sanitizeSensitiveText(input)?.slice(0, 8_000) ?? '',
        role,
        dependencies: [],
        capabilities: role === 'researcher' ? ['read', 'network-read', 'memory-read'] : ['read', 'memory-read'],
        workspaceAccess: 'read',
        paths: [],
      };
      const summary = sanitizeSensitiveText(String(output.finalOutput ?? 'SubAgent 未返回摘要')) ?? '';
      const completedAt = new Date().toISOString();
      const result: RoutedSubAgentResult = {
        id,
        status: 'completed',
        summary,
        artifacts: [],
        evidence: [{ type: 'agent-tool-call', ref: `${toolName}:${id}` }],
        startedAt,
        completedAt,
        ...(binding ? { modelBinding: binding } : {}),
        usage: modelUsageRecord(output.runContext.usage),
      };
      try {
        await options.onWorkUnit?.({
          descriptor,
          status: 'completed',
          observedAt: completedAt,
          result,
        });
      } catch {
        // WorkUnit observers are telemetry and cannot change the nested result.
      }
      await forwardEvent(options.onEvent, role, 'agent_end');
      return JSON.stringify(result);
    },
  });
}

export function createSubAgentTools(options: SubAgentToolsOptions): Tool[] {
  const researcherInstructions = [
      '你是独立研究子 Agent，只处理主 Agent 委派的明确子任务。',
      '检索或检查一手资料，区分事实与推断，返回紧凑结论和来源。',
      '不要修改文件，不要继续委派其他 Agent；若持久指令与只读职责冲突，以本职责为准。',
    ];
  const reviewerInstructions = [
      '你是独立审查子 Agent，检查指定代码、文档或方案。',
      '优先发现正确性、兼容性、安全性和测试缺口，按严重程度返回可操作意见。',
      '保持只读，不修改文件，不继续委派其他 Agent；若持久指令与只读职责冲突，以本职责为准。',
    ];
  const architectInstructions = [
      '你是独立架构子 Agent，只负责分析边界、数据流、方案取舍、风险与验证策略。',
      '必须保持只读，不修改文件、不运行命令、不继续委派；输出可实施但不实施的紧凑设计。',
    ];

  const tools = [
    observedSubAgentTool(
      'researcher',
      'delegate_research',
      '把独立、资料密集的研究子任务交给只读 researcher；简单查询不要委派。',
      researcherInstructions,
      options,
    ),
    observedSubAgentTool(
      'reviewer',
      'delegate_review',
      '把边界清晰的代码、文档或方案审查交给只读 reviewer。',
      reviewerInstructions,
      options,
    ),
  ];
  if (options.mode !== 'general') {
    tools.splice(1, 0, observedSubAgentTool(
      'architect',
      'delegate_architecture',
      '把边界清晰的架构分析或实施方案设计交给只读 architect。',
      architectInstructions,
      options,
    ));
  }
  return tools;
}
