import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  bindControlledRawRuntimeDaemon,
  createControlledRawRuntime,
  finalizeControlledRawRuntime,
  recoverControlledRawRuntimes,
  setupControlledRawRuntime,
  terminateProcessWithDeadlines,
  type ExitObservableProcess,
  type RawRuntimeOwnerIdentity,
} from '../scripts/conversation-runtime-lifecycle.js';

const createdAt = '2026-08-10T00:00:00.000Z';
const owner: RawRuntimeOwnerIdentity = {
  pid: 424242,
  instanceId: 'test-owner-0001',
  startedAt: '2026-08-09T23:59:00.000Z',
};

async function privateStorage(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await chmod(root, 0o700);
  return root;
}

function options(storageRoot: string, identity: string) {
  return {
    storageRoot,
    now: () => new Date(createdAt),
    identityFactory: () => identity,
    owner,
  };
}

async function waitForJson(file: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path.basename(file)}`);
}

async function waitForPidGone(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} did not exit`);
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

test('controlled raw runtime writes a private owner identity immediately and cleans setup failure', async () => {
  const storageRoot = await privateStorage('mimi-runtime-lifecycle-setup-');
  let observedRoot: string | undefined;
  try {
    await assert.rejects(
      setupControlledRawRuntime(options(storageRoot, 'runtime-setup-0001'), async (runtime) => {
        observedRoot = runtime.root;
        assert.equal((await stat(runtime.root)).mode & 0o777, 0o700);
        const markerPath = path.join(runtime.root, '.runtime-owner.json');
        assert.equal((await stat(markerPath)).mode & 0o777, 0o600);
        const marker = await readFile(markerPath, 'utf8');
        assert.equal(marker.includes(runtime.root), false);
        assert.equal(marker.includes(storageRoot), false);
        assert.match(marker, /"identity": "runtime-setup-0001"/u);
        assert.match(marker, /"device": "\d+"/u);
        assert.match(marker, /"inode": "\d+"/u);
        await writeFile(path.join(runtime.root, 'partially-created.json'), '{}\n');
        throw new Error('synthetic spawn failure');
      }),
      /synthetic spawn failure/u,
    );
    assert.ok(observedRoot);
    await assert.rejects(lstat(observedRoot), (error: unknown) => (
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ));
    assert.deepEqual(await readdir(storageRoot), []);
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('successful finalization deletes raw state while failure records a path-free content quarantine', async () => {
  const storageRoot = await privateStorage('mimi-runtime-lifecycle-finalize-');
  try {
    const success = await createControlledRawRuntime(options(storageRoot, 'runtime-success-0001'));
    await writeFile(path.join(success.root, 'control.token'), 'private-runtime-token', { mode: 0o600 });
    assert.deepEqual(await finalizeControlledRawRuntime(success), {
      state: 'deleted',
      rawRuntimeDeleted: true,
    });
    await assert.rejects(lstat(success.root), (error: unknown) => (
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ));

    const failed = await createControlledRawRuntime(options(storageRoot, 'runtime-failed-0001'));
    await mkdir(path.join(failed.root, 'daemon'), { mode: 0o700 });
    const contents = Buffer.from('private-runtime-token', 'utf8');
    await writeFile(path.join(failed.root, 'daemon', 'control.token'), contents, { mode: 0o600 });
    const quarantined = await finalizeControlledRawRuntime(failed, {
      reason: 'functional-failure',
      now: () => new Date('2026-08-10T00:05:00.000Z'),
    });
    assert.equal(quarantined.state, 'quarantined');
    if (quarantined.state !== 'quarantined') assert.fail('expected quarantine');
    assert.equal(quarantined.bytes, contents.byteLength);
    assert.equal(quarantined.fileCount, 1);
    assert.match(quarantined.treeDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(quarantined.createdAt, createdAt);
    assert.equal(quarantined.quarantinedAt, '2026-08-10T00:05:00.000Z');
    assert.equal(quarantined.reason, 'functional-failure');
    const serialized = JSON.stringify(quarantined);
    assert.equal(serialized.includes(failed.root), false);
    assert.equal(serialized.includes(storageRoot), false);

    const [quarantineName] = await readdir(storageRoot);
    assert.match(quarantineName ?? '', /^mimi-cr-quarantine-runtime-failed-0001$/u);
    const quarantineRoot = path.join(storageRoot, quarantineName!);
    assert.equal((await stat(quarantineRoot)).mode & 0o777, 0o700);
    const marker = await readFile(path.join(quarantineRoot, '.runtime-owner.json'), 'utf8');
    assert.equal(marker.includes(failed.root), false);
    assert.equal(marker.includes(storageRoot), false);
    assert.match(marker, new RegExp(quarantined.treeDigest, 'u'));
    assert.match(marker, /"reason": "functional-failure"/u);
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('successful deletion does not require snapshotting a stale Unix socket', async (context) => {
  if (process.platform === 'win32') {
    context.skip('Unix socket fixture is not available on Windows');
    return;
  }
  const storageRoot = await mkdtemp(path.join(path.sep, 'tmp', 'mimi-lc-socket-'));
  await chmod(storageRoot, 0o700);
  const runtime = await createControlledRawRuntime(options(storageRoot, 'runtime-socket-0001'));
  const socket = path.join(runtime.root, 'mimi.sock');
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    assert.equal((await lstat(socket)).isSocket(), true);
    assert.deepEqual(await finalizeControlledRawRuntime(runtime), {
      state: 'deleted',
      rawRuntimeDeleted: true,
    });
    await assert.rejects(lstat(runtime.root), (error: unknown) => (
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('recovery preserves live and young roots, counts quota, then removes expired dead quarantine', async () => {
  const storageRoot = await privateStorage('mimi-runtime-lifecycle-recover-');
  try {
    const runtime = await createControlledRawRuntime(options(storageRoot, 'runtime-recover-0001'));
    await writeFile(path.join(runtime.root, 'large.log'), Buffer.alloc(32, 0x61), { mode: 0o600 });
    await finalizeControlledRawRuntime(runtime, {
      reason: 'forced-shard-kill',
      now: () => new Date('2026-08-10T00:05:00.000Z'),
    });

    const live = await recoverControlledRawRuntimes({
      storageRoot,
      now: () => new Date('2026-08-11T00:00:00.000Z'),
      stagingGraceMs: 60_000,
      quarantineGraceMs: 60_000,
      quotaBytes: 1,
      ownerIsLive: () => true,
    });
    assert.equal(live.preservedLiveRoots, 1);
    assert.equal(live.removedQuarantineRoots, 0);
    assert.ok(live.usedBytes > 32, 'quota includes the durable owner marker');
    assert.equal(live.quotaExceeded, true);

    const young = await recoverControlledRawRuntimes({
      storageRoot,
      now: () => new Date('2026-08-10T00:05:30.000Z'),
      stagingGraceMs: 60_000,
      quarantineGraceMs: 60_000,
      quotaBytes: 1024 * 1024,
      ownerIsLive: () => false,
    });
    assert.equal(young.preservedYoungRoots, 1);
    assert.equal(young.removedQuarantineRoots, 0);

    const expired = await recoverControlledRawRuntimes({
      storageRoot,
      now: () => new Date('2026-08-10T00:07:00.000Z'),
      stagingGraceMs: 60_000,
      quarantineGraceMs: 60_000,
      quotaBytes: 1024 * 1024,
      ownerIsLive: () => false,
    });
    assert.equal(expired.removedQuarantineRoots, 1);
    assert.equal(expired.usedBytes, 0);
    assert.ok(expired.reclaimedBytes > 32);
    assert.deepEqual(await readdir(storageRoot), []);
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('recovery preserves an orphaned foreground Daemon, then reaps its socket after the Daemon dies', async (context) => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    context.skip('process start identity fixture requires macOS or Linux');
    return;
  }
  const testRoot = await mkdtemp(path.join(path.sep, 'tmp', 'mimi-lc-orphan-'));
  await chmod(testRoot, 0o700);
  const storageRoot = path.join(testRoot, 'storage');
  const readyFile = path.join(testRoot, 'ready.json');
  const daemonReadyFile = path.join(testRoot, 'daemon-ready');
  const lifecycleUrl = pathToFileURL(path.resolve(
    import.meta.dirname,
    '../scripts/conversation-runtime-lifecycle.ts',
  )).href;
  const ownerProgram = `
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bindControlledRawRuntimeDaemon, createControlledRawRuntime } from ${JSON.stringify(lifecycleUrl)};

const runtime = await createControlledRawRuntime({ storageRoot: process.env.STORAGE_ROOT });
const socket = path.join(runtime.root, 'daemon', 'mimi.sock');
const daemonProgram = ${JSON.stringify(`
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
mkdirSync(path.dirname(process.env.SOCKET_FILE), { recursive: true, mode: 0o700 });
const server = net.createServer();
server.listen(process.env.SOCKET_FILE, () => {
  writeFileSync(process.env.DAEMON_READY_FILE, 'ready\\n', { mode: 0o600 });
});
setInterval(() => undefined, 1000);
`)};
const daemon = spawn(process.execPath, ['--input-type=module', '-e', daemonProgram], {
  detached: true,
  stdio: 'ignore',
  env: {
    PATH: process.env.PATH,
    SOCKET_FILE: socket,
    DAEMON_READY_FILE: process.env.DAEMON_READY_FILE,
  },
});
if (!daemon.pid) throw new Error('daemon pid unavailable');
await bindControlledRawRuntimeDaemon(runtime, daemon.pid);
daemon.unref();
for (let attempt = 0; attempt < 400; attempt += 1) {
  try {
    await readFile(process.env.DAEMON_READY_FILE);
    break;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
}
await writeFile(process.env.READY_FILE, JSON.stringify({
  root: runtime.root,
  daemonPid: daemon.pid,
}), { mode: 0o600 });
setInterval(() => undefined, 1000);
`;
  const ownerProcess = spawn(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e', ownerProgram,
  ], {
    cwd: path.resolve(import.meta.dirname, '..'),
    detached: true,
    stdio: 'ignore',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      STORAGE_ROOT: storageRoot,
      READY_FILE: readyFile,
      DAEMON_READY_FILE: daemonReadyFile,
    },
  });
  let daemonPid: number | undefined;
  try {
    const ready = await waitForJson(readyFile);
    assert.equal(typeof ready.root, 'string');
    assert.equal(typeof ready.daemonPid, 'number');
    daemonPid = ready.daemonPid as number;
    ownerProcess.kill('SIGKILL');
    await new Promise<void>((resolve) => ownerProcess.once('exit', () => resolve()));

    const live = await recoverControlledRawRuntimes({
      storageRoot,
      now: () => new Date(Date.now() + 2 * 60_000),
      stagingGraceMs: 1,
      quarantineGraceMs: 1,
      quotaBytes: 1024 * 1024,
    });
    assert.equal(live.preservedLiveRoots, 1);
    assert.equal(live.removedStagingRoots, 0);
    assert.equal((await lstat(path.join(ready.root as string, 'daemon', 'mimi.sock'))).isSocket(), true);

    killProcessGroup(daemonPid);
    await waitForPidGone(daemonPid);
    const reaped = await recoverControlledRawRuntimes({
      storageRoot,
      now: () => new Date(Date.now() + 4 * 60_000),
      stagingGraceMs: 1,
      quarantineGraceMs: 1,
      quotaBytes: 1024 * 1024,
    });
    assert.equal(reaped.removedStagingRoots, 1);
    await assert.rejects(lstat(ready.root as string), (error: unknown) => (
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ));
  } finally {
    if (ownerProcess.pid) killProcessGroup(ownerProcess.pid);
    if (daemonPid) killProcessGroup(daemonPid);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('only the bound daemon/mimi.sock is admitted as live typed metadata', async (context) => {
  if (process.platform === 'win32') {
    context.skip('Unix socket fixture is not available on Windows');
    return;
  }
  const storageRoot = await mkdtemp(path.join(path.sep, 'tmp', 'mimi-lc-special-'));
  await chmod(storageRoot, 0o700);
  const runtime = await createControlledRawRuntime(options(storageRoot, 'runtime-special-0001'));
  await bindControlledRawRuntimeDaemon(runtime, process.pid);
  const daemonRoot = path.join(runtime.root, 'daemon');
  await mkdir(daemonRoot, { mode: 0o700 });
  const allowed = createServer();
  const malicious = createServer();
  try {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        allowed.once('error', reject);
        allowed.listen(path.join(daemonRoot, 'mimi.sock'), resolve);
      }),
      new Promise<void>((resolve, reject) => {
        malicious.once('error', reject);
        malicious.listen(path.join(daemonRoot, 'unexpected.sock'), resolve);
      }),
    ]);
    await assert.rejects(recoverControlledRawRuntimes({
      storageRoot,
      now: () => new Date('2026-08-11T00:00:00.000Z'),
      stagingGraceMs: 1,
      quarantineGraceMs: 1,
      quotaBytes: 1024 * 1024,
      ownerIsLive: () => false,
    }), /special/u);
    assert.equal((await lstat(runtime.root)).isDirectory(), true);
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => allowed.close(() => resolve())),
      new Promise<void>((resolve) => malicious.close(() => resolve())),
    ]);
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('recovery fails closed for symlinks and hardlinks before deleting any eligible root', async () => {
  const storageRoot = await privateStorage('mimi-runtime-lifecycle-links-');
  const outside = await privateStorage('mimi-runtime-lifecycle-outside-');
  try {
    const safe = await createControlledRawRuntime(options(storageRoot, 'runtime-safe-0001'));
    await writeFile(path.join(safe.root, 'safe.txt'), 'safe', { mode: 0o600 });
    const unsafe = await createControlledRawRuntime(options(storageRoot, 'runtime-unsafe-0001'));
    const outsideFile = path.join(outside, 'outside.txt');
    await writeFile(outsideFile, 'outside', { mode: 0o600 });
    const unsafeLink = path.join(unsafe.root, 'outside-link');
    await symlink(outsideFile, unsafeLink);
    const recovery = {
      storageRoot,
      now: () => new Date('2026-08-11T00:00:00.000Z'),
      stagingGraceMs: 60_000,
      quarantineGraceMs: 60_000,
      quotaBytes: 1024 * 1024,
      ownerIsLive: () => false,
    };
    await assert.rejects(recoverControlledRawRuntimes(recovery), /symbolic link/u);
    assert.equal((await lstat(safe.root)).isDirectory(), true, 'preflight is all-or-nothing');
    assert.equal((await lstat(unsafe.root)).isDirectory(), true);

    await rm(unsafeLink);
    const localFile = path.join(unsafe.root, 'local.txt');
    await writeFile(localFile, 'hard-link-source', { mode: 0o600 });
    const externalHardlink = path.join(outside, 'hardlink.txt');
    await link(localFile, externalHardlink);
    await assert.rejects(recoverControlledRawRuntimes(recovery), /hard-linked file/u);
    assert.equal((await lstat(safe.root)).isDirectory(), true, 'hardlink preflight deletes nothing');
    await rm(externalHardlink);

    const cleaned = await recoverControlledRawRuntimes(recovery);
    assert.equal(cleaned.removedStagingRoots, 2);
    assert.deepEqual(await readdir(storageRoot), []);
  } finally {
    await Promise.all([
      rm(storageRoot, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test('storage and candidate symlinks are rejected before lifecycle mutation', async () => {
  const root = await privateStorage('mimi-runtime-lifecycle-root-link-');
  const storageRoot = path.join(root, 'storage');
  const target = path.join(root, 'target');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, storageRoot);
  try {
    await assert.rejects(
      createControlledRawRuntime(options(storageRoot, 'runtime-root-link-0001')),
      /physical directory|must not traverse a symlink/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class NeverExits extends EventEmitter implements ExitObservableProcess {
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(): boolean {
    return true;
  }
}

test('SIGKILL wait has a hard deadline and removes its exit listener', async () => {
  const child = new NeverExits();
  const signals: NodeJS.Signals[] = [];
  const started = Date.now();
  const result = await terminateProcessWithDeadlines(child, {
    gracefulWaitMs: 10,
    killWaitMs: 10,
    signal: (_process, signal) => {
      signals.push(signal);
    },
  });
  const elapsed = Date.now() - started;
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(result, { exited: false, forced: true, killTimedOut: true });
  assert.equal(child.listenerCount('exit'), 0);
  assert.ok(elapsed < 1_000, `hard deadline unexpectedly took ${elapsed}ms`);
});
