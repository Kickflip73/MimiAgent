import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BASE_INSTRUCTIONS } from '../src/runtime/instructions.js';
import { resolveTaskWorkspace } from '../src/runtime/workspace-resolution.js';

test('documents structured workspace ownership without natural-language routing', () => {
  assert.match(BASE_INSTRUCTIONS, /工作区只来自可信 Host 的结构化字段/);
  assert.match(BASE_INSTRUCTIONS, /不会从 owner 自由文本中提取项目名/);
  assert.match(BASE_INSTRUCTIONS, /Memory 和历史中的旧路径只作为线索/);
});

test('uses the requested workspace supplied by the trusted CLI payload', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-requested-'));
  const requested = path.join(root, 'requested');
  const session = path.join(root, 'session');
  const fallback = path.join(root, 'fallback');
  await Promise.all([mkdir(requested), mkdir(session), mkdir(fallback)]);

  assert.deepEqual(await resolveTaskWorkspace({
    requestedWorkspaceRoot: requested,
    sessionWorkspaceRoot: session,
    defaultWorkspaceRoot: fallback,
  }), {
    workspaceRoot: requested,
    source: 'requested-workspace',
    created: false,
  });
});

test('uses the existing Session binding when the request has no workspace field', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-session-'));
  const session = path.join(root, 'session');
  const fallback = path.join(root, 'fallback');
  await Promise.all([mkdir(session), mkdir(fallback)]);

  assert.deepEqual(await resolveTaskWorkspace({
    sessionWorkspaceRoot: session,
    defaultWorkspaceRoot: fallback,
  }), {
    workspaceRoot: session,
    source: 'session',
    created: false,
  });
});

test('uses the runtime default only when no request or Session workspace exists', async () => {
  const fallback = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-default-'));

  assert.deepEqual(await resolveTaskWorkspace({
    defaultWorkspaceRoot: fallback,
  }), {
    workspaceRoot: fallback,
    source: 'runtime-default',
    created: false,
  });
});

test('owner prose cannot name, create, continue, or switch a workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-prose-'));
  const launch = path.join(root, 'launch');
  const misleadingProject = path.join(root, 'IdeaProjects', '应的代码');
  await Promise.all([mkdir(launch), mkdir(misleadingProject, { recursive: true })]);

  const inputs = [
    '你找错了，先去看一下巡检系统的整体流程文档和对应的代码仓库',
    '修复 missing-service 项目的单元测试',
    '创建一个 Unity 太空射击游戏',
    `去修复 ${misleadingProject} 里的构建错误`,
  ];
  for (const input of inputs) {
    const resolved = await resolveTaskWorkspace({
      requestedWorkspaceRoot: launch,
      defaultWorkspaceRoot: launch,
      input,
    } as Parameters<typeof resolveTaskWorkspace>[0] & { input: string });
    assert.equal(resolved.workspaceRoot, launch);
    assert.equal(resolved.source, 'requested-workspace');
  }
});

test('rejects an invalid structured workspace instead of falling back silently', async () => {
  const fallback = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-invalid-'));
  await assert.rejects(resolveTaskWorkspace({
    requestedWorkspaceRoot: path.join(fallback, 'missing'),
    defaultWorkspaceRoot: fallback,
  }), /请求工作区 不存在/);
});
