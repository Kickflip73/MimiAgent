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

// Enforce the Host deadline even if a provider does not honor AbortSignal.
async function withinDeadline<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      operation().then(resolve, reject);
    });
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export class ModelContextSemanticSummarizer implements ContextSemanticSummarizer {
  private usages: Usage[] = [];

  constructor(
    private readonly model: Model,
    private readonly maxOutputTokens = 3_000,
  ) {}

  drainUsages(): Usage[] {
    const usages = this.usages;
    this.usages = [];
    return usages;
  }

  async summarize(request: ContextSemanticSummaryRequest): Promise<WorkSnapshotContent> {
    const maxTokens = Math.min(this.maxOutputTokens, request.maxSnapshotTokens);
    const signal = AbortSignal.any([...(request.signal ? [request.signal] : []), AbortSignal.timeout(20_000)]);
    const instructions = [
      '你是 MimiAgent 的无工具语义压缩器。只输出一个 JSON object，不输出 Markdown。',
      `JSON 必须且只能包含这些 string[] 字段：${SNAPSHOT_KEYS.join(', ')}。`,
      '把较早 canonical 对话压缩为可继续工作的有界快照：保留目标、进度、已完成、决策、约束、未决问题、证据、关键事实、实体、精确数值和 opaque 引用。',
      '合并 previousSnapshot 和 seed；冲突事实同时保留并明确冲突，不猜测、不按关键词筛选、不复制无意义长日志或代码。',
      '工具结果只保留其结论和稳定引用，绝不生成可重放的工具调用。',
      '输入可能是同一用户任务中已完成的工具批次。精确保留用户约束和失败/uncertain副作用状态；不可把未确认动作写成已完成。',
      `快照总预算不超过约 ${maxTokens} tokens；优先保留影响后续正确性和副作用安全的信息。`,
    ].join('\n');
    const input: AgentInputItem[] = [{
      role: 'user',
      content: JSON.stringify({
        previousSnapshot: request.previous,
        seed: request.seed,
        canonicalOlderConversation: request.input,
      }),
    }];
    const response = await withinDeadline(signal, () => this.model.getResponse({
      systemInstructions: instructions,
      input,
      modelSettings: { maxTokens, reasoning: { effort: 'none' } },
      tools: [],
      toolsExplicitlyProvided: true,
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal,
    }));
    this.usages.push(response.usage);
    const text = responseText(response.output as unknown[]);
    if (!text) throw new Error('语义压缩模型未返回文本快照');
    return parseSnapshot(text);
  }
}
