import { randomUUID } from 'node:crypto';
import {
  Usage,
  type AgentInputItem,
  type AgentOutputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from '@openai/agents';
import type { ReasoningIntent } from '../../core/model-routing.js';

type NativeProtocol = 'anthropic' | 'google';

interface NativeModelOptions {
  protocol: NativeProtocol;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  reasoning: ReasoningIntent;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    const value = record(part);
    return typeof value.text === 'string' ? value.text : '';
  }).filter(Boolean).join('\n');
}

function requestItems(input: ModelRequest['input']): AgentInputItem[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }] as AgentInputItem[];
  }
  return input;
}

function anthropicMessages(input: ModelRequest['input']): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (const item of requestItems(input)) {
    const value = record(item);
    if (value.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: value.callId,
          name: value.name,
          input: typeof value.arguments === 'string'
            ? JSON.parse(value.arguments)
            : value.arguments,
        }],
      });
    } else if (value.type === 'function_call_result') {
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: value.callId,
          content: contentText(value.output),
        }],
      });
    } else if (value.role === 'user' || value.role === 'assistant') {
      messages.push({ role: value.role, content: contentText(value.content) });
    }
  }
  return messages;
}

function googleContents(input: ModelRequest['input']): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = [];
  for (const item of requestItems(input)) {
    const value = record(item);
    if (value.type === 'function_call') {
      contents.push({
        role: 'model',
        parts: [{
          functionCall: {
            name: value.name,
            args: typeof value.arguments === 'string'
              ? JSON.parse(value.arguments)
              : value.arguments,
          },
        }],
      });
    } else if (value.type === 'function_call_result') {
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: value.name,
            response: { output: contentText(value.output) },
          },
        }],
      });
    } else if (value.role === 'user' || value.role === 'assistant') {
      contents.push({
        role: value.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: contentText(value.content) }],
      });
    }
  }
  return contents;
}

function functionTools(request: ModelRequest): Array<Record<string, unknown>> {
  return request.tools.filter((item) => item.type === 'function').map((item) => ({
    name: item.name,
    description: item.description,
    parameters: item.parameters,
  }));
}

export class NativeJsonAgentModel implements Model {
  constructor(private readonly options: NativeModelOptions) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    return this.options.protocol === 'anthropic'
      ? this.anthropicResponse(request)
      : this.googleResponse(request);
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    yield { type: 'response_started' };
    const response = await this.getResponse(request);
    for (const item of response.output) {
      const value = record(item);
      if (value.role !== 'assistant' || !Array.isArray(value.content)) continue;
      for (const part of value.content) {
        const content = record(part);
        if (content.type === 'output_text' && typeof content.text === 'string') {
          yield { type: 'output_text_delta', delta: content.text };
        }
      }
    }
    yield {
      type: 'response_done',
      response: {
        id: response.responseId ?? randomUUID(),
        requestId: response.requestId,
        usage: response.usage,
        output: response.output,
        providerData: response.providerData,
      },
    } as StreamEvent;
  }

  private async anthropicResponse(request: ModelRequest): Promise<ModelResponse> {
    const tools = functionTools(request);
    const response = await fetch(`${this.options.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.options.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.options.modelId,
        max_tokens: request.modelSettings.maxTokens ?? 4_096,
        ...(request.systemInstructions ? { system: request.systemInstructions } : {}),
        messages: anthropicMessages(request.input),
        ...(tools.length ? {
          tools: tools.map((item) => ({
            name: item.name,
            description: item.description,
            input_schema: item.parameters,
          })),
        } : {}),
        ...(this.options.reasoning === 'high'
          ? { thinking: { type: 'enabled', budget_tokens: 8_192 } }
          : this.options.reasoning === 'off' ? { thinking: { type: 'disabled' } } : {}),
      }),
      signal: request.signal,
    });
    if (!response.ok) throw new Error(`Anthropic Messages 调用失败：HTTP ${response.status}`);
    const body = await response.json() as {
      id?: string;
      content?: Array<{
        type?: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
      }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const output: AgentOutputItem[] = [];
    const text = (body.content ?? [])
      .filter((item) => item.type === 'text' && item.text)
      .map((item) => item.text)
      .join('');
    if (text) {
      output.push({
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }],
      });
    }
    for (const item of body.content ?? []) {
      if (item.type !== 'tool_use' || !item.name) continue;
      output.push({
        type: 'function_call',
        callId: item.id ?? randomUUID(),
        name: item.name,
        arguments: JSON.stringify(item.input ?? {}),
      });
    }
    const inputTokens = body.usage?.input_tokens ?? 0;
    const outputTokens = body.usage?.output_tokens ?? 0;
    return {
      responseId: body.id,
      requestId: response.headers.get('request-id') ?? undefined,
      usage: new Usage({
        requests: 1,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      }),
      output,
      providerData: { transport: 'anthropic-messages' },
    };
  }

  private async googleResponse(request: ModelRequest): Promise<ModelResponse> {
    const tools = functionTools(request);
    const response = await fetch(
      `${this.options.baseUrl}/models/${encodeURIComponent(this.options.modelId)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': this.options.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...(request.systemInstructions
            ? { systemInstruction: { parts: [{ text: request.systemInstructions }] } }
            : {}),
          contents: googleContents(request.input),
          ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
          generationConfig: {
            ...(request.modelSettings.maxTokens
              ? { maxOutputTokens: request.modelSettings.maxTokens }
              : {}),
            ...(this.options.reasoning === 'high'
              ? { thinkingConfig: { thinkingLevel: 'HIGH' } }
              : this.options.reasoning === 'off'
                ? { thinkingConfig: { thinkingBudget: 0 } }
                : {}),
          },
        }),
        signal: request.signal,
      },
    );
    if (!response.ok) throw new Error(`Google Generate Content 调用失败：HTTP ${response.status}`);
    const body = await response.json() as {
      responseId?: string;
      candidates?: Array<{ content?: { parts?: Array<{
        text?: string;
        functionCall?: { name?: string; args?: unknown };
      }> } }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };
    const parts = body.candidates?.[0]?.content?.parts ?? [];
    const output: AgentOutputItem[] = [];
    const text = parts.map((item) => item.text ?? '').join('');
    if (text) {
      output.push({
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }],
      });
    }
    for (const [index, part] of parts.entries()) {
      if (!part.functionCall?.name) continue;
      output.push({
        type: 'function_call',
        callId: `${body.responseId ?? 'gemini'}:${index}`,
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      });
    }
    const inputTokens = body.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = body.usageMetadata?.candidatesTokenCount ?? 0;
    return {
      responseId: body.responseId,
      requestId: response.headers.get('x-request-id') ?? undefined,
      usage: new Usage({
        requests: 1,
        inputTokens,
        outputTokens,
        totalTokens: body.usageMetadata?.totalTokenCount ?? inputTokens + outputTokens,
      }),
      output,
      providerData: { transport: 'google-generate-content' },
    };
  }
}
