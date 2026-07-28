import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { withExclusiveFileLock } from '../core/state-file.js';

const revisionSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/);
const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/);

export const m1EvalOutcomeSchema = z.enum([
  'success', 'partial', 'blocked', 'failed', 'uncertain',
]);
export type M1EvalOutcome = z.infer<typeof m1EvalOutcomeSchema>;

export const m1EvalScenarioSchema = z.object({
  id: identifierSchema,
  app: z.string().min(1).max(80),
  channel: z.string().min(1).max(80),
  actionFamily: identifierSchema,
  executionPath: identifierSchema,
  risk: z.enum(['read', 'draft', 'low_write', 'high_write']),
  boundaryRef: z.string().min(1).max(240),
  expectedOutcome: m1EvalOutcomeSchema,
  tags: z.array(identifierSchema).min(1).max(12),
}).strict();
export type M1EvalScenario = z.infer<typeof m1EvalScenarioSchema>;

export const m1EvalManifestSchema = z.object({
  schemaVersion: z.literal(1),
  datasetRevision: revisionSchema,
  policyRevision: revisionSchema,
  toolSnapshotRevision: revisionSchema,
  scenarios: z.array(m1EvalScenarioSchema).min(1).max(1_000),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, scenario] of value.scenarios.entries()) {
    if (seen.has(scenario.id)) {
      context.addIssue({
        code: 'custom',
        path: ['scenarios', index, 'id'],
        message: `duplicate scenario id: ${scenario.id}`,
      });
    }
    seen.add(scenario.id);
  }
});
export type M1EvalManifest = z.infer<typeof m1EvalManifestSchema>;

export const m1EvalRecordSchema = z.object({
  recordId: z.string().uuid(),
  scenarioId: identifierSchema,
  datasetRevision: revisionSchema,
  app: z.string().min(1).max(80),
  channel: z.string().min(1).max(80),
  actionFamily: identifierSchema,
  executionPath: identifierSchema,
  risk: z.enum(['read', 'draft', 'low_write', 'high_write']),
  provider: z.enum(['openai', 'deepseek', 'deterministic', 'none']),
  policyRevision: revisionSchema,
  toolSnapshotRevision: revisionSchema,
  outcome: m1EvalOutcomeSchema,
  attempt: z.enum(['first', 'retry', 'takeover']),
  severity: z.enum(['none', 'S0', 'S1', 'S2', 'S3']),
  evidenceRef: z.string().regex(/^(sha256:[a-f0-9]{64}|meta:[a-z0-9][a-z0-9._/-]{0,199})$/),
  occurredAt: z.string().datetime({ offset: true }),
  durationMs: z.number().int().nonnegative().max(86_400_000),
  classification: identifierSchema,
}).strict().superRefine((value, context) => {
  if (value.outcome === 'success' && value.severity !== 'none') {
    context.addIssue({ code: 'custom', path: ['severity'], message: 'success must have severity none' });
  }
  if (value.outcome === 'uncertain' && value.attempt !== 'first') {
    context.addIssue({ code: 'custom', path: ['attempt'], message: 'uncertain must never be retried or taken over' });
  }
});
export type M1EvalRecord = z.infer<typeof m1EvalRecordSchema>;

const m1EvalRunSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  buildIdentity: z.string().min(1).max(160),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).optional(),
  records: z.array(m1EvalRecordSchema).max(20_000),
}).strict();
export type M1EvalRun = z.infer<typeof m1EvalRunSchema>;

export interface M1EvalObservation {
  outcome: M1EvalOutcome;
  severity?: M1EvalRecord['severity'];
  evidenceRef: string;
  durationMs: number;
  classification: string;
}

export interface M1EvalGroup {
  app: string;
  actionFamily: string;
  executionPath: string;
  denominator: number;
  success: number;
  partial: number;
  blocked: number;
  failed: number;
  uncertain: number;
  firstSuccess: number;
  retrySuccess: number;
  takeover: number;
  s0: number;
  s1: number;
  s2: number;
  s3: number;
}

export interface M1EvalReport {
  runId: string;
  datasetRevision: string;
  denominator: number;
  groups: M1EvalGroup[];
}

export async function readM1EvalManifest(file: string): Promise<M1EvalManifest> {
  return m1EvalManifestSchema.parse(JSON.parse(await readFile(file, 'utf8')) as unknown);
}

export async function runM1Eval(
  manifest: M1EvalManifest,
  options: {
    buildIdentity: string;
    provider: M1EvalRecord['provider'];
    execute: (scenario: M1EvalScenario) => Promise<M1EvalObservation>;
    now?: () => Date;
  },
): Promise<M1EvalRun> {
  const now = options.now ?? (() => new Date());
  const run: M1EvalRun = {
    schemaVersion: 1,
    runId: randomUUID(),
    buildIdentity: options.buildIdentity,
    startedAt: now().toISOString(),
    records: [],
  };
  for (const scenario of manifest.scenarios) {
    const observation = await options.execute(scenario);
    run.records.push(m1EvalRecordSchema.parse({
      recordId: randomUUID(),
      scenarioId: scenario.id,
      datasetRevision: manifest.datasetRevision,
      app: scenario.app,
      channel: scenario.channel,
      actionFamily: scenario.actionFamily,
      executionPath: scenario.executionPath,
      risk: scenario.risk,
      provider: options.provider,
      policyRevision: manifest.policyRevision,
      toolSnapshotRevision: manifest.toolSnapshotRevision,
      outcome: observation.outcome,
      attempt: 'first',
      severity: observation.severity ?? (observation.outcome === 'success' ? 'none' : 'S2'),
      evidenceRef: observation.evidenceRef,
      occurredAt: now().toISOString(),
      durationMs: observation.durationMs,
      classification: observation.classification,
    }));
  }
  run.completedAt = now().toISOString();
  return m1EvalRunSchema.parse(run);
}

export async function writeM1EvalRun(file: string, run: M1EvalRun): Promise<void> {
  const parsed = m1EvalRunSchema.parse(run);
  await withExclusiveFileLock(file, async () => {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  });
}

export async function readM1EvalRun(file: string): Promise<M1EvalRun> {
  return m1EvalRunSchema.parse(JSON.parse(await readFile(file, 'utf8')) as unknown);
}

export function reportM1Eval(run: M1EvalRun): M1EvalReport {
  const parsed = m1EvalRunSchema.parse(run);
  const groups = new Map<string, M1EvalGroup>();
  for (const record of parsed.records) {
    const key = `${record.app}\0${record.actionFamily}\0${record.executionPath}`;
    const group = groups.get(key) ?? {
      app: record.app,
      actionFamily: record.actionFamily,
      executionPath: record.executionPath,
      denominator: 0,
      success: 0,
      partial: 0,
      blocked: 0,
      failed: 0,
      uncertain: 0,
      firstSuccess: 0,
      retrySuccess: 0,
      takeover: 0,
      s0: 0,
      s1: 0,
      s2: 0,
      s3: 0,
    };
    group.denominator += 1;
    group[record.outcome] += 1;
    if (record.outcome === 'success' && record.attempt === 'first') group.firstSuccess += 1;
    if (record.outcome === 'success' && record.attempt === 'retry') group.retrySuccess += 1;
    if (record.attempt === 'takeover') group.takeover += 1;
    if (record.severity !== 'none') group[record.severity.toLowerCase() as 's0' | 's1' | 's2' | 's3'] += 1;
    groups.set(key, group);
  }
  const datasetRevision = parsed.records[0]?.datasetRevision ?? 'none';
  return {
    runId: parsed.runId,
    datasetRevision,
    denominator: parsed.records.length,
    groups: [...groups.values()].sort((left, right) => (
      left.app.localeCompare(right.app)
      || left.actionFamily.localeCompare(right.actionFamily)
      || left.executionPath.localeCompare(right.executionPath)
    )),
  };
}

export function reportM1EvalRuns(runs: readonly M1EvalRun[]): M1EvalReport {
  if (runs.length === 0) throw new Error('at least one M1 eval run is required');
  const parsed = runs.map((run) => m1EvalRunSchema.parse(run));
  const revisions = new Set(parsed.flatMap((run) => run.records.map((record) => record.datasetRevision)));
  if (revisions.size !== 1) throw new Error('M1 eval runs must use one dataset revision');
  const combined: M1EvalRun = {
    schemaVersion: 1,
    runId: parsed[0]!.runId,
    buildIdentity: `aggregate-${parsed.length}`,
    startedAt: parsed[0]!.startedAt,
    records: parsed.flatMap((run) => run.records),
  };
  return reportM1Eval(combined);
}
