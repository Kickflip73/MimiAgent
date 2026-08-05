import { tool, type Tool } from '@openai/agents';
import {
  completionContractSchema,
  completionReportSchema,
  type CompletionContract,
  type CompletionGateDecision,
  type CompletionReport,
} from '../core/completion.js';

export * from '../core/completion.js';

export function createCompletionTools(callbacks: {
  prepare: (contract: CompletionContract) => Promise<void>;
  finish: (report: CompletionReport) => Promise<CompletionGateDecision>;
}): Tool[] {
  return [
    tool({
      name: 'prepare_task',
      description: '为将要创建或已经恢复的持久 Goal 冻结 Completion Contract。新 Goal 必须先调用本工具，再用 set_goal 将目标和 Contract 一次提交；普通问答和短操作禁止调用。',
      parameters: completionContractSchema,
      execute: async (contract) => {
        await callbacks.prepare(contract);
        return { accepted: true, contract };
      },
    }),
    tool({
      name: 'finish_task',
      description: '仅为持久 Goal 提交完成证据。只有 decision=pass 才能把 Goal 标记完成；其他结果保留 Goal 和检查点但不自动重跑整个 Event，uncertain 禁止重放副作用。',
      parameters: completionReportSchema,
      execute: callbacks.finish,
    }),
  ];
}
