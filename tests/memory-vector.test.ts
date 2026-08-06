import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { MemoryDocument } from '../src/core/memory.js';
import { SqliteMemoryCatalog } from '../src/extensions/memory/sqlite-catalog.js';

function document(id: string, body: string): MemoryDocument {
  const timestamp = '2026-08-05T08:00:00.000Z';
  return {
    ref: { scope: 'private', profileId: 'owner', id },
    metadata: {
      schemaVersion: 1,
      id,
      title: id,
      kind: 'fact',
      scope: 'private',
      profileId: 'owner',
      status: 'active',
      confidence: 'source-grounded',
      aliases: [],
      tags: [],
      sourceRefs: [{
        type: 'session', id: `session@${id}`, digest: `sha256:${'a'.repeat(64)}`,
        occurredAt: timestamp, trust: 'owner',
      }],
      validFrom: null,
      validUntil: null,
      supersedes: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    body,
    digest: `sha256:${id.padEnd(64, 'b').slice(0, 64)}`,
  };
}

function embedding(model: string, vector: number[]) {
  return { model, chunks: [{ index: 0, digest: 'chunk-0', vector }] };
}

async function databaseSnapshot(root: string): Promise<Array<{
  name: string;
  size: number;
  mode: number;
  modifiedAt: string;
  digest: string;
}>> {
  const names = (await readdir(root)).sort();
  return Promise.all(names.map(async (name) => {
    const file = path.join(root, name);
    const [content, metadata] = await Promise.all([readFile(file), lstat(file, { bigint: true })]);
    return {
      name,
      size: content.byteLength,
      mode: Number(metadata.mode & 0o777n),
      modifiedAt: metadata.mtimeNs.toString(),
      digest: createHash('sha256').update(content).digest('hex'),
    };
  }));
}

test('sqlite-vec vec0 serves KNN without retaining legacy BLOB vector tables', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-vec0-'));
  const file = path.join(root, 'memory.db');
  const catalog = new SqliteMemoryCatalog(file, 'private', 'owner');
  try {
    const relevant = document('mem_vehicle_0001', 'A durable maintenance record.');
    const unrelated = document('mem_garden_0001', 'A durable irrigation record.');
    catalog.index(relevant, embedding('embedding-v1', [1, 0, 0]));
    catalog.index(unrelated, embedding('embedding-v1', [0, 1, 0]));

    const hits = catalog.search('no lexical overlap', { limit: 5 }, {
      model: 'embedding-v1',
      vector: [1, 0, 0],
    });
    assert.equal(hits[0]?.ref.id, relevant.ref.id);
    assert.deepEqual(catalog.search('semantic-only-query', { limit: 5 }, {
      model: 'embedding-v1',
      vector: [1, 0],
    }), []);
    assert.equal(catalog.status().vectorState, 'ready');
  } finally {
    catalog.close();
  }

  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = (database.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
    `).all() as Array<{ name: string }>).map((row) => row.name);
    assert.ok(tables.includes('document_vec_chunks'));
    assert.ok(tables.includes('document_vec_chunks_map'));
    assert.equal(tables.includes('document_embedding_chunks'), false);
    assert.equal(tables.includes('document_embeddings'), false);
  } finally {
    database.close();
  }
});

test('Vec load failure keeps FTS/lexical retrieval available', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-vec-failure-'));
  const catalog = new SqliteMemoryCatalog(path.join(root, 'memory.db'), 'private', 'owner', {
    loadVectorExtension: () => { throw new Error('injected extension load failure'); },
  });
  try {
    const page = document('mem_lexical_0001', 'Lexical fallback anchor remains searchable.');
    catalog.index(page, embedding('embedding-v1', [1, 0, 0]));
    const hits = catalog.search('Lexical fallback anchor', { limit: 5 }, {
      model: 'embedding-v1', vector: [1, 0, 0],
    });
    assert.equal(hits[0]?.ref.id, page.ref.id);
    assert.equal(catalog.status().fts5, true);
    assert.equal(catalog.status().vectorAvailable, false);
    assert.equal(catalog.status().vectorState, 'unavailable');
  } finally {
    catalog.close();
  }
});

test('read-only catalog reuses production FTS and vec0 KNN without changing durable files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-read-only-'));
  const file = path.join(root, 'memory.db');
  const relevant = document('mem_read_only_relevant', 'Atlas audit is waiting for supplier approval.');
  const unrelated = document('mem_read_only_unrelated', 'Garden irrigation maintenance record.');
  const writable = new SqliteMemoryCatalog(file, 'private', 'owner');
  writable.index(relevant, embedding('embedding-v1', [1, 0, 0]));
  writable.index(unrelated, embedding('embedding-v1', [0, 1, 0]));
  const expectedHybrid = writable.search('Atlas audit', { limit: 5 }, {
    model: 'embedding-v1', vector: [0, 1, 0],
  }).map((hit) => hit.ref.id);
  writable.close();
  const before = await databaseSnapshot(root);

  const readOnly = new SqliteMemoryCatalog(file, 'private', 'owner', { readOnly: true });
  try {
    assert.equal(readOnly.search('Atlas audit', { limit: 5 })[0]?.ref.id, relevant.ref.id);
    assert.equal(readOnly.search('semantic paraphrase without lexical overlap', { limit: 5 }, {
      model: 'embedding-v1', vector: [1, 0, 0],
    })[0]?.ref.id, relevant.ref.id);
    assert.deepEqual(readOnly.search('Atlas audit', { limit: 5 }, {
      model: 'embedding-v1', vector: [0, 1, 0],
    }).map((hit) => hit.ref.id), expectedHybrid);
    assert.equal(readOnly.status().vectorState, 'ready');
    assert.throws(() => readOnly.index(document('forbidden', 'must not write')), /read-only/);
  } finally {
    readOnly.close();
  }

  assert.deepEqual(await databaseSnapshot(root), before);
  const inspected = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(inspected.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master WHERE name='__memory_vec_selftest'
    `).get()!.count, 0);
  } finally {
    inspected.close();
  }

  const activeWriter = new DatabaseSync(file);
  try {
    activeWriter.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA wal_autocheckpoint=0;
      INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('read_only_probe', 'active');
    `);
    const activeBefore = await databaseSnapshot(root);
    assert.throws(
      () => new SqliteMemoryCatalog(file, 'private', 'owner', { readOnly: true }),
      /active WAL/,
    );
    assert.deepEqual(await databaseSnapshot(root), activeBefore);
  } finally {
    activeWriter.close();
  }

  const snapshotReader = new SqliteMemoryCatalog(file, 'private', 'owner', { readOnly: true });
  const concurrentWriter = new DatabaseSync(file);
  try {
    concurrentWriter.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA wal_autocheckpoint=0;
      INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('read_only_probe', 'changed');
    `);
    assert.throws(
      () => snapshotReader.search('Atlas audit', { limit: 5 }),
      /active WAL|changed during read-only audit/,
    );
  } finally {
    concurrentWriter.close();
    snapshotReader.close();
  }

  const postWalBefore = await databaseSnapshot(root);
  const walSnapshot = new SqliteMemoryCatalog(file, 'private', 'owner', {
    readOnly: true,
    readOnlySnapshotWal: true,
  });
  try {
    assert.equal(walSnapshot.search('Atlas audit', { limit: 5 })[0]?.ref.id, relevant.ref.id);
    assert.equal(walSnapshot.status().vectorState, 'ready');
  } finally {
    walSnapshot.close();
  }
  const postWalAfter = await databaseSnapshot(root);
  const mainBefore = postWalBefore.find((item) => item.name === 'memory.db');
  const mainAfter = postWalAfter.find((item) => item.name === 'memory.db');
  assert.ok(mainBefore);
  assert.ok(mainAfter);
  assert.deepEqual(mainAfter, mainBefore);
});

test('legacy BLOB chunks migrate only after validation and never mix model dimensions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-vec-migration-'));
  const file = path.join(root, 'memory.db');
  const page = document('mem_legacy_vec_0001', 'Legacy vector payload.');
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta VALUES ('version', '2');
    CREATE TABLE documents (
      ref_key TEXT PRIMARY KEY, id TEXT NOT NULL, scope TEXT NOT NULL, profile_id TEXT,
      title TEXT NOT NULL, aliases_json TEXT NOT NULL, tags_json TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, confidence TEXT NOT NULL, body TEXT NOT NULL, summary TEXT NOT NULL,
      digest TEXT NOT NULL, source_refs_json TEXT NOT NULL, occurred_at TEXT NOT NULL,
      valid_from TEXT, valid_until TEXT, document_type TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0,
      path TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE document_embedding_chunks (
      ref_key TEXT NOT NULL, digest TEXT NOT NULL, chunk_index INTEGER NOT NULL,
      chunk_digest TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      dimensions INTEGER NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(ref_key, chunk_index)
    );
  `);
  const key = `private:owner:${page.ref.id}`;
  legacy.prepare(`
    INSERT INTO documents VALUES (?, ?, 'private', 'owner', ?, '[]', '[]', 'fact', 'active',
      'source-grounded', ?, ?, ?, ?, ?, NULL, NULL, 'wiki', 0, NULL, ?)
  `).run(
    key, page.ref.id, page.metadata.title, page.body, page.body, page.digest,
    JSON.stringify(page.metadata.sourceRefs), page.metadata.updatedAt, page.metadata.updatedAt,
  );
  legacy.prepare(`
    INSERT INTO document_embedding_chunks VALUES (?, ?, 0, 'chunk-0', 'openai', 'legacy-model', 3, ?)
  `).run(key, page.digest, new Uint8Array(new Float32Array([1, 0, 0]).buffer));
  legacy.close();

  const legacyBefore = await databaseSnapshot(root);
  const legacyReadOnly = new SqliteMemoryCatalog(file, 'private', 'owner', { readOnly: true });
  try {
    assert.equal(legacyReadOnly.search('Legacy vector payload', { limit: 5 })[0]?.ref.id, page.ref.id);
    assert.equal(legacyReadOnly.status().pages, 1);
    assert.deepEqual(legacyReadOnly.search('Legacy vector payload', {
      limit: 5,
      relationKinds: ['depends-on'],
    }), []);
  } finally {
    legacyReadOnly.close();
  }
  assert.deepEqual(await databaseSnapshot(root), legacyBefore);

  const catalog = new SqliteMemoryCatalog(file, 'private', 'owner');
  try {
    assert.equal(catalog.search('semantic-only-query', { limit: 5 }, {
      model: 'legacy-model', vector: [1, 0, 0],
    })[0]?.ref.id, page.ref.id);
    assert.deepEqual(catalog.search('semantic-only-query', { limit: 5 }, {
      model: 'other-model', vector: [1, 0, 0, 0],
    }), []);
  } finally {
    catalog.close();
  }

  const verified = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(verified.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='table' AND name IN ('document_embeddings', 'document_embedding_chunks')
    `).get()!.count, 0);
  } finally {
    verified.close();
  }
});

test('embedding model or dimension change disables vectors until an explicit reindex', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-vec-reindex-'));
  const catalog = new SqliteMemoryCatalog(path.join(root, 'memory.db'), 'private', 'owner');
  const first = document('mem_reindex_first_0001', 'First lexical anchor.');
  const second = document('mem_reindex_second_0001', 'Second lexical anchor.');
  try {
    catalog.index(first, embedding('embedding-v1', [1, 0, 0]));
    catalog.index(second, embedding('embedding-v2', [0, 1]));
    assert.equal(catalog.status().vectorState, 'reindex-required');
    assert.equal(catalog.search('First lexical anchor', { limit: 5 }, {
      model: 'embedding-v1', vector: [1, 0, 0],
    })[0]?.ref.id, first.ref.id);
    assert.deepEqual(catalog.search('semantic-only-query', { limit: 5 }, {
      model: 'embedding-v1', vector: [1, 0, 0],
    }), []);

    catalog.rebuild([first, second], 'embedding-v2');
    assert.equal(catalog.status().vectorState, 'empty');
    catalog.index(first, embedding('embedding-v2', [1, 0]));
    catalog.index(second, embedding('embedding-v2', [0, 1]));
    assert.equal(catalog.status().vectorState, 'ready');
    assert.equal(catalog.search('semantic-only-query', { limit: 5 }, {
      model: 'embedding-v2', vector: [1, 0],
    })[0]?.ref.id, first.ref.id);
    assert.deepEqual(catalog.search('semantic-only-query', { limit: 5 }, {
      model: 'embedding-v1', vector: [1, 0, 0],
    }), []);
  } finally {
    catalog.close();
  }
});

test('vector KNN honors a provider-calibrated distance without weakening the default channel', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-vec-calibration-'));
  const catalog = new SqliteMemoryCatalog(path.join(root, 'memory.db'), 'private', 'owner');
  const relevant = document('mem_semantic_calibration_0001', 'Semantic candidate without lexical overlap.');
  const queryVector = [0.45, Math.sqrt(1 - 0.45 ** 2)];
  try {
    catalog.index(relevant, embedding('local-semantic-v1', [1, 0]));
    assert.deepEqual(catalog.search('opaque-question', { limit: 5 }, {
      model: 'local-semantic-v1', vector: queryVector,
    }), []);
    assert.equal(catalog.search('opaque-question', { limit: 5 }, {
      model: 'local-semantic-v1', vector: queryVector, maxDistance: 0.6,
    })[0]?.ref.id, relevant.ref.id);
  } finally {
    catalog.close();
  }
});
