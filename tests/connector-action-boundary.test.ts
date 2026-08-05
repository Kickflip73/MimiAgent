import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunContext, type Tool } from '@openai/agents';
import test from 'node:test';
import { ActionFailedSafeError } from '../src/core/action-intent.js';
import { ExecutionLedger } from '../src/core/execution-ledger.js';
import {
  connectorCapabilityRevision,
  connectorCapabilitySnapshot,
  createConnectorHostTools,
  createConnectorTaskHostTools,
  type ConnectorCapabilitySnapshot,
  type ConnectorTaskRuntime,
} from '../src/daemon/connector-action-tool.js';
import type {
  ConnectorActionRequest,
  ConnectorCapability,
  ConnectorCapabilityRequest,
  ConnectorManager,
} from '../src/daemon/connectors.js';
import { withExecutionLedger } from '../src/runtime/tool-ledger.js';

async function invoke(tools: Tool[], name: string, input: unknown): Promise<unknown> {
  const selected = tools.find((candidate) => candidate.name === name);
  assert.ok(selected && 'invoke' in selected && typeof selected.invoke === 'function', `missing ${name}`);
  return selected.invoke(new RunContext({}), JSON.stringify(input));
}

function capability(
  id: string,
  actions: Array<{
    name: string;
    description: string;
    capability: string;
    effect: 'read' | 'write' | 'unknown';
    routeOwner: string;
    modelVisible?: boolean;
    targetExample?: string;
    payloadExampleJson?: string;
  }> = [{
    name: 'send_message',
    description: 'send a message',
    capability: 'message.send',
    effect: 'write',
    routeOwner: id,
  }],
): ConnectorCapability {
  return {
    id,
    enabled: true,
    online: true,
    readiness: {
      inbound: 'ready',
      outbound: 'ready',
      deliveryConfirmed: true,
      reportedAt: '2026-07-27T00:00:00.000Z',
      freshUntil: '2026-07-27T01:00:00.000Z',
    },
    source: `fixture:${id}`,
    trust: 'owner',
    claimedComputerApps: [],
    actions,
  };
}

test('capability snapshot filters exact ids and actions while bounding the catalog', () => {
  const capabilities = [
    capability('mail', [
      { name: 'list', description: 'list inbox', capability: 'mail.list.read', effect: 'read', routeOwner: 'mail' },
      {
        name: 'send',
        description: 'deliver owner mail',
        capability: 'mail.send',
        effect: 'write',
        routeOwner: 'mail',
        targetExample: 'owner@example.com',
        payloadExampleJson: '{"subject":"hello"}',
      },
    ]),
    {
      ...capability('stale', [{
        name: 'inspect',
        description: 'inspect stale channel',
        capability: 'channel.inspect',
        effect: 'read',
        routeOwner: 'stale',
      }]),
      readiness: { inbound: 'ready' as const, outbound: 'ready' as const, stale: true },
    },
    capability('documents', [{
      name: 'render',
      description: 'render a document',
      capability: 'documents.render',
      effect: 'read',
      routeOwner: 'documents',
    }]),
  ];
  const manager = {
    configPath: '/fixture/connectors.json',
    listCapabilities: () => capabilities,
  } as ConnectorManager;
  const all = connectorCapabilitySnapshot(manager);
  assert.equal(all.total, 3);
  assert.equal(all.enabled, 3);
  assert.equal(all.online, 3);
  assert.equal(all.inboundReady, 2);
  assert.equal(all.outboundReady, 2);
  assert.equal(all.stale, 1);
  assert.equal(all.actions, 4);
  assert.equal(all.truncated, false);
  assert.deepEqual(connectorCapabilitySnapshot(manager, { connector: 'mail' }).connectors.map((item) => item.id), ['mail']);
  const actionMatch = connectorCapabilitySnapshot(manager, { query: 'deliver' });
  assert.equal(actionMatch.total, 1);
  assert.deepEqual(actionMatch.connectors[0]?.actions.map((action) => action.name), ['send']);
  assert.equal(actionMatch.connectors[0]?.actions[0]?.targetExample, 'owner@example.com');
  assert.equal(actionMatch.connectors[0]?.actions[0]?.payloadExampleJson, '{"subject":"hello"}');
  assert.equal(connectorCapabilitySnapshot(manager, { query: 'stale' }).total, 1);
  const businessWordMiss = connectorCapabilitySnapshot(manager, { query: 'multica' });
  assert.equal(businessWordMiss.total, 0);
  assert.equal(businessWordMiss.catalogTotal, 3);
  assert.equal(businessWordMiss.filterMatched, false);
  assert.ok(businessWordMiss.availableCapabilities.includes('documents.render'));
  const documentRender = connectorCapabilitySnapshot(manager, { capability: 'documents.render' });
  assert.equal(documentRender.total, 1);
  assert.equal(documentRender.connectors[0]?.routeOwner, 'documents');
  assert.equal(documentRender.connectors[0]?.actions[0]?.name, 'render');

  const many = Array.from({ length: 51 }, (_, index) => capability(
    `connector-${index}`,
    Array.from({ length: index === 0 ? 101 : 1 }, (__, actionIndex) => ({
      name: `action-${actionIndex}`,
      description: actionIndex === 0 ? 'x'.repeat(400) : 'bounded',
      capability: `fixture.action-${actionIndex}`,
      effect: 'unknown' as const,
      routeOwner: `connector-${index}`,
    })),
  ));
  const bounded = connectorCapabilitySnapshot({
    configPath: '/fixture/many.json',
    listCapabilities: () => many,
  } as ConnectorManager);
  assert.equal(bounded.connectors.length, 50);
  assert.equal(bounded.connectors.reduce((total, item) => total + item.actions.length, 0), 100);
  assert.equal(bounded.connectors[0]?.actions[0]?.description.length, 300);
  assert.equal(bounded.truncated, true);
});

test('Connector catalog revision ignores probe timestamps but tracks semantic readiness and actions', () => {
  const item = capability('mail');
  const manager = {
    configPath: '/fixture/connectors.json',
    listCapabilities: () => [item],
  } as ConnectorManager;
  const initial = connectorCapabilityRevision(manager);
  item.readiness.reportedAt = '2026-08-02T00:01:00.000Z';
  assert.equal(connectorCapabilityRevision(manager), initial);
  item.readiness.outbound = 'unavailable';
  const unavailable = connectorCapabilityRevision(manager);
  assert.notEqual(unavailable, initial);
  item.actions[0]!.description = 'updated bounded action';
  assert.notEqual(connectorCapabilityRevision(manager), unavailable);
});

test('model Connector catalog hides Browser, Computer fallback, and personal-message backends', () => {
  const manager = {
    configPath: '/fixture/connectors.json',
    listCapabilities: () => [
      capability('browser'),
      capability('desktop'),
      capability('personal-qq'),
      capability('macos-shortcuts'),
    ],
  } as ConnectorManager;
  const snapshot = connectorCapabilitySnapshot(manager);
  assert.deepEqual(snapshot.connectors.map((connector) => connector.id), ['macos-shortcuts']);
  assert.equal(snapshot.catalogTotal, 1);
});

test('model-facing host tools expose only inspect and capability invocation with bounded receipts', async () => {
  const capabilities = [capability('mail')];
  const requests: ConnectorActionRequest[] = [];
  const manager = {
    configPath: '/fixture/connectors.json',
    listCapabilities: () => capabilities,
    executeCapability: async (input: ConnectorCapabilityRequest) => {
      const request = { ...input, connector: 'mail' };
      requests.push(request);
      const result = (request.payload as { mode?: string }).mode === 'message'
        ? { messageId: 'message-1' }
        : (request.payload as { mode?: string }).mode === 'request'
          ? { requestId: 'request-1' }
          : (request.payload as { mode?: string }).mode === 'large'
            ? { data: 'x'.repeat(40_000) }
            : 'plain-result';
      return { connector: 'mail', effect: 'write' as const, result };
    },
  } as unknown as ConnectorManager;
  const observed: Array<{ request: ConnectorActionRequest; outcome: string }> = [];
  const tools = createConnectorHostTools(manager, (request, receipt) => {
    observed.push({ request, outcome: receipt.outcome });
  });
  const snapshot = await invoke(tools, 'inspect_mimi_capabilities', { connector: 'mail' }) as ConnectorCapabilitySnapshot;
  assert.equal(snapshot.total, 1);
  assert.match(String(await invoke(tools, 'inspect_mimi_capabilities', { connector: 'missing' })), /未注册/);
  assert.deepEqual(tools.map((item) => item.name), [
    'inspect_mimi_capabilities',
    'connector_capability',
  ]);
  assert.match(String(await invoke(tools, 'connector_capability', {
    capability: 'message.send',
    action: 'send_message',
    target: 'owner',
    payloadJson: '{',
  })), /有效 JSON/);
  const confirmed = await invoke(tools, 'connector_capability', {
    capability: 'message.send',
    action: 'send_message',
    target: 'owner',
    payloadJson: JSON.stringify({ mode: 'message' }),
  }) as Record<string, unknown>;
  assert.equal(confirmed.outcome, 'confirmed');
  assert.equal(confirmed.operationId, 'message-1');
  const requestReceipt = await invoke(tools, 'connector_capability', {
    capability: 'message.send',
    action: 'send_message',
    target: 'owner',
    payloadJson: JSON.stringify({ mode: 'request' }),
  }) as Record<string, unknown>;
  assert.equal(requestReceipt.operationId, 'request-1');
  const accepted = await invoke(tools, 'connector_capability', {
    capability: 'message.send',
    action: 'send_message',
    target: 'owner',
    payloadJson: JSON.stringify({ mode: 'plain' }),
  }) as Record<string, unknown>;
  assert.equal(accepted.outcome, 'accepted');
  assert.equal(accepted.evidence, 'plain-result');
  const large = await invoke(tools, 'connector_capability', {
    capability: 'message.send',
    action: 'send_message',
    target: 'owner',
    payloadJson: JSON.stringify({ mode: 'large' }),
  }) as Record<string, unknown>;
  assert.equal(large.truncated, true);
  assert.ok(Number(large.originalBytes) > 32_000);
  assert.equal(requests.length, 4);
  assert.equal(observed.length, 4);
});

test('internal Connector actions stay out of the model catalog and owner messaging has business-only inputs', async () => {
  const capabilities = [capability('personal-qq', [
    {
      name: 'get_context',
      description: 'read context',
      capability: 'personal-message.context.read',
      effect: 'read',
      routeOwner: 'personal-qq',
    },
    {
      name: 'send_to_owner',
      description: 'host internal owner send',
      capability: 'personal-message.owner.send',
      effect: 'write',
      routeOwner: 'personal-qq',
      modelVisible: false,
    },
  ])];
  const requests: ConnectorActionRequest[] = [];
  const manager = {
    configPath: '/fixture/connectors.json',
    listCapabilities: () => capabilities,
    executePersonalMessageAction: async (request: ConnectorActionRequest) => {
      requests.push(request);
      return {
        status: 'observed',
        messageId: 'chat-message-1',
        deliveryConfirmed: false,
      };
    },
  } as unknown as ConnectorManager;

  const tools = createConnectorHostTools(manager, undefined, { allowOwnerMessage: true });
  const catalog = await invoke(tools, 'inspect_mimi_capabilities', {}) as ConnectorCapabilitySnapshot;
  assert.deepEqual(catalog.availableCapabilities, []);
  assert.deepEqual(catalog.connectors, []);
  assert.deepEqual(tools.map((item) => item.name), [
    'inspect_mimi_capabilities',
    'connector_capability',
    'send_owner_message',
  ]);
  const disabledTools = createConnectorHostTools({
    ...manager,
    listCapabilities: () => [{ ...capabilities[0]!, enabled: false }],
  } as unknown as ConnectorManager, undefined, { allowOwnerMessage: true });
  assert.equal(disabledTools.some((item) => item.name === 'send_owner_message'), false);

  const receipt = await invoke(tools, 'send_owner_message', {
    channel: 'qq',
    text: 'owner visible text',
  }) as Record<string, unknown>;
  assert.equal(receipt.outcome, 'confirmed');
  assert.equal(receipt.operationId, 'chat-message-1');
  assert.deepEqual(requests, [{
    connector: 'personal-qq',
    action: 'send_to_owner',
    target: 'owner',
    payload: { text: 'owner visible text' },
  }]);
});

test('owner messaging preserves failed-safe and uncertain Connector outcomes', async () => {
  const result = { current: 'failed' };
  const manager = {
    configPath: '/fixture/connectors.json',
    listCapabilities: () => [capability('personal-qq', [{
      name: 'send_to_owner',
      description: 'host internal owner send',
      capability: 'personal-message.owner.send',
      effect: 'write',
      routeOwner: 'personal-qq',
      modelVisible: false,
    }])],
    executePersonalMessageAction: async () => result.current === 'failed'
      ? { status: 'failed', error: 'rejected before dispatch' }
      : { status: 'uncertain', error: 'connection ended after dispatch' },
  } as unknown as ConnectorManager;
  const tools = createConnectorHostTools(manager, undefined, { allowOwnerMessage: true });

  const failedRaw = await invoke(tools, 'send_owner_message', {
    channel: 'qq',
    text: 'first',
  });
  const failed = JSON.parse(String(failedRaw)) as Record<string, unknown>;
  assert.equal(failed.mimiStatus, 'action_failed_safe');
  result.current = 'uncertain';
  const uncertainRaw = await invoke(tools, 'send_owner_message', {
    channel: 'qq',
    text: 'second',
  });
  const uncertain = JSON.parse(String(uncertainRaw)) as Record<string, unknown>;
  assert.equal(uncertain.mimiStatus, 'action_uncertain');
  assert.equal(uncertain.retryable, false);
});

test('read capability receipts are confirmed from the declared effect', async () => {
  const capabilities = [capability('mail', [{
    name: 'list',
    description: 'list inbox',
    capability: 'mail.list.read',
    effect: 'read',
    routeOwner: 'mail',
  }])];
  const manager = {
    configPath: '/fixture/connectors.json',
    listCapabilities: () => capabilities,
    executeCapability: async () => ({
      connector: 'mail',
      effect: 'read' as const,
      result: { messages: ['bounded'] },
    }),
  } as unknown as ConnectorManager;

  const receipt = await invoke(createConnectorHostTools(manager), 'connector_capability', {
    capability: 'mail.list.read',
    action: 'list',
    target: 'owner',
    payloadJson: '{}',
  }) as Record<string, unknown>;

  assert.equal(receipt.effect, 'read');
  assert.equal(receipt.outcome, 'confirmed');
  assert.deepEqual(receipt.messages, ['bounded']);
});

test('explicit Connector rejection remains failed_safe across the SDK tool boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connector-failed-safe-'));
  let executions = 0;
  const manager = {
    configPath: '/fixture/connectors.json',
    listCapabilities: () => [capability('fixture', [{
      name: 'mutate',
      description: 'mutate fixture',
      capability: 'fixture.write',
      effect: 'write',
      routeOwner: 'fixture',
    }])],
    executeCapability: async (request: ConnectorCapabilityRequest) => {
      executions += 1;
      if ((request.payload as { valid?: boolean }).valid !== true) {
        throw new ActionFailedSafeError('payload rejected before execution');
      }
      return {
        connector: 'fixture',
        effect: 'write' as const,
        result: { outcome: 'confirmed', operationId: 'confirmed-operation' },
      };
    },
  } as unknown as ConnectorManager;
  const wrapped = withExecutionLedger(
    createConnectorHostTools(manager),
    new ExecutionLedger(path.join(root, 'ledger.json')),
    () => ({
      sessionId: 'owner',
      runId: 'event:connector-failed-safe',
      semanticCallIds: true,
      guardedActionContext: {
        ownerAuthenticated: true,
        exactTarget: true,
        lowRisk: false,
        reversible: false,
      },
    }),
  );
  const invokeWrapped = (payloadJson: string, callId: string) => {
    const selected = wrapped.find((tool) => tool.name === 'connector_capability');
    assert.ok(selected && 'invoke' in selected);
    return selected.invoke(new RunContext({}), JSON.stringify({
      capability: 'fixture.write',
      action: 'mutate',
      target: 'fixture:1',
      payloadJson,
    }), { toolCall: { callId } } as never);
  };

  const rejected = await invokeWrapped('{"valid":false}', 'rejected') as {
    error?: string;
    mimiActionIntent?: { outcome?: string };
  };
  assert.equal(rejected.error, 'payload rejected before execution');
  assert.equal(rejected.mimiActionIntent?.outcome, 'failed_safe');

  const corrected = await invokeWrapped('{"valid":true}', 'corrected') as {
    outcome?: string;
    mimiActionIntent?: { outcome?: string };
  };
  assert.equal(corrected.outcome, 'confirmed');
  assert.equal(corrected.mimiActionIntent?.outcome, 'confirmed');
  assert.equal(executions, 2);
});

test('host ledger freezes an exact uncertain Connector retry without model operationRef', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connector-host-intent-'));
  let executions = 0;
  const manager = {
    configPath: '/fixture/connectors.json',
    listCapabilities: () => [capability('browser', [{
      name: 'execute_javascript',
      description: 'execute page script',
      capability: 'browser.page.execute',
      effect: 'write',
      routeOwner: 'browser',
    }])],
    executeCapability: async () => {
      executions += 1;
      throw new Error('browser connection ended after dispatch');
    },
  } as unknown as ConnectorManager;
  const wrapped = withExecutionLedger(
    createConnectorHostTools(manager),
    new ExecutionLedger(path.join(root, 'ledger.json')),
    () => ({
      sessionId: 'owner',
      runId: 'event:browser-route-change',
      semanticCallIds: true,
      guardedActionContext: {
        ownerAuthenticated: true,
        exactTarget: true,
        lowRisk: false,
        reversible: false,
      },
    }),
  );
  const selected = wrapped.find((tool) => tool.name === 'connector_capability');
  assert.ok(selected && 'invoke' in selected);
  const invokeBrowser = (target: string, code: string, callId: string) => selected.invoke(
    new RunContext({}),
    JSON.stringify({
      capability: 'browser.page.execute',
      action: 'execute_javascript',
      target,
      payloadJson: JSON.stringify({ code }),
    }),
    { toolCall: { callId } } as never,
  );

  const uncertain = await invokeBrowser('browser:first-session', 'submit()', 'first') as {
    mimiStatus?: string;
    frozenTargetRef?: string;
  };
  assert.equal(uncertain.mimiStatus, 'action_uncertain');
  assert.equal(uncertain.frozenTargetRef, 'browser:first-session');

  const replay = await invokeBrowser('browser:first-session', 'submit()', 'second') as {
    mimiStatus?: string;
    frozenTargetRef?: string;
  };
  assert.equal(replay.mimiStatus, 'action_uncertain');
  assert.equal(replay.frozenTargetRef, 'browser:first-session');
  assert.equal(executions, 1);
});

test('task connector tools proxy only inspect and action with the exact signal and payload', async () => {
  const calls: Array<{ kind: string; value: unknown; aborted?: boolean }> = [];
  const snapshot: ConnectorCapabilitySnapshot = {
    configFile: '/fixture/connectors.json',
    catalogTotal: 1,
    catalogActions: 1,
    total: 1,
    enabled: 1,
    online: 1,
    inboundReady: 1,
    outboundReady: 1,
    stale: 0,
    actions: 1,
    filterMatched: true,
    availableCapabilities: ['mail.inspect'],
    truncated: false,
    connectors: [{
      id: 'mail',
      enabled: true,
      online: true,
      readiness: { inbound: 'ready', outbound: 'ready' },
      source: 'fixture:mail',
      routeOwner: 'mail',
      claimedComputerApps: [],
      actions: [{
        name: 'inspect',
        description: 'inspect',
        capability: 'mail.inspect',
        effect: 'read',
        routeOwner: 'mail',
      }],
    }],
  };
  const runtime: ConnectorTaskRuntime = {
    inspectCapabilities: async (filter, signal) => {
      calls.push({ kind: 'inspect', value: filter, aborted: signal?.aborted });
      return snapshot;
    },
    executeAction: async (request, signal) => {
      calls.push({ kind: 'action', value: request, aborted: signal?.aborted });
      return { outcome: 'accepted', operationId: 'operation-1' };
    },
  };
  const tools = createConnectorTaskHostTools(runtime);
  assert.deepEqual(tools.map((tool) => tool.name), ['inspect_mimi_capabilities', 'connector_action']);
  assert.equal((await invoke(tools, 'inspect_mimi_capabilities', { query: 'mail' }) as ConnectorCapabilitySnapshot).total, 1);
  const receipt = await invoke(tools, 'connector_action', {
    connector: 'mail',
    action: 'inspect',
    target: 'owner',
    payloadJson: '{}',
  }) as Record<string, unknown>;
  assert.equal(receipt.outcome, 'accepted');
  assert.equal(receipt.operationId, 'operation-1');
  assert.deepEqual(calls.map((call) => call.kind), ['inspect', 'action']);
});
