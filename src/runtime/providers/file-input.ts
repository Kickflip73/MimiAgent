import type {
  Model,
  ModelRequest,
  ModelResponse,
  ModelRetryAdvice,
  ModelRetryAdviceRequest,
  StreamEvent,
} from '@openai/agents';
import type { ModelRegistration, ProviderTransport } from '../../core/model-routing.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function inputFiles(input: ModelRequest['input']): Record<string, unknown>[] {
  if (typeof input === 'string') return [];
  const files: Record<string, unknown>[] = [];
  for (const item of input) {
    const current = record(item);
    if (!Array.isArray(current?.content)) continue;
    for (const part of current.content) {
      const content = record(part);
      if (content?.type === 'input_file') files.push(content);
    }
  }
  return files;
}

export function containsFileInput(input: ModelRequest['input']): boolean {
  return inputFiles(input).length > 0;
}

function assertInlineFile(file: Record<string, unknown>, transport: ProviderTransport): void {
  const value = file.file;
  if (typeof value !== 'string'
    || !/^data:[^;,\s]+;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(
      `${transport} fileInput 只接受有界 staging 生成的 base64 data URL；请求未发送`,
    );
  }
}

function assertFileInput(
  request: ModelRequest,
  registration: ModelRegistration,
  transport: ProviderTransport,
  adapterSupportsFileInput: boolean,
): void {
  const files = inputFiles(request.input);
  if (!files.length) return;
  if (registration.capabilities.fileInput !== true) {
    throw new Error(
      `模型 ${registration.target.providerId}/${registration.target.modelId} 未声明 fileInput；请求未发送`,
    );
  }
  if (!adapterSupportsFileInput) {
    throw new Error(`${transport} adapter 尚未实现 fileInput 显式转换；请求未发送`);
  }
  for (const file of files) assertInlineFile(file, transport);
}

/**
 * Enforces model truth at the final adapter boundary, before an SDK can serialize or fetch.
 * Only adapters with an audited input_file conversion may opt into pass-through.
 */
export function withFileInputCapability(
  model: Model,
  registration: ModelRegistration,
  transport: ProviderTransport,
  adapterSupportsFileInput: boolean,
): Model {
  return {
    async getResponse(request: ModelRequest): Promise<ModelResponse> {
      assertFileInput(request, registration, transport, adapterSupportsFileInput);
      return model.getResponse(request);
    },
    async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
      assertFileInput(request, registration, transport, adapterSupportsFileInput);
      yield* model.getStreamedResponse(request);
    },
    ...(model.getRetryAdvice ? {
      getRetryAdvice(args: ModelRetryAdviceRequest): Promise<ModelRetryAdvice | undefined>
        | ModelRetryAdvice | undefined {
        return model.getRetryAdvice!(args);
      },
    } : {}),
  };
}
