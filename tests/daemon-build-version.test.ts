import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  computeMimiBuildIdentity,
  computeMimiBuildVersion,
  daemonProtocolAction,
  forcedRestartBlockers,
  inspectGitBuildState,
  mimiBuildDiagnostics,
  MIMI_BUILD_IDENTITY,
  MIMI_BUILD_VERSION,
} from '../src/daemon/client-runtime.js';
import { DAEMON_PROTOCOL_VERSION, type DaemonStatus } from '../src/daemon/types.js';

const execFileAsync = promisify(execFile);
const CLEAN_COMMIT = '0123456789abcdef0123456789abcdef01234567';

test('daemon build identity binds package provenance and runtime content without timestamps', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-build-version-'));
  const runtimeRoot = path.join(root, 'dist');
  const daemonRoot = path.join(runtimeRoot, 'daemon');
  const modulePath = path.join(daemonRoot, 'client-runtime.js');
  const otherModule = path.join(runtimeRoot, 'index.js');
  await mkdir(daemonRoot, { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  await writeFile(path.join(runtimeRoot, 'build-identity.json'), JSON.stringify({
    schemaVersion: 1,
    packageVersion: '1.2.3',
    commitSha: CLEAN_COMMIT,
    dirty: false,
  }));
  await writeFile(modulePath, 'export const runtime = true;\n');
  await writeFile(otherModule, 'export const entry = true;\n');

  const initial = computeMimiBuildIdentity(modulePath);
  assert.equal(initial.commitSha, CLEAN_COMMIT);
  assert.equal(initial.dirty, false);
  assert.equal(initial.source, 'manifest');
  assert.match(initial.value, new RegExp(`^1\\.2\\.3\\+g${CLEAN_COMMIT}\\.clean\\.[0-9a-f]{12}$`));
  assert.equal(computeMimiBuildVersion(modulePath), initial.value);
  const later = new Date(Date.now() + 60_000);
  await utimes(modulePath, later, later);
  await utimes(otherModule, later, later);
  assert.deepEqual(computeMimiBuildIdentity(modulePath), initial);

  await writeFile(otherModule, 'export const entry = false;\n');
  assert.notEqual(computeMimiBuildVersion(modulePath), initial.value);

  await writeFile(path.join(runtimeRoot, 'build-identity.json'), JSON.stringify({
    schemaVersion: 1,
    packageVersion: '1.2.3',
    commitSha: CLEAN_COMMIT,
    dirty: true,
  }));
  const dirty = computeMimiBuildIdentity(modulePath);
  assert.equal(dirty.dirty, true);
  assert.match(dirty.value, /\.dirty\./);
  assert.notEqual(dirty.value, initial.value);
});

test('malformed or stale packaged provenance fails closed as unknown dirty', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-build-invalid-'));
  const runtimeRoot = path.join(root, 'dist');
  const daemonRoot = path.join(runtimeRoot, 'daemon');
  const modulePath = path.join(daemonRoot, 'client-runtime.js');
  await mkdir(daemonRoot, { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  await writeFile(modulePath, 'export const runtime = true;\n');
  await writeFile(path.join(runtimeRoot, 'build-identity.json'), JSON.stringify({
    schemaVersion: 1,
    packageVersion: '9.9.9',
    commitSha: 'not-a-commit',
    dirty: false,
  }));

  const identity = computeMimiBuildIdentity(modulePath);
  assert.equal(identity.commitSha, 'unknown');
  assert.equal(identity.dirty, true);
  assert.equal(identity.source, 'invalid_manifest');
  assert.match(identity.value, /^1\.2\.3\+gunknown\.dirty\.[0-9a-f]{12}$/);
});

test('Doctor build diagnostics expose installed, running, and optional workspace HEAD read-only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-build-git-'));
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'mimi-test@example.invalid'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Mimi Test'], { cwd: root });
  await writeFile(path.join(root, 'tracked.txt'), 'clean\n');
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd: root });
  await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });

  const cleanHead = inspectGitBuildState(root);
  assert.match(cleanHead?.commitSha ?? '', /^[0-9a-f]{40}$/);
  assert.equal(cleanHead?.dirty, false);
  assert.deepEqual(mimiBuildDiagnostics(MIMI_BUILD_VERSION, root), {
    installed: MIMI_BUILD_VERSION,
    running: MIMI_BUILD_VERSION,
    aligned: true,
    workspaceHead: cleanHead,
  });

  await writeFile(path.join(root, 'tracked.txt'), 'dirty\n');
  const dirtyHead = inspectGitBuildState(root);
  assert.equal(dirtyHead?.commitSha, cleanHead?.commitSha);
  assert.equal(dirtyHead?.dirty, true);
  const drift = mimiBuildDiagnostics('0.0.0+gdifferent.dirty.fixture', root);
  assert.equal(drift.aligned, false);
  assert.equal(drift.workspaceHead?.dirty, true);
  assert.equal(MIMI_BUILD_IDENTITY.value, MIMI_BUILD_VERSION);
});

test('a compatible busy daemon remains usable until a build upgrade is safe', () => {
  const status = {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    buildVersion: `${MIMI_BUILD_VERSION}-different`,
    permissionMode: 'trusted',
    tasks: { running: 1 },
  } as DaemonStatus;

  assert.equal(daemonProtocolAction(status, 'trusted'), 'reuse');
  assert.throws(
    () => daemonProtocolAction({ ...status, permissionMode: 'workspace' }, 'trusted'),
    /执行档位/,
  );
});

test('forced restart interrupts model-only work but protects uncertain boundaries', () => {
  assert.deepEqual(forcedRestartBlockers({
    activeEventCount: 1,
    activeToolCount: 0,
    activeTaskCount: 0,
    activeHostMutations: 0,
    outbox: { sending: 0 },
  }), []);
  assert.deepEqual(forcedRestartBlockers({
    activeEventCount: 1,
    activeTaskCount: 0,
    activeHostMutations: 0,
    outbox: { sending: 0 },
  }), ['活动 Run 未报告在途 Tool 状态']);
  assert.deepEqual(forcedRestartBlockers({
    activeEventCount: 1,
    activeToolCount: 2,
    activeTaskCount: 1,
    activeHostMutations: 1,
    outbox: { sending: 1 },
  }), [
    '在途 Tool 2',
    '独立 Task worker 1',
    'Host mutation 1',
    'Outbox sending 1',
  ]);
});
