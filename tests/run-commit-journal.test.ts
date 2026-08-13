import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  RunCommitJournal,
  runAnswerDigest,
  runCommitJournalId,
} from '../src/core/run-commit-journal.js';

test('run commit journal advances durably without storing answer text', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-run-commit-'));
  const file = path.join(root, 'journal.json');
  const answer = 'private final answer';
  const first = new RunCommitJournal(file);
  const prepared = await first.prepare({
    sessionId: 'owner',
    runId: 'run-1',
    executionKey: 'task:one',
    answerDigest: runAnswerDigest(answer),
    completionDecision: 'pass',
    runtimeActions: [{ type: 'switch_mode', mode: 'plan' }],
  });
  assert.equal(prepared.phase, 'prepared');
  await first.advance('owner', 'run-1', 'receipt_committed');
  await first.advance('owner', 'run-1', 'session_committed');

  const reopened = new RunCommitJournal(file);
  assert.equal((await reopened.get('owner', 'run-1'))?.phase, 'session_committed');
  assert.equal(JSON.stringify(await reopened.recoverable()).includes(answer), false);
  assert.equal((await reopened.findByExecutionKey('owner', 'task:one'))?.runId, 'run-1');

  await reopened.acknowledgeTask('owner', 'task:one');
  assert.equal((await reopened.get('owner', 'run-1'))?.phase, 'task_committed');
  await reopened.finalizeExecution('owner', 'task:one');
  assert.equal((await reopened.get('owner', 'run-1'))?.phase, 'finalized');
  assert.deepEqual(await reopened.recoverable(), []);
});

test('every commit phase survives a journal reopen', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-run-commit-phases-'));
  const file = path.join(root, 'journal.json');
  const phases = [
    'prepared',
    'receipt_committed',
    'session_committed',
    'goal_committed',
    'task_committed',
    'effects_applied',
    'finalized',
  ] as const;
  const journal = new RunCommitJournal(file);
  for (const [index, phase] of phases.entries()) {
    const runId = `run-${index}`;
    const executionKey = `task:${index}`;
    await journal.prepare({
      sessionId: 'owner',
      runId,
      executionKey,
      answerDigest: runAnswerDigest(runId),
      runtimeActions: [],
    });
    if (phase === 'task_committed') {
      await journal.acknowledgeTask('owner', executionKey);
    } else if (phase === 'finalized') {
      await journal.finalizeExecution('owner', executionKey);
    } else if (phase !== 'prepared') {
      await journal.advance('owner', runId, phase);
    }
    assert.equal((await new RunCommitJournal(file).get('owner', runId))?.phase, phase);
  }
});

test('run commit journal replaces a conflicting plan before any phase becomes durable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-run-commit-replace-prepared-'));
  const journal = new RunCommitJournal(path.join(root, 'journal.json'));
  await journal.prepare({
    sessionId: 'owner',
    runId: 'run-1',
    answerDigest: runAnswerDigest('one'),
    runtimeActions: [],
  });

  const prepared = await journal.prepare({
    sessionId: 'owner',
    runId: 'run-1',
    answerDigest: runAnswerDigest('two'),
    outcome: 'failed',
    runtimeActions: [],
  });

  assert.equal(prepared.answerDigest, runAnswerDigest('two'));
  assert.equal(prepared.outcome, 'failed');
});

test('run commit journal rejects a conflicting plan after durable progress', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-run-commit-conflict-'));
  const journal = new RunCommitJournal(path.join(root, 'journal.json'));
  await journal.prepare({
    sessionId: 'owner',
    runId: 'run-1',
    answerDigest: runAnswerDigest('one'),
    runtimeActions: [],
  });
  await journal.advance('owner', 'run-1', 'receipt_committed');

  await assert.rejects(journal.prepare({
    sessionId: 'owner',
    runId: 'run-1',
    answerDigest: runAnswerDigest('two'),
    runtimeActions: [],
  }), /不同的提交计划/);
});

test('one durable execution selects the latest attempt and finalizes every prior attempt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-run-commit-attempts-'));
  const journal = new RunCommitJournal(path.join(root, 'journal.json'));
  await journal.prepare({
    sessionId: 'owner',
    runId: 'attempt-1',
    executionKey: 'event:retry',
    answerDigest: runAnswerDigest('interrupted'),
    outcome: 'interrupted',
    runtimeActions: [],
  });
  await journal.prepare({
    sessionId: 'owner',
    runId: 'attempt-2',
    executionKey: 'event:retry',
    answerDigest: runAnswerDigest('completed'),
    outcome: 'completed',
    runtimeActions: [],
  });

  assert.equal((await journal.findByExecutionKey('owner', 'event:retry'))?.runId, 'attempt-2');
  await journal.acknowledgeTask('owner', 'event:retry');
  assert.equal((await journal.get('owner', 'attempt-1'))?.phase, 'task_committed');
  assert.equal((await journal.get('owner', 'attempt-2'))?.phase, 'task_committed');
  await journal.finalizeExecution('owner', 'event:retry');
  assert.equal((await journal.get('owner', 'attempt-1'))?.phase, 'finalized');
  assert.equal((await journal.get('owner', 'attempt-2'))?.phase, 'finalized');
});

test('preserves forward-compatible finalization media anchors when reopening a journal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-run-commit-forward-compatible-'));
  const file = path.join(root, 'journal.json');
  const answerDigest = runAnswerDigest('answer');
  const entryId = runCommitJournalId('owner', 'run-1');
  await writeFile(file, `${JSON.stringify({
    version: 1,
    entries: {
      [entryId]: {
        id: entryId,
        sessionId: 'owner',
        runId: 'run-1',
        phase: 'prepared',
        answerDigest,
        outcome: 'completed',
        runtimeActions: [],
        finalization: {
          runId: 'run-1',
          answerDigest,
          outcome: 'completed',
          evidenceRefs: [],
          mediaAnchors: [{
            evidenceId: 'media:audio:example',
            anchor: { kind: 'time', startMs: 0, endMs: 1_000 },
          }],
          toolManifest: [],
        },
        updatedAt: '2026-08-12T00:00:00.000Z',
      },
    },
  }, null, 2)}\n`);

  const journal = new RunCommitJournal(file);
  assert.equal((await journal.get('owner', 'run-1'))?.runId, 'run-1');
  await journal.advance('owner', 'run-1', 'receipt_committed');

  const persisted = JSON.parse(await readFile(file, 'utf8')) as {
    entries: Record<string, { finalization?: { mediaAnchors?: unknown[] } }>;
  };
  assert.equal(persisted.entries[entryId]?.finalization?.mediaAnchors?.length, 1);
  assert.deepEqual(await readdir(root), ['journal.json']);
});
