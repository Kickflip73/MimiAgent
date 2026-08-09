import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertRuntimeDependencySnapshot,
  compareRuntimeDependencySnapshots,
  snapshotRuntimeDependencyTree,
} from '../scripts/conversation-runtime-integrity.js';

async function fixtureTree(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-runtime-integrity-'));
  await mkdir(path.join(root, 'node_modules', 'alpha'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'beta'));
  await writeFile(path.join(root, 'node_modules', 'alpha', 'index.js'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'node_modules', 'alpha', 'package.json'), '{"name":"alpha"}\n');
  await symlink('alpha', path.join(root, 'node_modules', 'alpha-link'));
  return root;
}

test('runtime dependency snapshot is stable and changes with content, same-size rewrites, modes, and symlink targets', async () => {
  const fixture = await fixtureTree();
  try {
    const root = path.join(fixture, 'node_modules');
    const first = await snapshotRuntimeDependencyTree(root);
    const repeated = await snapshotRuntimeDependencyTree(root);
    assert.deepEqual(repeated, first);
    assert.equal(compareRuntimeDependencySnapshots(first, repeated), true);
    assert.doesNotThrow(() => assertRuntimeDependencySnapshot(first, repeated));

    const source = path.join(root, 'alpha', 'index.js');
    await writeFile(source, 'export const value = 2;\n');
    const sameSizeRewrite = await snapshotRuntimeDependencyTree(root);
    assert.notEqual(sameSizeRewrite.digest, first.digest);
    assert.equal(sameSizeRewrite.bytes, first.bytes);
    assert.equal(compareRuntimeDependencySnapshots(first, sameSizeRewrite), false);
    assert.throws(() => assertRuntimeDependencySnapshot(first, sameSizeRewrite), /snapshot changed/iu);

    await chmod(source, 0o600);
    const changedMode = await snapshotRuntimeDependencyTree(root);
    assert.notEqual(changedMode.digest, sameSizeRewrite.digest);

    await rm(path.join(root, 'alpha-link'));
    await symlink('beta', path.join(root, 'alpha-link'));
    const changedLink = await snapshotRuntimeDependencyTree(root);
    assert.notEqual(changedLink.digest, changedMode.digest);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('runtime dependency snapshot resolves its root but rejects escaping and absolute symlinks', async () => {
  const fixture = await fixtureTree();
  try {
    const root = path.join(fixture, 'node_modules');
    const rootLink = path.join(fixture, 'runtime-modules');
    await symlink('node_modules', rootLink);
    assert.deepEqual(
      await snapshotRuntimeDependencyTree(rootLink),
      await snapshotRuntimeDependencyTree(root),
    );
    await symlink('../outside', path.join(root, 'escape'));
    await assert.rejects(snapshotRuntimeDependencyTree(root), /symlink escapes root.*escape/iu);
    await rm(path.join(root, 'escape'));
    await symlink(path.join(fixture, 'outside'), path.join(root, 'absolute'));
    await assert.rejects(snapshotRuntimeDependencyTree(root), /symlink must be relative.*absolute/iu);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('runtime dependency snapshot enforces injectable file and byte limits before returning proof', async () => {
  const fixture = await fixtureTree();
  try {
    const root = path.join(fixture, 'node_modules');
    await assert.rejects(
      snapshotRuntimeDependencyTree(root, { maxFiles: 2 }),
      /file limit exceeded/iu,
    );
    await assert.rejects(
      snapshotRuntimeDependencyTree(root, { maxBytes: 8 }),
      /byte limit exceeded/iu,
    );
    await assert.rejects(
      snapshotRuntimeDependencyTree(root, { maxFiles: 0 }),
      /maxFiles must be a positive safe integer/iu,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('runtime dependency snapshot result never contains the absolute dependency root', async () => {
  const fixture = await fixtureTree();
  try {
    const root = path.join(fixture, 'node_modules');
    const snapshot = await snapshotRuntimeDependencyTree(root);
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes(root), false);
    assert.deepEqual(Object.keys(snapshot).sort(), ['bytes', 'digest', 'fileCount', 'schemaVersion']);
    assert.match(snapshot.digest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(snapshot.fileCount, 3);
    assert.ok(snapshot.bytes > 0);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
