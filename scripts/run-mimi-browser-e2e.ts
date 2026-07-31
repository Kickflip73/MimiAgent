import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mimiEntry = path.join(repositoryRoot, 'dist', 'index.js');
const iterations = integerEnvironment('MIMI_E2E_ITERATIONS', 10, 1, 30);

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
  browserToolCalls: number;
  contextSupportCalls: number;
  sessionLeak: boolean;
  operations: string[];
  failedTools?: string[];
  outputPreview?: string;
  runDiagnostics?: unknown;
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-browser-agent-e2e-'));
  const dataRoot = path.join(root, 'agent');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MIMI_WORKSPACE: repositoryRoot,
    MIMI_DATA_DIR: dataRoot,
    MIMI_DAEMON_DATA_DIR: path.join(root, 'daemon'),
    MIMI_DAEMON_SUPERVISOR: 'foreground',
    MIMI_COMPUTER_BACKEND: 'off',
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
        const status = JSON.parse(stdout) as { pid?: unknown };
        if (typeof status.pid === 'number') {
          ready = true;
          break;
        }
      } catch {
        await delay(100);
      }
    }
    if (!ready) throw new Error(`isolated daemon did not become ready: ${logs.join('').slice(-4_000)}`);
    await mimiCommand(['daemon', 'connectors', 'enable', 'browser'], env);
    const { stdout: configuredOutput } = await mimiCommand(['daemon', 'connectors'], env);
    const configured = JSON.parse(configuredOutput) as Array<{ id?: unknown; enabled?: unknown }>;
    for (const connector of configured) {
      if (connector.enabled === true && connector.id !== 'browser' && typeof connector.id === 'string') {
        await mimiCommand(['daemon', 'connectors', 'disable', connector.id], env);
      }
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { stdout } = await mimiCommand(['daemon', 'connectors'], env);
      const connectors = JSON.parse(stdout) as Array<{
        id?: unknown;
        online?: unknown;
        readiness?: { outbound?: unknown };
      }>;
      const browser = connectors.find((connector) => connector.id === 'browser');
      if (browser?.online === true && browser.readiness?.outbound === 'ready') return runtime;
      await delay(100);
    }
    throw new Error('isolated Browser Connector did not report outbound readiness');
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

async function fixtureServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    if (url.pathname === '/details') {
      response.end('<!doctype html><html><body><h1>Details</h1><p id="details-status">verified detail</p><a href="/">Back home</a></body></html>');
      return;
    }
    if (url.pathname === '/secondary') {
      response.end('<!doctype html><html><body><h1>Secondary tab</h1><p>secondary extraction marker</p></body></html>');
      return;
    }
    response.end(`<!doctype html><html><body>
      <h1>Mimi Browser Fixture</h1><p id="status">ready</p>
      <a id="details" href="/details">Open details</a>
      <form id="profile">
        <label>Name <input name="name" aria-label="Name"></label>
        <label>Role <select name="role" aria-label="Role"><option value="engineer">Engineer</option><option value="designer">Designer</option></select></label>
        <label><input type="checkbox" name="active"> Active</label>
        <button type="submit">Submit</button>
      </form>
      <pre id="result"></pre>
      <p>main extraction marker</p>
      <script>document.querySelector('#profile').addEventListener('submit', event => {
        event.preventDefault();
        const data = new FormData(event.target);
        document.querySelector('#result').textContent = JSON.stringify({
          name: data.get('name'), role: data.get('role'), active: data.get('active') === 'on'
        });
      });</script>
    </body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not expose a port');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  server.closeIdleConnections();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function parseOperation(item: SessionItem): string | undefined {
  if (item.type !== 'function_call' || !item.name) return undefined;
  if (!item.arguments) return item.name;
  try {
    const input = JSON.parse(item.arguments) as { operation?: unknown };
    return typeof input.operation === 'string' ? `${item.name}:${input.operation}` : item.name;
  } catch {
    return item.name;
  }
}

function structuredToolOutput(output: unknown): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;
  const wrapper = output as { type?: unknown; text?: unknown };
  if (wrapper.type !== 'text' || typeof wrapper.text !== 'string') return output;
  try {
    return JSON.parse(wrapper.text);
  } catch {
    return wrapper.text;
  }
}

function submittedProfile(items: readonly SessionItem[]): unknown {
  const resultByCallId = new Map(items
    .filter((item) => item.type === 'function_call_result' && item.callId)
    .map((item) => [item.callId!, structuredToolOutput(item.output)]));
  const call = items.find((item) => {
    if (item.type !== 'function_call' || item.name !== 'browser_observe' || !item.arguments) return false;
    try {
      const input = JSON.parse(item.arguments) as { operation?: unknown; selector?: unknown };
      return input.operation === 'read_element' && input.selector === '#result';
    } catch {
      return false;
    }
  });
  if (!call?.callId) return undefined;
  const envelope = resultByCallId.get(call.callId) as { result?: { value?: unknown } } | undefined;
  const value = envelope?.result?.value;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function failedToolDetails(items: readonly SessionItem[]): string[] {
  const callsById = new Map(items
    .filter((item) => item.type === 'function_call' && item.callId)
    .map((item) => [item.callId!, item]));
  return items.filter((item) => item.type === 'function_call_result'
    && /An error occurred|failed-safe|ActionFailedSafeError/iu.test(JSON.stringify(item.output)))
    .map((item) => {
      const call = item.callId ? callsById.get(item.callId) : undefined;
      const operation = call ? parseOperation(call) : item.name ?? 'unknown_tool';
      return `${operation}: ${JSON.stringify(item.output).slice(0, 800)}`;
    });
}

async function probeLeaks(env: NodeJS.ProcessEnv): Promise<boolean> {
  const { stdout } = await mimiCommand(['daemon', 'probe', 'browser-tabs'], env);
  const probe = JSON.parse(stdout) as { metadata?: { total?: unknown } };
  return probe.metadata?.total !== 0;
}

async function runIteration(
  baseUrl: string,
  iteration: number,
  runtime: IsolatedRuntime,
): Promise<IterationResult> {
  const started = Date.now();
  const sessionId = `mimi-browser-agent-e2e-${Date.now()}-${iteration}`;
  let toolCalls = 0;
  let browserToolCalls = 0;
  let contextSupportCalls = 0;
  let operations: string[] = [];
  let failedTools: string[] = [];
  let outputPreview: string | undefined;
  let runDiagnostics: unknown;
  let sessionLeak = false;
  let failure: string | undefined;
  try {
    const prompt = [
      `访问 ${baseUrl}/，使用原生 Browser 完成以下确定性任务。`,
      '读取主页 h1 和 #status；用一次 DOM snapshot 获取交互目标。',
      '表单必须使用 accessible label 定位且不要传 ref：把 Name 填为 Mimi，Role 选 Designer，勾选 Active 并提交；已 verified 的局部动作之间不要重复 snapshot，只在提交后读取 #result。',
      '用 role=link,name=Open details 打开详情，用 selector=h1 和 selector=#details-status 读取，再返回主页。',
      `新建标签页打开 ${baseUrl}/secondary，列出标签页并用 selector=h1 读取该页标题，然后关闭这个新标签页。`,
      '回到主页，用 extract 抽取正文并确认 main extraction marker。最后关闭浏览器会话，汇总所有读到的值。',
    ].join('\n');
    const { stdout, stderr } = await mimiCommand(
      [prompt],
      { ...runtime.env, MIMI_SESSION: sessionId },
      240_000,
    );
    const sessionPath = path.join(runtime.dataRoot, 'sessions', `${sessionId}.json`);
    const session = JSON.parse(await readFile(sessionPath, 'utf8')) as { items?: SessionItem[] };
    const items = session.items ?? [];
    const calls = items.filter((item) => item.type === 'function_call');
    toolCalls = calls.length;
    browserToolCalls = calls.filter((item) => item.name?.startsWith('browser_')).length;
    contextSupportCalls = calls.filter((item) => item.name === 'read_context_artifact').length;
    operations = calls.map(parseOperation).filter((value): value is string => Boolean(value));
    const directTools = calls.every((item) => (
      item.name?.startsWith('browser_') || item.name === 'read_context_artifact'
    ));
    failedTools = failedToolDetails(items);
    const requiredOperations = [
      'browser_open',
      'browser_observe:snapshot',
      'browser_act:fill',
      'browser_act:select',
      'browser_act:check',
      'browser_act:click',
      'browser_act:back',
      'browser_act:new_tab',
      'browser_observe:list_tabs',
      'browser_act:close_tab',
      'browser_observe:extract',
      'browser_close',
    ];
    const missing = requiredOperations.filter((operation) => !operations.includes(operation));
    const output = `${stdout}\n${stderr}`;
    const expected = [
      'Mimi Browser Fixture',
      'ready',
      'Mimi',
      'designer',
      'true',
      'Details',
      'verified detail',
      'Secondary tab',
      'main extraction marker',
    ];
    const normalizedOutput = output.replace(/\s+/gu, '');
    const missingOutput = expected.filter((value) => (
      !normalizedOutput.includes(value.replace(/\s+/gu, ''))
    ));
    const profile = submittedProfile(items);
    const profileMatches = JSON.stringify(profile) === JSON.stringify({
      name: 'Mimi',
      role: 'designer',
      active: true,
    });
    if (!directTools) failure = `non-native tools were called: ${operations.join(', ')}`;
    else if (failedTools.length) failure = `a Browser tool returned a failed result: ${failedTools[0]}`;
    else if (missing.length) failure = `required operations missing: ${missing.join(', ')}`;
    else if (!profileMatches) failure = `submitted profile mismatch: ${JSON.stringify(profile)}`;
    else if (missingOutput.length) failure = `expected output missing: ${missingOutput.join(', ')}`;
    else if (toolCalls > 26) failure = `combined scenario tool call budget exceeded: ${toolCalls}`;
    if (failure && output.trim()) outputPreview = output.trim().slice(0, 2_000);
  } catch (error) {
    failure = errorText(error);
  } finally {
    try {
      sessionLeak = await probeLeaks(runtime.env);
      if (sessionLeak) failure ??= 'Browser session leak detected';
    } catch (error) {
      failure ??= `Browser leak probe failed: ${errorText(error)}`;
    }
  }
  if (failure) {
    try {
      const { stdout } = await mimiCommand(['daemon', 'runs', '3'], runtime.env);
      runDiagnostics = JSON.parse(stdout);
    } catch (error) {
      runDiagnostics = { unavailable: errorText(error) };
    }
  }
  return {
    iteration,
    success: failure === undefined,
    durationMs: Date.now() - started,
    toolCalls,
    browserToolCalls,
    contextSupportCalls,
    sessionLeak,
    operations,
    ...(failedTools.length ? { failedTools } : {}),
    ...(outputPreview ? { outputPreview } : {}),
    ...(runDiagnostics !== undefined ? { runDiagnostics } : {}),
    ...(failure ? { error: failure } : {}),
  };
}

const runtime = await startIsolatedRuntime();
let fixture: Awaited<ReturnType<typeof fixtureServer>> | undefined;
const results: IterationResult[] = [];
try {
  fixture = await fixtureServer();
  const { baseUrl } = fixture;
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const result = await runIteration(baseUrl, iteration, runtime);
    results.push(result);
    process.stderr.write(`[mimi-browser-e2e] ${iteration}/${iterations} ${result.success ? 'pass' : 'fail'} ${result.durationMs}ms ${result.toolCalls} calls${result.error ? `: ${result.error}` : ''}\n`);
  }
} finally {
  if (fixture) await closeServer(fixture.server);
  await stopIsolatedRuntime(runtime);
}

const successes = results.filter((result) => result.success).length;
const report = {
  schemaVersion: 1,
  kind: 'mimi-browser-agent-real-e2e',
  scenarioClasses: ['read', 'form', 'navigation', 'tabs', 'extract'],
  iterations,
  successes,
  successRate: iterations ? successes / iterations : 0,
  medianDurationMs: percentile(results.map((result) => result.durationMs), 0.5),
  p95DurationMs: percentile(results.map((result) => result.durationMs), 0.95),
  medianToolCalls: percentile(results.map((result) => result.toolCalls), 0.5),
  p95ToolCalls: percentile(results.map((result) => result.toolCalls), 0.95),
  medianBrowserToolCalls: percentile(results.map((result) => result.browserToolCalls), 0.5),
  medianContextSupportCalls: percentile(results.map((result) => result.contextSupportCalls), 0.5),
  sessionLeaks: results.filter((result) => result.sessionLeak).length,
  results,
};
process.stdout.write(`${JSON.stringify(report)}\n`);
if (successes !== iterations || report.sessionLeaks !== 0) process.exitCode = 1;
