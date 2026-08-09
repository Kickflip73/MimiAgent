import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyRunOutcome,
  constrainRunAnswer,
  createRunFinalization,
  executionCompletionDecision,
  runEvidenceRefs,
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

test('ordinary Run outcomes follow structured Host facts instead of model wording', () => {
  const call = (
    toolName: string,
    status: 'started' | 'succeeded' | 'failed' | 'uncertain',
    output?: unknown,
  ) => ({
    sessionId: 'owner',
    runId: 'run-matrix',
    toolName,
    callId: `${toolName}-${status}`,
    argumentsJson: '{}',
    status,
    ...(output === undefined ? {} : { output }),
  });
  const cases = [
    ['no-tool read answer', [], 'completed'],
    ['successful read', [call('read_file', 'succeeded', { content: 'bounded' })], 'completed'],
    ['verified file mutation', [call('write_file', 'succeeded', {
      path: 'result.txt', bytes: 6, diagnostics: { ok: true },
    })], 'completed'],
    ['Browser interaction only', [call('browser_act', 'succeeded', {
      verified: true,
      completionScope: 'interaction',
      businessOutcome: 'unverified',
      mimiActionIntent: { ref: 'action-intent:browser', outcome: 'confirmed' },
    })], 'partial'],
    ['confirmed external action', [call('connector_action', 'succeeded', {
      outcome: 'confirmed',
      operationId: 'operation-1',
      occurredAt: '2026-08-02T00:00:00.000Z',
      mimiExecutionReceipt: { ref: 'execution:confirmed', outcome: 'succeeded' },
    })], 'completed'],
    ['partial tool failure', [
      call('read_file', 'succeeded', { content: 'bounded' }),
      call('run_shell', 'failed'),
    ], 'partial'],
    ['blocked dependency', [call('request_background_task_input', 'succeeded', {
      accepted: true,
      question: '请选择精确目标',
    })], 'blocked'],
    ['deterministic pre-dispatch failure', [call('connector_action', 'failed', {
      mimiStatus: 'tool_input_rejected',
      code: 'target_required',
      retryable: true,
    })], 'failed'],
    ['uncertain dispatch', [call('connector_action', 'uncertain')], 'uncertain'],
  ] as const;

  for (const [name, calls, expected] of cases) {
    assert.equal(classifyRunOutcome({ sdk: 'completed', calls }), expected, name);
  }
  assert.equal(classifyRunOutcome({ sdk: 'interrupted', calls: [] }), 'interrupted');
});

test('Host final answer constrains non-completed model claims and binds one final digest', () => {
  const calls = [{
    sessionId: 'owner',
    runId: 'run-partial',
    toolName: 'browser_act',
    callId: 'browser-click',
    argumentsJson: '{}',
    status: 'succeeded' as const,
    output: {
      completionScope: 'interaction',
      businessOutcome: 'unverified',
      mimiActionIntent: { ref: 'action-intent:browser-click', outcome: 'confirmed' },
    },
  }];
  const answer = constrainRunAnswer({
    draft: '全部业务已经完成。',
    outcome: 'partial',
    reason: '只有页面交互证据，业务结果尚未回读确认',
    nextAction: '读取同一业务对象并核对结果',
    evidenceRefs: ['action-intent:browser-click'],
  });
  const record = createRunFinalization({
    runId: 'run-partial',
    answer,
    outcome: 'partial',
    reason: '只有页面交互证据，业务结果尚未回读确认',
    nextAction: '读取同一业务对象并核对结果',
    evidenceRefs: ['action-intent:browser-click'],
    calls,
  });

  assert.equal(record.outcome, 'partial');
  assert.deepEqual(record.evidenceRefs, ['action-intent:browser-click']);
  assert.match(answer, /outcome=partial/);
  assert.match(answer, /不构成整体完成声明/);
  assert.doesNotMatch(answer.split('\n')[0]!, /全部业务已经完成/);
  assert.match(record.answerDigest, /^[a-f0-9]{64}$/u);
});

test('finalization collects ref-only media Evidence and artifact receipts', () => {
  const mediaEvidenceId = `media-evidence:sha256:${'a'.repeat(64)}`;
  const mediaArtifactRef = `media-artifact:sha256:${'b'.repeat(64)}`;
  const refs = runEvidenceRefs([{
    sessionId: 'owner',
    runId: 'run-media',
    toolName: 'generate_image',
    callId: 'call-media',
    argumentsJson: JSON.stringify({ prompt: 'draw a dot' }),
    status: 'succeeded',
    output: {
      kind: 'media',
      evidence: { ref: mediaEvidenceId },
      artifact: { ref: mediaArtifactRef, bytes: 68 },
      duplicate: { ref: mediaEvidenceId },
      ignored: { ref: 'private:path:/Users/example/image.png' },
      malformed: { ref: 'media-evidence:not-a-digest' },
    },
  }]);
  assert.deepEqual(refs, [mediaArtifactRef, mediaEvidenceId]);
});
