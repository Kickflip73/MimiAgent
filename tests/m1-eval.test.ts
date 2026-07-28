import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  m1EvalManifestSchema,
  m1EvalRecordSchema,
  readM1EvalManifest,
  readM1EvalRun,
  reportM1Eval,
  reportM1EvalRuns,
  runM1Eval,
  writeM1EvalRun,
  type M1EvalManifest,
  type M1EvalEvidence,
  type M1EvalRun,
} from '../src/runtime/m1-eval.js';

function fixtureEvidence() {
  return {
    kind: 'fixture' as const,
    boundary: 'fixture_suite' as const,
    resultReceived: true,
  };
}

function liveEvidence(overrides: Partial<{
  kind: 'live_action';
  boundary: 'connector_manager' | 'computer_manager';
  effect: 'read';
  registered: boolean;
  ready: boolean;
  fresh: boolean;
  targetVerified: boolean;
  actionResult: boolean;
}> = {}) {
  return {
    kind: 'live_action' as const,
    boundary: 'connector_manager' as const,
    effect: 'read' as const,
    registered: true,
    ready: true,
    fresh: true,
    targetVerified: true,
    actionResult: true,
    ...overrides,
  };
}

function manifest(evidenceKind: M1EvalManifest['evidenceKind'] = 'fixture'): M1EvalManifest {
  return m1EvalManifestSchema.parse({
    schemaVersion: 2,
    evidenceKind,
    datasetRevision: 'fixture-v2',
    policyRevision: 'policy-v2',
    toolSnapshotRevision: 'tools-v2',
    scenarios: [
      {
        id: 'computer.observe',
        app: 'Computer',
        channel: 'cua',
        actionFamily: 'observe',
        executionPath: 'computer-manager',
        risk: 'read',
        boundaryRef: 'tests/computer.test.ts#observe',
        expectedOutcome: 'success',
        tags: ['fixture'],
      },
      {
        id: 'browser.stale',
        app: 'Browser',
        channel: 'macos-browser',
        actionFamily: 'page.read',
        executionPath: 'connector-manager',
        risk: 'read',
        boundaryRef: 'tests/macos-browser-connector.test.ts#stale',
        expectedOutcome: 'blocked',
        tags: ['fixture', 'stale'],
      },
    ],
  });
}

async function completedRun(
  source = manifest(),
  evidence: M1EvalEvidence = fixtureEvidence(),
): Promise<M1EvalRun> {
  let tick = 0;
  return runM1Eval(source, {
    buildIdentity: 'fixture-build',
    provider: 'deterministic',
    now: () => new Date(Date.UTC(2026, 6, 28, 0, 0, tick++)),
    execute: async (scenario) => ({
      outcome: scenario.expectedOutcome,
      eligible: scenario.expectedOutcome === 'success',
      executed: scenario.expectedOutcome === 'success',
      severity: 'none',
      evidence,
      evidenceRef: `sha256:${scenario.id === 'computer.observe' ? 'a' : 'b'}`.padEnd(71, scenario.id === 'computer.observe' ? 'a' : 'b'),
      durationMs: 10,
      classification: `expected-${scenario.expectedOutcome}`,
    }),
  });
}

test('M1 v2 manifest validates evidence kind and rejects duplicate or damaged scenarios', async () => {
  const parsed = manifest();
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.evidenceKind, 'fixture');
  assert.throws(() => m1EvalManifestSchema.parse({
    ...parsed,
    scenarios: [parsed.scenarios[0], parsed.scenarios[0]],
  }), /duplicate scenario id/);
  assert.throws(() => m1EvalManifestSchema.parse({
    ...parsed,
    evidenceKind: 'claimed-live',
  }));

  const root = await mkdtemp(path.join(os.tmpdir(), 'm1-manifest-'));
  const corrupt = path.join(root, 'manifest.json');
  await writeFile(corrupt, '{"schemaVersion":2');
  await assert.rejects(() => readM1EvalManifest(corrupt), /JSON/);
});

test('M1 report separates requested coverage from eligible execution success', async () => {
  const run = await completedRun();
  const report = reportM1Eval(run);
  assert.deepEqual(report.totals, {
    requested: 2,
    eligible: 1,
    executed: 1,
    success: 1,
    blocked: 1,
    skipped: 0,
    failed: 0,
    uncertain: 0,
    qualifyingLiveActions: 0,
  });
  assert.equal(report.coverage, 0.5);
  assert.equal(report.eligibleExecutionSuccess, 1);
  assert.deepEqual(report.groups.map((group) => [
    group.evidenceKind, group.app, group.actionFamily, group.executionPath, group.requested,
  ]), [
    ['fixture', 'Browser', 'page.read', 'connector-manager', 1],
    ['fixture', 'Computer', 'observe', 'computer-manager', 1],
  ]);
  const accumulated = reportM1EvalRuns([run, await completedRun()]);
  assert.equal(accumulated.totals.requested, 4);
  assert.equal(accumulated.totals.qualifyingLiveActions, 0);
});

test('readiness evidence cannot be forged into a qualifying live action', () => {
  const base = {
    recordId: '00000000-0000-4000-8000-000000000001',
    operationId: '00000000-0000-4000-8000-000000000002',
    scenarioId: 'computer.readiness',
    datasetRevision: 'fixture-v2',
    app: 'Computer',
    channel: 'cua',
    actionFamily: 'readiness',
    executionPath: 'computer-manager',
    risk: 'read',
    provider: 'none',
    policyRevision: 'policy-v2',
    toolSnapshotRevision: 'tools-v2',
    outcome: 'success',
    eligible: true,
    executed: true,
    attempt: 'first',
    severity: 'none',
    evidenceRef: `sha256:${'c'.repeat(64)}`,
    occurredAt: '2026-07-28T00:00:00.000Z',
    durationMs: 100,
    classification: 'doctor-ready',
  };
  const readiness = {
    kind: 'readiness',
    boundary: 'readiness_check',
    resultReceived: true,
  } as const;
  assert.equal(m1EvalRecordSchema.parse({ ...base, evidence: readiness }).evidence.kind, 'readiness');
  assert.throws(() => m1EvalRecordSchema.parse({
    ...base,
    evidence: { ...readiness, kind: 'live_action' },
  }), /connector_manager|computer_manager/);
});

test('live action requires a registered fresh formal boundary and an action result', async () => {
  const source = manifest('live_action');
  await assert.rejects(() => completedRun(source, {
    kind: 'readiness',
    boundary: 'readiness_check',
    resultReceived: true,
  }), /evidence kind/);
  await assert.rejects(() => completedRun(source, liveEvidence({ registered: false })), /registered/);
  const run = await completedRun(source, liveEvidence());
  assert.equal(reportM1Eval(run).totals.qualifyingLiveActions, 1);
});

test('M1 uncertain records cannot be retried across runs', async () => {
  const first = await completedRun(manifest('live_action'), liveEvidence());
  first.records = [{
    ...first.records[0]!,
    outcome: 'uncertain',
    severity: 'S2',
    evidence: liveEvidence({ actionResult: false }),
  }];
  const retry = {
    ...await completedRun(manifest('live_action'), liveEvidence()),
    records: [{
      ...(await completedRun(manifest('live_action'), liveEvidence())).records[0]!,
      operationId: first.records[0]!.operationId,
      attempt: 'retry' as const,
    }],
  };
  assert.throws(() => reportM1EvalRuns([first, retry]), /uncertain.*retr/i);
});

test('M1 v1 run fails with an explicit provenance migration error', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'm1-v1-'));
  const file = path.join(root, 'run.json');
  await writeFile(file, JSON.stringify({
    schemaVersion: 1,
    runId: '00000000-0000-4000-8000-000000000001',
    buildIdentity: 'legacy',
    startedAt: '2026-07-28T00:00:00.000Z',
    records: [],
  }));
  await assert.rejects(() => readM1EvalRun(file), /v1.*provenance/i);
});

test('M1 run persistence is atomic and refuses conflicting concurrent writers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'm1-run-'));
  const file = path.join(root, 'run.json');
  const first = await completedRun();
  const second = { ...await completedRun(), buildIdentity: 'second-build' };
  const results = await Promise.allSettled([writeM1EvalRun(file, first), writeM1EvalRun(file, second)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const persisted = await readM1EvalRun(file);
  assert.ok(['fixture-build', 'second-build'].includes(persisted.buildIdentity));

  const before = await readFile(file, 'utf8');
  await assert.rejects(() => writeM1EvalRun(file, {
    ...first,
    records: [{ ...first.records[0]!, evidenceRef: 'raw private evidence' }],
  } as M1EvalRun));
  assert.equal(await readFile(file, 'utf8'), before);
});

test('M1 cumulative reports reject duplicate runs and mixed revisions', async () => {
  const first = await completedRun();
  assert.throws(() => reportM1EvalRuns([first, first]), /duplicate run/i);
  const second = await completedRun();
  second.policyRevision = 'policy-v3';
  second.records = second.records.map((record) => ({ ...record, policyRevision: 'policy-v3' }));
  assert.throws(() => reportM1EvalRuns([first, second]), /one policy revision/);
});

test('versioned repository M1 manifest contains at least 50 fixture boundary scenarios', async () => {
  const parsed = await readM1EvalManifest(path.join(process.cwd(), 'evals/m1/manifest.v2.json'));
  assert.equal(parsed.evidenceKind, 'fixture');
  assert.ok(parsed.scenarios.length >= 50);
  assert.equal(new Set(parsed.scenarios.map((scenario) => scenario.id)).size, parsed.scenarios.length);
  assert.ok(new Set(parsed.scenarios.map((scenario) => scenario.boundaryRef)).size >= 50);
  assert.deepEqual(new Set(parsed.scenarios.map((scenario) => scenario.app)), new Set([
    'Computer', 'Browser', 'Screen', 'Shortcuts', 'Daxiang',
  ]));
  assert.ok(parsed.scenarios.some((scenario) => scenario.expectedOutcome === 'uncertain'));
  assert.ok(parsed.scenarios.some((scenario) => scenario.tags.includes('kill-switch')));
});
