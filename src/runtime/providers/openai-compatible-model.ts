import {
  OpenAIChatCompletionsModel,
  type AgentInputItem,
  type AgentOutputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from '@openai/agents';
import OpenAI from 'openai';

const REASONING_CONTENT_MARKER = '__mimi_reasoning_content';

interface ReasoningProtocolState {
  reasoningContent: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function responseReasoningContent(providerData: unknown): string | undefined {
  const choices = record(providerData).choices;
  if (!Array.isArray(choices)) return undefined;
  const message = record(record(choices[0]).message);
  return typeof message.reasoning_content === 'string'
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
  if (reasoningContent === undefined) return output;
  const anchorIndex = output.findIndex((item) => item.type === 'message' && item.role === 'assistant');
  const fallbackAnchorIndex = output.findIndex((item) => item.type === 'function_call');
  const reasoningAnchorIndex = anchorIndex >= 0 ? anchorIndex : fallbackAnchorIndex;
  let hasReasoningItem = false;
  const preserved = output.map((item, index): AgentOutputItem => {
    if (item.type === 'reasoning') {
      if (hasReasoningItem) return item;
      hasReasoningItem = true;
      return {
        ...item,
        rawContent: [{ type: 'reasoning_text' as const, text: reasoningContent }],
      };
    }
    if (item.type !== 'function_call'
      && !(item.type === 'message' && item.role === 'assistant')) {
      return item;
    }
    const providerData = record(item.providerData);
    const {
      reasoning: _reasoning,
      reasoning_content: _reasoningContent,
      [REASONING_CONTENT_MARKER]: _reasoningContentMarker,
      ...portableProviderData
    } = providerData;
    const marker = index === reasoningAnchorIndex
      ? { [REASONING_CONTENT_MARKER]: true }
      : {};
    if (item.type === 'message') {
      const content = item.content.map((part) => {
        const value = part as unknown as Record<string, unknown>;
        const partProviderData = record(value.providerData);
        const {
          role: _role,
          tool_calls: _toolCalls,
          reasoning: _partReasoning,
          reasoning_content: _partReasoningContent,
          [REASONING_CONTENT_MARKER]: _partMarker,
          ...portablePartProviderData
        } = partProviderData;
        return {
          ...value,
          providerData: portablePartProviderData,
        } as unknown as typeof part;
      });
      return {
        ...item,
        content,
        providerData: { ...portableProviderData, ...marker },
      } as AgentOutputItem;
    }
    return {
      ...item,
      providerData: { ...portableProviderData, ...marker },
    } as AgentOutputItem;
  });
  if (hasReasoningItem) return preserved;
  return [{
    type: 'reasoning',
    content: [],
    rawContent: [{ type: 'reasoning_text', text: reasoningContent }],
  }, ...preserved];
}

function hasOwn(value: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, name);
}

function hasAssistantContent(message: Record<string, unknown>): boolean {
  return message.content !== null && message.content !== undefined;
}

function hasToolCalls(message: Record<string, unknown>): boolean {
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

function isReasoningOnlyAssistant(message: Record<string, unknown>): boolean {
  return message.role === 'assistant'
    && !hasAssistantContent(message)
    && !hasToolCalls(message)
    && (hasOwn(message, 'reasoning') || hasOwn(message, 'reasoning_content'));
}

function mergeAssistantFragments(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const leftCalls = Array.isArray(left.tool_calls) ? left.tool_calls : [];
  const rightCalls = Array.isArray(right.tool_calls) ? right.tool_calls : [];
  const merged: Record<string, unknown> = {
    ...left,
    ...right,
    role: 'assistant',
    content: hasAssistantContent(left) ? left.content : right.content,
  };
  if (leftCalls.length || rightCalls.length) {
    merged.tool_calls = [...leftCalls, ...rightCalls];
  } else {
    delete merged.tool_calls;
  }
  for (const name of ['reasoning', 'reasoning_content']) {
    if (!hasOwn(right, name) && hasOwn(left, name)) merged[name] = left[name];
  }
  return merged;
}

function normalizeAssistantFragments(messages: unknown[]): {
  changed: boolean;
  messages: unknown[];
} {
  const normalized: unknown[] = [];
  let changed = false;
  let pendingReasoning: Record<string, unknown> | undefined;
  // The SDK can split one response into reasoning-only, content, and tool-call
  // assistant messages. Track that provenance so unrelated assistant messages
  // are never coalesced just because they happen to be adjacent.
  let previousWasReasoningFragment = false;
  for (const message of messages) {
    const value = record(message);
    if (isReasoningOnlyAssistant(value)) {
      pendingReasoning = pendingReasoning
        ? mergeAssistantFragments(pendingReasoning, value)
        : value;
      changed = true;
      continue;
    }
    if (value.role !== 'assistant') {
      pendingReasoning = undefined;
      previousWasReasoningFragment = false;
      normalized.push(message);
      continue;
    }
    const mergedPendingReasoning = pendingReasoning !== undefined;
    let assistant = pendingReasoning
      ? mergeAssistantFragments(pendingReasoning, value)
      : value;
    pendingReasoning = undefined;
    const previous = record(normalized.at(-1));
    if (hasToolCalls(assistant)
      && previousWasReasoningFragment
      && previous.role === 'assistant'
      && hasAssistantContent(previous)
      && !hasToolCalls(previous)) {
      assistant = mergeAssistantFragments(previous, assistant);
      normalized[normalized.length - 1] = assistant;
      previousWasReasoningFragment = false;
      changed = true;
    } else {
      normalized.push(assistant);
      previousWasReasoningFragment = mergedPendingReasoning && !hasToolCalls(assistant);
    }
  }
  return { changed, messages: normalized };
}

function carriesReasoningContentDialect(message: unknown): boolean {
  const value = record(message);
  if (hasOwn(value, 'reasoning_content')) return true;
  for (const field of ['content', 'tool_calls']) {
    const entries = value[field];
    if (Array.isArray(entries) && entries.some((entry) => {
      const nested = record(entry);
      return hasOwn(nested, 'reasoning_content');
    })) return true;
  }
  return false;
}

function normalizeAssistantMessage(
  message: unknown,
  reasoningContentDialect: boolean,
): { changed: boolean; message: unknown } {
  const value = record(message);
  if (value.role !== 'assistant') return { changed: false, message };
  let changed = false;
  const portable: Record<string, unknown> = { ...value };
  if (hasOwn(portable, REASONING_CONTENT_MARKER)) {
    delete portable[REASONING_CONTENT_MARKER];
    changed = true;
  }
  if (reasoningContentDialect && typeof portable.reasoning === 'string') {
    if (!hasOwn(portable, 'reasoning_content')) {
      portable.reasoning_content = portable.reasoning;
    }
    delete portable.reasoning;
    changed = true;
  } else if (typeof portable.reasoning_content === 'string' && hasOwn(portable, 'reasoning')) {
    delete portable.reasoning;
    changed = true;
  }
  if (Array.isArray(portable.content)) {
    portable.content = portable.content.map((part) => {
      const content = record(part);
      const {
        role: _role,
        tool_calls: _toolCalls,
        reasoning: _reasoning,
        reasoning_content: _reasoningContent,
        [REASONING_CONTENT_MARKER]: _marker,
        ...cleanContent
      } = content;
      if (Object.keys(cleanContent).length !== Object.keys(content).length) changed = true;
      return cleanContent;
    });
  }
  if (Array.isArray(portable.tool_calls)) {
    portable.tool_calls = portable.tool_calls.map((call) => {
      const toolCall = record(call);
      const {
        reasoning: _reasoning,
        reasoning_content: _reasoningContent,
        [REASONING_CONTENT_MARKER]: _marker,
        ...cleanToolCall
      } = toolCall;
      if (Object.keys(cleanToolCall).length !== Object.keys(toolCall).length) changed = true;
      return cleanToolCall;
    });
  }
  return { changed, message: changed ? portable : message };
}

function normalizeReasoningContentRequest(
  body: BodyInit | null | undefined,
  protocol: ReasoningProtocolState,
): BodyInit | null | undefined {
  if (typeof body !== 'string') return body;
  let payload: Record<string, unknown>;
  try {
    payload = record(JSON.parse(body));
  } catch {
    return body;
  }
  if (!Array.isArray(payload.messages)) return body;
  const fragments = normalizeAssistantFragments(payload.messages);
  let changed = fragments.changed;
  const messages = fragments.messages.map((message) => {
    const normalized = normalizeAssistantMessage(
      message,
      protocol.reasoningContent || carriesReasoningContentDialect(message),
    );
    changed ||= normalized.changed;
    return normalized.message;
  });
  return changed ? JSON.stringify({ ...payload, messages }) : body;
}

function reasoningContentFetch(
  baseFetch: typeof globalThis.fetch,
  protocol: ReasoningProtocolState,
): typeof globalThis.fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => baseFetch(input, {
    ...init,
    body: normalizeReasoningContentRequest(init?.body, protocol),
  })) as typeof globalThis.fetch;
}

export function normalizeChatCompletionsInput(items: AgentInputItem[]): AgentInputItem[] {
  const portable: AgentInputItem[] = [];
  let pendingReasoning: AgentInputItem[] = [];
  for (const item of items) {
    const value = item as unknown as Record<string, unknown>;
    if (value.type === 'reasoning') {
      pendingReasoning.push(item);
      continue;
    }
    const assistantMessage = value.role === 'assistant'
      && (value.type === 'message' || value.type === undefined);
    const toolCall = value.type === 'function_call'
      || (value.type === 'hosted_tool_call' && value.name === 'file_search_call');
    if ((assistantMessage || toolCall) && pendingReasoning.length) {
      portable.push(...pendingReasoning);
      pendingReasoning = [];
    } else if (pendingReasoning.length) {
      // Truly standalone reasoning has no legal Chat Completions message form.
      pendingReasoning = [];
    }
    portable.push(item);
  }
  const unchanged = portable.length === items.length
    && portable.every((item, index) => item === items[index]);
  return unchanged ? items : portable;
}

function withoutReasoningContentMarker(providerData: unknown): {
  changed: boolean;
  providerData: unknown;
} {
  const value = record(providerData);
  if (!hasOwn(value, REASONING_CONTENT_MARKER)) {
    return { changed: false, providerData };
  }
  const { [REASONING_CONTENT_MARKER]: _marker, ...portable } = value;
  return { changed: true, providerData: portable };
}

export function stripChatCompletionsMetadata(items: AgentInputItem[]): AgentInputItem[] {
  let changed = false;
  const portable = items.map((item): AgentInputItem => {
    const value = item as unknown as Record<string, unknown>;
    const topLevel = withoutReasoningContentMarker(value.providerData);
    let contentChanged = false;
    const content = Array.isArray(value.content)
      ? value.content.map((part) => {
          const contentPart = part as Record<string, unknown>;
          const nested = withoutReasoningContentMarker(contentPart.providerData);
          if (!nested.changed) return part;
          contentChanged = true;
          return { ...contentPart, providerData: nested.providerData };
        })
      : value.content;
    if (!topLevel.changed && !contentChanged) return item;
    changed = true;
    return {
      ...value,
      ...(topLevel.changed ? { providerData: topLevel.providerData } : {}),
      ...(contentChanged ? { content } : {}),
    } as unknown as AgentInputItem;
  });
  return changed ? portable : items;
}

function normalizeRequestInput(request: ModelRequest): ModelRequest {
  if (typeof request.input === 'string') return request;
  // Keep this at the adapter boundary: Runner tool continuations do not pass
  // through the Session input callback again, but every model request does.
  const input = normalizeChatCompletionsInput(request.input);
  return input === request.input ? request : { ...request, input };
}

class OpenAICompatibleReasoningModel implements Model {
  constructor(
    private readonly delegate: OpenAIChatCompletionsModel,
    private readonly protocol: ReasoningProtocolState,
  ) {}

  getRetryAdvice: Model['getRetryAdvice'] = (args) => this.delegate.getRetryAdvice(args);

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.delegate.getResponse(normalizeRequestInput(request));
    const reasoningContent = responseReasoningContent(response.providerData);
    if (reasoningContent !== undefined) this.protocol.reasoningContent = true;
    return {
      ...response,
      output: preserveReasoningContent(response.output, reasoningContent),
    };
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    let reasoningContent: string | undefined;
    for await (const event of this.delegate.getStreamedResponse(normalizeRequestInput(request))) {
      const delta = streamReasoningContent(event);
      if (delta !== undefined) {
        reasoningContent = `${reasoningContent ?? ''}${delta}`;
        this.protocol.reasoningContent = true;
      }
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
  options: {
    reasoningContentDialect?: boolean;
    strictFeatureValidation?: boolean;
  } = {},
): Model {
  const inferredReasoningContentDialect = modelId.toLowerCase().startsWith('deepseek-')
    || baseUrl?.toLowerCase().includes('deepseek.') === true;
  const protocol = {
    reasoningContent: options.reasoningContentDialect ?? inferredReasoningContentDialect,
  };
  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl,
    fetch: reasoningContentFetch(globalThis.fetch, protocol),
  });
  return new OpenAICompatibleReasoningModel(new OpenAIChatCompletionsModel(
    client,
    modelId,
    { strictFeatureValidation: options.strictFeatureValidation },
  ), protocol);
}
