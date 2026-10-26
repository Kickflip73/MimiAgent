import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { defaultWorkspaceRoot, loadConfig, type AppConfig } from '../src/config.js';
import { savedSessionWorkspace } from '../src/daemon/session-workspace.js';
import { daemonWebBackend } from '../src/web/backend.js';
import { privateMemoryLayout } from '../src/extensions/memory/layout.js';
import { SqliteMemoryCatalog } from '../src/extensions/memory/sqlite-catalog.js';
import type { MemoryDocument } from '../src/core/memory.js';

test('default workspace is stable across launch directories; explicit selection wins', () => {
  const keys = ['MIMI_WORKSPACE', 'AGENT_WORKSPACE'];
  const previous = keys.map(key => process.env[key]);
  try {
    keys.forEach(key => delete process.env[key]);
    assert.equal(defaultWorkspaceRoot('/test-home'), '/test-home/Mimi/WorkSpace/default');
    assert.equal(loadConfig('/test-home').workspaceRoot, '/test-home/Mimi/WorkSpace/default');
    process.env.MIMI_WORKSPACE = '/chosen-workspace';
    assert.equal(loadConfig('/test-home').workspaceRoot, '/chosen-workspace');
  } finally { keys.forEach((key, index) => { const value = previous[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }); }
});

test('workspace survives runtime eviction including scheduled run sessions; external event cannot override it', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE tasks(id TEXT, session_key TEXT, authority_event_id TEXT, objective_json TEXT, created_at TEXT); CREATE TABLE runs(task_id TEXT, session_key TEXT); CREATE TABLE events(id TEXT, trust TEXT)');
    db.exec("INSERT INTO events VALUES('owner','owner'),('external','external')");
    const insert = db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)');
    insert.run('a','chat','owner',JSON.stringify({workspaceRoot:'/chosen'}),'2026-01-01');
    insert.run('b','chat','external',JSON.stringify({workspaceRoot:'/untrusted'}),'2026-01-03');
    insert.run('c','other','owner',JSON.stringify({workspaceRoot:'/other'}),'2026-01-04');
    db.exec("INSERT INTO runs VALUES('a','scheduled-run')");
    assert.equal(savedSessionWorkspace(db,'chat'),'/chosen');
    assert.equal(savedSessionWorkspace(db,'scheduled-run'),'/chosen');
    assert.equal(savedSessionWorkspace(db,'missing'),undefined);
  } finally { db.close(); }
});

test('memory detail reads current catalog without any daemon or execution actor', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-detail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = privateMemoryLayout(root, 'owner').databaseFile;
  const writer = new SqliteMemoryCatalog(file, 'private', 'owner');
  t.after(() => writer.close());
  const timestamp = '2026-10-09T00:00:00.000Z';
  const doc: MemoryDocument = {
    ref: { scope: 'private', profileId: 'owner', id: 'fixture' },
    metadata: { schemaVersion: 1, id: 'fixture', title: 'Fixture', kind: 'fact', scope: 'private', profileId: 'owner', status: 'active', confidence: 'source-grounded', aliases: [], tags: [], sourceRefs: [], validFrom: null, validUntil: null, supersedes: [], createdAt: timestamp, updatedAt: timestamp },
    body: 'Saved body', digest: 'sha256:' + 'a'.repeat(64),
  };
  writer.index(doc);
  const backend = daemonWebBackend({ workspaceRoot: root, dataRoot: root, daemonDataRoot: root } as AppConfig, { homeDirectory: root });
  const result = await backend.memoryRead('synthetic', 'private', 'fixture') as MemoryDocument;
  assert.equal(result.body, 'Saved body');
  assert.equal(await backend.memoryRead('synthetic', 'workspace', 'fixture'), undefined);
  writer.index({ ...doc, body: 'Updated body' });
  assert.equal((await backend.memoryRead('synthetic', 'private', 'fixture') as MemoryDocument).body, 'Updated body');
  await assert.rejects(backend.memoryRead('../escape', 'private', 'fixture'), /会话 ID/);
});
