import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { createRoutedMemoryHub } from '../src/extensions/memory/hub.js';

test('memory timing separates shared initialization, search, and episode persistence without query data', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-timing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const timings: Array<{ operation: string; phases: Record<string, number | boolean> }> = [];
  const context = { profileId: 'fixture', workspaceRoot: root, sessionId: 'session', runId: 'run', cause: { trust: 'owner' as const, source: 'fixture' } };
  const hub = createRoutedMemoryHub({ workspaceRoot: root, dataRoot: path.join(root, 'data'), onTiming: (ctx, operation, phases) => {
    assert.equal(ctx.runId, 'run');
    timings.push({ operation, phases });
  } });
  await Promise.all([hub.search('PRIVATE_QUERY_MUST_NOT_BE_LOGGED', context), hub.list(context)]);
  await hub.recordEpisode({ sessionId: 'session', runId: 'run', input: 'PRIVATE_QUERY_MUST_NOT_BE_LOGGED', answer: 'PRIVATE_ANSWER_MUST_NOT_BE_LOGGED', occurredAt: new Date().toISOString() }, context);
  assert.equal(timings.filter(item => item.operation === 'initialize').length, 1);
  for (const field of ['layoutMs', 'catalogOpenMs', 'vaultInitializeMs', 'recoverMs', 'loadPagesMs', 'catalogSyncMs', 'documentEmbeddingsMs', 'legacyCutoverMs', 'totalMs']) {
    assert.equal(typeof timings[0]!.phases[field], 'number', field);
  }
  assert.equal(typeof timings.find(item => item.operation === 'search')?.phases.catalogSearchMs, 'number');
  const saved = timings.find(item => item.operation === 'recordEpisode')!.phases;
  assert.equal(typeof saved.catalogIndexMs, 'number');
  assert.equal(typeof saved.rawEvidenceCommitMs, 'number');
  assert.equal(typeof saved.pruneEpisodesMs, 'number');
  assert.doesNotMatch(JSON.stringify(timings), /PRIVATE_QUERY|PRIVATE_ANSWER/);
});

test('memory timing observer failures do not fail search or initialization', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-observer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hub = createRoutedMemoryHub({ workspaceRoot: root, dataRoot: path.join(root, 'data'), onTiming: async () => { throw new Error('observer'); } });
  assert.deepEqual(await hub.search('missing', { profileId: 'fixture', workspaceRoot: root, sessionId: 's', runId: 'r', cause: { trust: 'owner', source: 'fixture' } }), []);
});
