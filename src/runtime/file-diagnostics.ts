import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface FileDiagnosticReport {
  status: 'clean' | 'issues' | 'unavailable';
  command?: string;
  files: string[];
  output?: string;
}

const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

async function runBounded(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 10_000,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = (chunk: Buffer) => {
      if (output.length < 20_000) output += chunk.toString('utf8').slice(0, 20_000 - output.length);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: error.message });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: output.trim() });
    });
  });
}

export async function diagnoseWrittenFiles(
  workspaceRoot: string,
  writtenFiles: readonly string[],
): Promise<FileDiagnosticReport> {
  const files = [...new Set(writtenFiles.map((file) => path.resolve(workspaceRoot, file)))];
  if (!files.length) return { status: 'unavailable', files: [] };
  const jsonFiles = files.filter((file) => path.extname(file).toLowerCase() === '.json');
  const jsonIssues: string[] = [];
  for (const file of jsonFiles) {
    try {
      JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      jsonIssues.push(`${path.relative(workspaceRoot, file)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (jsonIssues.length) return { status: 'issues', command: 'JSON.parse', files, output: jsonIssues.join('\n') };
  if (!files.some((file) => CODE_EXTENSIONS.has(path.extname(file).toLowerCase()))) {
    return { status: 'clean', command: jsonFiles.length ? 'JSON.parse' : 'syntax-only', files };
  }
  const compiler = path.join(workspaceRoot, 'node_modules', '.bin', 'tsc');
  const tsconfig = path.join(workspaceRoot, 'tsconfig.json');
  if (!await exists(compiler) || !await exists(tsconfig)) {
    return { status: 'unavailable', files, output: '未找到工作区 node_modules/.bin/tsc 或 tsconfig.json' };
  }
  const result = await runBounded(compiler, ['--noEmit', '--pretty', 'false'], workspaceRoot);
  if (result.code === null) return { status: 'unavailable', command: 'tsc --noEmit', files, output: result.output };
  return {
    status: result.code === 0 ? 'clean' : 'issues',
    command: 'tsc --noEmit',
    files,
    ...(result.output ? { output: result.output } : {}),
  };
}
