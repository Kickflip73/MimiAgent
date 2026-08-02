import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateDeadLetters,
  classifyDeadLetterFailure,
  classifyDigestAges,
  classifyReadinessUnknown,
  operationalClassification,
} from '../src/daemon/operational-classification.js';
import type { ConnectorCapability } from '../src/daemon/connectors.js';

function connector(
  id: string,
  readiness: ConnectorCapability['readiness'],
): ConnectorCapability {
  return {
    id,
    enabled: true,
    online: true,
    readiness,
    source: `fixture:${id}`,
    trust: 'owner',
    claimedComputerApps: [],
    actions: [],
  };
}

test('dead letters aggregate into observable dispositions without copying errors', () => {
  const classified = aggregateDeadLetters([
    { failure: { code: 'provider.http_429', disposition: {
      phase: 'provider', kind: 'transient', retryable: true, dispatchStarted: false,
    } }, count: 2 },
    { failure: { code: 'provider.quota', disposition: {
      phase: 'provider', kind: 'validation', retryable: false, dispatchStarted: false,
    } }, count: 3 },
    { failure: { code: 'connector.delivery_uncertain', disposition: {
      phase: 'dispatch', kind: 'uncertain', retryable: false, dispatchStarted: true,
    } }, count: 1 },
    { count: 4 },
    { failure: { code: 'ledger.contract_violation', disposition: {
      phase: 'runtime', kind: 'validation', retryable: false, dispatchStarted: false,
    } }, count: 2 },
    { failure: { code: 'worker.reclaimed', disposition: {
      phase: 'runtime', kind: 'transient', retryable: true, dispatchStarted: false,
    } }, count: 3 },
  ]);
  assert.deepEqual(classified, [
    { category: 'provider', disposition: 'retry_after_fix', count: 5 },
    { category: 'unknown', disposition: 'investigate', count: 4 },
    { category: 'worker_runtime', disposition: 'retry_after_fix', count: 3 },
    { category: 'configuration', disposition: 'retry_after_fix', count: 2 },
    { category: 'uncertain_side_effect', disposition: 'manual_verify', count: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(classified), /quota|dispatch|fixture/);
});

test('structured Task facts classify failures without reading natural-language errors', () => {
  assert.deepEqual(classifyDeadLetterFailure({
    code: 'worker.unexpected_exit',
    disposition: {
      phase: 'runtime', kind: 'transient', retryable: true, dispatchStarted: false,
    },
  }), {
    category: 'worker_runtime',
    disposition: 'retry_after_fix',
  });
  assert.deepEqual(classifyDeadLetterFailure({
    code: 'ledger.corrupt',
    disposition: {
      phase: 'runtime', kind: 'validation', retryable: false, dispatchStarted: false,
    },
  }), {
    category: 'configuration',
    disposition: 'retry_after_fix',
  });
});

test('Digest age and readiness unknown distinguish startup grace from overdue fixes', () => {
  const now = Date.parse('2026-07-27T12:00:00.000Z');
  assert.deepEqual(classifyDigestAges([
    '2026-07-27T11:00:00.000Z',
    '2026-07-25T12:00:00.000Z',
    '2026-07-10T12:00:00.000Z',
  ], now), [
    { age: 'fresh', count: 1 },
    { age: 'aging', count: 1 },
    { age: 'stale', count: 1 },
  ]);
  const unknown = connector('legacy', { inbound: 'unknown', outbound: 'unknown' });
  assert.equal(classifyReadinessUnknown(
    [unknown],
    '2026-07-27T11:59:30.000Z',
    now,
  )[0]?.reason, 'startup_grace');
  assert.deepEqual(classifyReadinessUnknown(
    [unknown],
    '2026-07-27T10:00:00.000Z',
    now,
  ), [{
    connector: 'legacy',
    reason: 'legacy_missing_status',
    disposition: 'connector_fix_required',
  }]);
});

test('operational classification reports remaining unknown dead letters explicitly', () => {
  const snapshot = operationalClassification({
    deadLetters: [{ count: 7 }],
    digestOccurredAt: [],
    connectors: [connector('stale', {
      inbound: 'unknown',
      outbound: 'unknown',
      stale: true,
    })],
    daemonStartedAt: '2026-07-27T00:00:00.000Z',
    now: Date.parse('2026-07-27T12:00:00.000Z'),
  });
  assert.equal(snapshot.unclassifiedDeadLetters, 7);
  assert.equal(snapshot.readinessUnknown[0]?.reason, 'stale_status');
  assert.equal(snapshot.readinessUnknown[0]?.disposition, 'connector_fix_required');
});
