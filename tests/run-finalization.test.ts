import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createRunFinalization,
  executionCompletionDecision,
  toolExecutionManifest,
} from '../src/core/run-finalization.js';

test('finalization projects different file mutations from the ledger without copying payloads', () => {
  const calls = [
    {
      sessionId: 'owner',
      runId: 'run-file',
      toolName: 'write_file',
      callId: 'call-write',
      argumentsJson: JSON.stringify({ path: 'notes/a.txt', content: 'private body' }),
      status: 'succeeded' as const,
      output: { path: 'notes/a.txt', bytes: 12 },
    },
    {
      sessionId: 'owner',
      runId: 'run-file',
      toolName: 'edit_file',
      callId: 'call-edit',
      argumentsJson: JSON.stringify({ path: 'notes/a.txt', patch: 'secret patch' }),
      status: 'failed' as const,
      error: 'conflict containing private text',
    },
  ];

  const manifest = toolExecutionManifest(calls);
  assert.deepEqual(manifest.map((entry) => ({
    toolName: entry.toolName,
    callId: entry.callId,
    status: entry.status,
  })), [
    { toolName: 'write_file', callId: 'call-write', status: 'succeeded' },
    { toolName: 'edit_file', callId: 'call-edit', status: 'failed' },
  ]);
  assert.match(manifest[0]!.argumentsDigest, /^[a-f0-9]{64}$/u);
  assert.match(manifest[0]!.outcomeDigest!, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(manifest), /private body|secret patch|private text/u);
});

test('finalization gives shell and uncertain external effects one canonical answer-bound record', () => {
  const calls = [
    {
      sessionId: 'owner',
      runId: 'execution-1:attempt-1',
      toolName: 'run_shell',
      callId: 'call-shell',
      modelCallIds: ['model-shell'],
      argumentsJson: JSON.stringify({ command: 'touch result.txt' }),
      status: 'succeeded' as const,
      output: { exitCode: 0 },
    },
    {
      sessionId: 'owner',
      runId: 'execution-1',
      toolName: 'connector_action',
      callId: 'call-external',
      argumentsJson: JSON.stringify({ action: 'send' }),
      status: 'uncertain' as const,
      error: 'transport closed',
    },
  ];

  const record = createRunFinalization({
    runId: 'run-1',
    answer: '任务状态不确定，未重放外部动作。',
    completionDecision: 'uncertain',
    calls,
  });

  assert.equal(record.runId, 'run-1');
  assert.equal(record.completionDecision, 'uncertain');
  assert.match(record.answerDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(record.toolManifest.map((entry) => entry.status), ['succeeded', 'uncertain']);
  assert.equal(record.toolManifest[0]!.modelCallId, 'model-shell');
  assert.notEqual(record.toolManifest[0]!.argumentsDigest, record.toolManifest[1]!.argumentsDigest);
  assert.equal(executionCompletionDecision(calls), 'uncertain');
});

test('ordinary run completion is not downgraded by a recovered failed-safe Connector capability', () => {
  assert.equal(executionCompletionDecision([{
    sessionId: 'owner',
    runId: 'run-1',
    toolName: 'connector_capability',
    callId: 'rejected',
    argumentsJson: '{}',
    status: 'failed',
    error: 'rejected before dispatch',
  }, {
    sessionId: 'owner',
    runId: 'run-1',
    toolName: 'connector_capability',
    callId: 'corrected',
    argumentsJson: '{}',
    status: 'succeeded',
    output: { outcome: 'confirmed' },
  }]), undefined);
});
