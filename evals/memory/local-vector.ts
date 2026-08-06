import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { MemoryStatusSnapshot, RunMemoryContext } from '../../src/core/memory.js';
import {
  createMemoryHub,
  createRoutedMemoryHub,
} from '../../src/extensions/memory/hub.js';
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from '../../src/extensions/memory/local-embedding-provider.js';

type ReadyVectorState = 'ready';
type HybridRetrievalMode = 'hybrid';

export interface LocalVectorAcceptanceReport {
  schemaVersion: 1;
  provider: 'local';
  apiKeysPresent: false;
  model: string;
  revision: string;
  modelBytes: number;
  prepare: {
    lexicalHits: number;
    hybridHits: number;
    topHitCorrect: boolean;
    vectorRows: number;
    vectorState: ReadyVectorState;
    retrievalMode: HybridRetrievalMode;
    networkCalls: number;
    reindexMs: number;
  };
  offlineRestart: {
    topHitCorrect: boolean;
    vectorRows: number;
    vectorState: ReadyVectorState;
    retrievalMode: HybridRetrievalMode;
    networkCalls: number;
    startupMs: number;
    warmQueryP50Ms: number;
    warmQueryP95Ms: number;
    rssBytes: number;
    rssDeltaBytes: number;
  };
}

type PreparePhase = LocalVectorAcceptanceReport['prepare'] & {
  phase: 'prepare';
  provider: 'local';
  apiKeysPresent: false;
  model: string;
  revision: string;
  modelBytes: number;
};

type OfflinePhase = LocalVectorAcceptanceReport['offlineRestart'] & {
  phase: 'offline';
  provider: 'local';
  apiKeysPresent: false;
};

const MODEL_LIMIT_BYTES = 100 * 1024 * 1024;
const WARM_QUERY_P95_LIMIT_MS = 200;
const RSS_DELTA_LIMIT_BYTES = 300 * 1024 * 1024;
const SEMANTIC_QUERY = '未来三个月优先做什么';
const EXPECTED_TITLE = '季度路线图';
const FIXTURES = [
  ['季度路线图', '路线图记录了接下来一个季度的交付优先级。'],
  ['设计评审', '周四下午与设计团队评审新版交互方案。'],
  ['外部等待', '供应商尚未提供安全审计报告。'],
  ['支付风险', '支付模块上线前仍需验证回滚预案。'],
  ['车辆维护', '发动机润滑油每十二个月更换一次。'],
  ['预算会议', '本周五上午审查下一财年的费用计划。'],
] as const;

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)]!;
}

function acceptanceError(message: string): never {
  throw new Error(`Local vector acceptance failed: ${message}`);
}

export function assertLocalVectorAcceptance(
  value: LocalVectorAcceptanceReport,
): asserts value is LocalVectorAcceptanceReport {
  if (value.schemaVersion !== 1) acceptanceError('schema version');
  if (value.provider !== 'local' || value.apiKeysPresent !== false) acceptanceError('zero-key local provider');
  if (!/^local:.+@[a-f0-9]{40}:q8$/i.test(value.model)) acceptanceError('pinned model identity');
  if (!/^[a-f0-9]{40}$/i.test(value.revision)) acceptanceError('pinned revision');
  if (!(value.modelBytes > 0 && value.modelBytes <= MODEL_LIMIT_BYTES)) acceptanceError('model size');
  if (value.prepare.lexicalHits !== 0
    || value.prepare.hybridHits < 1
    || !value.prepare.topHitCorrect) acceptanceError('semantic vector gain');
  if (value.prepare.vectorRows < 1
    || value.prepare.vectorState !== 'ready'
    || value.prepare.retrievalMode !== 'hybrid') acceptanceError('prepared vector state');
  if (!Number.isFinite(value.prepare.reindexMs) || value.prepare.reindexMs < 0) acceptanceError('reindex timing');
  if (value.offlineRestart.networkCalls !== 0 || !value.offlineRestart.topHitCorrect) {
    acceptanceError('offline restart');
  }
  if (value.offlineRestart.vectorRows < 1
    || value.offlineRestart.vectorState !== 'ready'
    || value.offlineRestart.retrievalMode !== 'hybrid') acceptanceError('offline vector state');
  if (!(value.offlineRestart.warmQueryP95Ms >= value.offlineRestart.warmQueryP50Ms
    && value.offlineRestart.warmQueryP95Ms <= WARM_QUERY_P95_LIMIT_MS)) {
    acceptanceError('warm query latency');
  }
  if (!(value.offlineRestart.rssDeltaBytes >= 0
    && value.offlineRestart.rssDeltaBytes <= RSS_DELTA_LIMIT_BYTES)) acceptanceError('resident memory delta');
}

function context(workspaceRoot: string): RunMemoryContext {
  return {
    profileId: 'local-vector-eval',
    workspaceRoot,
    sessionId: 'local-vector-eval',
    runId: 'local-vector-eval-run',
    cause: { trust: 'owner', source: 'fixture-eval' },
  };
}

function readyStatus(status: MemoryStatusSnapshot): {
  vectorRows: number;
  vectorState: ReadyVectorState;
  retrievalMode: HybridRetrievalMode;
} {
  if (status.vectorState !== 'ready' || status.retrievalMode !== 'hybrid') {
    acceptanceError([
      'MemoryHub did not enter hybrid ready state',
      status.embeddingState ?? 'unknown-provider',
      status.vectorState ?? 'unknown-vector',
      status.nextAction ?? 'unknown-action',
    ].join('/'));
  }
  const vectorRows = status.vectorRows ?? 0;
  if (vectorRows < 1) acceptanceError('MemoryHub stored no vec0 rows');
  return { vectorRows, vectorState: status.vectorState, retrievalMode: status.retrievalMode };
}

async function runPreparePhase(root: string): Promise<PreparePhase> {
  const workspaceRoot = path.join(root, 'workspace');
  const dataRoot = path.join(root, 'data');
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...arguments_) => {
    networkCalls += 1;
    return originalFetch(...arguments_);
  };
  try {
    const lexicalHub = await createMemoryHub({
      workspaceRoot,
      dataRoot,
      profileId: 'local-vector-eval',
      retrievalMode: 'lexical',
      cutover: false,
    });
    const ctx = context(workspaceRoot);
    for (const [index, fixture] of FIXTURES.entries()) {
      await lexicalHub.remember({ title: fixture[0], content: fixture[1], kind: 'fact' }, {
        ...ctx,
        runId: `${ctx.runId}-${index}`,
      });
    }
    const lexicalHits = (await lexicalHub.search(SEMANTIC_QUERY, ctx, { limit: 5 })).length;
    const hub = createRoutedMemoryHub({
      workspaceRoot,
      dataRoot,
      retrievalMode: 'auto',
    });
    const reindexStarted = performance.now();
    await hub.reindex(ctx);
    const reindexMs = performance.now() - reindexStarted;
    const hits = await hub.search(SEMANTIC_QUERY, ctx, { limit: 5 });
    const status = await hub.status(ctx);
    const ready = readyStatus(status);
    if (status.embeddingProvider !== 'local'
      || !status.configuredEmbeddingModel
      || !status.embeddingRevision
      || !status.embeddingModelBytes) acceptanceError('local provider diagnostics');
    return {
      phase: 'prepare',
      provider: 'local',
      apiKeysPresent: false,
      model: status.configuredEmbeddingModel,
      revision: status.embeddingRevision,
      modelBytes: status.embeddingModelBytes,
      lexicalHits,
      hybridHits: hits.length,
      topHitCorrect: hits[0]?.title === EXPECTED_TITLE,
      ...ready,
      networkCalls,
      reindexMs,
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function runOfflinePhase(root: string): Promise<OfflinePhase> {
  const workspaceRoot = path.join(root, 'workspace');
  const dataRoot = path.join(root, 'data');
  const rssBefore = process.memoryUsage().rss;
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error('network disabled for offline acceptance');
  };
  try {
    const started = performance.now();
    const hub = createRoutedMemoryHub({
      workspaceRoot,
      dataRoot,
      retrievalMode: 'auto',
    });
    const startupMs = performance.now() - started;
    const ctx = context(workspaceRoot);
    const first = await hub.search(SEMANTIC_QUERY, ctx, { limit: 5 });
    const latencies: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const queryStarted = performance.now();
      await hub.search(SEMANTIC_QUERY, ctx, { limit: 5 });
      latencies.push(performance.now() - queryStarted);
    }
    const status = await hub.status(ctx);
    const ready = readyStatus(status);
    if (status.embeddingProvider !== 'local') acceptanceError('offline provider');
    const rssBytes = process.memoryUsage().rss;
    return {
      phase: 'offline',
      provider: 'local',
      apiKeysPresent: false,
      topHitCorrect: first[0]?.title === EXPECTED_TITLE,
      ...ready,
      networkCalls,
      startupMs,
      warmQueryP50Ms: percentile(latencies, 0.5),
      warmQueryP95Ms: percentile(latencies, 0.95),
      rssBytes,
      rssDeltaBytes: Math.max(0, rssBytes - rssBefore),
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.MIMI_EMBEDDING_API_KEY;
  delete environment.OPENAI_API_KEY;
  return environment;
}

async function childPhase(root: string, phase: 'prepare' | 'offline'): Promise<PreparePhase | OfflinePhase> {
  const entry = fileURLToPath(import.meta.url);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx', entry,
      '--phase', phase,
      '--root', root,
    ], {
      cwd: path.resolve(fileURLToPath(new URL('../..', import.meta.url))),
      env: sanitizedEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.stderr.resume();
    child.once('error', () => reject(new Error(`local vector ${phase} phase failed to start`)));
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`local vector ${phase} phase failed`));
        return;
      }
      try {
        resolve(JSON.parse(output) as PreparePhase | OfflinePhase);
      } catch {
        reject(new Error(`local vector ${phase} phase returned invalid output`));
      }
    });
  });
}

async function seedLocalModel(root: string, sourceRoot: string): Promise<void> {
  const targetRoot = path.join(
    root,
    'data',
    'memory',
    'models',
    DEFAULT_LOCAL_EMBEDDING_MODEL.cacheKey,
    DEFAULT_LOCAL_EMBEDDING_MODEL.revision,
  );
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  await chmod(targetRoot, 0o700);
  for (const asset of DEFAULT_LOCAL_EMBEDDING_MODEL.assets) {
    const target = path.join(targetRoot, ...asset.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(path.join(path.resolve(sourceRoot), ...asset.path.split('/')), target);
    await chmod(target, 0o600);
  }
}

export async function runLocalVectorAcceptance(
  options: { modelSeed?: string } = {},
): Promise<LocalVectorAcceptanceReport> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-local-vector-acceptance-'));
  try {
    if (options.modelSeed) await seedLocalModel(root, options.modelSeed);
    const prepare = await childPhase(root, 'prepare') as PreparePhase;
    const offline = await childPhase(root, 'offline') as OfflinePhase;
    const report: LocalVectorAcceptanceReport = {
      schemaVersion: 1,
      provider: prepare.provider,
      apiKeysPresent: prepare.apiKeysPresent,
      model: prepare.model,
      revision: prepare.revision,
      modelBytes: prepare.modelBytes,
      prepare: {
        lexicalHits: prepare.lexicalHits,
        hybridHits: prepare.hybridHits,
        topHitCorrect: prepare.topHitCorrect,
        vectorRows: prepare.vectorRows,
        vectorState: prepare.vectorState,
        retrievalMode: prepare.retrievalMode,
        networkCalls: prepare.networkCalls,
        reindexMs: prepare.reindexMs,
      },
      offlineRestart: {
        topHitCorrect: offline.topHitCorrect,
        vectorRows: offline.vectorRows,
        vectorState: offline.vectorState,
        retrievalMode: offline.retrievalMode,
        networkCalls: offline.networkCalls,
        startupMs: offline.startupMs,
        warmQueryP50Ms: offline.warmQueryP50Ms,
        warmQueryP95Ms: offline.warmQueryP95Ms,
        rssBytes: offline.rssBytes,
        rssDeltaBytes: offline.rssDeltaBytes,
      },
    };
    assertLocalVectorAcceptance(report);
    return report;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const phase = argument('--phase');
  const root = argument('--root');
  if (phase === 'prepare' && root) {
    console.log(JSON.stringify(await runPreparePhase(root)));
    return;
  }
  if (phase === 'offline' && root) {
    console.log(JSON.stringify(await runOfflinePhase(root)));
    return;
  }
  console.log(JSON.stringify(await runLocalVectorAcceptance({
    modelSeed: argument('--model-seed') ?? process.env.MIMI_MEMORY_LOCAL_EVAL_MODEL_SEED,
  }), null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    const message = error instanceof Error
      && error.message.startsWith('Local vector acceptance failed:')
      ? error.message
      : 'local vector acceptance failed';
    console.error(message);
    process.exitCode = 1;
  });
}
