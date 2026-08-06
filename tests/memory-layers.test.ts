import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMemoryHub } from '../src/extensions/memory/hub.js';
import { memoryPageMetadataSchema } from '../src/extensions/memory/wiki-schema.js';

const occurredAt = '2026-08-05T08:00:00.000Z';
const digest = `sha256:${'a'.repeat(64)}`;
const sourceRef = {
  type: 'session' as const,
  id: 'session-1@run-1',
  digest,
  occurredAt,
  trust: 'owner' as const,
};

function baseMetadata() {
  return {
    id: 'mem_layer_contract_0001',
    canonicalKey: 'private:layer-contract',
    title: 'Layer contract',
    kind: 'fact' as const,
    scope: 'private' as const,
    profileId: 'owner',
    status: 'active' as const,
    confidence: 'user-confirmed' as const,
    aliases: [],
    tags: [],
    sourceRefs: [sourceRef],
    validFrom: null,
    validUntil: null,
    supersedes: [],
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

test('Memory schema v2 keeps v1 readable and limits typed facets to provenance fields', () => {
  const legacy = memoryPageMetadataSchema.parse({ schemaVersion: 1, ...baseMetadata() });
  assert.equal(legacy.schemaVersion, 1);
  assert.equal('layer' in legacy, false);

  const layered = memoryPageMetadataSchema.parse({
    schemaVersion: 2,
    ...baseMetadata(),
    layer: 'L1',
    derivedFrom: [],
    facets: {
      kind: 'fact',
      entities: ['MimiAgent'],
      relations: [],
      time: { occurredAt, validFrom: null, validUntil: null },
      sources: [`session:${sourceRef.id}:${sourceRef.digest}`],
    },
  });
  assert.equal(layered.schemaVersion, 2);
  assert.equal(layered.layer, 'L1');
  assert.throws(() => memoryPageMetadataSchema.parse({
    ...layered,
    facets: { ...layered.facets, narrative: 'free text belongs in the page body' },
  }));
});

test('MemoryHub writes L1 atoms and explains an L2 conclusion down to L0 evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-layers-'));
  const hub = await createMemoryHub({
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    profileId: 'owner',
    cutover: false,
  });
  const context = {
    profileId: 'owner',
    workspaceRoot: root,
    sessionId: 'session-1',
    runId: 'run-1',
    cause: { trust: 'owner' as const, source: 'cli' },
  };
  const atom = await hub.remember({
    title: 'Owner uses strict evidence',
    content: 'The owner requires every durable conclusion to retain its evidence.',
    kind: 'fact',
    sourceRefs: [sourceRef],
    facets: { entities: ['owner'], relations: [], time: { occurredAt } },
  }, context);
  assert.equal(atom.metadata.schemaVersion, 2);
  assert.equal(atom.metadata.layer, 'L1');
  assert.deepEqual(atom.metadata.derivedFrom, []);
  assert.match(atom.body, /every durable conclusion/);

  const topic = await hub.remember({
    title: 'Owner evidence policy',
    content: 'Owner memory conclusions remain traceable to original evidence.',
    kind: 'synthesis',
    layer: 'L2',
    derivedFrom: [atom.ref],
    sourceRefs: [sourceRef],
    facets: {
      entities: ['owner', 'MemoryHub'],
      relations: [{ kind: 'summarizes', target: atom.ref }],
      time: { occurredAt },
    },
  }, context);
  assert.equal(topic.metadata.schemaVersion, 2);
  assert.equal(topic.metadata.layer, 'L2');
  assert.deepEqual(topic.metadata.derivedFrom, [atom.ref]);

  const explanation = await hub.explain(topic.ref, context);
  assert.deepEqual(explanation.conclusions.map((item) => item.ref.id), [topic.ref.id, atom.ref.id]);
  assert.deepEqual(explanation.evidence.map((item) => item.digest), [digest]);
  assert.equal(explanation.complete, true);
});
