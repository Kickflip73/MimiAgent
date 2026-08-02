import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.js';
import { createMimiBackup } from '../src/daemon/backup.js';
import {
  migrateSensitiveHistory,
  scanSensitiveHistory,
} from '../src/daemon/data-governance.js';
import { MimiStore } from '../src/daemon/store.js';

const FIXTURE_TOKEN = ['sk', 'fixture', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
const FIXTURE_MULTICA_TOKEN = ['mul', 'abcdef0123456789abcdef0123456789'].join('_');
const FIXTURE_EMAIL = 'fixture.owner@example.invalid';

test('historical dry-run reports only categories and fingerprints, then verified backup gates reversible apply', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-data-governance-'));
  const dataRoot = path.join(root, 'data');
  const daemonRoot = path.join(root, 'daemon');
  await mkdir(path.join(dataRoot, 'traces'), { recursive: true });
  await mkdir(path.join(dataRoot, 'memory', 'owner', 'wiki', 'fact'), { recursive: true });
  await mkdir(daemonRoot, { recursive: true });
  const databaseFile = path.join(daemonRoot, 'mimi.db');
  const store = new MimiStore(databaseFile);
  try {
    const now = new Date().toISOString();
    const event = store.appendEvent({
      id: 'event',
      externalId: 'event',
      source: 'local-cli',
      type: 'command.received',
      trust: 'owner',
      payload: {},
      profileId: 'owner',
      occurredAt: now,
      receivedAt: now,
    }).event;
    store.enqueueTask({
      id: 'task',
      type: 'background',
      idempotencyKey: 'task',
      authorityEventId: event.id,
      profileId: 'owner',
      objective: { prompt: `use ${FIXTURE_TOKEN} and ${FIXTURE_MULTICA_TOKEN}` },
      executor: 'isolated_worker',
      workspaceAccess: 'write',
      priority: 50,
    });
    store.schedules.add({
      name: 'legacy fixture',
      type: 'at',
      value: 'once',
      prompt: 'safe before legacy injection',
      profileId: 'owner',
      trust: 'owner',
      nextRunAt: '2030-01-01T00:00:00.000Z',
    });
  } finally {
    store.close();
  }
  const legacyDatabase = new DatabaseSync(databaseFile);
  legacyDatabase.prepare('UPDATE tasks SET objective_json = ? WHERE id = ?').run(
    JSON.stringify({ prompt: `use ${FIXTURE_TOKEN} and ${FIXTURE_MULTICA_TOKEN}` }),
    'task',
  );
  legacyDatabase.prepare('UPDATE schedules SET prompt = ?').run(
    `contact ${FIXTURE_EMAIL} using ${FIXTURE_TOKEN}`,
  );
  legacyDatabase.close();
  await writeFile(path.join(dataRoot, 'traces', 'session.jsonl'), JSON.stringify({
    type: 'tool',
    data: { email: FIXTURE_EMAIL },
  }));
  await writeFile(path.join(dataRoot, 'memory', 'owner', 'wiki', 'fact', 'fixture.md'), [
    '---',
    'id: fixture',
    '---',
    '',
    `credential ${FIXTURE_TOKEN}`,
    `contact ${FIXTURE_EMAIL}`,
    '',
  ].join('\n'));
  await writeFile(path.join(dataRoot, 'plans.json'), JSON.stringify({
    version: 1,
    objective: `contact ${FIXTURE_EMAIL}`,
  }));

  const dryRun = await scanSensitiveHistory({ dataRoot, databaseFile });
  assert.equal(dryRun.mode, 'dry_run');
  assert.ok(dryRun.findings >= 4);
  assert.equal(dryRun.rawValuesIncluded, false);
  assert.equal(JSON.stringify(dryRun).includes(FIXTURE_TOKEN), false);
  assert.equal(JSON.stringify(dryRun).includes(FIXTURE_MULTICA_TOKEN), false);
  assert.equal(JSON.stringify(dryRun).includes(FIXTURE_EMAIL), false);

  const backupDirectory = path.join(root, 'backup');
  const config = {
    dataRoot,
    daemonDataRoot: daemonRoot,
  } as AppConfig;
  await createMimiBackup(config, backupDirectory);
  await assert.rejects(migrateSensitiveHistory({
    dataRoot,
    databaseFile,
    daemonSocket: path.join(root, 'running.sock'),
    backupDirectory: path.join(root, 'missing-backup'),
  }), /ENOENT|备份/);
  const runningSocket = path.join(root, 'running.sock');
  await writeFile(runningSocket, '');
  await assert.rejects(migrateSensitiveHistory({
    dataRoot,
    databaseFile,
    daemonSocket: runningSocket,
    backupDirectory,
  }), /Daemon 已停止/);
  await unlink(runningSocket);
  const result = await migrateSensitiveHistory({
    dataRoot,
    databaseFile,
    daemonSocket: path.join(root, 'stopped.sock'),
    backupDirectory,
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.originalsPreservedInBackup, true);
  assert.ok(result.databaseValuesChanged >= 1);
  assert.ok(result.filesChanged >= 3);
  assert.equal(result.verification.findings, 0);
  assert.equal((await readFile(path.join(dataRoot, 'traces', 'session.jsonl'), 'utf8')).includes(FIXTURE_EMAIL), false);
  const privateMemory = await readFile(
    path.join(dataRoot, 'memory', 'owner', 'wiki', 'fact', 'fixture.md'),
    'utf8',
  );
  assert.equal(privateMemory.includes(FIXTURE_TOKEN), false);
  assert.equal(privateMemory.includes(FIXTURE_EMAIL), true);
});
