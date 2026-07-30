import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PlanStore } from '../src/core/plan.js';
import { RunFailureError } from '../src/runtime/run-failure.js';

function contract(objective: string, target: string) {
  return {
    objective,
    kind: 'artifact' as const,
    criteria: [{
      id: 'read',
      description: `read ${target}`,
      requiredEvidence: 'artifact' as const,
      expectedTool: 'read_file',
      expectedArgumentsContain: [target],
    }],
  };
}

test('Goal setup and stale updates leave no partial state across different objectives', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-goal-aggregate-failure-'));
  const file = path.join(root, 'plans.json');
  const plans = new PlanStore(file, 'goal-aggregate');
  const packageGoal = await plans.createGoal({
    objective: 'read package metadata',
    completionContract: contract('read package metadata', 'package.json'),
    status: 'paused',
    checkpoint: 'not read yet',
    nextAction: 'read package.json',
  });
  const beforeConflict = await readFile(file, 'utf8');

  await assert.rejects(
    plans.createGoal({
      objective: 'read project overview',
      completionContract: contract('read project overview', 'README.md'),
      status: 'active',
    }),
    (error: unknown) => error instanceof RunFailureError
      && error.disposition.kind === 'state_conflict',
  );
  assert.equal(await readFile(file, 'utf8'), beforeConflict);

  await assert.rejects(
    plans.checkpoint(
      { checkpoint: 'stale writer', nextAction: 'read README.md' },
      { goalId: packageGoal.id, expectedRevision: packageGoal.revision - 1 },
    ),
    (error: unknown) => error instanceof RunFailureError
      && error.disposition.kind === 'state_conflict',
  );
  assert.equal(await readFile(file, 'utf8'), beforeConflict);
});

test('Goal continuation and cancellation use id/revision CAS instead of wording', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-goal-aggregate-cas-'));
  const plans = new PlanStore(path.join(root, 'plans.json'), 'goal-cas');
  const goal = await plans.createGoal({
    objective: 'inspect project metadata',
    completionContract: contract('inspect project metadata', 'package.json'),
    status: 'paused',
    checkpoint: 'waiting',
    nextAction: 'inspect package.json',
  });

  const continued = await plans.checkpoint(
    { status: 'active', checkpoint: 'continuing with alternate wording' },
    { goalId: goal.id, expectedRevision: goal.revision },
  );
  assert.equal(continued.revision, goal.revision + 1);

  await assert.rejects(
    plans.checkpoint(
      { checkpoint: '旧措辞继续执行' },
      { goalId: goal.id, expectedRevision: goal.revision },
    ),
    (error: unknown) => error instanceof RunFailureError
      && error.disposition.kind === 'state_conflict',
  );
  const cancelled = await plans.cancelGoal({
    goalId: continued.id,
    expectedRevision: continued.revision,
    checkpoint: 'owner cancelled',
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.revision, continued.revision + 1);
  assert.deepEqual(
    await plans.cancelGoal({
      goalId: cancelled.id,
      expectedRevision: cancelled.revision,
      checkpoint: 'owner cancelled',
    }),
    cancelled,
  );
});
