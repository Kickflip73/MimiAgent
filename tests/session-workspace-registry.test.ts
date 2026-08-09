import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionWorkspaceRegistry } from '../src/daemon/session-workspace-registry.js';

test('Session workspace registry persists opaque ids while keeping paths out of Event-safe values', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-registry-'));
  const workspaceA = path.join(root, 'daemon-default');
  const workspaceB = path.join(root, 'client-project');
  await mkdir(workspaceA);
  await mkdir(workspaceB);
  const file = path.join(root, 'daemon', 'session-workspaces.json');
  const registry = new SessionWorkspaceRegistry(file);
  const binding = await registry.bind('new-session', workspaceB);
  assert.match(binding.workspaceId, /^workspace:[0-9a-f-]{36}$/u);
  assert.doesNotMatch(binding.workspaceId, /client-project/u);
  assert.equal((await registry.resolve('new-session', binding.workspaceId))?.workspaceRoot, await realpath(workspaceB));

  const reopened = new SessionWorkspaceRegistry(file);
  assert.deepEqual(await reopened.resolve('new-session', binding.workspaceId), {
    ...binding,
    created: false,
  });
  await assert.rejects(
    reopened.bind('new-session', workspaceA),
    /工作区切换必须经过独立的空闲门禁/u,
  );
  assert.deepEqual(await reopened.resolve('new-session', binding.workspaceId), {
    ...binding,
    created: false,
  });
  await assert.rejects(
    reopened.resolve('other-session', binding.workspaceId),
    /没有持久化 Workspace binding/u,
  );
  const raw = await readFile(file, 'utf8');
  assert.match(raw, /client-project/u);
  assert.doesNotMatch(JSON.stringify({ workspaceId: binding.workspaceId }), /client-project|\/Users\//u);
  assert.equal(await reopened.release('new-session', binding.workspaceId), true);
  assert.equal(await reopened.resolve('new-session'), undefined);
});

test('Session workspace registry binds the physical directory behind a symlink', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-physical-'));
  const physical = path.join(root, 'physical');
  const alias = path.join(root, 'alias');
  await mkdir(physical);
  await symlink(physical, alias, 'dir');
  const registry = new SessionWorkspaceRegistry(path.join(root, 'registry.json'));
  const binding = await registry.bind('session', alias);
  assert.equal(binding.workspaceRoot, await realpath(physical));
});
