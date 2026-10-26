import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  EmbeddingProvider,
  EmbeddingProviderDiagnostics,
  EmbeddingProviderState,
  EmbeddingPurpose,
} from './embedding-provider.js';

export interface LocalEmbeddingAsset {
  path: string;
  bytes: number;
  sha256: string;
}

export interface LocalEmbeddingModelSpec {
  id: string;
  cacheKey: string;
  revision: string;
  queryInstruction: string;
  assets: LocalEmbeddingAsset[];
}

export const DEFAULT_LOCAL_EMBEDDING_MODEL: LocalEmbeddingModelSpec = {
  id: 'onnx-community/bge-small-zh-v1.5-ONNX',
  cacheKey: 'bge-small-zh-v1.5-q8',
  revision: '9507db33464b5da99a532ac26b2a251767cbc62b',
  queryInstruction: '为这个句子生成表示以用于检索相关文章：',
  assets: [
    { path: 'config.json', bytes: 904, sha256: '34fa1ea6278c257de3cc8ce7e9bdc48647b802145a9da0fc32e95db620efd04f' },
    { path: 'tokenizer.json', bytes: 362_603, sha256: '3d09c84ebd10306706a79a8276b3ab736a40d8ec03251c7639f4e52c3a1a4f8e' },
    { path: 'tokenizer_config.json', bytes: 414, sha256: '7e3bd6113f18c20975eaa8e8cc03c95b727fd83d6357f8e171e22b3736bf706d' },
    { path: 'onnx/model_quantized.onnx', bytes: 168_002, sha256: '99a6e522710c00220c89f8c52e0cc5aa09d4cbb1c34c0e932eab3a9dfdc65df3' },
    { path: 'onnx/model_quantized.onnx_data', bytes: 23_774_208, sha256: '952623481ca8beea884e3d3c9ecaf8a3c7bf1d0c21de29e970cd31af9d37a90b' },
  ],
};

interface FeatureExtractionOutput {
  tolist(): unknown;
}

interface FeatureExtractionPipeline {
  (
    inputs: string[],
    options: { pooling: 'cls'; normalize: true },
  ): Promise<FeatureExtractionOutput>;
}

type PipelineFactory = (modelDirectory: string) => Promise<FeatureExtractionPipeline>;
type FetchAsset = (url: string) => Promise<Response>;

class LocalEmbeddingTimeoutError extends Error {}

async function withTimeout<T>(operation: Promise<T>, timeoutMs?: number): Promise<T> {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return operation;
  const abort = new AbortController();
  const timeout = delay(Math.max(1, Math.trunc(timeoutMs)), undefined, {
    signal: abort.signal,
    ref: false,
  }).then(() => { throw new LocalEmbeddingTimeoutError(); });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    abort.abort();
  }
}

export interface LocalEmbeddingProviderOptions {
  dataRoot: string;
  model?: LocalEmbeddingModelSpec;
  fetchAsset?: FetchAsset;
  pipelineFactory?: PipelineFactory;
  platform?: NodeJS.Platform;
  architecture?: string;
}

function supported(platform: NodeJS.Platform, architecture: string): boolean {
  return (platform === 'darwin' || platform === 'linux')
    && (architecture === 'arm64' || architecture === 'x64');
}

async function sha256(file: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

function validVectorBatch(value: unknown, count: number): value is number[][] {
  if (!Array.isArray(value) || value.length !== count) return false;
  const dimensions = Array.isArray(value[0]) ? value[0].length : 0;
  return dimensions > 0 && value.every((vector) => (
    Array.isArray(vector)
    && vector.length === dimensions
    && vector.every((item) => typeof item === 'number' && Number.isFinite(item))
  ));
}

async function defaultPipelineFactory(modelDirectory: string): Promise<FeatureExtractionPipeline> {
  const tokenizerPackage = '@huggingface/tokenizers';
  const runtimePackage = 'onnxruntime-node';
  const [{ Tokenizer }, ort, tokenizerJson, tokenizerConfig] = await Promise.all([
    import(tokenizerPackage) as Promise<{
      Tokenizer: new (tokenizer: object, config: object) => {
        encode(text: string, options: { return_token_type_ids: true }): {
          ids: number[];
          attention_mask: number[];
          token_type_ids: number[];
        };
        token_to_id(token: string): number | undefined;
      };
    }>,
    import(runtimePackage) as Promise<{
      Tensor: new (type: 'int64', data: BigInt64Array, dimensions: number[]) => unknown;
      InferenceSession: {
        create(file: string, options: {
          executionProviders: ['cpu'];
          graphOptimizationLevel: 'all';
        }): Promise<{
          run(feeds: Record<string, unknown>): Promise<Record<string, {
            data: ArrayLike<number>;
            dims: readonly number[];
          }>>;
        }>;
      };
    }>,
    readFile(path.join(modelDirectory, 'tokenizer.json'), 'utf8'),
    readFile(path.join(modelDirectory, 'tokenizer_config.json'), 'utf8'),
  ]);
  const tokenizerConfigValue = JSON.parse(tokenizerConfig) as {
    pad_token?: string;
    sep_token?: string;
  };
  const tokenizer = new Tokenizer(
    JSON.parse(tokenizerJson) as object,
    tokenizerConfigValue,
  );
  const padTokenId = tokenizerConfigValue.pad_token
    ? tokenizer.token_to_id(tokenizerConfigValue.pad_token) ?? 0
    : 0;
  const separatorTokenId = tokenizerConfigValue.sep_token
    ? tokenizer.token_to_id(tokenizerConfigValue.sep_token)
    : undefined;
  const session = await ort.InferenceSession.create(
    path.join(modelDirectory, 'onnx', 'model_quantized.onnx'),
    { executionProviders: ['cpu'], graphOptimizationLevel: 'all' },
  );
  return async (inputs) => {
    const encoded = inputs.map((input) => tokenizer.encode(input, { return_token_type_ids: true }));
    const bounded = encoded.map((value) => {
      const ids = value.ids.slice(0, 512);
      if (value.ids.length > ids.length && separatorTokenId !== undefined) ids[ids.length - 1] = separatorTokenId;
      return {
        ids,
        attentionMask: value.attention_mask.slice(0, ids.length),
        tokenTypeIds: value.token_type_ids.slice(0, ids.length),
      };
    });
    const sequenceLength = Math.max(...bounded.map((value) => value.ids.length));
    const flatten = (select: (value: typeof bounded[number], index: number) => number) => {
      const result = new BigInt64Array(inputs.length * sequenceLength);
      for (let batch = 0; batch < bounded.length; batch += 1) {
        const value = bounded[batch]!;
        for (let index = 0; index < sequenceLength; index += 1) {
          result[batch * sequenceLength + index] = BigInt(select(value, index));
        }
      }
      return result;
    };
    const dimensions = [inputs.length, sequenceLength];
    const output = await session.run({
      input_ids: new ort.Tensor('int64', flatten((value, index) => value.ids[index] ?? padTokenId), dimensions),
      attention_mask: new ort.Tensor('int64', flatten((value, index) => value.attentionMask[index] ?? 0), dimensions),
      token_type_ids: new ort.Tensor('int64', flatten((value, index) => value.tokenTypeIds[index] ?? 0), dimensions),
    });
    const embeddings = output.sentence_embedding;
    if (!embeddings || embeddings.dims[0] !== inputs.length || embeddings.dims.length !== 2) {
      throw new Error('Local embedding runtime output 无效');
    }
    const vectorDimensions = embeddings.dims[1] ?? 0;
    const vectors = Array.from({ length: inputs.length }, (_, batch) => {
      const vector = Array.from(
        { length: vectorDimensions },
        (_, index) => Number(embeddings.data[batch * vectorDimensions + index]),
      );
      const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
      return norm > 0 ? vector.map((value) => value / norm) : vector;
    });
    return { tolist: () => vectors };
  };
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'local' as const;
  readonly vectorSearchMaxDistance = 0.6;
  readonly model: string;
  private readonly modelSpec: LocalEmbeddingModelSpec;
  private readonly modelDirectory: string;
  private readonly fetchAsset: FetchAsset;
  private readonly pipelineFactory: PipelineFactory;
  private readonly platform: NodeJS.Platform;
  private readonly architecture: string;
  private pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;
  private inferenceCircuitOpen = false;
  private state: EmbeddingProviderState | undefined;
  private reason: string | undefined;

  constructor(options: LocalEmbeddingProviderOptions) {
    this.modelSpec = options.model ?? DEFAULT_LOCAL_EMBEDDING_MODEL;
    if (!/^[a-z0-9._-]+$/i.test(this.modelSpec.cacheKey)
      || !/^[a-f0-9]{40}$/i.test(this.modelSpec.revision)
      || this.modelSpec.assets.length === 0
      || this.modelSpec.assets.some((asset) => (
        path.isAbsolute(asset.path)
        || asset.path.split('/').includes('..')
        || asset.bytes < 1
        || !/^[a-f0-9]{64}$/i.test(asset.sha256)
      ))) throw new Error('Local embedding model manifest 无效');
    this.model = `local:${this.modelSpec.id}@${this.modelSpec.revision}:q8`;
    this.modelDirectory = path.join(
      path.resolve(options.dataRoot),
      'memory',
      'models',
      this.modelSpec.cacheKey,
      this.modelSpec.revision,
    );
    this.fetchAsset = options.fetchAsset ?? ((url) => globalThis.fetch(url));
    this.pipelineFactory = options.pipelineFactory ?? defaultPipelineFactory;
    this.platform = options.platform ?? process.platform;
    this.architecture = options.architecture ?? process.arch;
  }

  async embed(
    inputs: string[],
    options: { purpose: EmbeddingPurpose; allowDownload: boolean; timeoutMs?: number },
  ): Promise<number[][] | undefined> {
    if (inputs.length === 0 || !supported(this.platform, this.architecture)) {
      this.state = 'unsupported';
      this.reason = 'unsupported_platform';
      return undefined;
    }
    if (this.inferenceCircuitOpen) {
      this.state = 'unavailable';
      this.reason = 'inference_timeout';
      return undefined;
    }
    if (!await this.ensureAssets(options.allowDownload)) return undefined;
    try {
      const output = await withTimeout((async () => {
        this.pipelinePromise ??= this.pipelineFactory(this.modelDirectory);
        const pipeline = await this.pipelinePromise;
        const values = options.purpose === 'query'
          ? inputs.map((input) => `${this.modelSpec.queryInstruction}${input}`)
          : inputs;
        return pipeline(values, { pooling: 'cls', normalize: true });
      })(), options.timeoutMs);
      const vectors = output.tolist();
      if (!validVectorBatch(vectors, inputs.length)) {
        this.state = 'unavailable';
        this.reason = 'invalid_runtime_output';
        return undefined;
      }
      this.state = 'ready';
      this.reason = undefined;
      return vectors;
    } catch (error) {
      if (error instanceof LocalEmbeddingTimeoutError) this.inferenceCircuitOpen = true;
      else this.pipelinePromise = undefined;
      this.state = 'unavailable';
      this.reason = error instanceof LocalEmbeddingTimeoutError
        ? 'inference_timeout'
        : 'runtime_load_or_inference_failed';
      return undefined;
    }
  }

  async diagnostics(): Promise<EmbeddingProviderDiagnostics> {
    if (!supported(this.platform, this.architecture)) {
      this.state = 'unsupported';
      this.reason = 'unsupported_platform';
    } else if (this.state !== 'unavailable') {
      this.state = await this.assetState();
      this.reason = this.state === 'missing'
        ? 'model_assets_missing'
        : this.state === 'corrupt'
        ? 'model_asset_digest_mismatch'
        : undefined;
    }
    return {
      kind: this.kind,
      state: this.state ?? 'missing',
      model: this.model,
      revision: this.modelSpec.revision,
      modelBytes: this.modelSpec.assets.reduce((total, asset) => total + asset.bytes, 0),
      runtime: 'onnxruntime-node@1.24.3+@huggingface/tokenizers@0.1.3',
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }

  private async ensureAssets(allowDownload: boolean): Promise<boolean> {
    this.state = await this.assetState();
    if (this.state === 'ready') return true;
    if (!allowDownload) {
      this.reason = this.state === 'corrupt'
        ? 'model_asset_digest_mismatch'
        : 'model_assets_missing';
      return false;
    }
    try {
      await mkdir(this.modelDirectory, { recursive: true, mode: 0o700 });
      await chmod(this.modelDirectory, 0o700);
      for (const asset of this.modelSpec.assets) {
        if (await this.assetValid(asset)) continue;
        await this.download(asset);
      }
      this.state = await this.assetState();
      this.reason = this.state === 'ready' ? undefined : 'model_asset_digest_mismatch';
      return this.state === 'ready';
    } catch {
      this.state = await this.assetState();
      this.reason = this.state === 'corrupt'
        ? 'model_asset_digest_mismatch'
        : 'model_download_failed';
      return false;
    }
  }

  private async assetState(): Promise<'ready' | 'missing' | 'corrupt'> {
    let missing = false;
    for (const asset of this.modelSpec.assets) {
      const target = path.join(this.modelDirectory, ...asset.path.split('/'));
      try {
        const metadata = await stat(target);
        if (!metadata.isFile() || metadata.size !== asset.bytes) return 'corrupt';
        if (await sha256(target) !== asset.sha256) return 'corrupt';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing = true;
        else return 'corrupt';
      }
    }
    return missing ? 'missing' : 'ready';
  }

  private async assetValid(asset: LocalEmbeddingAsset): Promise<boolean> {
    const target = path.join(this.modelDirectory, ...asset.path.split('/'));
    try {
      const metadata = await stat(target);
      return metadata.isFile()
        && metadata.size === asset.bytes
        && await sha256(target) === asset.sha256;
    } catch {
      return false;
    }
  }

  private async download(asset: LocalEmbeddingAsset): Promise<void> {
    const relativePath = asset.path.split('/').map(encodeURIComponent).join('/');
    const repository = this.modelSpec.id.split('/').map(encodeURIComponent).join('/');
    const url = `https://huggingface.co/${repository}/resolve/${this.modelSpec.revision}/${relativePath}?download=true`;
    const response = await this.fetchAsset(url);
    if (!response.ok) throw new Error('model_download_failed');
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== asset.bytes || digest !== asset.sha256) {
      throw new Error('model_asset_digest_mismatch');
    }
    const target = path.join(this.modelDirectory, ...asset.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temporary, target);
      await chmod(target, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
