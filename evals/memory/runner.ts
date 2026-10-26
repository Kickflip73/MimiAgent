import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type OpenAI from 'openai';
import type {
  MemoryDocument,
  MemoryHit,
  MemoryKind,
  MemoryRef,
  MemoryStatus,
  RunMemoryContext,
  SourceRef,
} from '../../src/core/memory.js';
import { createMemoryHub } from '../../src/extensions/memory/hub.js';
import { SqliteMemoryCatalog } from '../../src/extensions/memory/sqlite-catalog.js';

type EvalScenario = 'normal' | 'correction' | 'conflict' | 'expiration' | 'entity-merge'
  | 'source-deletion' | 'reindex';
type EvalOutcome = 'correct' | 'partial' | 'evidence-insufficient' | 'incorrect';

export interface MemoryEvalFixture {
  id: string;
  title: string;
  content: string;
  kind: MemoryKind;
  scenario: EvalScenario;
  tags: string[];
  questions: string[];
  priorTitle?: string;
  priorContent?: string;
  secondaryTitle?: string;
  secondaryContent?: string;
}

export interface MemoryEvalQuestion {
  id: string;
  fixtureId: string;
  query: string;
  tags: string[];
  expected: 'hit' | 'evidence-insufficient';
}

export interface MemoryEvalDataset {
  schemaVersion: 1;
  revision: string;
  fixtures: MemoryEvalFixture[];
  questions: MemoryEvalQuestion[];
}

export interface MemoryEvalModeReport {
  correct: number;
  partial: number;
  evidenceInsufficient: number;
  incorrect: number;
  sourceCoverage: number;
  p50Ms: number;
  p95Ms: number;
}

export interface MemoryEvalReport {
  schemaVersion: 1;
  datasetRevision: string;
  questionCount: number;
  modes: { lexical: MemoryEvalModeReport; hybrid: MemoryEvalModeReport };
  faults: {
    vecUnavailableLexicalSucceeded: boolean;
    wrongDimensionIsolated: boolean;
    embeddingChangeRequiresReindex: boolean;
    reindexRecovered: boolean;
  };
}

interface FixtureState {
  refs: MemoryRef[];
  evidenceIds: string[];
}

interface Manifest {
  schemaVersion: number;
  revision: string;
  fixtures: MemoryEvalFixture[];
}

const datasetFile = fileURLToPath(new URL('./dataset.v1.json', import.meta.url));

export async function loadMemoryEvalDataset(file = datasetFile): Promise<MemoryEvalDataset> {
  const manifest = JSON.parse(await readFile(file, 'utf8')) as Manifest;
  if (manifest.schemaVersion !== 1 || !manifest.revision || !Array.isArray(manifest.fixtures)) {
    throw new Error('Invalid M2 memory eval manifest');
  }
  if (manifest.fixtures.some((fixture) => !Array.isArray(fixture.questions) || !fixture.questions.length)) {
    throw new Error('M2 memory eval fixtures require explicit questions');
  }
  const questions = manifest.fixtures.flatMap((fixture) => fixture.questions.map((query, index) => ({
    id: `${fixture.id}.q${index + 1}`,
    fixtureId: fixture.id,
    query,
    tags: [...fixture.tags],
    expected: fixture.scenario === 'expiration' ? 'evidence-insufficient' as const : 'hit' as const,
  })));
  if (new Set(manifest.fixtures.map((fixture) => fixture.id)).size !== manifest.fixtures.length
    || new Set(questions.map((question) => question.id)).size !== questions.length) {
    throw new Error('M2 memory eval manifest contains duplicate identifiers');
  }
  const normalizedQueries = questions.map((question) => question.query.trim().toLocaleLowerCase().replace(/\s+/g, ' '));
  if (new Set(normalizedQueries).size !== questions.length) {
    throw new Error('M2 memory eval questions must remain distinct after case and whitespace normalization');
  }
  if (questions.some((question) => {
    const terms = question.query.match(/[\p{L}\p{N}]+/gu) ?? [];
    return !question.query.endsWith('?') || terms.length < 4;
  })) throw new Error('M2 memory eval requires natural questions, not lookup tokens');
  if (questions.length < 50) throw new Error('M2 memory eval requires at least 50 deterministic questions');
  return { schemaVersion: 1, revision: manifest.revision, fixtures: manifest.fixtures, questions };
}

function context(root: string): RunMemoryContext {
  return {
    profileId: 'eval',
    workspaceRoot: root,
    sessionId: 'm2-memory-eval',
    runId: 'm2-memory-eval-run',
    cause: { trust: 'owner', source: 'fixture-eval' },
  };
}

function evidence(fixture: MemoryEvalFixture, suffix: string): SourceRef {
  return {
    type: 'mimi-event',
    id: `fixture:${fixture.id}:${suffix}`,
    digest: `sha256:${createHash('sha256').update(`${fixture.id}:${suffix}`).digest('hex')}`,
    occurredAt: '2026-08-05T08:00:00.000Z',
    trust: 'system',
  };
}

const evalEmbeddingDimensions = 512;
const evalStopWords = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'did', 'do', 'does', 'for', 'from',
  'has', 'have', 'how', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'was', 'what',
  'when', 'where', 'which', 'who', 'why', 'with',
]);

function featureHash(feature: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < feature.length; index += 1) {
    hash ^= feature.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Test-only generic text vector used to exercise the vec0/RRF mechanism. */
export function deterministicEvalEmbedding(input: string): number[] {
  const vector = Array.from({ length: evalEmbeddingDimensions }, () => 0);
  const tokens = input.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const token of tokens) {
    if (evalStopWords.has(token)) continue;
    const features = [`word:${token}`];
    const padded = `^${token}$`;
    for (let index = 0; index <= padded.length - 3; index += 1) {
      features.push(`gram:${padded.slice(index, index + 3)}`);
    }
    for (const feature of features) {
      const hash = featureHash(feature);
      const weight = feature.startsWith('word:') ? 2 : 1;
      vector[hash % evalEmbeddingDimensions]! += (hash & 0x80000000) === 0 ? weight : -weight;
    }
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return vector.map((_, index) => index === 0 ? 1 : 0);
  return vector.map((value) => value / magnitude);
}

function fakeEmbeddingClient(): OpenAI {
  return {
    embeddings: {
      create: async (request: { input: string | string[] }) => ({
        data: (Array.isArray(request.input) ? request.input : [request.input])
          .map((input) => ({ embedding: deterministicEvalEmbedding(input) })),
      }),
    },
  } as unknown as OpenAI;
}

async function seedFixture(
  fixture: MemoryEvalFixture,
  hub: Awaited<ReturnType<typeof createMemoryHub>>,
  ctx: RunMemoryContext,
): Promise<FixtureState> {
  const current = evidence(fixture, 'current');
  if (fixture.scenario === 'correction') {
    const priorSource = evidence(fixture, 'prior');
    const prior = await hub.capture({
      title: fixture.priorTitle!, content: fixture.priorContent!, sourceRefs: [priorSource],
      scope: 'private', kind: fixture.kind, confidence: 'source-grounded', reasonCode: 'eval_prior',
    }, ctx);
    const page = await hub.remember({
      title: fixture.title, content: fixture.content, kind: fixture.kind,
      sourceRefs: [current], confidence: 'source-grounded', supersedes: [prior.pageRefs[0]!.id],
    }, { ...ctx, runId: `${ctx.runId}-${fixture.id}` });
    return { refs: [page.ref], evidenceIds: [current.id] };
  }
  if (fixture.scenario === 'entity-merge') {
    const secondarySource = evidence(fixture, 'secondary');
    const target = await hub.capture({
      title: fixture.title, content: fixture.content, sourceRefs: [current], scope: 'private',
      kind: fixture.kind, confidence: 'source-grounded', reasonCode: 'eval_entity_target',
    }, ctx);
    const duplicate = await hub.capture({
      title: fixture.secondaryTitle!, content: fixture.secondaryContent!, sourceRefs: [secondarySource],
      scope: 'private', kind: fixture.kind, confidence: 'source-grounded', reasonCode: 'eval_entity_duplicate',
    }, { ...ctx, runId: `${ctx.runId}-${fixture.id}-secondary` });
    await hub.merge({
      targetRef: target.pageRefs[0]!, mergedRefs: [duplicate.pageRefs[0]!],
      title: fixture.title, content: fixture.content, reasonCode: 'eval_entity_merge',
    }, ctx);
    return { refs: [target.pageRefs[0]!], evidenceIds: [current.id, secondarySource.id] };
  }
  if (fixture.scenario === 'source-deletion') {
    const relative = 'knowledge/sources/source-orchid.md';
    const absolute = path.join(ctx.workspaceRoot, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, `# ${fixture.title}\n\n${fixture.content}\n`, 'utf8');
    const receipt = await hub.ingest(relative, ctx);
    await rm(absolute);
    await hub.reindex(ctx);
    return { refs: receipt.pageRefs, evidenceIds: [relative] };
  }
  const receipt = await hub.capture({
    title: fixture.title,
    content: fixture.content,
    sourceRefs: [current],
    scope: 'private',
    kind: fixture.kind,
    status: fixture.scenario === 'conflict' ? 'conflicted' : 'active',
    confidence: fixture.scenario === 'conflict' ? 'inferred' : 'source-grounded',
    reasonCode: `eval_${fixture.scenario}`,
  }, { ...ctx, runId: `${ctx.runId}-${fixture.id}` });
  if (fixture.scenario === 'expiration') await hub.expire(receipt.pageRefs[0]!, 'eval_expired', ctx);
  if (fixture.scenario === 'reindex') await hub.reindex(ctx);
  return { refs: receipt.pageRefs, evidenceIds: [current.id] };
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)]!;
}

function outcomeFor(
  question: MemoryEvalQuestion,
  hits: MemoryHit[],
  state: FixtureState,
): { outcome: EvalOutcome; covered: number; required: number } {
  if (question.expected === 'evidence-insufficient') {
    return { outcome: hits.length === 0 ? 'evidence-insufficient' : 'incorrect', covered: 0, required: 0 };
  }
  const expected = new Set(state.refs.map((ref) => ref.id));
  const matched = hits.filter((hit) => expected.has(hit.ref.id));
  if (!matched.length) return { outcome: 'incorrect', covered: 0, required: state.evidenceIds.length };
  const evidenceIds = new Set(matched.flatMap((hit) => hit.sourceRefs.map((source) => source.id)));
  const covered = state.evidenceIds.filter((id) => evidenceIds.has(id)).length;
  const complete = covered === state.evidenceIds.length;
  return {
    outcome: expected.has(hits[0]!.ref.id) && complete ? 'correct' : 'partial',
    covered,
    required: state.evidenceIds.length,
  };
}

async function runMode(dataset: MemoryEvalDataset, mode: 'lexical' | 'hybrid'): Promise<MemoryEvalModeReport> {
  const root = await mkdtemp(path.join(os.tmpdir(), `mimi-m2-memory-${mode}-`));
  try {
    const hub = await createMemoryHub({
      workspaceRoot: root,
      dataRoot: path.join(root, 'data'),
      profileId: 'eval',
      cutover: false,
      retrievalMode: mode === 'lexical' ? 'lexical' : 'auto',
      ...(mode === 'hybrid' ? { embeddingClient: fakeEmbeddingClient(), embeddingModel: 'generic-test-ngram-v1' } : {}),
    });
    const ctx = context(root);
    const states = new Map<string, FixtureState>();
    for (const fixture of dataset.fixtures) states.set(fixture.id, await seedFixture(fixture, hub, ctx));
    const counts: Record<EvalOutcome, number> = {
      correct: 0, partial: 0, 'evidence-insufficient': 0, incorrect: 0,
    };
    const latencies: number[] = [];
    let covered = 0;
    let required = 0;
    for (const question of dataset.questions) {
      const started = performance.now();
      const hits = await hub.search(question.query, ctx, { scope: 'all', limit: 5 });
      latencies.push(performance.now() - started);
      const scored = outcomeFor(question, hits, states.get(question.fixtureId)!);
      counts[scored.outcome] += 1;
      covered += scored.covered;
      required += scored.required;
    }
    return {
      correct: counts.correct,
      partial: counts.partial,
      evidenceInsufficient: counts['evidence-insufficient'],
      incorrect: counts.incorrect,
      sourceCoverage: required ? covered / required : 1,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function faultDocument(id: string, body: string): MemoryDocument {
  const timestamp = '2026-08-05T08:00:00.000Z';
  return {
    ref: { scope: 'private', profileId: 'eval', id },
    metadata: {
      schemaVersion: 1, id, title: id, kind: 'fact', scope: 'private', profileId: 'eval',
      status: 'active', confidence: 'source-grounded', aliases: [], tags: [],
      sourceRefs: [{
        type: 'session', id: `session@${id}`, digest: `sha256:${'f'.repeat(64)}`,
        occurredAt: timestamp, trust: 'owner',
      }],
      validFrom: null, validUntil: null, supersedes: [], createdAt: timestamp, updatedAt: timestamp,
    },
    body,
    digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
  };
}

async function runFaultProbes(): Promise<MemoryEvalReport['faults']> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-m2-memory-faults-'));
  try {
    const fallback = faultDocument('mem_fault_fallback_0001', 'Fallback-Lexical fault anchor.');
    const unavailable = new SqliteMemoryCatalog(path.join(root, 'unavailable.db'), 'private', 'eval', {
      loadVectorExtension: () => { throw new Error('injected unavailable'); },
    });
    unavailable.index(fallback, { model: 'model-v1', chunks: [{ index: 0, digest: 'a', vector: [1, 0, 0] }] });
    const vecUnavailableLexicalSucceeded = unavailable.search('Fallback-Lexical', { limit: 3 }, {
      model: 'model-v1', vector: [1, 0, 0],
    })[0]?.ref.id === fallback.ref.id;
    unavailable.close();

    const catalog = new SqliteMemoryCatalog(path.join(root, 'change.db'), 'private', 'eval');
    const first = faultDocument('mem_fault_first_0001', 'First vector record.');
    const second = faultDocument('mem_fault_second_0001', 'Second vector record.');
    catalog.index(first, { model: 'model-v1', chunks: [{ index: 0, digest: 'a', vector: [1, 0, 0] }] });
    catalog.index(second, { model: 'model-v2', chunks: [{ index: 0, digest: 'b', vector: [0, 1] }] });
    const embeddingChangeRequiresReindex = catalog.status().vectorState === 'reindex-required';
    const wrongDimensionIsolated = catalog.search('Semantic-Probe', { limit: 3 }, {
      model: 'model-v1', vector: [1, 0],
    }).length === 0;
    catalog.rebuild([first, second], 'model-v2');
    catalog.index(first, { model: 'model-v2', chunks: [{ index: 0, digest: 'a', vector: [1, 0] }] });
    catalog.index(second, { model: 'model-v2', chunks: [{ index: 0, digest: 'b', vector: [0, 1] }] });
    const reindexRecovered = catalog.search('Semantic-Probe', { limit: 3 }, {
      model: 'model-v2', vector: [1, 0],
    })[0]?.ref.id === first.ref.id;
    catalog.close();
    return {
      vecUnavailableLexicalSucceeded,
      wrongDimensionIsolated,
      embeddingChangeRequiresReindex,
      reindexRecovered,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runMemoryEval(dataset: MemoryEvalDataset): Promise<MemoryEvalReport> {
  return {
    schemaVersion: 1,
    datasetRevision: dataset.revision,
    questionCount: dataset.questions.length,
    modes: {
      lexical: await runMode(dataset, 'lexical'),
      hybrid: await runMode(dataset, 'hybrid'),
    },
    faults: await runFaultProbes(),
  };
}
