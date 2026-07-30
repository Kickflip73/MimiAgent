import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DaemonLifecycleStore } from '../src/daemon/lifecycle.js';

test('daemon lifecycle records an intentional owner shutdown as one durable epoch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-daemon-lifecycle-owner-'));
  const file = path.join(root, 'lifecycle.json');
  const lifecycle = new DaemonLifecycleStore(file, { historyLimit: 4 });
  const starting = await lifecycle.begin({
    buildVersion: '0.12.0+fixture',
    pid: 101,
    workerId: 'worker-owner',
    workspaceRoot: root,
    supervisor: 'launchd',
  });

  await lifecycle.transition(starting.epochId, 'online');
  await lifecycle.transition(starting.epochId, 'stopping', { reason: 'owner_shutdown' });
  const stopped = await lifecycle.transition(starting.epochId, 'stopped', {
    reason: 'owner_shutdown',
    exitCode: 0,
  });

  assert.equal(stopped.phase, 'stopped');
  assert.equal(stopped.reason, 'owner_shutdown');
  assert.equal(stopped.exitCode, 0);
  assert.equal((await lifecycle.latest())?.epochId, starting.epochId);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).epochs.length, 1);
});

test('daemon lifecycle closes an orphaned online epoch before recording supervisor recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-daemon-lifecycle-recovery-'));
  const lifecycle = new DaemonLifecycleStore(path.join(root, 'lifecycle.json'));
  const first = await lifecycle.begin({
    buildVersion: '0.12.0+old',
    pid: 201,
    workerId: 'worker-old',
    workspaceRoot: root,
    supervisor: 'launchd',
  });
  await lifecycle.transition(first.epochId, 'online');

  const recovered = await lifecycle.begin({
    buildVersion: '0.12.0+new',
    pid: 202,
    workerId: 'worker-new',
    workspaceRoot: root,
    supervisor: 'launchd',
  });
  const history = await lifecycle.history();

  assert.equal(history[0]?.phase, 'unknown_ungraceful');
  assert.equal(history[0]?.reason, 'missing_terminal_receipt');
  assert.equal(recovered.recoveredFromEpochId, first.epochId);
  await lifecycle.transition(recovered.epochId, 'stopping', { reason: 'signal', signal: 'SIGTERM' });
  const failed = await lifecycle.transition(recovered.epochId, 'failed', {
    reason: 'signal',
    signal: 'SIGTERM',
    exitCode: 1,
  });
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.signal, 'SIGTERM');
  assert.equal(failed.exitCode, 1);
});
