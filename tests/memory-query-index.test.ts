import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SqliteMemoryCatalog } from '../src/extensions/memory/sqlite-catalog.js';

test('memory metadata queries use type ordering index, preserve body matching and full detail reads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-query-'));
  const file = path.join(root, 'memory.db');
  let catalog = new SqliteMemoryCatalog(file, 'private', 'owner');
  let database: DatabaseSync | undefined;
  try {
    const ref = { scope: 'private' as const, profileId: 'owner', id: 'note' };
    const at = '2026-10-09T08:00:00.000Z';
    const body = 'Body-only uniqueneedle text.\n' + 'Long content. '.repeat(5000);
    catalog.index({ ref, digest: 'digest-note', body, metadata: {
      schemaVersion: 1, id: 'note', title: 'Title', kind: 'fact', scope: 'private', profileId: 'owner',
      status: 'active', confidence: 'source-grounded', aliases: [], tags: [], sourceRefs: [],
      validFrom: null, validUntil: null, supersedes: [], createdAt: at, updatedAt: at,
    } });
    assert.equal(catalog.search('uniqueneedle')[0]?.ref.id, 'note');
    assert.equal(catalog.readDocument(ref)?.body, body);
    assert.equal('body' in catalog.list()[0]!, false);
    database = new DatabaseSync(file);
    database.exec('DROP INDEX documents_type_updated_idx');
    database.close(); database = undefined;
    catalog.close(); catalog = new SqliteMemoryCatalog(file, 'private', 'owner');
    // Capture the production query rather than duplicating it in the regression.
    const internal = (catalog as unknown as { database: DatabaseSync }).database;
    const prepare = internal.prepare.bind(internal);
    let listSql = '';
    internal.prepare = ((sql: string) => {
      if (sql.includes('FROM documents WHERE') && sql.includes('ORDER BY updated_at')) listSql = sql;
      return prepare(sql);
    }) as typeof internal.prepare;
    assert.equal(catalog.list({ status: 'active', limit: 2 }).length, 1);
    assert.ok(listSql);
    assert.doesNotMatch(listSql.split('FROM')[0]!, /\bbody\b|SELECT \*/);
    const plan = prepare(`EXPLAIN QUERY PLAN ${listSql}`).all('wiki', 'active', 2).map(row => row.detail).join('\n');
    assert.match(plan, /SEARCH documents USING INDEX documents_type_updated_idx/);
    assert.doesNotMatch(plan, /USE TEMP B-TREE/);
  } finally {
    database?.close(); catalog.close(); await rm(root, { recursive: true, force: true });
  }
});
