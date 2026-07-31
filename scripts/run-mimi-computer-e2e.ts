import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CuaDriverClient } from '../src/extensions/computer/cua-driver-client.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mimiEntry = path.join(repositoryRoot, 'dist', 'index.js');
const driverCommand = resolveDriverCommand(process.env.MIMI_CUA_DRIVER_COMMAND ?? 'cua-driver');
const iterations = integerEnvironment('MIMI_E2E_ITERATIONS', 10, 1, 30);
const CALCULATOR_BUNDLE = 'com.apple.calculator';
const TEXTEDIT_BUNDLE = 'com.apple.TextEdit';

interface SessionItem {
  type?: string;
  name?: string;
  callId?: string;
  arguments?: string;
  output?: unknown;
}

interface IterationResult {
  iteration: number;
  success: boolean;
  durationMs: number;
  toolCalls: number;
  computerToolCalls: number;
  operations: string[];
  sessionLeak: boolean;
  outputPreview?: string;
  error?: string;
}

interface IsolatedRuntime {
  root: string;
  dataRoot: string;
  env: NodeJS.ProcessEnv;
  daemon: ChildProcess;
  exited: Promise<void>;
  logs: string[];
}

function resolveDriverCommand(command: string): string {
  if (path.isAbsolute(command)) return command;
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', command),
    ...(process.env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.resolve(directory, command)),
  ];
  const match = [...new Set(candidates)].find((candidate) => {
    try {
      const info = statSync(candidate);
      return info.isFile() && (info.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  });
  if (!match) throw new Error(`Cannot find executable ${command} on PATH`);
  return match;
}

function integerEnvironment(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function mimiCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeout = 30_000,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [mimiEntry, ...args], {
    cwd: repositoryRoot,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function startIsolatedRuntime(): Promise<IsolatedRuntime> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-computer-agent-e2e-'));
  const dataRoot = path.join(root, 'agent');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MIMI_WORKSPACE: repositoryRoot,
    MIMI_DATA_DIR: dataRoot,
    MIMI_DAEMON_DATA_DIR: path.join(root, 'daemon'),
    MIMI_DAEMON_SUPERVISOR: 'foreground',
    MIMI_COMPUTER_BACKEND: 'cua',
    MIMI_CUA_DRIVER_COMMAND: driverCommand,
    MIMI_COMPUTER_DEFAULT_ACCESS: 'background',
    MIMI_SESSION_MAX_CONCURRENCY: '1',
  };
  const logs: string[] = [];
  const daemon = spawn(process.execPath, [mimiEntry, 'daemon', 'run'], {
    cwd: repositoryRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const appendLog = (chunk: Buffer | string) => {
    logs.push(chunk.toString());
    if (logs.length > 200) logs.splice(0, logs.length - 200);
  };
  daemon.stdout?.on('data', appendLog);
  daemon.stderr?.on('data', appendLog);
  const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()));
  const runtime = { root, dataRoot, env, daemon, exited, logs };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (daemon.exitCode !== null) break;
      try {
        const { stdout } = await mimiCommand(['daemon', 'status', '--json'], env, 1_000);
        if (typeof (JSON.parse(stdout) as { pid?: unknown }).pid === 'number') {
          ready = true;
          break;
        }
      } catch {
        await delay(100);
      }
    }
    if (!ready) throw new Error(`isolated daemon did not become ready: ${logs.join('').slice(-4_000)}`);
    const { stdout } = await mimiCommand(['daemon', 'connectors'], env);
    const connectors = JSON.parse(stdout) as Array<{ id?: unknown; enabled?: unknown }>;
    for (const connector of connectors) {
      if (connector.enabled === true && typeof connector.id === 'string') {
        await mimiCommand(['daemon', 'connectors', 'disable', connector.id], env);
      }
    }
    return runtime;
  } catch (error) {
    await stopIsolatedRuntime(runtime);
    throw error;
  }
}

async function stopIsolatedRuntime(runtime: IsolatedRuntime): Promise<void> {
  try {
    await mimiCommand(['daemon', 'stop'], runtime.env, 15_000);
  } catch {
    runtime.daemon.kill('SIGTERM');
  }
  await Promise.race([runtime.exited, delay(15_000)]);
  if (runtime.daemon.exitCode === null && runtime.daemon.signalCode === null) {
    runtime.daemon.kill('SIGKILL');
    await runtime.exited;
  }
  await rm(runtime.root, { recursive: true, force: true });
}

function operation(item: SessionItem): string | undefined {
  if (item.type !== 'function_call' || !item.name) return undefined;
  if (!item.arguments) return item.name;
  try {
    const input = JSON.parse(item.arguments) as { app?: unknown; action?: { type?: unknown } };
    if (item.name === 'computer_observe') {
      return `${item.name}:${typeof input.app === 'string' ? input.app : 'list'}`;
    }
    if (item.name === 'computer_act' && typeof input.action?.type === 'string') {
      return `${item.name}:${input.action.type}`;
    }
  } catch {
    return item.name;
  }
  return item.name;
}

async function newPids(
  backend: CuaDriverClient,
  bundleId: string,
  existing: ReadonlySet<number>,
): Promise<number[]> {
  return [...new Set((await backend.listTargets({ query: bundleId, limit: 50 }))
    .filter((target) => target.bundleId === bundleId && !existing.has(target.pid))
    .map((target) => target.pid))];
}

async function cleanupPids(pids: readonly number[]): Promise<boolean> {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const alive = pids.some((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (!alive) return false;
    await delay(100);
  }
  return pids.some((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}

async function runIteration(
  iteration: number,
  backend: CuaDriverClient,
  runtime: IsolatedRuntime,
): Promise<IterationResult> {
  const started = Date.now();
  const sessionId = `mimi-computer-agent-e2e-${Date.now()}-${iteration}`;
  const dataRoot = runtime.dataRoot;
  const fixture = path.join(runtime.root, `mimi-computer-agent-${iteration}.txt`);
  const initial = `Mimi agent fixture ${iteration}`;
  const expected = `${initial}\nVerified by Mimi agent ${iteration}`;
  await writeFile(fixture, initial, 'utf8');
  const existingCalculator = new Set((await backend.listTargets({ query: CALCULATOR_BUNDLE, limit: 50 }))
    .filter((target) => target.bundleId === CALCULATOR_BUNDLE).map((target) => target.pid));
  const existingTextEdit = new Set((await backend.listTargets({ query: TEXTEDIT_BUNDLE, limit: 50 }))
    .filter((target) => target.bundleId === TEXTEDIT_BUNDLE).map((target) => target.pid));
  let items: SessionItem[] = [];
  let output = '';
  let failure: string | undefined;
  let sessionLeak = false;
  try {
    const prompt = [
      '只使用直接可见的原生 computer_observe 和 computer_act，不要检查或调用 capability gateway、Skill、Shell、AppleScript。',
      `先观察 app=${CALCULATOR_BUNDLE}，然后无论是否已运行都用 launch_app 启动 bundleId=${CALCULATOR_BUNDLE} 且 newInstance=true，只操作这次 launch 返回的新窗口 state。`,
      '用 keypress 依次输入 7、SHIFT+8、8、ENTER，直接使用每次 computer_act 返回的 fresh state，不要在动作之间额外 observe，也不要重复任何按键；确认显示结果 56。',
      `然后用 launch_app 启动 bundleId=${TEXTEDIT_BUNDLE}，newInstance=true，urls=[${JSON.stringify(pathToFileURL(fixture).toString())}]。`,
      `直接在 launch_app 返回的新 TextEdit 窗口 state 中找到可写文本元素；只有结果是 next=computer_observe 时才观察 app=${TEXTEDIT_BUNDLE}。用一次 set_value 把全文设为 ${JSON.stringify(expected)}，并直接从返回的 state 确认 Verified by Mimi agent ${iteration}。`,
      '最后简短汇总 Calculator 结果和 TextEdit 最终文本。',
    ].join('\n');
    const { stdout, stderr } = await mimiCommand(
      [prompt],
      { ...runtime.env, MIMI_SESSION: sessionId },
      240_000,
    );
    output = `${stdout}\n${stderr}`;
    const session = JSON.parse(await readFile(path.join(dataRoot, 'sessions', `${sessionId}.json`), 'utf8')) as {
      items?: SessionItem[];
    };
    items = session.items ?? [];
    const calls = items.filter((item) => item.type === 'function_call');
    const operations = calls.map(operation).filter((value): value is string => Boolean(value));
    const directTools = calls.every((item) => (
      item.name === 'computer_observe'
      || item.name === 'computer_act'
      || item.name === 'read_context_artifact'
    ));
    const serialized = `${output}\n${JSON.stringify(items)}`;
    const required = [
      'computer_observe:com.apple.calculator',
      'computer_act:keypress',
      'computer_act:launch_app',
      'computer_act:set_value',
    ];
    const missing = required.filter((value) => !operations.includes(value));
    if (!directTools) failure = `non-native tools were called: ${operations.join(', ')}`;
    else if (missing.length) failure = `required operations missing: ${missing.join(', ')}`;
    else if (/An error occurred|failed-safe|ActionFailedSafeError/iu.test(JSON.stringify(items))) {
      failure = 'a Computer tool returned a failed result';
    } else if (!serialized.includes('56')) failure = 'Calculator result 56 was not observed';
    else if (!serialized.includes(`Verified by Mimi agent ${iteration}`)) failure = 'TextEdit result was not observed';
    else if (calls.length > 12) failure = `combined Computer tool call budget exceeded: ${calls.length}`;
  } catch (error) {
    failure = errorText(error);
  } finally {
    const created = [
      ...await newPids(backend, CALCULATOR_BUNDLE, existingCalculator),
      ...await newPids(backend, TEXTEDIT_BUNDLE, existingTextEdit),
    ];
    sessionLeak = await cleanupPids(created);
    if (sessionLeak) failure ??= `test app process leak detected: ${created.join(',')}`;
  }
  const calls = items.filter((item) => item.type === 'function_call');
  const operations = calls.map(operation).filter((value): value is string => Boolean(value));
  return {
    iteration,
    success: failure === undefined,
    durationMs: Date.now() - started,
    toolCalls: calls.length,
    computerToolCalls: calls.filter((item) => item.name?.startsWith('computer_')).length,
    operations,
    sessionLeak,
    ...(failure && output.trim() ? { outputPreview: output.trim().slice(0, 2_000) } : {}),
    ...(failure ? { error: failure } : {}),
  };
}

const runtime = await startIsolatedRuntime();
const backend = new CuaDriverClient(driverCommand, 30_000);
const results: IterationResult[] = [];
try {
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const result = await runIteration(iteration, backend, runtime);
    results.push(result);
    process.stderr.write(`[mimi-computer-agent-e2e] ${iteration}/${iterations} ${result.success ? 'pass' : 'fail'} ${result.durationMs}ms ${result.toolCalls} calls${result.error ? `: ${result.error}` : ''}\n`);
  }
} finally {
  await backend.close();
  await stopIsolatedRuntime(runtime);
}

const successes = results.filter((result) => result.success).length;
const report = {
  schemaVersion: 1,
  kind: 'mimi-computer-agent-real-e2e',
  scenarioClasses: ['app-observe', 'keyboard-and-vision', 'text-read-write'],
  iterations,
  successes,
  successRate: iterations ? successes / iterations : 0,
  medianDurationMs: percentile(results.map((result) => result.durationMs), 0.5),
  p95DurationMs: percentile(results.map((result) => result.durationMs), 0.95),
  medianToolCalls: percentile(results.map((result) => result.toolCalls), 0.5),
  p95ToolCalls: percentile(results.map((result) => result.toolCalls), 0.95),
  sessionLeaks: results.filter((result) => result.sessionLeak).length,
  results,
};
process.stdout.write(`${JSON.stringify(report)}\n`);
if (successes !== iterations || report.sessionLeaks !== 0) process.exitCode = 1;
