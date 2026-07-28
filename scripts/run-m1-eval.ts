import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  readM1EvalManifest,
  readM1EvalRun,
  reportM1Eval,
  reportM1EvalRuns,
  runM1Eval,
  writeM1EvalRun,
  type M1EvalObservation,
  type M1EvalScenario,
} from '../src/runtime/m1-eval.js';

interface SuiteResult {
  ok: boolean;
  durationMs: number;
  evidenceRef: string;
}

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function fixtureFile(scenario: M1EvalScenario): string {
  const file = scenario.boundaryRef.split('#', 1)[0];
  if (!file || !/^tests\/[a-z0-9._/-]+\.test\.ts$/.test(file)) {
    throw new Error(`fixture ${scenario.id} has invalid boundaryRef`);
  }
  return file;
}

async function runSuite(file: string): Promise<SuiteResult> {
  const startedAt = Date.now();
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', file], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  const collect = (chunk: Buffer) => {
    if (bytes >= 1_000_000) return;
    const bounded = chunk.subarray(0, 1_000_000 - bytes);
    chunks.push(bounded);
    bytes += bounded.length;
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  const digest = createHash('sha256')
    .update(file)
    .update(Buffer.concat(chunks))
    .update(String(code))
    .digest('hex');
  return {
    ok: code === 0,
    durationMs: Date.now() - startedAt,
    evidenceRef: `sha256:${digest}`,
  };
}

function printReport(file: string, report: ReturnType<typeof reportM1Eval>): void {
  process.stdout.write(`${JSON.stringify({ file, ...report }, null, 2)}\n`);
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'fixtures';
  const output = path.resolve(argument('--output', `artifacts/m1-eval/fixtures-${Date.now()}.json`)!);
  if (mode === 'report') {
    const inputs = process.argv.slice(3).filter((value) => !value.startsWith('--'));
    const files = inputs.length > 0 ? inputs.map((file) => path.resolve(file)) : [output];
    printReport(files.join(','), reportM1EvalRuns(await Promise.all(files.map(readM1EvalRun))));
    return;
  }
  if (mode !== 'fixtures') {
    throw new Error('usage: run-m1-eval.ts fixtures|report [--manifest file] [--output file] [--build identity]');
  }
  const manifestFile = path.resolve(argument('--manifest', 'evals/m1/manifest.v1.json')!);
  const manifest = await readM1EvalManifest(manifestFile);
  const suiteResults = new Map<string, Promise<SuiteResult>>();
  for (const scenario of manifest.scenarios) {
    const file = fixtureFile(scenario);
    if (!suiteResults.has(file)) suiteResults.set(file, runSuite(file));
  }
  const run = await runM1Eval(manifest, {
    buildIdentity: argument('--build', process.env.MIMI_BUILD_IDENTITY ?? 'working-tree')!,
    provider: 'deterministic',
    execute: async (scenario): Promise<M1EvalObservation> => {
      const result = await suiteResults.get(fixtureFile(scenario))!;
      return result.ok
        ? {
            outcome: scenario.expectedOutcome,
            severity: 'none',
            evidenceRef: result.evidenceRef,
            durationMs: result.durationMs,
            classification: `expected-${scenario.expectedOutcome}`,
          }
        : {
            outcome: 'failed',
            severity: 'S2',
            evidenceRef: result.evidenceRef,
            durationMs: result.durationMs,
            classification: 'fixture-suite-failed',
          };
    },
  });
  await mkdir(path.dirname(output), { recursive: true });
  await writeM1EvalRun(output, run);
  printReport(output, reportM1Eval(run));
  if (run.records.some((record) => record.classification === 'fixture-suite-failed')) process.exitCode = 1;
}

await main();
