import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BASE_INSTRUCTIONS } from '../src/runtime/instructions.js';
import { resolveTaskWorkspace } from '../src/runtime/workspace-resolution.js';

test('tells Mimi where user work lives and treats stale memory paths only as clues', () => {
  assert.match(BASE_INSTRUCTIONS, /默认用户工作根目录 ~\/MimiWorkspace/);
  assert.match(BASE_INSTRUCTIONS, /默认使用用户运行本次 mimi 的目录/);
  assert.match(BASE_INSTRUCTIONS, /为当前代码仓库创建文档.*仍保存在当前工作区/);
  assert.match(BASE_INSTRUCTIONS, /Memory 和历史中的旧路径只作为线索/);
  assert.match(BASE_INSTRUCTIONS, /禁止因旧路径不存在就断言项目或文件已经丢失/);
  assert.match(BASE_INSTRUCTIONS, /MimiAgent 运行时代码目录.*不能承载无关用户项目/);
});

test('uses an explicit project path instead of the directory where Mimi was started', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-explicit-'));
  const launchDirectory = path.join(home, 'unrelated');
  const project = path.join(home, 'Projects', 'target-project');
  await Promise.all([mkdir(launchDirectory, { recursive: true }), mkdir(project, { recursive: true })]);

  const resolved = await resolveTaskWorkspace({
    input: `请修复 ${project} 里的构建错误`,
    requestedWorkspaceRoot: launchDirectory,
    homeDirectory: home,
  });

  assert.deepEqual(resolved, {
    workspaceRoot: project,
    source: 'explicit-path',
    created: false,
  });
});

test('resolves a named project from standard project roots', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-named-'));
  const launchDirectory = path.join(home, 'Downloads');
  const project = path.join(home, 'IdeaProjects', 'supply-service');
  await Promise.all([mkdir(launchDirectory), mkdir(project, { recursive: true })]);

  const resolved = await resolveTaskWorkspace({
    input: '去修复 supply-service 项目的单元测试',
    requestedWorkspaceRoot: launchDirectory,
    homeDirectory: home,
  });

  assert.equal(resolved.workspaceRoot, project);
  assert.equal(resolved.source, 'named-project');
});

test('does not fall back to the launch directory when a named project is missing', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-missing-'));
  const launchDirectory = path.join(home, 'Project', 'unrelated');
  await mkdir(launchDirectory, { recursive: true });

  await assert.rejects(resolveTaskWorkspace({
    input: '修复 missing-service 项目的单元测试',
    requestedWorkspaceRoot: launchDirectory,
    homeDirectory: home,
  }), /未找到项目 missing-service.*绝对路径/);
});

test('uses the launch directory for work on the current project', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-current-'));
  const project = path.join(home, 'Project', 'current-service');
  await mkdir(project, { recursive: true });

  const resolved = await resolveTaskWorkspace({
    input: '修复当前项目的 TypeScript 类型错误',
    requestedWorkspaceRoot: project,
    homeDirectory: home,
  });

  assert.equal(resolved.workspaceRoot, project);
  assert.equal(resolved.source, 'current-directory');
});

test('keeps a code analysis and its requested document in the launch repository', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-analysis-'));
  const project = path.join(home, 'IdeaProjects', 'inspection-service');
  await mkdir(project, { recursive: true });

  const resolved = await resolveTaskWorkspace({
    input: [
      '深度分析当前巡检领域相关的代码逻辑，对巡检领域做一次整体的业务逻辑梳理，',
      '重点梳理定时任务相关的业务逻辑，以及巡检相关的一些接口。',
      '给巡检做一个全面的业务流程梳理，并落到一个文档。',
    ].join(''),
    requestedWorkspaceRoot: project,
    homeDirectory: home,
  });

  assert.deepEqual(resolved, {
    workspaceRoot: project,
    source: 'current-directory',
    created: false,
  });
  await assert.rejects(stat(path.join(home, 'MimiWorkspace')), { code: 'ENOENT' });
});

test('creates an ordinary requested document in the launch directory', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-document-'));
  const project = path.join(home, 'Projects', 'current-service');
  await mkdir(project, { recursive: true });

  const resolved = await resolveTaskWorkspace({
    input: '写一份接口排查文档',
    requestedWorkspaceRoot: project,
    homeDirectory: home,
  });

  assert.equal(resolved.workspaceRoot, project);
  assert.equal(resolved.source, 'current-directory');
  await assert.rejects(stat(path.join(home, 'MimiWorkspace')), { code: 'ENOENT' });
});

test('prefers the current CLI launch directory over an unrelated Session workspace', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-cli-session-'));
  const project = path.join(home, 'IdeaProjects', 'inspection-service');
  const staleSession = path.join(home, 'MimiWorkspace', 'old-task');
  await Promise.all([mkdir(project, { recursive: true }), mkdir(staleSession, { recursive: true })]);

  const resolved = await resolveTaskWorkspace({
    input: '当前工作区是哪个？',
    requestedWorkspaceRoot: project,
    sessionWorkspaceRoot: staleSession,
    homeDirectory: home,
  });

  assert.equal(resolved.workspaceRoot, project);
  assert.equal(resolved.source, 'current-directory');
});

test('creates a concrete task directory under MimiWorkspace for unspecified new work', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-default-'));
  const unrelated = path.join(home, 'Project', 'MimiAgent');
  await mkdir(unrelated, { recursive: true });

  const resolved = await resolveTaskWorkspace({
    input: '创建一个 Unity 太空射击游戏',
    requestedWorkspaceRoot: unrelated,
    homeDirectory: home,
  });

  assert.equal(resolved.workspaceRoot, path.join(home, 'MimiWorkspace', 'Unity-太空射击游戏'));
  assert.equal(resolved.source, 'default-task');
  assert.equal(resolved.created, true);
  assert.equal((await stat(resolved.workspaceRoot)).isDirectory(), true);
});

test('creates an explicitly requested directory for new project work', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-create-explicit-'));
  const target = path.join(home, 'Projects', 'new-game');

  const resolved = await resolveTaskWorkspace({
    input: `在 ${target} 创建一个新游戏项目`,
    homeDirectory: home,
  });

  assert.deepEqual(resolved, {
    workspaceRoot: target,
    source: 'explicit-path',
    created: true,
  });
  assert.equal((await stat(target)).isDirectory(), true);
});

test('continues a newly created task in the Session workspace', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-session-'));
  const sessionWorkspace = path.join(home, 'MimiWorkspace', 'Unity-太空射击游戏');
  const launchDirectory = path.join(home, 'Project', 'MimiAgent');
  await Promise.all([mkdir(sessionWorkspace, { recursive: true }), mkdir(launchDirectory, { recursive: true })]);

  const resolved = await resolveTaskWorkspace({
    input: '继续开发这个游戏项目，补上开始菜单',
    requestedWorkspaceRoot: launchDirectory,
    sessionWorkspaceRoot: sessionWorkspace,
    homeDirectory: home,
  });

  assert.equal(resolved.workspaceRoot, sessionWorkspace);
  assert.equal(resolved.source, 'session');
});

test('creates a different default directory for a clearly new task in the same Session', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-new-task-'));
  const sessionWorkspace = path.join(home, 'MimiWorkspace', '太空射击游戏');
  await mkdir(sessionWorkspace, { recursive: true });

  const resolved = await resolveTaskWorkspace({
    input: '创建一个个人记账网站',
    sessionWorkspaceRoot: sessionWorkspace,
    homeDirectory: home,
  });

  assert.equal(resolved.workspaceRoot, path.join(home, 'MimiWorkspace', '个人记账网站'));
  assert.equal(resolved.source, 'default-task');
});
