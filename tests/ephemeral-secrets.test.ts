import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunContext } from '@openai/agents';
import { test } from 'node:test';
import { AttentionEngine } from '../src/daemon/attention.js';
import { MimiDispatcher } from '../src/daemon/dispatcher.js';
import {
  ephemeralSecretReferences,
  EphemeralSecretBroker,
} from '../src/daemon/ephemeral-secrets.js';
import { MimiStore } from '../src/daemon/store.js';
import {
  activateEphemeralOwnerInput,
  ephemeralOwnerInputInstructions,
  redactActiveEphemeralText,
} from '../src/runtime/ephemeral-owner-input.js';
import { MimiAgent } from '../src/runtime/mimi-agent.js';
import { MimiHost } from '../src/runtime/mimi-host.js';
import { TerminalRunInterruptedError } from '../src/runtime/run-outcome.js';
import type { AgentRunRequest } from '../src/runtime/run-service.js';

const fixtureSecret = ['sk', 'EphemeralFixtureNotARealCredential123'].join('-');
const fixtureSession = 'ephemeral-session';

function provenance(
  eventId: string,
  sessionId = fixtureSession,
  source = 'local-cli',
) {
  return {
    eventId,
    sessionId,
    profileId: 'owner',
    source,
    trust: 'owner',
  };
}

function fullOwnerScope(eventId: string, sessionId = fixtureSession) {
  return {
    runId: `run-${eventId}`,
    ownerId: `owner-${eventId}`,
    sessionId,
    profileId: 'owner',
    mode: 'general' as const,
    permissionMode: 'trusted' as const,
    securityProfile: 'full-owner' as const,
    ephemeralSensitiveModelAccess: true,
    cause: {
      eventId,
      profileId: 'owner',
      source: 'local-cli',
      trust: 'owner' as const,
    },
  };
}

test('regression: Full Owner current Run receives a provider-visible value while durable input stays redacted', () => {
  const broker = new EphemeralSecretBroker();
  const captured = broker.capture(provenance('event-visible'), `请校验 ${fixtureSecret} 的长度`);
  const lease = broker.take('event-visible', fixtureSession, captured.references);
  assert.ok(lease);

  assert.doesNotMatch(captured.sanitized, new RegExp(fixtureSecret));
  const access = activateEphemeralOwnerInput(lease, fullOwnerScope('event-visible'));
  assert.ok(access);
  const providerInstructions = ephemeralOwnerInputInstructions(access);

  const simulatedModelAnswer = providerInstructions.includes(fixtureSecret)
    ? `已在当前 Run 校验，长度为 ${fixtureSecret.length}`
    : '我只能看到 [REDACTED]，无法校验';
  assert.equal(simulatedModelAnswer, `已在当前 Run 校验，长度为 ${fixtureSecret.length}`);
  assert.match(providerInstructions, /模型 Provider/);
  assert.equal(
    redactActiveEphemeralText(`错误输出：${fixtureSecret}`, access),
    '错误输出：[REDACTED:ephemeral-secret]',
  );
});

test('ephemeral owner leases are one-shot, bounded by Session and TTL, and never persist raw prompt text', () => {
  let now = 1_000;
  const broker = new EphemeralSecretBroker(100, () => now);
  const captured = broker.capture(provenance('event-1'), `请用 ${fixtureSecret} 测试接口`);

  assert.doesNotMatch(captured.sanitized, new RegExp(fixtureSecret));
  assert.match(captured.sanitized, /REDACTED:credential/);
  assert.deepEqual(captured.references.map((item) => item.environmentVariable), [
    'MIMI_EPHEMERAL_SECRET_1',
  ]);
  assert.deepEqual(ephemeralSecretReferences({ transientInputRefs: captured.references }), captured.references);

  assert.equal(broker.take('event-1', 'another-session', captured.references), undefined);
  assert.equal(broker.take('event-1', fixtureSession, captured.references), undefined);

  const expiring = broker.capture(provenance('event-2'), fixtureSecret);
  assert.equal(
    new EphemeralSecretBroker().take('event-2', fixtureSession, expiring.references),
    undefined,
  );
  now += 101;
  assert.equal(broker.take('event-2', fixtureSession, expiring.references), undefined);
});

test('dispatcher binds a transient lease only to the direct owner conversation Run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ephemeral-dispatch-'));
  const database = path.join(root, 'mimi.db');
  const store = new MimiStore(database);
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const broker = new EphemeralSecretBroker();
  const eventId = 'ephemeral-event';
  const captured = broker.capture(provenance(eventId), `测试 ${fixtureSecret}`);
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
    sessionKey: fixtureSession,
  });
  assert.ok(routed.task);
  assert.doesNotMatch(JSON.stringify(store.getTask(routed.task.id)), new RegExp(fixtureSecret));
  assert.doesNotMatch(JSON.stringify(store.getImmutableEvent(eventId)), new RegExp(fixtureSecret));

  let request: AgentRunRequest | undefined;
  const agent = {
    currentSessionId: fixtureSession,
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
    takeEphemeralSecrets: (id, sessionId, references) => broker.take(id, sessionId, references),
  });
  try {
    assert.equal(await dispatcher.processTaskById(routed.task.id), true);
    assert.ok(request);
    assert.doesNotMatch(request.input, new RegExp(fixtureSecret));
    assert.equal(request.options?.ephemeralOwnerInput?.values[0], fixtureSecret);
    assert.equal(
      request.options?.ephemeralOwnerInput?.shellEnvironment.MIMI_EPHEMERAL_SECRET_1,
      fixtureSecret,
    );
    assert.equal(broker.take(eventId, fixtureSession, captured.references), undefined);
    assert.doesNotMatch(await readFile(database, 'utf8'), new RegExp(fixtureSecret));
  } finally {
    store.close();
  }
});

test('runtime sends the value only in Full Owner host context and fences tools, output, and Run end', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ephemeral-runtime-'));
  const dataRoot = path.join(root, '.mimi-agent');
  const eventId = 'runtime-sensitive-event';
  const broker = new EphemeralSecretBroker();
  const captured = broker.capture(provenance(eventId), `校验 ${fixtureSecret}`);
  const lease = broker.take(eventId, fixtureSession, captured.references);
  assert.ok(lease);
  const agent = await MimiAgent.create({
    provider: 'openai',
    workspaceRoot: root,
    dataRoot,
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    contextWindow: 128_000,
    maxTurns: 20,
    securityProfile: 'full-owner',
    permissionMode: 'trusted',
  }, fixtureSession);
  let runtimeAgent: {
    instructions: string;
    tools: Array<{
      name: string;
      invoke?: (context: RunContext<unknown>, input: string) => Promise<unknown>;
    }>;
  } | undefined;
  const runner = (agent as unknown as {
    runner: {
      run: (
        candidate: unknown,
        input?: unknown,
        options?: { session?: { addItems(items: unknown[]): Promise<void> } },
      ) => Promise<unknown>;
    };
  }).runner;
  runner.run = async (candidate, _input, options) => {
    runtimeAgent = candidate as typeof runtimeAgent;
    await options?.session?.addItems([{
      type: 'function_call',
      name: 'write_file',
      callId: 'sensitive-call',
      arguments: JSON.stringify({ path: 'never.txt', content: fixtureSecret }),
    }]);
    return {};
  };
  try {
    await agent.stream(captured.sanitized, undefined, {
      cause: {
        eventId,
        profileId: 'owner',
        source: 'local-cli',
        trust: 'owner',
      },
      ephemeralOwnerInput: lease,
      executionKey: `task:${eventId}`,
      retainExecutionLedger: true,
    });
    assert.ok(runtimeAgent);
    assert.match(runtimeAgent.instructions, new RegExp(fixtureSecret));
    const shell = runtimeAgent.tools.find((tool) => tool.name === 'run_shell');
    assert.ok(shell?.invoke);
    const shellResult = await shell.invoke(
      new RunContext({}),
      JSON.stringify({
        command: 'printf %s "$MIMI_EPHEMERAL_SECRET_1"',
        timeoutSeconds: 5,
      }),
    );
    assert.doesNotMatch(JSON.stringify(shellResult), new RegExp(fixtureSecret));
    assert.match(JSON.stringify(shellResult), /REDACTED:ephemeral-secret/);
    const rejectedShell = await shell.invoke(
      new RunContext({}),
      JSON.stringify({ command: `printf %s ${fixtureSecret}`, timeoutSeconds: 5 }),
    );
    assert.deepEqual(rejectedShell, {
      mimiStatus: 'tool_input_rejected',
      retryable: true,
      code: 'ephemeral_secret_in_tool_arguments',
      message: '工具未执行，临时敏感原值也未进入命令行或执行账本。请在当前 Run 直接重试，并在 Shell 命令中只引用 $MIMI_EPHEMERAL_SECRET_1；不要再次拼接原值。Owner 明确要求持久配置时，可由 Shell 使用该环境变量写入目标私有配置并保持 0600 权限。',
    });
    const retriedShell = await shell.invoke(
      new RunContext({}),
      JSON.stringify({
        command: 'printf %s "$MIMI_EPHEMERAL_SECRET_1"',
        timeoutSeconds: 5,
      }),
    );
    assert.doesNotMatch(JSON.stringify(retriedShell), new RegExp(fixtureSecret));
    assert.match(JSON.stringify(retriedShell), /REDACTED:ephemeral-secret/);
    const delegate = runtimeAgent.tools.find((tool) => tool.name === 'delegate_research');
    if (delegate?.invoke) {
      const rejectedDelegate = await delegate.invoke(
        new RunContext({}),
        JSON.stringify({ input: fixtureSecret }),
      );
      assert.match(JSON.stringify(rejectedDelegate), /tool_input_rejected/);
      assert.match(JSON.stringify(rejectedDelegate), /只能由主 Agent Shell/);
    }

    await agent.completeRun(`已校验 ${fixtureSecret}`);
    const checkpoint = await (agent as unknown as {
      session: {
        getCheckpoint(): Promise<{ answer?: string } | undefined>;
        getItems(): Promise<unknown[]>;
      };
    }).session.getCheckpoint();
    assert.doesNotMatch(checkpoint?.answer ?? '', new RegExp(fixtureSecret));
    assert.match(checkpoint?.answer ?? '', /REDACTED:ephemeral-secret/);
    const items = await (agent as unknown as {
      session: { getItems(): Promise<unknown[]> };
    }).session.getItems();
    assert.doesNotMatch(JSON.stringify(items), new RegExp(fixtureSecret));
    assert.match(JSON.stringify(items), /REDACTED:ephemeral-secret/);

    await assert.rejects(
      shell.invoke(
        new RunContext({}),
        JSON.stringify({
          command: 'test -z "$MIMI_EPHEMERAL_SECRET_1" && printf cleared',
          timeoutSeconds: 5,
        }),
      ),
      /Run 已失效/,
    );

    const cancelledEventId = 'runtime-sensitive-cancelled';
    const cancelledCaptured = broker.capture(
      provenance(cancelledEventId),
      `取消前校验 ${fixtureSecret}`,
    );
    const cancelledLease = broker.take(
      cancelledEventId,
      fixtureSession,
      cancelledCaptured.references,
    );
    assert.ok(cancelledLease);
    await agent.stream(cancelledCaptured.sanitized, undefined, {
      cause: {
        eventId: cancelledEventId,
        profileId: 'owner',
        source: 'local-cli',
        trust: 'owner',
      },
      ephemeralOwnerInput: cancelledLease,
      executionKey: `task:${cancelledEventId}`,
      retainExecutionLedger: true,
    });
    const cancelledShell = runtimeAgent?.tools.find((tool) => tool.name === 'run_shell');
    assert.ok(cancelledShell?.invoke);
    await agent.failRun(new TerminalRunInterruptedError(`cancel ${fixtureSecret}`), true);
    await assert.rejects(
      cancelledShell.invoke(
        new RunContext({}),
        JSON.stringify({ command: 'printf %s "$MIMI_EPHEMERAL_SECRET_1"' }),
      ),
      /Run 已失效/,
    );
    const persistentState = await Promise.all([
      path.join(dataRoot, 'sessions', `${fixtureSession}.json`),
      path.join(dataRoot, 'execution-ledger.json'),
      path.join(dataRoot, 'run-commit-journal.json'),
      path.join(dataRoot, 'traces', `${fixtureSession}.jsonl`),
    ].map((file) => readFile(file, 'utf8').catch(() => '')));
    assert.doesNotMatch(persistentState.join('\n'), new RegExp(fixtureSecret));
  } finally {
    await agent.close();
  }
});

test('Safe, Workstation, external sources, and another Session cannot elevate a lease', () => {
  const broker = new EphemeralSecretBroker();
  assert.throws(
    () => broker.capture(provenance('external', fixtureSession, 'webhook'), fixtureSecret),
    /认证直接 Owner/,
  );
  assert.throws(
    () => broker.capture({
      ...provenance('untrusted'),
      trust: 'external',
    }, fixtureSecret),
    /认证直接 Owner/,
  );

  const safeCaptured = broker.capture(provenance('safe'), fixtureSecret);
  const safeLease = broker.take('safe', fixtureSession, safeCaptured.references);
  assert.ok(safeLease);
  assert.equal(activateEphemeralOwnerInput(safeLease, {
    ...fullOwnerScope('safe'),
    securityProfile: 'safe',
    permissionMode: 'read-only',
    ephemeralSensitiveModelAccess: false,
  }), undefined);

  const workstationCaptured = broker.capture(provenance('workstation'), fixtureSecret);
  const workstationLease = broker.take('workstation', fixtureSession, workstationCaptured.references);
  assert.ok(workstationLease);
  assert.equal(activateEphemeralOwnerInput(workstationLease, {
    ...fullOwnerScope('workstation'),
    securityProfile: 'workstation',
    permissionMode: 'workspace',
    ephemeralSensitiveModelAccess: false,
  }), undefined);

  const externalRunCaptured = broker.capture(provenance('external-run'), fixtureSecret);
  const externalRunLease = broker.take(
    'external-run',
    fixtureSession,
    externalRunCaptured.references,
  );
  assert.ok(externalRunLease);
  assert.throws(
    () => activateEphemeralOwnerInput(externalRunLease, {
      ...fullOwnerScope('external-run'),
      cause: {
        eventId: 'external-run',
        profileId: 'owner',
        source: 'webhook',
        trust: 'external',
      },
    }),
    /provenance/,
  );

  const otherCaptured = broker.capture(provenance('other-session'), fixtureSecret);
  const otherLease = broker.take('other-session', fixtureSession, otherCaptured.references);
  assert.ok(otherLease);
  assert.throws(
    () => activateEphemeralOwnerInput(otherLease, fullOwnerScope('other-session', 'different-session')),
    /provenance/,
  );
});

test('direct Owner route normalization does not invalidate a consumed same-Session lease', () => {
  const broker = new EphemeralSecretBroker();
  const captured = broker.capture(provenance('normalized-route'), fixtureSecret);
  const lease = broker.take('normalized-route', fixtureSession, captured.references);
  assert.ok(lease);

  const access = activateEphemeralOwnerInput(lease, {
    ...fullOwnerScope('runtime-event'),
    profileId: 'normalized-owner-profile',
    cause: {
      eventId: 'runtime-event',
      profileId: 'normalized-owner-profile',
      source: 'runtime-http',
      trust: 'owner',
    },
  });
  assert.ok(access);
  assert.equal(access.sessionId, fixtureSession);
  assert.equal(access.values[0], fixtureSecret);
});

test('fingerprints and labeled values stay generic and concurrent Events remain isolated', () => {
  const broker = new EphemeralSecretBroker();
  const captured = broker.capture(provenance('fingerprint-event'), fixtureSecret);
  const expected = createHash('sha256').update(fixtureSecret).digest('hex').slice(0, 16);
  assert.equal(captured.references[0]?.fingerprint, `credential:sha256:${expected}`);
  assert.doesNotMatch(JSON.stringify(captured.references), new RegExp(fixtureSecret));

  const labeled = broker.capture(
    provenance('labeled-event'),
    'api_key="LabeledCredentialFixture123"',
  );
  const bearer = broker.capture(
    provenance('bearer-event'),
    'Bearer AuthorizationFixture123456',
  );
  assert.equal(
    broker.take('labeled-event', fixtureSession, labeled.references)?.values[0],
    'LabeledCredentialFixture123',
  );
  assert.equal(
    broker.take('bearer-event', fixtureSession, bearer.references)?.values[0],
    'AuthorizationFixture123456',
  );
});
