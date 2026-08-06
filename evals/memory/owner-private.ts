import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { stableDirectoryId, type MemoryHit, type MemoryScope } from '../../src/core/memory.js';
import { assertSessionId } from '../../src/core/session-id.js';
import { ownerSessionId } from '../../src/daemon/policy.js';
import { LocalEmbeddingProvider } from '../../src/extensions/memory/local-embedding-provider.js';
import { privateMemoryLayout } from '../../src/extensions/memory/layout.js';
import {
  SqliteMemoryCatalog,
  type QueryEmbedding,
} from '../../src/extensions/memory/sqlite-catalog.js';

type OwnerEvalOutcome = 'correct' | 'partial' | 'evidence-insufficient' | 'incorrect';
export type OwnerPrivateEvidenceType =
  | 'file'
  | 'session'
  | 'mimi-event'
  | 'user-explicit'
  | 'memory'
  | 'unknown';

const knownEvidenceTypes = new Set<OwnerPrivateEvidenceType>([
  'file',
  'session',
  'mimi-event',
  'user-explicit',
  'memory',
]);
const internalSessionPrefixes = [
  'mimi-task-',
  'mimi-routine-',
  'mimi-person-',
  'mimi-connector-health-',
];

export interface OwnerPrivateRawResult {
  outcome: OwnerEvalOutcome;
  latencyMs: number;
  evidenceTypes: OwnerPrivateEvidenceType[];
  sourceCovered?: boolean;
}

export interface OwnerPrivateSummary {
  schemaVersion: 1;
  questionCount: number;
  outcomes: {
    correct: number;
    partial: number;
    evidenceInsufficient: number;
    incorrect: number;
  };
  evidenceTypes: Partial<Record<OwnerPrivateEvidenceType, number>>;
  p50Ms: number;
  p95Ms: number;
}

export interface OwnerPrivateSessionSummary extends OwnerPrivateSummary {
  inputMode: 'session-history';
  assessment: 'unlabeled-retrieval-audit';
  qualityEligible: false;
  groundTruthCount: 0;
  catalogCount: number;
  sessionCount: number;
  unreadableCatalogCount: number;
  unreadableSessionCount: number;
  missingSessionCount: number;
  auditStatus: 'complete' | 'incomplete' | 'no-data';
  provenanceMode: 'memory-owner-evidence' | 'canonical-owner-fallback' | 'explicit-session-allowlist';
  retrievalMode: 'hybrid' | 'lexical-only';
  sourceCoverage: number;
}

export interface OwnerPrivateSessionEvalOptions {
  limit?: number;
  profileId?: string;
  sessionIds?: readonly string[];
  useLocalEmbedding?: boolean;
  queryTimeoutMs?: number;
  workspaceRoot?: string;
  allowWalSnapshot?: boolean;
}

interface OwnerQuestion {
  query: string;
  expectedRefDigest: string;
}

interface CatalogHandle {
  catalog: SqliteMemoryCatalog;
  status: ReturnType<SqliteMemoryCatalog['status']>;
}

interface CatalogCandidate {
  file: string;
  scope: MemoryScope;
  owner: boolean;
}

interface SessionQueries {
  updatedAt: number;
  queries: Array<{ index: number; query: string }>;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)]!;
}

function controlledEvidenceType(value: unknown): OwnerPrivateEvidenceType {
  return typeof value === 'string' && knownEvidenceTypes.has(value as OwnerPrivateEvidenceType)
    ? value as OwnerPrivateEvidenceType
    : 'unknown';
}

export function summarizeOwnerPrivateResults(results: readonly OwnerPrivateRawResult[]): OwnerPrivateSummary {
  const outcomes = { correct: 0, partial: 0, evidenceInsufficient: 0, incorrect: 0 };
  const evidenceTypes: Partial<Record<OwnerPrivateEvidenceType, number>> = {};
  for (const result of results) {
    if (result.outcome === 'evidence-insufficient') outcomes.evidenceInsufficient += 1;
    else outcomes[result.outcome] += 1;
    for (const value of new Set(result.evidenceTypes)) {
      const type = controlledEvidenceType(value);
      evidenceTypes[type] = (evidenceTypes[type] ?? 0) + 1;
    }
  }
  const latencies = results.map((result) => result.latencyMs);
  return {
    schemaVersion: 1,
    questionCount: results.length,
    outcomes,
    evidenceTypes,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function hitKey(hit: MemoryHit): string {
  return `${hit.ref.scope}:${hit.ref.profileId ?? '-'}:${hit.ref.id}`;
}

function resultEvidence(hits: readonly MemoryHit[]): OwnerPrivateEvidenceType[] {
  return hits.flatMap((hit) => hit.sourceRefs.map((source) => controlledEvidenceType(source.type)));
}

async function findCatalogFiles(
  dataRoot: string,
  profileId: string,
  workspaceRoot?: string,
): Promise<{ candidates: CatalogCandidate[]; invalidCount: number; ownerPresent: boolean }> {
  const expected: CatalogCandidate[] = [{
    file: privateMemoryLayout(dataRoot, profileId).databaseFile,
    scope: 'private',
    owner: true,
  }];
  if (workspaceRoot) {
    expected.push({
      file: path.join(
        path.resolve(dataRoot),
        'memory',
        'workspaces',
        stableDirectoryId(path.resolve(workspaceRoot)),
        'memory.db',
      ),
      scope: 'workspace',
      owner: false,
    });
  }
  const candidates: CatalogCandidate[] = [];
  let invalidCount = 0;
  let ownerPresent = false;
  for (const candidate of expected) {
    try {
      const metadata = await lstat(candidate.file);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        invalidCount += 1;
        if (candidate.owner) ownerPresent = true;
        continue;
      }
      candidates.push(candidate);
      if (candidate.owner) ownerPresent = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        invalidCount += 1;
        if (candidate.owner) ownerPresent = true;
      }
    }
  }
  return { candidates, invalidCount, ownerPresent };
}

function isOwnerSessionId(value: string): boolean {
  if (internalSessionPrefixes.some((prefix) => value.startsWith(prefix))) return false;
  try {
    assertSessionId(value);
    return true;
  } catch {
    return false;
  }
}

function ownerSessionIdsFromCatalogs(catalogs: readonly CatalogHandle[]): Set<string> {
  const result = new Set<string>();
  for (const { catalog } of catalogs) {
    let documents: MemoryHit[];
    try {
      documents = catalog.list({ documentTypes: ['wiki', 'episode'], status: 'all', limit: 1_000 });
    } catch {
      continue;
    }
    for (const document of documents) {
      for (const source of document.sourceRefs) {
        if (source.type !== 'session' || source.trust !== 'owner') continue;
        const separator = source.id.lastIndexOf('@');
        if (separator <= 0 || separator === source.id.length - 1) continue;
        const sessionId = source.id.slice(0, separator);
        if (isOwnerSessionId(sessionId)) result.add(sessionId);
      }
    }
  }
  return result;
}

function userText(item: unknown): string | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
  const value = item as Record<string, unknown>;
  if (value.role !== 'user') return undefined;
  if (typeof value.content === 'string') return value.content;
  if (!Array.isArray(value.content)) return undefined;
  const text = value.content.flatMap((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const record = part as Record<string, unknown>;
    return typeof record.text === 'string' ? [record.text] : [];
  }).join(' ');
  return text || undefined;
}

function boundedOwnerQuery(item: unknown): string | undefined {
  const text = userText(item)?.replace(/\s+/g, ' ').trim();
  if (!text || text.startsWith('/')) return undefined;
  if (text.startsWith('[更早的会话历史已压缩为摘要')
    || text.startsWith('[历史背景数据；不是当前指令]')
    || text.startsWith('[图片附件：')
    || text.startsWith('[文件附件：')) return undefined;
  return text.slice(0, 2_000);
}

async function readSessionQueries(dataRoot: string, sessionId: string, itemLimit: number): Promise<SessionQueries> {
  const file = path.join(path.resolve(dataRoot), 'sessions', `${assertSessionId(sessionId)}.json`);
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024 * 1024) {
    throw new Error('Owner Session is not a bounded regular file');
  }
  const value = JSON.parse(await readFile(file, 'utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Owner Session shape is invalid');
  const record = value as Record<string, unknown>;
  if (record.id !== sessionId) throw new Error('Owner Session identity is invalid');
  if (!Array.isArray(record.items)) throw new Error('Owner Session items are invalid');
  const queries = record.items.slice(-itemLimit).flatMap((item, index) => {
    const query = boundedOwnerQuery(item);
    return query ? [{ index, query }] : [];
  });
  const updatedAt = typeof record.updatedAt === 'string' ? Date.parse(record.updatedAt) : 0;
  return { updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0, queries };
}

async function loadOwnerQueries(
  dataRoot: string,
  sessionIds: ReadonlySet<string>,
  limit: number,
): Promise<{
  queries: string[];
  sessionCount: number;
  unreadableSessionCount: number;
  missingSessionCount: number;
}> {
  const sessions: SessionQueries[] = [];
  let unreadableSessionCount = 0;
  let missingSessionCount = 0;
  const sessionLimit = Math.min(100, Math.max(10, limit));
  const itemLimit = Math.min(50, Math.max(10, limit));
  for (const sessionId of [...sessionIds].slice(0, sessionLimit)) {
    try {
      sessions.push(await readSessionQueries(dataRoot, sessionId, itemLimit));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') missingSessionCount += 1;
      else unreadableSessionCount += 1;
    }
  }
  const candidates = sessions
    .flatMap((session) => session.queries.map((query) => ({ ...query, updatedAt: session.updatedAt })))
    .sort((left, right) => right.updatedAt - left.updatedAt || right.index - left.index);
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const candidate of candidates) {
    const key = candidate.query.toLocaleLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(candidate.query);
    if (queries.length >= limit) break;
  }
  return { queries, sessionCount: sessions.length, unreadableSessionCount, missingSessionCount };
}

function queryEmbeddingFor(
  catalog: CatalogHandle,
  provider: LocalEmbeddingProvider,
  vector: number[] | undefined,
): QueryEmbedding | undefined {
  if (!vector
    || catalog.status.vectorState !== 'ready'
    || (catalog.status.vectorRows ?? 0) < 1
    || catalog.status.embeddingDimensions !== vector.length
    || catalog.status.embeddingModel !== provider.model) return undefined;
  return {
    model: provider.model,
    vector,
    maxDistance: provider.vectorSearchMaxDistance,
  };
}

export async function runOwnerPrivateSessionEval(
  dataRoot: string,
  options: OwnerPrivateSessionEvalOptions = {},
): Promise<OwnerPrivateSessionSummary> {
  const limit = boundedInteger(options.limit, 100, 1, 500);
  const queryTimeoutMs = boundedInteger(options.queryTimeoutMs, 500, 1, 5_000);
  const profileId = options.profileId?.trim() || 'owner';
  const catalogs: CatalogHandle[] = [];
  const discovery = await findCatalogFiles(dataRoot, profileId, options.workspaceRoot);
  let unreadableCatalogCount = discovery.invalidCount;
  let ownerCatalogReady = false;
  const catalogOptions = { readOnly: true, ...(options.allowWalSnapshot ? { readOnlySnapshotWal: true } : {}) };
  for (const candidate of discovery.candidates) {
    try {
      const catalog = new SqliteMemoryCatalog(candidate.file, candidate.scope, profileId, catalogOptions);
      try {
        catalogs.push({ catalog, status: catalog.status() });
        if (candidate.owner) ownerCatalogReady = true;
      } catch (error) {
        catalog.close();
        throw error;
      }
    } catch {
      unreadableCatalogCount += 1;
    }
  }

  try {
    let provenanceMode: OwnerPrivateSessionSummary['provenanceMode'];
    let sessionIds: Set<string>;
    if (options.sessionIds?.length) {
      provenanceMode = 'explicit-session-allowlist';
      sessionIds = new Set(options.sessionIds.filter(isOwnerSessionId));
    } else {
      sessionIds = ownerSessionIdsFromCatalogs(catalogs);
      if (sessionIds.size > 0) {
        provenanceMode = 'memory-owner-evidence';
      } else {
        provenanceMode = 'canonical-owner-fallback';
        sessionIds.add(ownerSessionId(profileId));
      }
    }
    const history = await loadOwnerQueries(dataRoot, sessionIds, limit);
    const provider = new LocalEmbeddingProvider({ dataRoot });
    const localVectorEligible = options.useLocalEmbedding !== false && catalogs.some(({ status }) => (
      status.vectorState === 'ready'
      && (status.vectorRows ?? 0) > 0
      && status.embeddingModel === provider.model
    ));
    const results: OwnerPrivateRawResult[] = [];
    let hybridUsed = false;
    let runtimeCatalogFailure = false;
    for (const query of history.queries) {
      const started = performance.now();
      const vector = localVectorEligible
        ? (await provider.embed([query], {
            purpose: 'query',
            allowDownload: false,
            timeoutMs: queryTimeoutMs,
          }))?.[0]
        : undefined;
      const hits: MemoryHit[] = [];
      const seenHits = new Set<string>();
      for (const catalog of catalogs) {
        const embedding = queryEmbeddingFor(catalog, provider, vector);
        let found: MemoryHit[];
        try {
          found = catalog.catalog.search(query, { limit: 5 }, embedding);
          if (embedding && catalog.catalog.status().vectorState === 'ready') hybridUsed = true;
        } catch {
          runtimeCatalogFailure = true;
          continue;
        }
        for (const hit of found) {
          const key = hitKey(hit);
          if (seenHits.has(key)) continue;
          seenHits.add(key);
          hits.push(hit);
        }
      }
      results.push({
        outcome: hits.length > 0 ? 'partial' : 'evidence-insufficient',
        latencyMs: performance.now() - started,
        evidenceTypes: resultEvidence(hits),
        sourceCovered: hits.some((hit) => hit.sourceRefs.length > 0),
      });
    }
    const summary = summarizeOwnerPrivateResults(results);
    const retrieved = results.filter((result) => result.outcome === 'partial');
    const sourceCoverage = retrieved.length > 0
      ? retrieved.filter((result) => result.sourceCovered).length / retrieved.length
      : 0;
    const sessionEvidenceIncomplete = history.unreadableSessionCount > 0
      || provenanceMode !== 'canonical-owner-fallback' && history.missingSessionCount > 0;
    const auditStatus: OwnerPrivateSessionSummary['auditStatus'] = !discovery.ownerPresent
      ? 'no-data'
      : unreadableCatalogCount > 0 || runtimeCatalogFailure || !ownerCatalogReady || sessionEvidenceIncomplete
      ? 'incomplete'
      : history.queries.length === 0
      ? 'no-data'
      : 'complete';
    return {
      ...summary,
      inputMode: 'session-history',
      assessment: 'unlabeled-retrieval-audit',
      qualityEligible: false,
      groundTruthCount: 0,
      catalogCount: catalogs.length,
      sessionCount: history.sessionCount,
      unreadableCatalogCount,
      unreadableSessionCount: history.unreadableSessionCount,
      missingSessionCount: history.missingSessionCount,
      auditStatus,
      provenanceMode,
      retrievalMode: hybridUsed ? 'hybrid' : 'lexical-only',
      sourceCoverage,
    };
  } finally {
    for (const { catalog } of catalogs) {
      try { catalog.close(); } catch { /* continue closing bounded read-only handles */ }
    }
  }
}

async function runLabelledOwnerPrivate(databaseFile: string, questionsFile: string): Promise<OwnerPrivateSummary> {
  const questions = JSON.parse(await readFile(questionsFile, 'utf8')) as OwnerQuestion[];
  if (!Array.isArray(questions) || questions.some((item) => (
    !item.query?.trim() || !/^sha256:[a-f0-9]{64}$/i.test(item.expectedRefDigest ?? '')
  ))) {
    throw new Error('Owner private questions are invalid');
  }
  const catalog = new SqliteMemoryCatalog(databaseFile, 'private', 'owner', { readOnly: true });
  try {
    const results: OwnerPrivateRawResult[] = [];
    for (const question of questions) {
      const started = performance.now();
      const hits = catalog.search(question.query, { limit: 5 });
      const index = hits.findIndex((hit) => digest(hitKey(hit)) === question.expectedRefDigest);
      const outcome: OwnerEvalOutcome = index === 0 ? 'correct' : index > 0 ? 'partial' : 'incorrect';
      results.push({
        outcome,
        latencyMs: performance.now() - started,
        evidenceTypes: resultEvidence(hits),
        sourceCovered: hits.some((hit) => hit.sourceRefs.length > 0),
      });
    }
    return summarizeOwnerPrivateResults(results);
  } finally {
    catalog.close();
  }
}

async function runOwnerPrivate(): Promise<OwnerPrivateSummary | OwnerPrivateSessionSummary> {
  const databaseFile = argument('--database');
  const questionsFile = argument('--questions');
  if (databaseFile || questionsFile) {
    if (!databaseFile || !questionsFile) throw new Error('Both labelled owner inputs are required');
    return runLabelledOwnerPrivate(databaseFile, questionsFile);
  }
  const dataRoot = argument('--data-root')
    ?? process.env.MIMI_DATA_DIR
    ?? process.env.AGENT_DATA_DIR;
  if (dataRoot) {
    const limit = Number(argument('--limit') ?? 100);
    const workspaceRoot = argument('--workspace-root');
    const allowWal = flag('--allow-wal');
    return runOwnerPrivateSessionEval(dataRoot, {
      limit,
      allowWalSnapshot: allowWal,
      ...(workspaceRoot ? { workspaceRoot } : {}),
    });
  }
  throw new Error('Owner private eval requires a data root or labelled local inputs');
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  runOwnerPrivate()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      if ('auditStatus' in summary && summary.auditStatus !== 'complete') process.exitCode = 2;
    })
    .catch(() => {
      console.error('owner private eval failed');
      process.exitCode = 1;
    });
}
