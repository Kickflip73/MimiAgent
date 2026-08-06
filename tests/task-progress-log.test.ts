import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TaskProgressLog } from '../src/daemon/task-progress-log.js';

test('persists bounded Mimi background progress without private reasoning details', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-progress-'));
  const log = new TaskProgressLog(root);
  const taskId = randomUUID();

  await log.append(taskId, {
    kind: 'status',
    tone: 'tool',
    title: 'Shell · npm test',
    detail: '测试运行中',
    fullDetail: 'SECRET_TOOL_OUTPUT',
    next: '等待测试完成',
  });
  await log.append(taskId, {
    kind: 'reasoning',
    text: 'PRIVATE_REASONING',
  });
  await log.append(taskId, {
    kind: 'plan',
    steps: [{ id: 'research', description: '核验来源', status: 'running' }],
  });

  const progress = await log.inspect(taskId);
  assert.ok(progress);
  assert.equal(progress.recentEvents.length, 2);
  assert.match(progress.latestActivity ?? '', /核验来源/);
  assert.match(progress.logUpdatedAt, /^\d{4}-/);
  assert.equal((await stat(progress.logPath)).mode & 0o777, 0o600);
  const contents = await readFile(progress.logPath, 'utf8');
  assert.doesNotMatch(contents, /PRIVATE_REASONING|SECRET_TOOL_OUTPUT/);
});

test('returns undefined before a Mimi background progress log exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-progress-missing-'));
  assert.equal(await new TaskProgressLog(root).inspect(randomUUID()), undefined);
});

test('rotates a Mimi background progress log at its configured size bound', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-progress-rotate-'));
  const log = new TaskProgressLog(root, 200);
  const taskId = randomUUID();
  for (let index = 0; index < 4; index += 1) {
    await log.append(taskId, {
      kind: 'status', tone: 'tool', title: `step ${index}`,
      detail: 'bounded detail'.repeat(10), next: 'continue',
    });
  }
  const progress = await log.inspect(taskId);
  assert.ok(progress);
  assert.match(progress.latestActivity ?? '', /step 3/);
  assert.equal((await stat(`${progress.logPath}.previous`)).isFile(), true);
});
