import type OpenAI from 'openai';

export type EmbeddingPurpose = 'query' | 'document';
export type EmbeddingProviderState = 'ready' | 'missing' | 'corrupt' | 'unsupported' | 'unavailable';

export interface EmbeddingProviderDiagnostics {
  kind: 'local' | 'remote';
  state: EmbeddingProviderState;
  model: string;
  revision?: string;
  modelBytes?: number;
  runtime?: string;
  reason?: string;
}

export interface EmbeddingProvider {
  readonly kind: 'local' | 'remote';
  readonly model: string;
  readonly vectorSearchMaxDistance?: number;
  embed(
    inputs: string[],
    options: {
      purpose: EmbeddingPurpose;
      allowDownload: boolean;
      timeoutMs?: number;
    },
  ): Promise<number[][] | undefined>;
  diagnostics(): Promise<EmbeddingProviderDiagnostics>;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'remote' as const;

  constructor(
    private readonly client: OpenAI,
    readonly model: string,
  ) {}

  async embed(
    inputs: string[],
    options: { purpose: EmbeddingPurpose; allowDownload: boolean; timeoutMs?: number },
  ): Promise<number[][] | undefined> {
    const response = await this.client.embeddings.create(
      { model: this.model, input: inputs },
      options.timeoutMs === undefined
        ? undefined
        : { maxRetries: 0, timeout: options.timeoutMs },
    );
    return response.data.map((item) => item.embedding);
  }

  async diagnostics(): Promise<EmbeddingProviderDiagnostics> {
    return { kind: this.kind, state: 'ready', model: this.model, runtime: 'openai-compatible' };
  }
}
