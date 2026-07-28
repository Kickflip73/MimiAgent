import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { withExclusiveFileLock } from '../core/state-file.js';

const revisionSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/);
const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/);

export const m1EvalEvidenceKindSchema = z.enum([
  'fixture', 'readiness', 'live_action', 'soak',
]);
export type M1EvalEvidenceKind = z.infer<typeof m1EvalEvidenceKindSchema>;

export const m1EvalOutcomeSchema = z.enum([
  'success', 'blocked', 'skipped', 'failed', 'uncertain',
]);
export type M1EvalOutcome = z.infer<typeof m1EvalOutcomeSchema>;

const fixtureEvidenceSchema = z.object({
  kind: z.literal('fixture'),
  boundary: z.literal('fixture_suite'),
  resultReceived: z.boolean(),
}).strict();

const readinessEvidenceSchema = z.object({
  kind: z.literal('readiness'),
  boundary: z.literal('readiness_check'),
  resultReceived: z.boolean(),
}).strict();

const liveActionEvidenceSchema = z.object({
  kind: z.literal('live_action'),
  boundary: z.enum(['connector_manager', 'computer_manager']),
  effect: z.literal('read'),
  registered: z.boolean(),
  ready: z.boolean(),
  fresh: z.boolean(),
  targetVerified: z.boolean(),
  actionResult: z.boolean(),
}).strict();

const soakEvidenceSchema = z.object({
  kind: z.literal('soak'),
  boundary: z.literal('soak_monitor'),
  resultReceived: z.boolean(),
  observedDurationMs: z.number().int().positive().max(31 * 86_400_000),
}).strict();

export const m1EvalEvidenceSchema = z.discriminatedUnion('kind', [
  fixtureEvidenceSchema,
  readinessEvidenceSchema,
  liveActionEvidenceSchema,
  soakEvidenceSchema,
]);
export type M1EvalEvidence = z.infer<typeof m1EvalEvidenceSchema>;

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
  schemaVersion: z.literal(2),
  evidenceKind: m1EvalEvidenceKindSchema,
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
  operationId: z.string().uuid(),
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
  eligible: z.boolean(),
  executed: z.boolean(),
  attempt: z.enum(['first', 'retry', 'takeover']),
  severity: z.enum(['none', 'S0', 'S1', 'S2', 'S3']),
  evidence: m1EvalEvidenceSchema,
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
  if (value.executed && !value.eligible) {
    context.addIssue({ code: 'custom', path: ['executed'], message: 'executed evidence must be eligible' });
  }
  if ((value.outcome === 'blocked' || value.outcome === 'skipped') && value.executed) {
    context.addIssue({ code: 'custom', path: ['executed'], message: `${value.outcome} evidence must not be executed` });
  }
  if (!['blocked', 'skipped'].includes(value.outcome) && !value.executed) {
    context.addIssue({ code: 'custom', path: ['executed'], message: `${value.outcome} evidence must be executed` });
  }
  if (value.evidence.kind !== 'live_action') return;
  const evidence = value.evidence;
  if (value.executed && !evidence.registered) {
    context.addIssue({ code: 'custom', path: ['evidence', 'registered'], message: 'live_action execution must use a registered boundary' });
  }
  if (value.executed && (!evidence.ready || !evidence.fresh)) {
    context.addIssue({ code: 'custom', path: ['evidence', 'ready'], message: 'live_action execution must be ready and fresh' });
  }
  if (value.executed && !evidence.targetVerified) {
    context.addIssue({ code: 'custom', path: ['evidence', 'targetVerified'], message: 'live_action execution target must be verified' });
  }
  if ((value.outcome === 'success' || value.outcome === 'failed') && !evidence.actionResult) {
    context.addIssue({ code: 'custom', path: ['evidence', 'actionResult'], message: 'live_action success or failure requires an action result' });
  }
  if (value.outcome === 'uncertain' && evidence.actionResult) {
    context.addIssue({ code: 'custom', path: ['evidence', 'actionResult'], message: 'uncertain live_action must not claim a received action result' });
  }
});
export type M1EvalRecord = z.infer<typeof m1EvalRecordSchema>;

const m1EvalRunSchema = z.object({
  schemaVersion: z.literal(2),
  runId: z.string().uuid(),
  evidenceKind: m1EvalEvidenceKindSchema,
  datasetRevision: revisionSchema,
  policyRevision: revisionSchema,
  toolSnapshotRevision: revisionSchema,
  buildIdentity: z.string().min(1).max(160),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).optional(),
  records: z.array(m1EvalRecordSchema).max(20_000),
}).strict().superRefine((value, context) => {
  const recordIds = new Set<string>();
  const scenarioIds = new Set<string>();
  const operationIds = new Set<string>();
  for (const [index, record] of value.records.entries()) {
    const mismatches = [
      record.datasetRevision !== value.datasetRevision ? 'datasetRevision' : undefined,
      record.policyRevision !== value.policyRevision ? 'policyRevision' : undefined,
      record.toolSnapshotRevision !== value.toolSnapshotRevision ? 'toolSnapshotRevision' : undefined,
      record.evidence.kind !== value.evidenceKind ? 'evidence kind' : undefined,
    ].filter((item): item is string => item !== undefined);
    if (mismatches.length) {
      context.addIssue({
        code: 'custom',
        path: ['records', index],
        message: `record does not match run ${mismatches.join(', ')}`,
      });
    }
    for (const [label, id, seen] of [
      ['record id', record.recordId, recordIds],
      ['scenario id', record.scenarioId, scenarioIds],
      ['operation id', record.operationId, operationIds],
    ] as const) {
      if (seen.has(id)) {
        context.addIssue({ code: 'custom', path: ['records', index], message: `duplicate ${label}: ${id}` });
      }
      seen.add(id);
    }
  }
  if (value.completedAt && Date.parse(value.completedAt) < Date.parse(value.startedAt)) {
    context.addIssue({ code: 'custom', path: ['completedAt'], message: 'completedAt precedes startedAt' });
  }
});
export type M1EvalRun = z.infer<typeof m1EvalRunSchema>;

export interface M1EvalObservation {
  outcome: M1EvalOutcome;
  eligible: boolean;
  executed: boolean;
  severity?: M1EvalRecord['severity'];
  evidence: M1EvalEvidence;
  evidenceRef: string;
  durationMs: number;
  classification: string;
}

export interface M1EvalTotals {
  requested: number;
  eligible: number;
  executed: number;
  success: number;
  blocked: number;
  skipped: number;
  failed: number;
  uncertain: number;
  qualifyingLiveActions: number;
}

export interface M1EvalGroup extends M1EvalTotals {
  evidenceKind: M1EvalEvidenceKind;
  app: string;
  actionFamily: string;
  executionPath: string;
  coverage: number;
  eligibleExecutionSuccess: number | null;
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
  totals: M1EvalTotals;
  coverage: number;
  eligibleExecutionSuccess: number | null;
  groups: M1EvalGroup[];
}

function emptyTotals(): M1EvalTotals {
  return {
    requested: 0,
    eligible: 0,
    executed: 0,
    success: 0,
    blocked: 0,
    skipped: 0,
    failed: 0,
    uncertain: 0,
    qualifyingLiveActions: 0,
  };
}

function rates<T extends M1EvalTotals>(value: T) {
  return {
    coverage: value.requested === 0 ? 0 : value.eligible / value.requested,
    eligibleExecutionSuccess: value.executed === 0 ? null : value.success / value.executed,
  };
}

export async function readM1EvalManifest(file: string): Promise<M1EvalManifest> {
  const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
  if (raw && typeof raw === 'object' && (raw as { schemaVersion?: unknown }).schemaVersion === 1) {
    throw new Error('legacy M1 manifest v1 has no evidence provenance; rerun with manifest v2');
  }
  return m1EvalManifestSchema.parse(raw);
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
  const parsedManifest = m1EvalManifestSchema.parse(manifest);
  const now = options.now ?? (() => new Date());
  const run: M1EvalRun = {
    schemaVersion: 2,
    runId: randomUUID(),
    evidenceKind: parsedManifest.evidenceKind,
    datasetRevision: parsedManifest.datasetRevision,
    policyRevision: parsedManifest.policyRevision,
    toolSnapshotRevision: parsedManifest.toolSnapshotRevision,
    buildIdentity: options.buildIdentity,
    startedAt: now().toISOString(),
    records: [],
  };
  for (const scenario of parsedManifest.scenarios) {
    const observation = await options.execute(scenario);
    run.records.push(m1EvalRecordSchema.parse({
      recordId: randomUUID(),
      operationId: randomUUID(),
      scenarioId: scenario.id,
      datasetRevision: parsedManifest.datasetRevision,
      app: scenario.app,
      channel: scenario.channel,
      actionFamily: scenario.actionFamily,
      executionPath: scenario.executionPath,
      risk: scenario.risk,
      provider: options.provider,
      policyRevision: parsedManifest.policyRevision,
      toolSnapshotRevision: parsedManifest.toolSnapshotRevision,
      outcome: observation.outcome,
      eligible: observation.eligible,
      executed: observation.executed,
      attempt: 'first',
      severity: observation.severity ?? (observation.outcome === 'success' ? 'none' : 'S2'),
      evidence: observation.evidence,
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
    const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
    try {
      const existing = await readFile(file, 'utf8');
      if (existing === serialized) return;
      throw new Error(`M1 eval run file already contains a different run: ${path.basename(file)}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, serialized, { mode: 0o600 });
    await rename(temporary, file);
  });
}

export async function readM1EvalRun(file: string): Promise<M1EvalRun> {
  const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
  if (raw && typeof raw === 'object' && (raw as { schemaVersion?: unknown }).schemaVersion === 1) {
    throw new Error('legacy M1 eval run v1 has no evidence provenance; rerun or migrate explicitly without live_action credit');
  }
  return m1EvalRunSchema.parse(raw);
}

function reportM1EvalRecords(
  runId: string,
  datasetRevision: string,
  records: readonly M1EvalRecord[],
): M1EvalReport {
  const totals = emptyTotals();
  const groups = new Map<string, M1EvalGroup>();
  for (const record of records) {
    const key = `${record.evidence.kind}\0${record.app}\0${record.actionFamily}\0${record.executionPath}`;
    const group = groups.get(key) ?? {
      evidenceKind: record.evidence.kind,
      app: record.app,
      actionFamily: record.actionFamily,
      executionPath: record.executionPath,
      ...emptyTotals(),
      coverage: 0,
      eligibleExecutionSuccess: null,
      firstSuccess: 0,
      retrySuccess: 0,
      takeover: 0,
      s0: 0,
      s1: 0,
      s2: 0,
      s3: 0,
    };
    for (const target of [totals, group]) {
      target.requested += 1;
      if (record.eligible) target.eligible += 1;
      if (record.executed) target.executed += 1;
      target[record.outcome] += 1;
      if (record.evidence.kind === 'live_action' && record.executed && record.evidence.actionResult) {
        target.qualifyingLiveActions += 1;
      }
    }
    if (record.outcome === 'success' && record.attempt === 'first') group.firstSuccess += 1;
    if (record.outcome === 'success' && record.attempt === 'retry') group.retrySuccess += 1;
    if (record.attempt === 'takeover') group.takeover += 1;
    if (record.severity !== 'none') group[record.severity.toLowerCase() as 's0' | 's1' | 's2' | 's3'] += 1;
    groups.set(key, group);
  }
  const outputGroups = [...groups.values()].map((group) => Object.assign(group, rates(group)));
  return {
    runId,
    datasetRevision,
    totals,
    ...rates(totals),
    groups: outputGroups.sort((left, right) => (
      left.evidenceKind.localeCompare(right.evidenceKind)
      || left.app.localeCompare(right.app)
      || left.actionFamily.localeCompare(right.actionFamily)
      || left.executionPath.localeCompare(right.executionPath)
    )),
  };
}

export function reportM1Eval(run: M1EvalRun): M1EvalReport {
  const parsed = m1EvalRunSchema.parse(run);
  return reportM1EvalRecords(parsed.runId, parsed.datasetRevision, parsed.records);
}

export function reportM1EvalRuns(runs: readonly M1EvalRun[]): M1EvalReport {
  if (runs.length === 0) throw new Error('at least one M1 eval run is required');
  const parsed = runs.map((run) => m1EvalRunSchema.parse(run));
  const runIds = new Set<string>();
  const recordIds = new Set<string>();
  for (const run of parsed) {
    if (runIds.has(run.runId)) throw new Error(`duplicate run id: ${run.runId}`);
    runIds.add(run.runId);
    for (const record of run.records) {
      if (recordIds.has(record.recordId)) throw new Error(`duplicate record id: ${record.recordId}`);
      recordIds.add(record.recordId);
    }
  }
  for (const [field, label] of [
    ['datasetRevision', 'dataset revision'],
    ['policyRevision', 'policy revision'],
    ['toolSnapshotRevision', 'tool snapshot revision'],
  ] as const) {
    if (new Set(parsed.map((run) => run[field])).size !== 1) {
      throw new Error(`M1 eval runs must use one ${label}`);
    }
  }
  const operations = new Map<string, M1EvalRecord[]>();
  for (const record of parsed.flatMap((run) => run.records)) {
    const records = operations.get(record.operationId) ?? [];
    records.push(record);
    operations.set(record.operationId, records);
  }
  for (const records of operations.values()) {
    records.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    const uncertain = records.findIndex((record) => record.outcome === 'uncertain');
    if (uncertain >= 0 && records.slice(uncertain + 1).some((record) => record.attempt !== 'first')) {
      throw new Error(`uncertain operation ${records[uncertain]!.operationId} must never be retried or taken over`);
    }
  }
  return reportM1EvalRecords(
    parsed[0]!.runId,
    parsed[0]!.datasetRevision,
    parsed.flatMap((run) => run.records),
  );
}
