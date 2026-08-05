import type { Model } from '@openai/agents';
import type { ReasoningIntent } from '../core/model-routing.js';

export type AgentModel = string | Model;

export interface ModelUsageRecord {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: 'unknown';
}

export function modelUsageRecord(usage: {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}): ModelUsageRecord {
  return {
    requests: usage.requests,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cost: 'unknown',
  };
}

export function reasoningModelSettings(reasoning?: ReasoningIntent): {
  reasoning?: { effort: 'none' | 'high' };
} {
  if (reasoning === 'high') return { reasoning: { effort: 'high' } };
  if (reasoning === 'off') return { reasoning: { effort: 'none' } };
  return {};
}
