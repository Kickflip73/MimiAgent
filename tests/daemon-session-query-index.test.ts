import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MimiStore } from '../src/daemon/store.js';

const root = path.resolve(import.meta.dirname, '..');

// Check the production queries, including their ordering and OR/UNION semantics.
async function queryFrom(file: string, marker: string): Promise<string> {
  const source = await readFile(path.join(root, file), 'utf8');
  const start = source.indexOf(marker);
  assert.ok(start >= 0);
  const tick = source.indexOf('`', start);
  return source.slice(tick + 1, source.indexOf('`', tick + 1));
}

function plan(database: DatabaseSync, sql: string, ...args: string[]): string {
  return database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args)
    .map((row) => String(row.detail)).join('\n');
}

test('fresh and existing databases bound session history and workspace lookup by session indexes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mimi-session-query-'));
  const file = path.join(directory, 'mimi.db');
  const timeline = await queryFrom('src/web/session-timeline.ts', 'function durableRuns');
  const workspace = await queryFrom('src/daemon/session-workspace.ts', 'function savedSessionWorkspace');
  let store: MimiStore | undefined;
  let database: DatabaseSync | undefined;
  try {
    store = new MimiStore(file);
    store.close(); store = undefined;
    database = new DatabaseSync(file);
    // Existing installations have this global ordering index; it must not be used to
    // scan every historical answer while looking for a new or empty Session.
    database.exec('CREATE INDEX IF NOT EXISTS runs_started_at ON runs(started_at)');
    for (const iteration of ['fresh', 'reopened-v17']) {
      const historyPlan = plan(database, timeline, 'new-session');
      assert.match(historyPlan, /SEARCH runs USING INDEX runs_session_started_idx \(session_key=\?\)/);
      assert.doesNotMatch(historyPlan, /SCAN runs|USE TEMP B-TREE FOR ORDER BY/);
      const workspacePlan = plan(database, workspace, 'new-session', 'new-session');
      assert.match(workspacePlan, /SEARCH runs USING COVERING INDEX runs_session_started_idx \(session_key=\?\)/);
      assert.match(workspacePlan, /SEARCH tasks USING INDEX tasks_session_idx \(session_key=\?\)/);
      assert.doesNotMatch(workspacePlan, /SCAN t\b|SCAN runs\b/);
      assert.deepEqual(database.prepare(timeline).all('new-session'), []);
      if (iteration === 'fresh') {
        database.exec('DROP INDEX runs_session_started_idx');
        assert.match(plan(database, timeline, 'new-session'), /SCAN runs USING INDEX runs_started_at/);
        database.close(); database = undefined;
        store = new MimiStore(file); // Existing v17 schema receives the derived index.
        store.close(); store = undefined;
        database = new DatabaseSync(file);
        assert.equal(database.prepare('PRAGMA user_version').get()?.user_version, 17);
      }
    }
  } finally {
    store?.close(); database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('task sidebar SQL reads bounded metadata and preserves fields without decoding result bodies', async () => {
  const { taskListItem } = await import('../src/daemon/task-inspection.js');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-query-'));
  const file = path.join(directory, 'mimi.db');
  let store = new MimiStore(file);
  let database: DatabaseSync | undefined;
  try {
    const timestamp = '2026-10-09T08:00:00.000Z';
    const authority = store.appendEvent({ id: 'authority', externalId: 'authority', source: 'local-cli',
      type: 'command.received', trust: 'owner', profileId: 'owner', payload: {},
      replyRoute: { channel: 'local' }, occurredAt: timestamp, receivedAt: timestamp }).event;
    for (let i = 0; i < 3; i += 1) {
      store.enqueueTask({ id: `task-${i}`, type: 'background', idempotencyKey: `task-${i}`,
        authorityEventId: authority.id, profileId: 'owner', sessionKey: `session-${i}`,
        objective: { objective: i ? 'a'.repeat(700) : '', originSessionId: 'origin' },
        executor: 'isolated_worker', workspaceAccess: 'write', priority: 50 });
    }
    database = new DatabaseSync(file);
    database.prepare('UPDATE tasks SET created_at=?, updated_at=?, error=?').run(timestamp, timestamp, 'error'.repeat(150));
    const expected = store.listTasks(2).map(taskListItem);
    assert.deepEqual(expected.map((item) => item.taskId), ['task-2', 'task-1']);
    // A deliberately undecodable result proves the sidebar path never parses it.
    database.exec("UPDATE tasks SET result_json='not-json'; DROP INDEX tasks_created_idx");
    database.close(); database = undefined;
    store.close(); store = new MimiStore(file); // existing deployment receives index
    database = new DatabaseSync(file);
    assert.deepEqual(store.listTaskSummaries(2), expected);
    assert.equal(store.listTaskSummaries(200).find((item) => item.taskId === 'task-0')?.objective, '');
    const sql = await queryFrom('src/daemon/task-store.ts', 'listSummaries(limit:');
    assert.doesNotMatch(sql, /result_json|SELECT \*/);
    const queryPlan = plan(database, sql, '100');
    assert.match(queryPlan, /SCAN tasks USING INDEX tasks_created_idx/);
    assert.doesNotMatch(queryPlan, /USE TEMP B-TREE/);
  } finally {
    store.close(); database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
