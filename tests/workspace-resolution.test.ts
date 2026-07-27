import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BASE_INSTRUCTIONS } from '../src/runtime/instructions.js';
import { resolveTaskWorkspace } from '../src/runtime/workspace-resolution.js';

test('tells Mimi where user work lives and treats stale memory paths only as clues', () => {
  assert.match(BASE_INSTRUCTIONS, /默认用户工作根目录 ~\/MimiWorkspace/);
  assert.match(BASE_INSTRUCTIONS, /Memory 和历史中的旧路径只作为线索/);
  assert.match(BASE_INSTRUCTIONS, /禁止因旧路径不存在就断言项目或文件已经丢失/);
  assert.match(BASE_INSTRUCTIONS, /MimiAgent 运行时代码目录.*不能作为.*用户工作内容的默认目录/);
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
