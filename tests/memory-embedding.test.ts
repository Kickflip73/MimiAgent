import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type OpenAI from 'openai';
import {
  createMemoryHub,
  routedMemoryEmbeddingProvider,
} from '../src/extensions/memory/hub.js';
import {
  LocalEmbeddingProvider,
  type LocalEmbeddingModelSpec,
} from '../src/extensions/memory/local-embedding-provider.js';

function context(root: string) {
  return {
    profileId: 'owner',
    workspaceRoot: root,
    sessionId: 'memory-embedding-test',
    runId: 'run-1',
    cause: { trust: 'owner' as const, source: 'test' },
  };
}

test('MemoryHub uses an embedding provider boundary and only explicit reindex may prepare assets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-provider-'));
  const calls: Array<{
    inputs: string[];
    purpose: 'query' | 'document';
    allowDownload: boolean;
    timeoutMs?: number;
  }> = [];
  const embeddingProvider = {
    kind: 'local' as const,
    model: 'fixture-semantic-model@1',
    embed: async (
      inputs: string[],
      options: { purpose: 'query' | 'document'; allowDownload: boolean; timeoutMs?: number },
    ) => {
      calls.push({ inputs, ...options });
      return inputs.map((input) => (
        /路线图|未来三个月/u.test(input) ? [1, 0, 0] : [0, 1, 0]
      ));
    },
    diagnostics: async () => ({
      kind: 'local' as const,
      state: 'ready' as const,
      model: 'fixture-semantic-model@1',
      revision: 'fixture-revision',
      modelBytes: 1,
    }),
  };
  const hub = await createMemoryHub({
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    profileId: 'owner',
    embeddingProvider,
  } as unknown as Parameters<typeof createMemoryHub>[0]);
  const ctx = context(root);
  const relevant = await hub.remember({
    title: '季度路线图',
    content: '路线图记录了接下来一个季度的交付优先级。',
    kind: 'fact',
  }, ctx);
  await hub.remember({
    title: '厨房清单',
    content: '厨房需要补充滤纸。',
    kind: 'fact',
  }, ctx);

  assert.equal((await hub.search('未来三个月优先做什么', ctx))[0]?.ref.id, relevant.ref.id);
  assert.ok(calls.some((call) => call.purpose === 'document' && !call.allowDownload));
  assert.ok(calls.some((call) => call.purpose === 'query' && !call.allowDownload));
  assert.ok(calls.filter((call) => call.purpose === 'document').every((call) => (
    typeof call.timeoutMs === 'number' && call.timeoutMs > 0
  )));

  await hub.reindex(ctx);
  assert.ok(calls.some((call) => call.purpose === 'document' && call.allowDownload));
  const status = await hub.status(ctx) as unknown as {
    providerConfigured: boolean;
    embeddingProvider: string;
    embeddingState: string;
  };
  assert.equal(status.providerConfigured, true);
  assert.equal(status.embeddingProvider, 'local');
  assert.equal(status.embeddingState, 'ready');
});

test('local provider downloads pinned assets only when allowed and rejects cache corruption', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-local-embedding-assets-'));
  const payloads = new Map([
    ['config.json', new TextEncoder().encode('{"model":"fixture"}')],
    ['onnx/model_quantized.onnx', new Uint8Array([1, 3, 5, 7, 9])],
  ]);
  const model: LocalEmbeddingModelSpec = {
    id: 'fixture/semantic-model',
    cacheKey: 'fixture-semantic-model',
    revision: 'a'.repeat(40),
    queryInstruction: 'query: ',
    assets: [...payloads].map(([assetPath, bytes]) => ({
      path: assetPath,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  };
  const downloads: string[] = [];
  const embedded: string[][] = [];
  const provider = new LocalEmbeddingProvider({
    dataRoot: root,
    model,
    fetchAsset: async (url) => {
      downloads.push(url);
      const assetPath = [...payloads.keys()].find((candidate) => url.includes(candidate));
      return assetPath
        ? new Response(payloads.get(assetPath))
        : new Response(null, { status: 404 });
    },
    pipelineFactory: async () => async (inputs) => {
      embedded.push(inputs);
      return { tolist: () => inputs.map(() => [0.6, 0.8]) };
    },
  });

  assert.equal((await provider.diagnostics()).state, 'missing');
  assert.equal(await provider.embed(['semantic query'], {
    purpose: 'query', allowDownload: false,
  }), undefined);
  assert.equal(downloads.length, 0);
  assert.deepEqual(await provider.embed(['semantic query'], {
    purpose: 'query', allowDownload: true,
  }), [[0.6, 0.8]]);
  assert.deepEqual(embedded, [['query: semantic query']]);
  assert.equal(downloads.length, model.assets.length);
  assert.ok(downloads.every((url) => url.includes(model.revision)));
  assert.equal((await provider.diagnostics()).state, 'ready');

  const modelRoot = path.join(root, 'memory', 'models', model.cacheKey, model.revision);
  assert.equal((await stat(modelRoot)).mode & 0o777, 0o700);
  for (const asset of model.assets) {
    assert.equal((await stat(path.join(modelRoot, ...asset.path.split('/')))).mode & 0o777, 0o600);
  }

  await writeFile(path.join(modelRoot, 'config.json'), 'corrupt');
  const restarted = new LocalEmbeddingProvider({ dataRoot: root, model });
  assert.equal((await restarted.diagnostics()).state, 'corrupt');
  assert.equal(await restarted.embed(['query'], {
    purpose: 'query', allowDownload: false,
  }), undefined);
});

test('unsupported local embedding platform stays available as lexical-only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-local-embedding-platform-'));
  const provider = new LocalEmbeddingProvider({
    dataRoot: root,
    platform: 'aix',
    architecture: 'ppc64',
  });
  assert.equal(await provider.embed(['query'], {
    purpose: 'query', allowDownload: true,
  }), undefined);
  assert.equal((await provider.diagnostics()).state, 'unsupported');
});

test('local embedding timeout returns control for lexical fallback when inference stalls', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-local-embedding-timeout-'));
  const bytes = new Uint8Array([2, 4, 6, 8]);
  const model: LocalEmbeddingModelSpec = {
    id: 'fixture/stalled-model',
    cacheKey: 'fixture-stalled-model',
    revision: 'b'.repeat(40),
    queryInstruction: '',
    assets: [{
      path: 'model.bin',
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }],
  };
  const provider = new LocalEmbeddingProvider({
    dataRoot: root,
    model,
    fetchAsset: async () => new Response(bytes),
    pipelineFactory: async () => async () => new Promise(() => undefined),
  });
  const result = await Promise.race([
    provider.embed(['stalled query'], {
      purpose: 'query', allowDownload: true, timeoutMs: 10,
    }),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error('local embedding timeout was ignored')),
      250,
    )),
  ]);
  assert.equal(result, undefined);
  assert.equal((await provider.diagnostics()).reason, 'inference_timeout');
});

test('local embedding timeout opens an instance circuit without starting more inference sessions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-local-embedding-timeout-circuit-'));
  const bytes = new Uint8Array([1, 3, 5, 7]);
  const model: LocalEmbeddingModelSpec = {
    id: 'fixture/stalled-circuit-model',
    cacheKey: 'fixture-stalled-circuit-model',
    revision: 'c'.repeat(40),
    queryInstruction: '',
    assets: [{
      path: 'model.bin',
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }],
  };
  let factoryCalls = 0;
  let inferenceCalls = 0;
  const provider = new LocalEmbeddingProvider({
    dataRoot: root,
    model,
    fetchAsset: async () => new Response(bytes),
    pipelineFactory: async () => {
      factoryCalls += 1;
      return async () => {
        inferenceCalls += 1;
        return new Promise(() => undefined);
      };
    },
  });

  assert.equal(await provider.embed(['first stalled query'], {
    purpose: 'query', allowDownload: true, timeoutMs: 10,
  }), undefined);
  const second = await Promise.race([
    provider.embed(['second query after timeout'], {
      purpose: 'query', allowDownload: false,
    }),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error('timeout circuit did not return immediately')),
      250,
    )),
  ]);

  assert.equal(second, undefined);
  assert.equal(factoryCalls, 1);
  assert.equal(inferenceCalls, 1);
  assert.equal((await provider.diagnostics()).reason, 'inference_timeout');

  const restarted = new LocalEmbeddingProvider({
    dataRoot: root,
    model,
    pipelineFactory: async () => async (inputs) => ({
      tolist: () => inputs.map(() => [0.6, 0.8]),
    }),
  });
  assert.deepEqual(await restarted.embed(['query after provider rebuild'], {
    purpose: 'query', allowDownload: false,
  }), [[0.6, 0.8]]);
});

test('runtime defaults to local embedding and requires a dedicated key to opt into remote', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-local-embedding-default-'));
  const embeddingClient = {
    embeddings: { create: async () => ({ data: [] }) },
  } as unknown as OpenAI;
  const local = routedMemoryEmbeddingProvider({ dataRoot: root, embeddingClient }, {
    OPENAI_API_KEY: 'chat-only-key',
  });
  assert.equal(local.kind, 'local');
  const remote = routedMemoryEmbeddingProvider({
    dataRoot: root,
    embeddingClient,
  }, {
    MIMI_EMBEDDING_API_KEY: 'embedding-key',
    EMBEDDING_MODEL: 'embedding-model',
  });
  assert.equal(remote.kind, 'remote');
  assert.equal(remote.model, 'embedding-model');
});

test('memory doctor directs a missing local model to the existing reindex action', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-local-embedding-doctor-'));
  const embeddingProvider = {
    kind: 'local' as const,
    model: 'local-fixture@1',
    embed: async () => undefined,
    diagnostics: async () => ({
      kind: 'local' as const,
      state: 'missing' as const,
      model: 'local-fixture@1',
    }),
  };
  const hub = await createMemoryHub({
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    profileId: 'owner',
    embeddingProvider,
  } as unknown as Parameters<typeof createMemoryHub>[0]);
  const status = await hub.status(context(root));
  assert.equal(status.providerConfigured, true);
  assert.equal(status.embeddingState, 'missing');
  assert.equal(status.retrievalMode, 'lexical-only');
  assert.equal(status.nextAction, 'run-reindex');
});
