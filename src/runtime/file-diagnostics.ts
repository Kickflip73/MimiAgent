import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface FileDiagnosticReport {
  status: 'clean' | 'issues' | 'unavailable';
  command?: string;
  files: string[];
  output?: string;
  uncheckedFiles?: string[];
  nextChecks?: string[];
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
  const uncheckedFiles = files.filter(file => !CODE_EXTENSIONS.has(path.extname(file).toLowerCase())
    && path.extname(file).toLowerCase() !== '.json');
  const visual = files.some(file => /\.(?:html?|svg|css|jsx|tsx)$/i.test(file));
  const nextChecks = visual
    ? ['在浏览器实际渲染并查看截图，核对布局、文字、裁切；动画观察不同时间点，交互实际操作验收。语法检查不能证明视觉或行为正确。']
    : ['按用户要求核对内容或运行相关行为测试；语法检查不代表业务验收。'];
  const coverage = { uncheckedFiles, nextChecks };
  const jsonIssues: string[] = [];
  for (const file of jsonFiles) {
    try {
      JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      jsonIssues.push(`${path.relative(workspaceRoot, file)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (jsonIssues.length) return { status: 'issues', command: 'JSON.parse', files, ...coverage, output: jsonIssues.join('\n') };
  if (!files.some((file) => CODE_EXTENSIONS.has(path.extname(file).toLowerCase()))) {
    return { status: uncheckedFiles.length ? 'unavailable' : 'clean', files, ...coverage,
      ...(jsonFiles.length ? { command: 'JSON.parse' } : {}),
      ...(uncheckedFiles.length ? { output: '这些格式未检查，不得声称语法或效果校验通过。' } : {}),
    };
  }
  const compiler = path.join(workspaceRoot, 'node_modules', '.bin', 'tsc');
  const tsconfig = path.join(workspaceRoot, 'tsconfig.json');
  if (!await exists(compiler) || !await exists(tsconfig)) {
    return { status: 'unavailable', files, ...coverage, output: '未找到工作区 node_modules/.bin/tsc 或 tsconfig.json' };
  }
  const result = await runBounded(compiler, ['--noEmit', '--pretty', 'false'], workspaceRoot);
  if (result.code === null) return { status: 'unavailable', command: 'tsc --noEmit', files, ...coverage, output: result.output };
  return {
    status: result.code !== 0 ? 'issues' : uncheckedFiles.length ? 'unavailable' : 'clean',
    command: 'tsc --noEmit',
    files,
    ...coverage,
    ...(uncheckedFiles.length ? { output: '部分文件格式未检查，tsc 只检查当前项目配置包含的代码。' } : {}),
    ...(result.output ? { output: result.output } : {}),
  };
}
