import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

interface ExpectedFile {
  path: string;
  absent?: boolean;
  contains?: string;
}

interface AgentEvalCase {
  name: string;
  input: string;
  expectedTools?: string[];
  expectedAnyTools?: string[][];
  forbiddenTools?: string[];
  expectedOutputPatterns?: string[];
  fixtureFiles?: Record<string, string>;
  expectedFiles?: ExpectedFile[];
  maxDurationMs?: number;
  env?: Record<string, string>;
}

interface ProcessResult {
  output: string;
  durationMs: number;
}

const projectRoot = process.cwd();
const configuredCases = process.argv[2]?.trim() ?? process.env.MIMI_AGENT_EVAL_CASES?.trim();
const casesFile = configuredCases
  ? path.resolve(projectRoot, configuredCases)
  : path.join(projectRoot, 'evals', 'agent-cases.json');
const cases = JSON.parse(await readFile(casesFile, 'utf8')) as AgentEvalCase[];
const entry = path.join(projectRoot, 'src', 'index.ts');
let passed = 0;

function workspacePath(workspaceRoot: string, requestedPath: string): string {
  const target = path.resolve(workspaceRoot, requestedPath);
  const relative = path.relative(workspaceRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`eval 文件路径必须是工作区内的相对路径：${requestedPath}`);
  }
  return target;
}

async function prepareWorkspace(workspaceRoot: string, item: AgentEvalCase): Promise<void> {
  await mkdir(workspaceRoot, { recursive: true });
  for (const [requestedPath, content] of Object.entries(item.fixtureFiles ?? {})) {
    const target = workspacePath(workspaceRoot, requestedPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

function caseEnvironment(
  item: AgentEvalCase,
  caseRoot: string,
  workspaceRoot: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MIMI_WORKSPACE: workspaceRoot,
    AGENT_WORKSPACE: workspaceRoot,
    MIMI_DATA_DIR: path.join(caseRoot, 'data'),
    MIMI_DAEMON_DATA_DIR: path.join(caseRoot, 'daemon'),
    MIMI_SKILLS_DIR: path.join(workspaceRoot, 'skills'),
    MIMI_MCP_CONFIG: path.join(caseRoot, 'mcp.json'),
    MIMI_ENV_FILE: path.join(caseRoot, '.env'),
    MIMI_COMPUTER_BACKEND: 'off',
    MIMI_PERMISSION_MODE: 'trusted',
    MIMI_SESSION: 'eval',
    MIMI_MODE: 'general',
    MIMI_MAX_TURNS: '12',
    MIMI_OUTPUT_LEVEL: 'trace',
    MIMI_TTS_ENABLED: 'false',
    ...item.env,
  };
}

async function runCase(
  item: AgentEvalCase,
  caseRoot: string,
  workspaceRoot: string,
): Promise<ProcessResult> {
  const mcpConfig = path.join(caseRoot, 'mcp.json');
  await writeFile(mcpConfig, '{"servers":{}}\n', 'utf8');
  const startedAt = Date.now();
  const maximum = item.maxDurationMs ?? 90_000;
  const hardTimeoutMs = Math.max(90_000, maximum * 2);
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry, item.input], {
      cwd: workspaceRoot,
      env: caseEnvironment(item, caseRoot, workspaceRoot),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, hardTimeoutMs);
    child.stdout.on('data', (chunk) => { text += String(chunk); });
    child.stderr.on('data', (chunk) => { text += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Agent eval 超过硬超时 ${hardTimeoutMs}ms\n${text}`));
      else if (code === 0) resolve(text);
      else reject(new Error(`Agent eval 退出码 ${String(code)}\n${text}`));
    });
  });
  return { output, durationMs: Date.now() - startedAt };
}

async function stopCaseDaemon(
  item: AgentEvalCase,
  caseRoot: string,
  workspaceRoot: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry, 'daemon', 'stop'], {
      cwd: workspaceRoot,
      env: caseEnvironment(item, caseRoot, workspaceRoot),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`隔离 Daemon 在 15 秒内未停止\n${output}`));
    }, 15_000);
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`隔离 Daemon 停止失败（退出码 ${String(code)}）\n${output}`));
    });
  });
}

async function terminateCaseDaemon(caseRoot: string, workspaceRoot: string): Promise<void> {
  const journal = JSON.parse(
    await readFile(path.join(caseRoot, 'daemon', 'lifecycle.json'), 'utf8'),
  ) as { epochs?: Array<{ pid?: number; phase?: string; workspaceRoot?: string }> };
  const epoch = journal.epochs?.at(-1);
  if (!epoch || !['starting', 'online', 'stopping'].includes(epoch.phase ?? '')) return;
  if (epoch.workspaceRoot !== workspaceRoot || !Number.isSafeInteger(epoch.pid) || epoch.pid! <= 0) {
    throw new Error('拒绝终止无法验证归属的隔离 Daemon');
  }
  try { process.kill(epoch.pid!, 'SIGTERM'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(epoch.pid!, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.kill(epoch.pid!, 'SIGKILL');
}

function usedTool(output: string, name: string): boolean {
  return output.includes(`工具  ${name}`);
}

async function verifyFiles(
  workspaceRoot: string,
  expectations: readonly ExpectedFile[],
): Promise<string[]> {
  const failures: string[] = [];
  for (const expectation of expectations) {
    const target = workspacePath(workspaceRoot, expectation.path);
    let contents: string | undefined;
    try {
      contents = await readFile(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (expectation.absent) {
      if (contents !== undefined) failures.push(`文件仍存在: ${expectation.path}`);
      continue;
    }
    if (contents === undefined) {
      failures.push(`文件不存在: ${expectation.path}`);
    } else if (expectation.contains !== undefined && !contents.includes(expectation.contains)) {
      failures.push(`文件缺少内容: ${expectation.path} → ${expectation.contains}`);
    }
  }
  return failures;
}

for (const item of cases) {
  const caseRoot = await mkdtemp(path.join(os.tmpdir(), 'mimi-agent-eval-'));
  const workspaceRoot = path.join(caseRoot, 'workspace');
  let result: ProcessResult | undefined;
  const failures: string[] = [];
  try {
    await prepareWorkspace(workspaceRoot, item);
    try {
      result = await runCase(item, caseRoot, workspaceRoot);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    if (result) {
      const missing = (item.expectedTools ?? []).filter((name) => !usedTool(result!.output, name));
      if (missing.length) failures.push(`缺少工具: ${missing.join(', ')}`);
      for (const group of item.expectedAnyTools ?? []) {
        if (!group.some((name) => usedTool(result!.output, name))) {
          failures.push(`未使用任一候选工具: ${group.join(' | ')}`);
        }
      }
      const forbidden = (item.forbiddenTools ?? []).filter((name) => usedTool(result!.output, name));
      if (forbidden.length) failures.push(`使用了禁止工具: ${forbidden.join(', ')}`);
      for (const pattern of item.expectedOutputPatterns ?? []) {
        if (!new RegExp(pattern, 'u').test(result.output)) failures.push(`输出未匹配: ${pattern}`);
      }
      if (result.durationMs > (item.maxDurationMs ?? 90_000)) {
        failures.push(`耗时 ${result.durationMs}ms 超过 ${item.maxDurationMs ?? 90_000}ms`);
      }
    }
    failures.push(...await verifyFiles(workspaceRoot, item.expectedFiles ?? []));
  } finally {
    try {
      await stopCaseDaemon(item, caseRoot, workspaceRoot);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      try {
        await terminateCaseDaemon(caseRoot, workspaceRoot);
      } catch (cleanupError) {
        failures.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
      }
    } finally {
      await rm(caseRoot, { recursive: true, force: true });
    }
  }
  const ok = failures.length === 0;
  const duration = result ? ` (${result.durationMs}ms)` : '';
  console.log(`${ok ? '✓' : '✗'} ${item.name}${duration}`);
  if (ok) passed += 1;
  else {
    for (const failure of failures) console.log(`  - ${failure.slice(0, 3_000)}`);
  }
}

console.log(`\n${passed}/${cases.length} agent behavior evals passed`);
if (passed !== cases.length) process.exitCode = 1;
