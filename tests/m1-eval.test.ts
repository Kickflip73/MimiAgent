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
  type M1EvalRun,
} from '../src/runtime/m1-eval.js';

function manifest(): M1EvalManifest {
  return m1EvalManifestSchema.parse({
    schemaVersion: 1,
    datasetRevision: 'fixture-v1',
    policyRevision: 'policy-v1',
    toolSnapshotRevision: 'tools-v1',
    scenarios: [
      {
        id: 'computer.observe',
        app: 'Computer',
        channel: 'cua',
        actionFamily: 'observe',
        executionPath: 'computer',
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
        executionPath: 'connector',
        risk: 'read',
        boundaryRef: 'tests/macos-browser-connector.test.ts#stale',
        expectedOutcome: 'blocked',
        tags: ['fixture', 'stale'],
      },
    ],
  });
}

async function completedRun(): Promise<M1EvalRun> {
  let tick = 0;
  return runM1Eval(manifest(), {
    buildIdentity: 'fixture-build',
    provider: 'deterministic',
    now: () => new Date(Date.UTC(2026, 6, 28, 0, 0, tick++)),
    execute: async (scenario) => ({
      outcome: scenario.expectedOutcome,
      severity: 'none',
      evidenceRef: `sha256:${scenario.id === 'computer.observe' ? 'a' : 'b'}`.padEnd(71, scenario.id === 'computer.observe' ? 'a' : 'b'),
      durationMs: 10,
      classification: `expected-${scenario.expectedOutcome}`,
    }),
  });
}

test('M1 manifest validates fixed revisions and rejects duplicate or damaged scenarios', async () => {
  const parsed = manifest();
  assert.equal(parsed.scenarios.length, 2);
  assert.throws(() => m1EvalManifestSchema.parse({
    ...parsed,
    scenarios: [parsed.scenarios[0], parsed.scenarios[0]],
  }), /duplicate scenario id/);
  assert.throws(() => m1EvalManifestSchema.parse({
    ...parsed,
    scenarios: [{ ...parsed.scenarios[0], risk: 'silent-write' }],
  }), /Invalid option/);

  const root = await mkdtemp(path.join(os.tmpdir(), 'm1-manifest-'));
  const corrupt = path.join(root, 'manifest.json');
  await writeFile(corrupt, '{"schemaVersion":1');
  await assert.rejects(() => readM1EvalManifest(corrupt), /JSON/);
});

test('M1 runner records real denominators and report groups by app action family and path', async () => {
  const run = await completedRun();
  assert.equal(run.records.length, 2);
  assert.equal(run.records[0]?.attempt, 'first');
  const report = reportM1Eval(run);
  assert.equal(report.denominator, 2);
  assert.deepEqual(report.groups.map((group) => [
    group.app, group.actionFamily, group.executionPath, group.denominator,
  ]), [
    ['Browser', 'page.read', 'connector', 1],
    ['Computer', 'observe', 'computer', 1],
  ]);
  assert.equal(report.groups[0]?.blocked, 1);
  assert.equal(report.groups[1]?.firstSuccess, 1);
  const accumulated = reportM1EvalRuns([run, await completedRun()]);
  assert.equal(accumulated.denominator, 4);
  assert.equal(accumulated.groups[0]?.denominator, 2);
});

test('M1 uncertain records fail the reverse fault injection if marked retry', () => {
  const base = {
    recordId: '00000000-0000-4000-8000-000000000001',
    scenarioId: 'daxiang.timeout',
    datasetRevision: 'fixture-v1',
    app: 'Daxiang',
    channel: 'personal-daxiang',
    actionFamily: 'send.receipt',
    executionPath: 'personal-message',
    risk: 'high_write',
    provider: 'deepseek',
    policyRevision: 'policy-v1',
    toolSnapshotRevision: 'tools-v1',
    outcome: 'uncertain',
    severity: 'S2',
    evidenceRef: `sha256:${'c'.repeat(64)}`,
    occurredAt: '2026-07-28T00:00:00.000Z',
    durationMs: 100,
    classification: 'post-click-timeout',
  };
  assert.throws(() => m1EvalRecordSchema.parse({ ...base, attempt: 'retry' }), /must never be retried/);
  assert.equal(m1EvalRecordSchema.parse({ ...base, attempt: 'first' }).outcome, 'uncertain');
});

test('M1 cumulative reports reject mixed dataset revisions', async () => {
  const first = await completedRun();
  const second = await completedRun();
  second.records[0] = { ...second.records[0]!, datasetRevision: 'fixture-v2' };
  assert.throws(() => reportM1EvalRuns([first, second]), /one dataset revision/);
});

test('M1 run persistence is atomic under duplicate concurrent writers and preserves last valid state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'm1-run-'));
  const file = path.join(root, 'run.json');
  const first = await completedRun();
  const second = { ...await completedRun(), buildIdentity: 'second-build' };
  await Promise.all([writeM1EvalRun(file, first), writeM1EvalRun(file, second)]);
  const persisted = await readM1EvalRun(file);
  assert.ok(['fixture-build', 'second-build'].includes(persisted.buildIdentity));
  assert.equal(persisted.records.length, 2);

  const before = await readFile(file, 'utf8');
  await assert.rejects(() => writeM1EvalRun(file, {
    ...first,
    records: [{ ...first.records[0]!, evidenceRef: 'raw private evidence' }],
  } as M1EvalRun));
  assert.equal(await readFile(file, 'utf8'), before);
});

test('versioned repository M1 manifest contains at least 50 distinct boundary scenarios', async () => {
  const parsed = await readM1EvalManifest(path.join(process.cwd(), 'evals/m1/manifest.v1.json'));
  assert.ok(parsed.scenarios.length >= 50);
  assert.equal(new Set(parsed.scenarios.map((scenario) => scenario.id)).size, parsed.scenarios.length);
  assert.ok(new Set(parsed.scenarios.map((scenario) => scenario.boundaryRef)).size >= 50);
  assert.deepEqual(new Set(parsed.scenarios.map((scenario) => scenario.app)), new Set([
    'Computer', 'Browser', 'Screen', 'Shortcuts', 'Daxiang',
  ]));
  assert.ok(parsed.scenarios.some((scenario) => scenario.expectedOutcome === 'uncertain'));
  assert.ok(parsed.scenarios.some((scenario) => scenario.tags.includes('kill-switch')));
});
