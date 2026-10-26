import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AgentInputItem } from '@openai/agents';
import type { MemoryDocument, SourceRef } from '../src/core/memory.js';
import { FileSession } from '../src/core/session.js';
import { ownerSessionId } from '../src/daemon/policy.js';
import { privateMemoryLayout } from '../src/extensions/memory/layout.js';
import { SqliteMemoryCatalog } from '../src/extensions/memory/sqlite-catalog.js';
import {
  deterministicEvalEmbedding,
  loadMemoryEvalDataset,
  runMemoryEval,
} from '../evals/memory/runner.js';
import { assertLocalVectorAcceptance } from '../evals/memory/local-vector.js';
import {
  runOwnerPrivateSessionEval,
  summarizeOwnerPrivateResults,
} from '../evals/memory/owner-private.js';

function privateEvalDocument(
  id: string,
  body: string,
  sourceRefs: SourceRef[],
): MemoryDocument {
  const timestamp = '2026-08-02T00:00:00.000Z';
  return {
    ref: { scope: 'private', profileId: 'owner', id },
    metadata: {
      schemaVersion: 1,
      id,
      title: id,
      kind: 'fact',
      scope: 'private',
      profileId: 'owner',
      status: 'active',
      confidence: 'source-grounded',
      aliases: [],
      tags: ['risk'],
      sourceRefs,
      validFrom: null,
      validUntil: null,
      supersedes: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    body,
    digest: `sha256:${createHash('sha256').update(id).digest('hex')}`,
  };
}

async function fileSnapshot(root: string): Promise<Array<{
  file: string;
  size: number;
  mode: number;
  digest: string;
}>> {
  const result: Array<{ file: string; size: number; mode: number; digest: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        const [metadata, content] = await Promise.all([lstat(absolute), readFile(absolute)]);
        result.push({
          file: path.relative(root, absolute),
          size: metadata.size,
          mode: metadata.mode & 0o777,
          digest: createHash('sha256').update(content).digest('hex'),
        });
      }
    }
  };
  await visit(root);
  return result;
}

test('M2 memory eval has at least 50 distinct natural questions and every required domain and failure scenario', async () => {
  const dataset = await loadMemoryEvalDataset();
  assert.ok(dataset.questions.length >= 50);
  assert.equal(new Set(dataset.questions.map((item) => item.id)).size, dataset.questions.length);
  const normalizedQueries = dataset.questions.map((item) => item.query.trim().toLocaleLowerCase().replace(/\s+/g, ' '));
  assert.equal(new Set(normalizedQueries).size, dataset.questions.length);
  assert.ok(dataset.questions.every((item) => item.query.endsWith('?')));
  const tags = new Set(dataset.questions.flatMap((item) => item.tags));
  for (const required of [
    'people',
    'project',
    'commitment',
    'time',
    'source',
    'correction',
    'conflict',
    'expiration',
    'source-deletion',
    'entity-merge',
    'embedding-change',
    'vec-unavailable',
    'reindex',
  ]) assert.ok(tags.has(required), required);
});

test('M2 hybrid mechanism uses one generic deterministic text embedding for unseen inputs', () => {
  const reference = deterministicEvalEmbedding('invoice approval remains waiting');
  const paraphrase = deterministicEvalEmbedding('waiting for invoice approval');
  const unrelated = deterministicEvalEmbedding('coffee roast preference');
  const cosine = (left: number[], right: number[]) => left.reduce(
    (sum, value, index) => sum + value * (right[index] ?? 0),
    0,
  );
  assert.equal(reference.length, 512);
  assert.deepEqual(reference, deterministicEvalEmbedding('invoice approval remains waiting'));
  assert.ok(cosine(reference, paraphrase) > cosine(reference, unrelated));
});

test('local vector acceptance requires zero-key semantic gain and an offline hybrid restart', () => {
  const report = {
    schemaVersion: 1 as const,
    provider: 'local' as const,
    apiKeysPresent: false as const,
    model: `local:model@${'a'.repeat(40)}:q8`,
    revision: 'a'.repeat(40),
    modelBytes: 24_000_000,
    prepare: {
      lexicalHits: 0,
      hybridHits: 1,
      topHitCorrect: true,
      vectorRows: 6,
      vectorState: 'ready' as const,
      retrievalMode: 'hybrid' as const,
      networkCalls: 5,
      reindexMs: 250,
    },
    offlineRestart: {
      topHitCorrect: true,
      vectorRows: 6,
      vectorState: 'ready' as const,
      retrievalMode: 'hybrid' as const,
      networkCalls: 0,
      startupMs: 25,
      warmQueryP50Ms: 3,
      warmQueryP95Ms: 5,
      rssBytes: 250_000_000,
      rssDeltaBytes: 120_000_000,
    },
  };
  assert.doesNotThrow(() => assertLocalVectorAcceptance(report));
  assert.throws(() => assertLocalVectorAcceptance({
    ...report,
    offlineRestart: { ...report.offlineRestart, networkCalls: 1 },
  }));
  assert.doesNotMatch(JSON.stringify(report), /\"(?:query|content|sourceRef|path)\"\s*:/i);
});

test('M2 memory eval reports lexical/hybrid outcomes, source coverage, latency, and fault probes', async () => {
  const report = await runMemoryEval(await loadMemoryEvalDataset());
  for (const mode of ['lexical', 'hybrid'] as const) {
    const result = report.modes[mode];
    assert.equal(
      result.correct + result.partial + result.evidenceInsufficient + result.incorrect,
      report.questionCount,
    );
    assert.equal(result.incorrect, 0);
    assert.equal(result.sourceCoverage, 1);
    assert.ok(result.p50Ms >= 0);
    assert.ok(result.p95Ms >= result.p50Ms);
  }
  assert.deepEqual(report.faults, {
    vecUnavailableLexicalSucceeded: true,
    wrongDimensionIsolated: true,
    embeddingChangeRequiresReindex: true,
    reindexRecovered: true,
  });
  assert.doesNotMatch(JSON.stringify(report), /query|content|sourceRef|\/Users\//i);
});

test('owner private eval summaries never retain questions, refs, or local paths', () => {
  const summary = summarizeOwnerPrivateResults([
    {
      outcome: 'correct',
      latencyMs: 2,
      evidenceTypes: ['session'],
    },
  ]);
  assert.deepEqual(summary.outcomes, {
    correct: 1, partial: 0, evidenceInsufficient: 0, incorrect: 0,
  });
  assert.deepEqual(summary.evidenceTypes, { session: 1 });
  assert.doesNotMatch(JSON.stringify(summary), /private owner|secret-ref|\/Users\//);
});

test('owner private session eval reads real formats read-only and emits aggregate evidence only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-owner-private-session-eval-'));
  const sessionsRoot = path.join(root, 'sessions');
  const isolatedSessionsRoot = path.join(root, 'isolated-sessions');
  const catalogRoot = path.dirname(privateMemoryLayout(root, 'owner').databaseFile);
  await mkdir(sessionsRoot, { recursive: true });
  const privateQuestion = 'Who is waiting for the Atlas audit report?';
  await new FileSession(sessionsRoot, 'owner-session').addItems([
    { role: 'user', content: privateQuestion },
    { role: 'assistant', content: 'Should this private assistant sentinel be evaluated?' },
  ] as AgentInputItem[]);
  await new FileSession(sessionsRoot, 'external-session').addItems([
    { role: 'user', content: 'Should an unproven external Session be evaluated?' },
  ] as AgentInputItem[]);
  await new FileSession(isolatedSessionsRoot, 'isolated-owner').addItems([
    { role: 'user', content: 'Should isolated task history be evaluated?' },
  ] as AgentInputItem[]);
  const databaseFile = path.join(catalogRoot, 'memory.db');
  const ownerSource: SourceRef = {
    type: 'session', id: 'session-secret-ref', digest: `sha256:${'a'.repeat(64)}`,
    occurredAt: '2026-08-02T00:00:00.000Z', trust: 'owner',
  };
  const catalog = new SqliteMemoryCatalog(databaseFile, 'private', 'owner');
  catalog.index(privateEvalDocument(
    'atlas-secret-ref',
    'The supplier is waiting for the Atlas audit report before release.',
    [ownerSource, { ...ownerSource, type: 'private-secret-type' } as unknown as SourceRef],
  ), { model: 'fixture-vector', chunks: [{ index: 0, digest: 'atlas-chunk', vector: [1, 0, 0] }] });
  catalog.index(privateEvalDocument('owner-episode', 'Private episode body.', [{
    ...ownerSource,
    id: 'owner-session@run-1',
  }]), undefined, 'episode');
  catalog.close();
  const otherProfile = new SqliteMemoryCatalog(
    privateMemoryLayout(root, 'other-profile').databaseFile,
    'private',
    'other-profile',
  );
  otherProfile.index(privateEvalDocument(
    'cross-profile-secret',
    'The Atlas audit report belongs to another profile and must stay invisible.',
    [{ ...ownerSource, id: 'external-session@run-other' }],
  ));
  otherProfile.close();
  const before = await fileSnapshot(root);

  const report = await runOwnerPrivateSessionEval(root, { limit: 10 });

  assert.equal(report.inputMode, 'session-history');
  assert.equal(report.assessment, 'unlabeled-retrieval-audit');
  assert.equal(report.qualityEligible, false);
  assert.equal(report.auditStatus, 'complete');
  assert.equal(report.provenanceMode, 'memory-owner-evidence');
  assert.equal(report.questionCount, 1);
  assert.equal(report.groundTruthCount, 0);
  assert.equal(report.catalogCount, 1);
  assert.equal(report.retrievalMode, 'lexical-only');
  assert.deepEqual(report.outcomes, {
    correct: 0, partial: 1, evidenceInsufficient: 0, incorrect: 0,
  });
  assert.deepEqual(report.evidenceTypes, { session: 1, unknown: 1 });
  assert.equal(report.sourceCoverage, 1);
  assert.deepEqual(await fileSnapshot(root), before);
  assert.doesNotMatch(
    JSON.stringify(report),
    /Atlas audit report|atlas-secret-ref|session-secret-ref|private-secret-type|mimi-owner-private-session-eval/,
  );

  const invalidBounds = await runOwnerPrivateSessionEval(root, {
    limit: Number.NaN,
    queryTimeoutMs: Number.NaN,
  });
  assert.equal(invalidBounds.questionCount, 1);
  assert.equal(invalidBounds.auditStatus, 'complete');
});

test('owner private audit reports no-data and fails closed on an active owner WAL', async () => {
  const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'mimi-owner-private-empty-'));
  const noData = await runOwnerPrivateSessionEval(emptyRoot, { limit: 10 });
  assert.equal(noData.auditStatus, 'no-data');
  assert.equal(noData.catalogCount, 0);

  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-owner-private-active-wal-'));
  const sessionId = ownerSessionId('owner');
  await new FileSession(path.join(root, 'sessions'), sessionId).addItems([
    { role: 'user', content: 'What is the current Atlas audit status?' },
  ] as AgentInputItem[]);
  const databaseFile = privateMemoryLayout(root, 'owner').databaseFile;
  const catalog = new SqliteMemoryCatalog(databaseFile, 'private', 'owner');
  catalog.index(privateEvalDocument('active-wal-page', 'Atlas audit status.', [{
    type: 'session', id: `${sessionId}@run-1`, digest: `sha256:${'c'.repeat(64)}`,
    occurredAt: '2026-08-02T00:00:00.000Z', trust: 'owner',
  }]));
  catalog.close();
  const writer = new DatabaseSync(databaseFile);
  try {
    writer.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA wal_autocheckpoint=0;
      INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('private_eval_probe', 'active');
    `);
    const before = await fileSnapshot(path.dirname(databaseFile));
    const report = await runOwnerPrivateSessionEval(root, { limit: 10 });
    assert.equal(report.auditStatus, 'incomplete');
    assert.equal(report.catalogCount, 0);
    assert.equal(report.unreadableCatalogCount, 1);
    assert.deepEqual(await fileSnapshot(path.dirname(databaseFile)), before);
  } finally {
    writer.close();
  }
});

test('owner private eval failures never print private input paths', () => {
  const privatePath = path.join(os.tmpdir(), 'OWNER_PRIVATE_PATH_MUST_NOT_LEAK.json');
  const entry = fileURLToPath(new URL('../evals/memory/owner-private.ts', import.meta.url));
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', entry,
    '--database', privatePath,
    '--questions', privatePath,
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr.trim(), 'owner private eval failed');
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /OWNER_PRIVATE_PATH_MUST_NOT_LEAK/);
});
