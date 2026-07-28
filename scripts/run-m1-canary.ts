import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  m1EvalManifestSchema,
  reportM1Eval,
  runM1Eval,
  writeM1EvalRun,
  type M1EvalObservation,
  type M1EvalScenario,
} from '../src/runtime/m1-eval.js';

interface ProbeResult {
  ok: boolean;
  blocked?: boolean;
  classification: string;
  durationMs: number;
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
    chunks.push(chunk.subarray(0, 2_000_000 - bytes));
    bytes += Math.min(chunk.length, 2_000_000 - bytes);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) throw new Error(`${command} exited ${code ?? 'unknown'}`);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function connectorAction(
  connector: string,
  action: string,
  target: string,
  payload: unknown,
): Promise<void> {
  const child = spawn(process.execPath, [path.resolve(connector)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  const id = 'm1-readonly-canary';
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({ type: 'action', id, action, target, payload })}\n`);
  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('read-only connector canary timed out'));
    }, 15_000);
    const poll = setInterval(() => {
      const lines = stdout.split('\n').filter(Boolean);
      for (const line of lines) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (parsed.id !== id) continue;
        clearInterval(poll);
        clearTimeout(timer);
        resolve(parsed);
      }
    }, 20);
    child.once('error', (error) => {
      clearInterval(poll);
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (stdout.includes(`"id":"${id}"`)) return;
      clearInterval(poll);
      clearTimeout(timer);
      reject(new Error(`connector exited ${code ?? 'unknown'}: ${stderr.slice(0, 200)}`));
    });
  }).finally(() => {
    child.stdin.end();
    child.kill('SIGTERM');
  });
  if (result.ok !== true) throw new Error(String(result.error ?? 'read-only connector canary failed'));
  // Deliberately discard result.result: live titles, URLs, shortcut names, and OCR never enter evidence.
}

function idleDoctor(value: unknown): boolean {
  const root = value as {
    ready?: boolean;
    daemon?: { status?: {
      activeEventCount?: number;
      activeTaskCount?: number;
      activeHostMutations?: number;
      outbox?: { pending?: number; sending?: number };
    } };
  };
  const status = root.daemon?.status;
  return root.ready === true
    && status?.activeEventCount === 0
    && status.activeTaskCount === 0
    && status.activeHostMutations === 0
    && status.outbox?.pending === 0
    && status.outbox.sending === 0;
}

async function main(): Promise<void> {
  const output = path.resolve(argument('--output', `artifacts/m1-eval/canary-${Date.now()}.json`));
  const doctor = await commandJson('mimi', ['daemon', 'doctor']);
  if (!idleDoctor(doctor)) throw new Error('live canary gate blocked: daemon/Event/Task/Outbox/host mutation is not idle and ready');
  const connectors = await commandJson('mimi', ['daemon', 'connectors']) as Array<{
    id?: string;
    enabled?: boolean;
    online?: boolean;
    readiness?: { outbound?: string; targetBindingStatus?: string };
  }>;
  const browser = connectors.find((item) => item.id === 'macos-browser');
  const daxiang = connectors.find((item) => item.id === 'personal-daxiang');
  const base = [
    ['browser.tabs', 'Browser', 'macos-browser', 'tabs.read', 'connector'],
    ['shortcuts.catalog', 'Shortcuts', 'macos-shortcuts', 'catalog.read', 'connector'],
    ['computer.readiness', 'Computer', 'cua', 'readiness', 'computer'],
    ['daxiang.binding', 'Daxiang', 'personal-daxiang', 'target.binding', 'personal-message'],
  ] as const;
  const scenarios = Array.from({ length: 20 }, (_, index) => {
    const selected = base[index % base.length]!;
    return {
      id: `${selected[0]}.${String(index + 1).padStart(2, '0')}`,
      app: selected[1],
      channel: selected[2],
      actionFamily: selected[3],
      executionPath: selected[4],
      risk: 'read' as const,
      boundaryRef: `live-readonly-canary/${selected[0]}`,
      expectedOutcome: selected[0] === 'daxiang.binding' ? 'blocked' as const : 'success' as const,
      tags: ['canary', 'readonly'],
    };
  });
  const manifest = m1EvalManifestSchema.parse({
    schemaVersion: 1,
    datasetRevision: 'm1-canary-2026-07-28.1',
    policyRevision: 'm1-policy-c4e3e4a.1',
    toolSnapshotRevision: 'live-doctor-protocol-10',
    scenarios,
  });
  const probe = (scenario: M1EvalScenario): Promise<ProbeResult> => {
    const key = scenario.id.split('.').slice(0, 2).join('.');
    const startedAt = Date.now();
    return (async (): Promise<ProbeResult> => {
      try {
        if (key === 'browser.tabs') {
          if (!browser?.enabled || !browser.online || browser.readiness?.outbound !== 'ready') {
            return { ok: false, blocked: true, classification: 'browser-not-ready', durationMs: Date.now() - startedAt };
          }
          await connectorAction('examples/connectors/macos-browser-connector.mjs', 'list_tabs', 'all', { limit: 5 });
        } else if (key === 'shortcuts.catalog') {
          await connectorAction('examples/connectors/macos-shortcuts-connector.mjs', 'list_folders', 'all', { limit: 5 });
        } else if (key === 'computer.readiness') {
          const freshDoctor = await commandJson('mimi', ['daemon', 'doctor']);
          const computer = (freshDoctor as { computer?: { ready?: boolean } }).computer;
          if (computer?.ready !== true) {
            return { ok: false, blocked: true, classification: 'computer-not-ready', durationMs: Date.now() - startedAt };
          }
        } else {
          const freshConnectors = await commandJson('mimi', ['daemon', 'connectors']) as Array<{
            id?: string;
            enabled?: boolean;
            readiness?: { targetBindingStatus?: string };
          }>;
          const freshDaxiang = freshConnectors.find((item) => item.id === 'personal-daxiang') ?? daxiang;
          const targetNotBound = freshDaxiang?.enabled !== true
            || freshDaxiang.readiness?.targetBindingStatus === 'target_not_bound';
          return {
            ok: false,
            blocked: targetNotBound,
            classification: targetNotBound ? 'target-not-bound' : 'unexpected-daxiang-binding',
            durationMs: Date.now() - startedAt,
          };
        }
        return { ok: true, classification: 'readonly-probe-ok', durationMs: Date.now() - startedAt };
      } catch {
        return { ok: false, blocked: true, classification: 'readonly-probe-unavailable', durationMs: Date.now() - startedAt };
      }
    })();
  };
  const run = await runM1Eval(manifest, {
    buildIdentity: argument('--build', 'working-tree'),
    provider: 'none',
    execute: async (scenario): Promise<M1EvalObservation> => {
      const result = await probe(scenario);
      return {
        outcome: result.ok ? 'success' : result.blocked ? 'blocked' : 'failed',
        severity: result.ok || result.blocked ? 'none' : 'S2',
        evidenceRef: `meta:live/${scenario.id}`,
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
