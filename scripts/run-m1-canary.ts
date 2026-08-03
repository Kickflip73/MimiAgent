import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  isM1CanaryHostIdle,
  m1CanaryBuildIdentity,
  m1EvalEvidenceSchema,
  m1EvalManifestSchema,
  reportM1Eval,
  runM1Eval,
  writeM1EvalRun,
  type M1EvalEvidence,
  type M1EvalObservation,
  type M1EvalOutcome,
  type M1EvalScenario,
} from '../src/runtime/m1-eval.js';

interface ProbeResult {
  outcome: M1EvalOutcome;
  eligible: boolean;
  executed: boolean;
  evidence: M1EvalEvidence;
  classification: string;
  evidenceRef: string;
  durationMs: number;
}

interface CommandFailure extends Error {
  output?: string;
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

async function commandJson(command: string, args: string[]): Promise<unknown> {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const chunks: Buffer[] = [];
  let bytes = 0;
  const collect = (chunk: Buffer) => {
    if (bytes >= 2_000_000) return;
    const bounded = chunk.subarray(0, 2_000_000 - bytes);
    chunks.push(bounded);
    bytes += bounded.length;
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  const output = Buffer.concat(chunks).toString('utf8');
  if (code !== 0) {
    const error = new Error(`${command} exited ${code ?? 'unknown'}`) as CommandFailure;
    error.output = output.slice(0, 2_000);
    throw error;
  }
  return JSON.parse(output) as unknown;
}

const profiles = {
  'browser.tabs': {
    profile: 'browser-tabs',
    app: 'Browser',
    channel: 'browser',
    actionFamily: 'tabs.read',
    executionPath: 'connector-manager',
    boundary: 'connector_manager',
  },
  'shortcuts.catalog': {
    profile: 'shortcuts-catalog',
    app: 'Shortcuts',
    channel: 'macos-shortcuts',
    actionFamily: 'catalog.read',
    executionPath: 'connector-manager',
    boundary: 'connector_manager',
  },
  'computer.window': {
    profile: 'computer-window',
    app: 'Computer',
    channel: 'cua',
    actionFamily: 'window.observe',
    executionPath: 'computer-manager',
    boundary: 'computer_manager',
  },
  'screen.window': {
    profile: 'screen-window',
    app: 'Screen',
    channel: 'macos-screen',
    actionFamily: 'window.read',
    executionPath: 'connector-manager',
    boundary: 'connector_manager',
  },
  'daxiang.health': {
    profile: 'daxiang-health',
    app: 'Daxiang',
    channel: 'personal-daxiang',
    actionFamily: 'health.read',
    executionPath: 'connector-manager',
    boundary: 'connector_manager',
  },
} as const;

const profileCounts: ReadonlyArray<readonly [keyof typeof profiles, number]> = [
  ['browser.tabs', 8],
  ['computer.window', 8],
  ['screen.window', 4],
  ['shortcuts.catalog', 4],
  ['daxiang.health', 6],
];

async function probe(scenario: M1EvalScenario): Promise<ProbeResult> {
  const key = scenario.id.split('.').slice(0, 2).join('.') as keyof typeof profiles;
  const selected = profiles[key];
  if (!selected) throw new Error(`unknown canary scenario ${scenario.id}`);
  const startedAt = Date.now();
  try {
    const raw = await commandJson('mimi', ['daemon', 'probe', selected.profile]) as {
      receiptId?: string;
      classification?: string;
      evidence?: unknown;
    };
    const evidence = m1EvalEvidenceSchema.parse(raw.evidence);
    if (evidence.kind !== 'live_action' || evidence.boundary !== selected.boundary) {
      throw new Error('probe receipt evidence kind or boundary mismatch');
    }
    if (!raw.receiptId || !/^[0-9a-f-]{36}$/.test(raw.receiptId)) {
      throw new Error('probe receipt id missing');
    }
    return {
      outcome: 'success',
      eligible: true,
      executed: true,
      evidence,
      classification: raw.classification ?? 'readonly-probe-ok',
      evidenceRef: `meta:probe/${raw.receiptId}`,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const detail = `${error instanceof Error ? error.message : String(error)} ${(error as CommandFailure).output ?? ''}`;
    if (/not idle|active (?:event|task|outbox|host mutation)|gate blocked: daemon/iu.test(detail)) {
      return {
        outcome: 'blocked',
        eligible: false,
        executed: false,
        evidence: {
          kind: 'live_action',
          boundary: selected.boundary,
          effect: 'read',
          registered: false,
          ready: false,
          fresh: false,
          targetVerified: false,
          actionResult: false,
        },
        classification: 'daemon-became-busy',
        evidenceRef: `meta:probe/${selected.profile}-daemon-became-busy`,
        durationMs: Date.now() - startedAt,
      };
    }
    const uncertain = /uncertain|不确定|可能已执行/iu.test(detail);
    return {
      outcome: uncertain ? 'uncertain' : 'blocked',
      eligible: uncertain,
      executed: uncertain,
      evidence: {
        kind: 'live_action',
        boundary: selected.boundary,
        effect: 'read',
        registered: uncertain,
        ready: uncertain,
        fresh: uncertain,
        targetVerified: uncertain,
        actionResult: false,
      },
      classification: uncertain ? 'probe-result-uncertain' : 'probe-gate-blocked',
      evidenceRef: `meta:probe/${selected.profile}-blocked`,
      durationMs: Date.now() - startedAt,
    };
  }
}

async function main(): Promise<void> {
  const output = path.resolve(argument('--output', `artifacts/m1-eval/canary-${Date.now()}.json`));
  const scenarios = profileCounts.flatMap(([key, count]) => {
    const selected = profiles[key];
    return Array.from({ length: count }, (_, index) => ({
      id: `${key}.${String(index + 1).padStart(2, '0')}`,
      app: selected.app,
      channel: selected.channel,
      actionFamily: selected.actionFamily,
      executionPath: selected.executionPath,
      risk: 'read' as const,
      boundaryRef: `probe.read/${selected.profile}`,
      expectedOutcome: 'success' as const,
      tags: ['canary', 'readonly', 'formal-path'],
    }));
  });
  const manifest = m1EvalManifestSchema.parse({
    schemaVersion: 2,
    evidenceKind: 'live_action',
    datasetRevision: 'm1-closeout-2026-08-03.1',
    policyRevision: 'm1-fast-closeout-v4',
    toolSnapshotRevision: 'daemon-probe-read-v2',
    scenarios,
  });
  const doctor = await commandJson('mimi', ['daemon', 'doctor']);
  const runningBuild = m1CanaryBuildIdentity(doctor);
  if (!runningBuild) {
    throw new Error('M1 canary requires Doctor installed/running alignment on a clean traceable build');
  }
  const requestedBuild = argument('--build', runningBuild);
  if (requestedBuild !== runningBuild) {
    throw new Error('M1 canary --build must exactly match the running Doctor build identity');
  }
  let stopReason = isM1CanaryHostIdle(doctor) ? undefined : 'daemon-not-idle';
  const run = await runM1Eval(manifest, {
    buildIdentity: runningBuild,
    provider: 'none',
    execute: async (scenario): Promise<M1EvalObservation> => {
      if (stopReason) {
        const selected = profiles[scenario.id.split('.').slice(0, 2).join('.') as keyof typeof profiles];
        if (!selected) throw new Error(`unknown canary scenario ${scenario.id}`);
        return {
          outcome: 'blocked',
          eligible: false,
          executed: false,
          severity: 'none',
          evidence: {
            kind: 'live_action',
            boundary: selected.boundary,
            effect: 'read',
            registered: false,
            ready: false,
            fresh: false,
            targetVerified: false,
            actionResult: false,
          },
          evidenceRef: `meta:probe/${selected.profile}-${stopReason}`,
          durationMs: 0,
          classification: stopReason,
        };
      }
      const result = await probe(scenario);
      if (result.classification === 'daemon-became-busy') {
        stopReason = result.classification;
      }
      return {
        outcome: result.outcome,
        eligible: result.eligible,
        executed: result.executed,
        severity: result.outcome === 'failed' || result.outcome === 'uncertain' ? 'S2' : 'none',
        evidence: result.evidence,
        evidenceRef: result.evidenceRef,
        durationMs: result.durationMs,
        classification: result.classification,
      };
    },
  });
  await mkdir(path.dirname(output), { recursive: true });
  await writeM1EvalRun(output, run);
  process.stdout.write(`${JSON.stringify({ file: output, ...reportM1Eval(run) }, null, 2)}\n`);
}

await main();
