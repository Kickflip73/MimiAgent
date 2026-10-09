import assert from 'node:assert/strict';
import fs, { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { serializePage, WikiVault } from '../src/extensions/memory/wiki-vault.js';

function page(id: string): string {
  const time = '2026-10-09T00:00:00.000Z';
  return serializePage({ schemaVersion: 1, id, title: id, kind: 'fact', scope: 'private', profileId: 'owner', status: 'active', confidence: 'user-confirmed', aliases: [], tags: [], sourceRefs: [{ type: 'session', id: 'fixture', digest: `sha256:${'a'.repeat(64)}`, occurredAt: time, trust: 'owner' }], validFrom: null, validUntil: null, supersedes: [], createdAt: time, updatedAt: time }, `Body for ${id}`);
}

test('Wiki inspection bounds concurrent reads and preserves sorted pages and lint issues', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-wiki-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ids = Array.from({ length: 20 }, (_, i) => `mem_fixture_${String(i).padStart(3, '0')}`);
  await mkdir(path.join(root, 'fact'));
  await Promise.all(ids.map(id => writeFile(path.join(root, 'fact', `${id}.md`), page(id))));
  await writeFile(path.join(root, 'fact', 'a-invalid.md'), 'missing frontmatter');
  await writeFile(path.join(root, 'fact', 'z-oversize.md'), 'x'.repeat(200_001));
  await writeFile(path.join(root, '_navigation.md'), 'not a page');
  const originalRead = fs.readFile;
  let active = 0, maximum = 0;
  t.mock.method(fs, 'readFile', async (file: string) => {
    active += 1;
    maximum = Math.max(maximum, active);
    try {
      await new Promise(resolve => setTimeout(resolve, file.endsWith('000.md') ? 20 : 2));
      return await originalRead(file, 'utf8');
    } finally { active -= 1; }
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const vault = new WikiVault(root, 'private', 'owner');
  const result = await vault.inspect();
  assert.ok(maximum > 1 && maximum <= 8, `maximum concurrent reads: ${maximum}`);
  assert.deepEqual(result.pages.map(item => item.ref.id), ids);
  assert.deepEqual(result.issues.map(issue => issue.code), ['invalid-page', 'page-too-large']);
  assert.deepEqual((await vault.list()).map(item => item.ref.id), ids);
});

test('bounded canonical path checks preserve symlink exclusion and reject path escape', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-wiki-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, 'wiki');
  await mkdir(vaultRoot);
  const id = 'mem_fixture_path';
  const outside = path.join(root, `${id}.md`);
  await writeFile(outside, page(id));
  await symlink(outside, path.join(vaultRoot, 'link.md'));
  const vault = new WikiVault(vaultRoot, 'private', 'owner');
  assert.deepEqual((await vault.inspect()).pages, []);
  const inside = path.join(vaultRoot, `${id}.md`);
  await writeFile(inside, page(id));
  const originalRealpath = fs.realpath;
  t.mock.method(fs, 'realpath', async (file: string) => file === inside ? outside : originalRealpath(file));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(vault.inspect(), /符号链接越界/);
});
