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
