import type { AgentInputItem, Model, Usage } from '@openai/agents';
import {
  type ContextSemanticSummarizer,
  type ContextSemanticSummaryRequest,
  type WorkSnapshotContent,
} from '../core/context.js';

const SNAPSHOT_KEYS: Array<keyof WorkSnapshotContent> = [
  'goal',
  'progress',
  'completed',
  'decisions',
  'constraints',
  'openQuestions',
  'evidence',
  'keyFacts',
  'references',
];

function responseText(output: unknown[]): string {
  return output.flatMap((item) => {
    const value = item as Record<string, unknown>;
    if (!Array.isArray(value.content)) return [];
    return value.content.flatMap((part) => {
      const block = part as Record<string, unknown>;
      return block.type === 'output_text' && typeof block.text === 'string' ? [block.text] : [];
    });
  }).join('\n').trim();
}

function parseSnapshot(text: string): WorkSnapshotContent {
  const json = text.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const snapshot = {} as WorkSnapshotContent;
  for (const key of SNAPSHOT_KEYS) {
    if (!Array.isArray(parsed[key]) || parsed[key].some((value) => typeof value !== 'string')) {
      throw new Error(`语义工作快照字段 ${key} 不是 string[]`);
    }
    snapshot[key] = parsed[key] as string[];
  }
  return snapshot;
}

export class ModelContextSemanticSummarizer implements ContextSemanticSummarizer {
  private usages: Usage[] = [];

  constructor(
    private readonly model: Model,
    private readonly maxOutputTokens = 16_384,
  ) {}

  drainUsages(): Usage[] {
    const usages = this.usages;
    this.usages = [];
    return usages;
  }

  async summarize(request: ContextSemanticSummaryRequest): Promise<WorkSnapshotContent> {
    const instructions = [
      '你是 MimiAgent 的无工具语义压缩器。只输出一个 JSON object，不输出 Markdown。',
      `JSON 必须且只能包含这些 string[] 字段：${SNAPSHOT_KEYS.join(', ')}。`,
      '把较早 canonical 对话压缩为可继续工作的有界快照：保留目标、进度、已完成、决策、约束、未决问题、证据、关键事实、实体、精确数值和 opaque 引用。',
      '合并 previousSnapshot 和 seed；冲突事实同时保留并明确冲突，不猜测、不按关键词筛选、不复制无意义长日志或代码。',
      '工具结果只保留其结论和稳定引用，绝不生成可重放的工具调用。',
      `快照总预算不超过约 ${request.maxSnapshotTokens} tokens；优先保留影响后续正确性和副作用安全的信息。`,
    ].join('\n');
    const input: AgentInputItem[] = [{
      role: 'user',
      content: JSON.stringify({
        previousSnapshot: request.previous,
        seed: request.seed,
        canonicalOlderConversation: request.input,
      }),
    }];
    const response = await this.model.getResponse({
      systemInstructions: instructions,
      input,
      modelSettings: { maxTokens: Math.min(this.maxOutputTokens, request.maxSnapshotTokens) },
      tools: [],
      toolsExplicitlyProvided: true,
      outputType: 'text',
      handoffs: [],
      tracing: false,
    });
    this.usages.push(response.usage);
    const text = responseText(response.output as unknown[]);
    if (!text) throw new Error('语义压缩模型未返回文本快照');
    return parseSnapshot(text);
  }
}
