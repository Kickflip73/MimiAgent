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

test('new episodes avoid FTS cleanup scans; retention below its limit reads only the covering count', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-episode-write-'));
  const catalog = new SqliteMemoryCatalog(path.join(root, 'memory.db'), 'private', 'owner');
  try {
    const internal = (catalog as unknown as { database: DatabaseSync }).database;
    const prepare = internal.prepare.bind(internal);
    const queries: string[] = [];
    internal.prepare = ((sql: string) => { queries.push(sql); return prepare(sql); }) as typeof internal.prepare;
    const at = '2026-10-09T08:00:00.000Z';
    const page = { ref: { scope: 'private' as const, profileId: 'owner', id: 'episode-test' },
      digest: 'before', body: 'uniquebeforeword', metadata: {
        schemaVersion: 1 as const, id: 'episode-test', title: 'Episode', kind: 'source-summary' as const,
        scope: 'private' as const, profileId: 'owner', status: 'active' as const,
        confidence: 'source-grounded' as const, aliases: [], tags: [], sourceRefs: [],
        validFrom: null, validUntil: null, supersedes: [], createdAt: at, updatedAt: at,
      } };
    catalog.index(page, undefined, 'episode');
    assert.equal(queries.some(sql => /DELETE FROM documents_fts/.test(sql)), false);
    assert.equal(catalog.search('uniquebeforeword', { documentTypes: ['episode'] }).length, 1);
    queries.length = 0;
    catalog.index({ ...page, digest: 'after', body: 'uniqueafterword' }, undefined, 'episode');
    assert.equal(queries.filter(sql => /DELETE FROM documents_fts/.test(sql)).length, 1);
    assert.equal(catalog.search('uniquebeforeword', { documentTypes: ['episode'] }).length, 0);
    assert.equal(catalog.search('uniqueafterword', { documentTypes: ['episode'] }).length, 1);
    queries.length = 0;
    assert.equal(catalog.pruneEpisodes(), 0);
    assert.equal(queries.length, 1);
    assert.match(queries[0]!, /COUNT\(\*\)/);
    const plan = prepare(`EXPLAIN QUERY PLAN ${queries[0]}`).all().map(row => row.detail).join('\n');
    assert.match(plan, /COVERING INDEX documents_type_updated_idx/);
    assert.equal(catalog.pruneEpisodes(0), 1);
    assert.equal(catalog.readDocument(page.ref), undefined);
  } finally { catalog.close(); await rm(root, { recursive: true, force: true }); }
});
