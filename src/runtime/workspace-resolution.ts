import { constants } from 'node:fs';
import { access, mkdir, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type WorkspaceResolutionSource =
  | 'explicit-path'
  | 'named-project'
  | 'current-directory'
  | 'session'
  | 'default-task';

export interface WorkspaceResolution {
  workspaceRoot: string;
  source: WorkspaceResolutionSource;
  created: boolean;
}

export interface WorkspaceResolutionInput {
  input: string;
  requestedWorkspaceRoot?: string;
  sessionWorkspaceRoot?: string;
  homeDirectory?: string;
}

const CURRENT_PROJECT = /(?:当前|这个|本|这里的|这个目录(?:里的)?)(?:项目|工程|仓库|代码|目录)|(?:current|this)\s+(?:project|repository|repo|workspace|directory)/iu;
const CONTINUE_CURRENT_WORK = /(?:继续|接着|延续|完善|补充|迭代|这个(?:游戏|应用|网站|项目|工程|事项))|\b(?:continue|resume|keep working|extend|finish)\b/iu;
const NEW_WORK = /(?:创建|新建|从零(?:开始)?|搭建|生成|制作|开发|实现|写(?:一份|一个)?|做(?:一个|个)?).{0,40}(?:项目|工程|应用|程序|游戏|网站|页面|插件|脚本|报告|文档|PPT|演示|表格|工作簿|图片|视频|音频)|\b(?:create|build|generate|make|develop|implement|write)\b.{0,60}\b(?:project|app|application|game|website|page|plugin|script|report|document|deck|spreadsheet|image|video|audio)\b/iu;
const DEVELOPMENT_WORK = /(?:代码|仓库|项目|工程|实现|修复|重构|构建|测试|编译|依赖|模块|函数|接口|组件|部署|code|repository|repo|project|implement|fix|refactor|build|test|compile|dependency|module|function|interface|component|deploy)/iu;

async function directory(value: string): Promise<string | undefined> {
  try {
    const resolved = path.resolve(value);
    const info = await stat(resolved);
    return info.isDirectory() ? resolved : info.isFile() ? path.dirname(resolved) : undefined;
  } catch {
    return undefined;
  }
}

function unquote(value: string): string {
  return value.trim().replace(/^['"`]|['"`，。；;：:,）)\]}]+$/gu, '');
}

function explicitPathCandidates(input: string, homeDirectory: string, requested?: string): string[] {
  const values: string[] = [];
  const pattern = /(?:^|[\s"'`（(])((?:~\/|\/)[^\s"'`，。；;：:,）)\]}]+)/gu;
  for (const match of input.matchAll(pattern)) {
    const raw = unquote(match[1] ?? '');
    if (!raw) continue;
    values.push(raw.startsWith('~/') ? path.join(homeDirectory, raw.slice(2)) : raw);
  }
  const relativePattern = /(?:^|[\s"'`（(])(\.{1,2}\/[^\s"'`，。；;：:,）)\]}]+)/gu;
  if (requested) {
    for (const match of input.matchAll(relativePattern)) {
      const raw = unquote(match[1] ?? '');
      if (raw) values.push(path.resolve(requested, raw));
    }
  }
  return [...new Set(values)];
}

function requestedProjectName(input: string): string | undefined {
  const patterns = [
    /(?:对|进入|打开|切换到|开发|修改|修复|构建|测试)\s*([\p{L}\p{N}._-]{2,80})\s*(?:项目|工程|仓库)/iu,
    /\b(?:open|switch to|develop|modify|fix|build|test)\s+([A-Za-z0-9._-]{2,80})\s+(?:project|repository|repo)\b/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(input);
    if (match?.[1] && !/^(?:当前|这个|本|这里|current|this)/iu.test(match[1])) return match[1];
  }
  return undefined;
}

async function childDirectories(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .slice(0, 500)
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

async function resolveNamedProject(
  name: string,
  requestedWorkspaceRoot: string | undefined,
  homeDirectory: string,
): Promise<string | undefined> {
  const roots = new Set([
    requestedWorkspaceRoot ? path.dirname(path.resolve(requestedWorkspaceRoot)) : undefined,
    path.join(homeDirectory, 'Project'),
    path.join(homeDirectory, 'Projects'),
    path.join(homeDirectory, 'IdeaProjects'),
    path.join(homeDirectory, 'Documents', 'Mimi'),
    path.join(homeDirectory, 'MimiWorkspace'),
  ].filter((value): value is string => Boolean(value)));
  const candidates = new Set<string>();
  for (const root of roots) {
    const direct = await directory(path.join(root, name));
    if (direct) candidates.add(direct);
    if (root.endsWith(path.join('Documents', 'Mimi'))) {
      for (const child of await childDirectories(root)) {
        const dated = await directory(path.join(child, name));
        if (dated) candidates.add(dated);
      }
    }
  }
  if (candidates.size > 1) {
    throw new Error(`项目 ${name} 对应多个工作区，请提供明确的绝对路径：${[...candidates].join(', ')}`);
  }
  return [...candidates][0];
}

function taskSlug(input: string): string {
  const firstLine = input.split(/\r?\n/, 1)[0] ?? '';
  const withoutLead = firstLine
    .replace(/^(?:请|麻烦|帮我|给我|我要|我想要|可以)?\s*(?:(?:创建|新建|从零(?:开始)?|搭建|生成|制作|开发|实现|做)(?:一份|一个|个)?|写(?:一份|一个)?)\s*/u, '')
    .replace(/^(?:please\s+)?(?:create|build|generate|make|develop|implement|write)\s+/iu, '');
  const normalized = withoutLead
    .replace(/(?:~\/|\/)[^\s"'`，。；;：:,）)\]}]+/gu, '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return [...(normalized || '未命名事项')].slice(0, 48).join('');
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function resolveTaskWorkspace(
  request: WorkspaceResolutionInput,
): Promise<WorkspaceResolution> {
  const homeDirectory = request.homeDirectory ?? os.homedir();
  const requested = request.requestedWorkspaceRoot
    ? await directory(request.requestedWorkspaceRoot)
    : undefined;
  const session = request.sessionWorkspaceRoot
    ? await directory(request.sessionWorkspaceRoot)
    : undefined;

  const explicitCandidates = explicitPathCandidates(request.input, homeDirectory, requested);
  for (const candidate of explicitCandidates) {
    const resolved = await directory(candidate);
    if (resolved) return { workspaceRoot: resolved, source: 'explicit-path', created: false };
  }
  if (explicitCandidates.length) {
    if (NEW_WORK.test(request.input)) {
      const target = path.resolve(explicitCandidates[0]!);
      await mkdir(target, { recursive: true });
      return { workspaceRoot: target, source: 'explicit-path', created: true };
    }
    throw new Error(`指定的项目工作区不存在：${explicitCandidates[0]}`);
  }

  const projectName = requestedProjectName(request.input);
  if (projectName) {
    const project = await resolveNamedProject(projectName, requested, homeDirectory);
    if (project) return { workspaceRoot: project, source: 'named-project', created: false };
    throw new Error(`未找到项目 ${projectName} 的工作区，请提供明确的绝对路径`);
  }

  const defaultRoot = path.join(homeDirectory, 'MimiWorkspace');
  if (session && inside(defaultRoot, session)
    && NEW_WORK.test(request.input)
    && CONTINUE_CURRENT_WORK.test(request.input)) {
    return { workspaceRoot: session, source: 'session', created: false };
  }
  if (NEW_WORK.test(request.input) && !CURRENT_PROJECT.test(request.input)) {
    const target = path.join(defaultRoot, taskSlug(request.input));
    let created = false;
    try {
      await access(target, constants.F_OK);
    } catch {
      await mkdir(target, { recursive: true });
      created = true;
    }
    return { workspaceRoot: target, source: 'default-task', created };
  }
  if (requested && (CURRENT_PROJECT.test(request.input) || DEVELOPMENT_WORK.test(request.input))) {
    return { workspaceRoot: requested, source: 'current-directory', created: false };
  }
  if (session) return { workspaceRoot: session, source: 'session', created: false };
  if (requested) return { workspaceRoot: requested, source: 'current-directory', created: false };

  const target = path.join(defaultRoot, taskSlug(request.input));
  await mkdir(target, { recursive: true });
  return { workspaceRoot: target, source: 'default-task', created: true };
}
