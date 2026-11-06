import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CompletionCoordinator,
  incompleteCompletionAnswer,
} from '../src/runtime/completion-coordinator.js';
import type { ExecutionCallRecord } from '../src/core/execution-ledger.js';

const confirmedCall: ExecutionCallRecord = {
  sessionId: 'session-1',
  runId: 'prior-run',
  toolName: 'connector_action',
  callId: 'semantic-call',
  modelCallId: 'model-call',
  modelCallIds: ['model-call', 'model-call-retry'],
  argumentsJson: '{"action":"send_message","target":"owner"}',
  status: 'succeeded',
  output: {
    outcome: 'confirmed',
    tool: 'connector_action',
    action: 'send_message',
    operationId: 'operation-1',
    occurredAt: '2026-07-24T00:00:00.000Z',
  },
};

test('Computer delivery, old receipts and model claims do not satisfy a GUI completion criterion', async () => {
  for (const [output, expected] of [
    [{ ok: true, state: { text: '56' } }, 'continue'],
    [{ ok: true, verified: false, verification: { status: 'not_requested' } }, 'continue'],
    [{ ok: true, verified: true, verification: { status: 'failed' } }, 'continue'],
    [{ ok: true, verified: true, verification: { status: 'passed', evidenceViewRef: 'fresh' } }, 'pass'],
  ] as const) {
    const coordinator = new CompletionCoordinator({ async listCalls() { return [{ ...confirmedCall, toolName: 'computer_act', argumentsJson: '{"verify":{"equals":"56"}}', output }]; } });
    const result = await coordinator.evaluate({
      sessionId: 's', runId: 'r', goalOwned: false, planOwned: false, teamOwned: false, requireDurableBlocker: false,
      plans: { async get() { return []; } }, team: { async list() { return []; } },
      completionContract: { objective: 'calculator', kind: 'external_action', criteria: [{ id: 'result', description: 'display 56', requiredEvidence: 'tool_receipt', expectedTool: 'computer_act', expectedArgumentsContain: ['"equals":"56"'] }] },
      completionReport: { status: 'completed', proofs: [{ criterionId: 'result', evidence: '56', toolCallIds: ['model-call'] }] },
    });
    assert.equal(result.gate.decision, expected);
  }
});

test('completion coordinator recovers prior evidence and fingerprints owned plan/team state', async () => {
  const requestedRuns: string[] = [];
  const coordinator = new CompletionCoordinator({
    async listCalls(_sessionId, runId) {
      requestedRuns.push(runId);
      return runId === 'prior-run' ? [confirmedCall] : [];
    },
  });
  const request = {
    sessionId: 'session-1',
    runId: 'current-run',
    recoveryRunId: 'prior-run',
    completionContract: {
      objective: 'send the requested message',
      kind: 'external_action' as const,
      criteria: [{
        id: 'sent',
        description: 'message was confirmed',
        requiredEvidence: 'tool_receipt' as const,
        expectedTool: 'connector_action',
        expectedArgumentsContain: ['send_message'],
      }],
    },
    completionReport: {
      status: 'completed' as const,
      proofs: [{ criterionId: 'sent', evidence: 'confirmed', toolCallIds: ['model-call'] }],
    },
    requireDurableBlocker: false,
    goalOwned: true,
    planOwned: true,
    teamOwned: true,
    plans: { async get() { return [{ id: 'plan', description: 'send', status: 'completed' as const }]; } },
    team: {
      async list() {
        return [{
          id: 'worker',
          description: 'send',
          role: 'builder' as const,
          status: 'completed' as const,
          dependencies: [],
          paths: ['message.txt'],
          createdAt: '2026-07-24T00:00:00.000Z',
          updatedAt: '2026-07-24T00:00:01.000Z',
        }];
      },
    },
  };

  const first = await coordinator.evaluate(request);
  const second = await coordinator.evaluate(request);
  assert.equal(first.gate.decision, 'pass');
  assert.equal(first.progressFingerprint, second.progressFingerprint);
  assert.deepEqual(requestedRuns, ['current-run', 'prior-run', 'current-run', 'prior-run']);
});

test('completion coordinator skips unowned state and formats non-pass answers safely', async () => {
  const coordinator = new CompletionCoordinator({
    async listCalls() {
      return [];
    },
  });
  const result = await coordinator.evaluate({
    sessionId: 'session-1',
    runId: 'run-1',
    requireDurableBlocker: false,
    goalOwned: false,
    planOwned: false,
    teamOwned: false,
    plans: { async get() { throw new Error('unowned plan was read'); } },
    team: { async list() { throw new Error('unowned team was read'); } },
  });
  assert.equal(result.gate.decision, 'continue');
  assert.match(incompleteCompletionAnswer({
    decision: 'continue',
    reason: 'missing proof',
    unmetCriteria: ['artifact'],
  }), /未满足：artifact/);
  assert.match(incompleteCompletionAnswer({
    decision: 'blocked',
    reason: 'owner input required',
    unmetCriteria: [],
  }), /\/resume/);
  assert.match(incompleteCompletionAnswer({
    decision: 'uncertain',
    reason: 'external result unknown',
    unmetCriteria: [],
  }), /不会自动重放副作用/);
});
