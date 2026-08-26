import type { RunStreamEvent } from '@openai/agents';

export type RunStreamProjection =
  | { kind: 'answer'; text: string }
  | { kind: 'reasoning'; text: string }
  | {
      kind: 'status';
      tone: 'agent' | 'thinking' | 'tool' | 'success' | 'failure';
      title: string;
      detail?: string;
      fullDetail?: string;
      next: string;
      nextMotion?: 'thinking' | 'running';
    };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function text(value: unknown, limit?: number): string | undefined {
  if (value === undefined) return undefined;
  let rendered: string;
  try {
    rendered = typeof value === 'string' ? value : JSON.stringify(value, null, limit ? 0 : 2);
  } catch {
    rendered = String(value);
  }
  if (!limit) return rendered;
  const compact = rendered.replace(/\s+/g, ' ').trim();
  return compact.length <= limit ? compact : `${compact.slice(0, Math.max(0, limit - 3))}...`;
}

export function projectRunStreamEvent(event: RunStreamEvent): RunStreamProjection | undefined {
  if (event.type === 'agent_updated_stream_event') {
    return { kind: 'status', tone: 'agent', title: event.agent.name, next: 'Agent 工作中' };
  }
  if (event.type === 'run_item_stream_event') {
    const item = record(event.item);
    const raw = record(item?.rawItem);
    const name = typeof raw?.name === 'string' ? raw.name : undefined;
    if (event.name === 'tool_called') {
      const title = name ?? 'unknown';
      return {
        kind: 'status',
        tone: 'tool',
        title,
        detail: text(raw?.arguments, 160),
        fullDetail: text(raw?.arguments),
        next: `正在执行 ${title}`,
        nextMotion: 'running',
      };
    }
    if (event.name === 'tool_output') {
      return {
        kind: 'status',
        tone: 'success',
        title: name === 'run_team' ? 'Ultra Team' : name ?? 'tool',
        detail: name === 'run_team' ? '本轮并行任务已结束' : text(item?.output, 120),
        fullDetail: text(item?.output),
        next: '模型继续思考',
      };
    }
    // A reasoning item closes one model step, not the whole reasoning phase. In
    // tool-using runs it can occur repeatedly before the final answer, so it is
    // progress metadata rather than a user-visible status transition.
    return undefined;
  }
  if (event.type !== 'raw_model_stream_event') return undefined;
  if (event.data.type === 'output_text_delta') return { kind: 'answer', text: event.data.delta };
  if (event.data.type !== 'model') return undefined;
  const providerEvent = record(event.data.event);
  const choices = Array.isArray(providerEvent?.choices) ? providerEvent.choices : undefined;
  const delta = record(record(choices?.[0])?.delta);
  if (typeof delta?.reasoning_content === 'string') {
    return { kind: 'reasoning', text: delta.reasoning_content };
  }
  if (providerEvent?.type === 'response.reasoning_summary_text.delta'
    && typeof providerEvent.delta === 'string') {
    return { kind: 'reasoning', text: providerEvent.delta };
  }
  return undefined;
}
