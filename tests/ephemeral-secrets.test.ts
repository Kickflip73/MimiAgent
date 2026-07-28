import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AttentionEngine } from '../src/daemon/attention.js';
import { MimiDispatcher } from '../src/daemon/dispatcher.js';
import {
  ephemeralSecretInstructions,
  ephemeralSecretReferences,
  EphemeralSecretBroker,
} from '../src/daemon/ephemeral-secrets.js';
import { MimiStore } from '../src/daemon/store.js';
import { MimiHost } from '../src/runtime/mimi-host.js';
import type { AgentRunRequest } from '../src/runtime/run-service.js';
import type { MimiAgent } from '../src/runtime/mimi-agent.js';

const fixtureSecret = ['sk', 'EphemeralFixtureNotARealCredential123'].join('-');

test('ephemeral owner secrets are referenced once without entering durable prompt text', () => {
  let now = 1_000;
  const broker = new EphemeralSecretBroker(100, () => now);
  const captured = broker.capture('event-1', `请用 ${fixtureSecret} 测试接口`);

  assert.doesNotMatch(captured.sanitized, new RegExp(fixtureSecret));
  assert.match(captured.sanitized, /REDACTED:credential/);
  assert.deepEqual(captured.references.map((item) => item.environmentVariable), [
    'MIMI_EPHEMERAL_SECRET_1',
  ]);
  assert.deepEqual(ephemeralSecretReferences({ transientInputRefs: captured.references }), captured.references);
  assert.doesNotMatch(ephemeralSecretInstructions(captured.references), new RegExp(fixtureSecret));

  assert.equal(
    broker.take('event-1', captured.references)?.MIMI_EPHEMERAL_SECRET_1,
    fixtureSecret,
  );
  assert.equal(broker.take('event-1', captured.references), undefined);

  const expiring = broker.capture('event-2', fixtureSecret);
  now += 101;
  assert.equal(broker.take('event-2', expiring.references), undefined);
});

test('dispatcher passes an owner secret only through current Run shell environment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ephemeral-dispatch-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const broker = new EphemeralSecretBroker();
  const eventId = 'ephemeral-event';
  const captured = broker.capture(eventId, `测试 ${fixtureSecret}`);
  const now = new Date().toISOString();
  const routed = store.ingestEvent({
    id: eventId,
    externalId: eventId,
    source: 'local-cli',
    kind: 'command',
    trust: 'owner',
    payload: {
      prompt: captured.sanitized,
      transientInputRefs: captured.references,
    },
    occurredAt: now,
    receivedAt: now,
    priority: 100,
    profileId: 'owner',
    sessionKey: 'ephemeral-session',
  });
  assert.ok(routed.task);
  assert.doesNotMatch(JSON.stringify(store.getTask(routed.task.id)), new RegExp(fixtureSecret));
  assert.doesNotMatch(JSON.stringify(store.getImmutableEvent(eventId)), new RegExp(fixtureSecret));

  let request: AgentRunRequest | undefined;
  const agent = {
    currentSessionId: 'ephemeral-session',
    currentCapabilitySnapshot: () => undefined,
    completedExecution: async () => undefined,
    finalizeExecutionLedger: async () => undefined,
    reopenExecutionLedger: async () => undefined,
  } as unknown as MimiAgent;
  const host = new MimiHost(agent, {
    execute: async (candidate) => {
      request = candidate;
      return { answer: 'done', effects: [] };
    },
  });
  const dispatcher = new MimiDispatcher(store, host, attention, undefined, undefined, {
    claimTaskTypes: ['conversation'],
    takeEphemeralSecrets: (id, references) => broker.take(id, references),
  });
  try {
    assert.equal(await dispatcher.processTaskById(routed.task.id), true);
    assert.ok(request);
    assert.doesNotMatch(request.input as string, new RegExp(fixtureSecret));
    assert.equal(
      request.options?.ephemeralShellEnvironment?.MIMI_EPHEMERAL_SECRET_1,
      fixtureSecret,
    );
    assert.match(request.options?.hostInstructions ?? '', /MIMI_EPHEMERAL_SECRET_1/);
    assert.doesNotMatch(request.options?.hostInstructions ?? '', new RegExp(fixtureSecret));
    assert.equal(broker.take(eventId, captured.references), undefined);
  } finally {
    store.close();
  }
});

test('ephemeral fingerprints remain stable without revealing their source value', () => {
  const broker = new EphemeralSecretBroker();
  const captured = broker.capture('fingerprint-event', fixtureSecret);
  const expected = createHash('sha256').update(fixtureSecret).digest('hex').slice(0, 16);
  assert.equal(captured.references[0]?.fingerprint, `credential:sha256:${expected}`);
  assert.doesNotMatch(JSON.stringify(captured.references), new RegExp(fixtureSecret));
});

test('labeled and authorization secrets expose only their usable values to the Run', () => {
  const broker = new EphemeralSecretBroker();
  const labeledToken = broker.capture('labeled-token-event', `api_key=${fixtureSecret}`);
  assert.equal(labeledToken.references.length, 1);
  assert.match(labeledToken.sanitized, new RegExp(labeledToken.references[0]!.fingerprint));
  assert.equal(
    broker.take('labeled-token-event', labeledToken.references)?.MIMI_EPHEMERAL_SECRET_1,
    fixtureSecret,
  );

  const labeled = broker.capture('labeled-event', 'api_key="LabeledCredentialFixture123"');
  assert.equal(
    broker.take('labeled-event', labeled.references)?.MIMI_EPHEMERAL_SECRET_1,
    'LabeledCredentialFixture123',
  );

  const bearer = broker.capture('bearer-event', 'Bearer AuthorizationFixture123456');
  assert.equal(
    broker.take('bearer-event', bearer.references)?.MIMI_EPHEMERAL_SECRET_1,
    'AuthorizationFixture123456',
  );
});

test('another Event cannot claim or replay an owner transient binding', () => {
  const broker = new EphemeralSecretBroker();
  const captured = broker.capture('owner-event', fixtureSecret);
  assert.equal(broker.take('external-event', captured.references), undefined);
  assert.equal(
    broker.take('owner-event', [{
      ...captured.references[0]!,
      environmentVariable: 'MIMI_EPHEMERAL_SECRET_2',
    }]),
    undefined,
  );
  assert.equal(broker.take('owner-event', captured.references), undefined);
});
