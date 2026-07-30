import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SourceRef } from '../src/core/memory.js';
import { contentDigest } from '../src/core/memory.js';
import { RawEvidenceStore } from '../src/extensions/memory/raw-evidence-store.js';

function source(runId: string, content: string): SourceRef {
  return {
    type: 'session',
    id: `owner@${runId}`,
    digest: `sha256:${contentDigest(content)}`,
    occurredAt: '2026-07-30T00:00:00.000Z',
    trust: 'owner',
  };
}

test('same content from different Runs shares one blob and keeps two provenance refs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-raw-evidence-repeat-'));
  const store = new RawEvidenceStore(root);
  await store.initialize();
  const content = 'The same durable observation.';

  const first = await store.preserve(source('run-one', content), content);
  const second = await store.preserve(source('run-two', content), content);

  assert.notEqual(first, second);
  assert.equal((await readdir(path.join(root, 'blobs'))).length, 1);
  assert.equal((await readdir(path.join(root, 'refs', 'sessions'))).length, 2);
  const references = await Promise.all([first, second].map((file) => readFile(file, 'utf8')));
  assert.match(references[0]!, /owner@run-one/u);
  assert.match(references[1]!, /owner@run-two/u);
  assert.doesNotMatch(references.join('\n'), /The same durable observation/u);
});

test('different content cannot overwrite a blob and failed catalog commit leaves no half-state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-raw-evidence-atomic-'));
  const store = new RawEvidenceStore(root);
  await store.initialize();
  const firstContent = 'First observation.';
  const secondContent = 'Second observation.';
  await store.preserve(source('run-one', firstContent), firstContent);
  await store.preserve(source('run-two', secondContent), secondContent);
  assert.equal((await readdir(path.join(root, 'blobs'))).length, 2);

  const failingContent = 'Must roll back with the catalog failure.';
  await assert.rejects(
    store.commit(
      source('run-failing', failingContent),
      failingContent,
      () => { throw new Error('catalog unavailable'); },
    ),
    /catalog unavailable/u,
  );
  assert.equal((await readdir(path.join(root, 'blobs'))).length, 2);
  assert.equal((await readdir(path.join(root, 'refs', 'sessions'))).length, 2);
});
