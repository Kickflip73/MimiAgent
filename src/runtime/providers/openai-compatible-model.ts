import {
  OpenAIChatCompletionsModel,
  type AgentOutputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from '@openai/agents';
import OpenAI from 'openai';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function responseReasoningContent(providerData: unknown): string | undefined {
  const choices = record(providerData).choices;
  if (!Array.isArray(choices)) return undefined;
  const message = record(record(choices[0]).message);
  return typeof message.reasoning_content === 'string' && message.reasoning_content
    ? message.reasoning_content
    : undefined;
}

function streamReasoningContent(event: StreamEvent): string | undefined {
  if (event.type !== 'model') return undefined;
  const choices = record(event.event).choices;
  if (!Array.isArray(choices)) return undefined;
  const delta = record(record(choices[0]).delta);
  return typeof delta.reasoning_content === 'string' ? delta.reasoning_content : undefined;
}

function preserveReasoningContent(
  output: AgentOutputItem[],
  reasoningContent: string | undefined,
): AgentOutputItem[] {
  if (!reasoningContent) return output;
  const hasReasoningItem = output.some((item) => item.type === 'reasoning');
  const preserved = output.map((item) => item.type === 'function_call'
    ? {
        ...item,
        providerData: {
          ...item.providerData,
          reasoning_content: reasoningContent,
        },
      }
    : item);
  if (hasReasoningItem) return preserved;
  return [{
    type: 'reasoning',
    content: [],
    rawContent: [{ type: 'reasoning_text', text: reasoningContent }],
  }, ...preserved];
}

function normalizeReasoningContentRequest(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (typeof body !== 'string') return body;
  let payload: Record<string, unknown>;
  try {
    payload = record(JSON.parse(body));
  } catch {
    return body;
  }
  if (!Array.isArray(payload.messages)) return body;
  let changed = false;
  const messages = payload.messages.map((message) => {
    const value = record(message);
    if (value.role !== 'assistant'
      || typeof value.reasoning_content !== 'string'
      || !('reasoning' in value)) {
      return message;
    }
    const { reasoning: _sdkReasoningAlias, ...portable } = value;
    changed = true;
    return portable;
  });
  return changed ? JSON.stringify({ ...payload, messages }) : body;
}

function reasoningContentFetch(baseFetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => baseFetch(input, {
    ...init,
    body: normalizeReasoningContentRequest(init?.body),
  })) as typeof globalThis.fetch;
}

class OpenAICompatibleReasoningModel implements Model {
  constructor(private readonly delegate: OpenAIChatCompletionsModel) {}

  getRetryAdvice: Model['getRetryAdvice'] = (args) => this.delegate.getRetryAdvice(args);

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.delegate.getResponse(request);
    const reasoningContent = responseReasoningContent(response.providerData);
    return {
      ...response,
      output: preserveReasoningContent(response.output, reasoningContent),
    };
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    let reasoningContent = '';
    for await (const event of this.delegate.getStreamedResponse(request)) {
      reasoningContent += streamReasoningContent(event) ?? '';
      if (event.type !== 'response_done') {
        yield event;
        continue;
      }
      yield {
        ...event,
        response: {
          ...event.response,
          output: preserveReasoningContent(
            event.response.output,
            reasoningContent,
          ) as typeof event.response.output,
        },
      };
    }
  }
}

export function createOpenAICompatibleModel(
  apiKey: string | undefined,
  baseUrl: string | undefined,
  modelId: string,
  options: { strictFeatureValidation?: boolean } = {},
): Model {
  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl,
    fetch: reasoningContentFetch(globalThis.fetch),
  });
  return new OpenAICompatibleReasoningModel(new OpenAIChatCompletionsModel(
    client,
    modelId,
    options,
  ));
}
