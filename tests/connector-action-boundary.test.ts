import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunContext, type Tool } from '@openai/agents';
import test from 'node:test';
import { ActionFailedSafeError } from '../src/core/action-intent.js';
import { ExecutionLedger } from '../src/core/execution-ledger.js';
import {
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
      { name: 'send', description: 'deliver owner mail', capability: 'mail.send', effect: 'write', routeOwner: 'mail' },
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
    capability('browser', [{
      name: 'page_text',
      description: 'read bounded visible page text',
      capability: 'browser.page.read',
      effect: 'read',
      routeOwner: 'browser',
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
  assert.equal(connectorCapabilitySnapshot(manager, { query: 'stale' }).total, 1);
  const businessWordMiss = connectorCapabilitySnapshot(manager, { query: 'multica' });
  assert.equal(businessWordMiss.total, 0);
  assert.equal(businessWordMiss.catalogTotal, 3);
  assert.equal(businessWordMiss.filterMatched, false);
  assert.ok(businessWordMiss.availableCapabilities.includes('browser.page.read'));
  const browserRead = connectorCapabilitySnapshot(manager, { capability: 'browser.page.read' });
  assert.equal(browserRead.total, 1);
  assert.equal(browserRead.connectors[0]?.routeOwner, 'browser');
  assert.equal(browserRead.connectors[0]?.actions[0]?.name, 'page_text');

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
    'invoke_capability',
  ]);
  assert.match(String(await invoke(tools, 'invoke_capability', {
    capability: 'message.send',
    action: 'send_message',
    target: 'owner',
    operationRef: 'mail:owner:message:invalid-json',
    payloadJson: '{',
  })), /有效 JSON/);
  assert.match(String(await invoke(tools, 'invoke_capability', {
    capability: 'message.send',
    action: 'send_message',
    target: 'owner',
    payloadJson: JSON.stringify({ mode: 'message' }),
  })), /缺少 operationRef/);
  const confirmed = await invoke(tools, 'invoke_capability', {
    capability: 'message.send',
    action: 'send_message',
    target: 'owner',
    operationRef: 'mail:owner:message:confirmed',
    payloadJson: JSON.stringify({ mode: 'message' }),
  }) as Record<string, unknown>;
  assert.equal(confirmed.outcome, 'confirmed');
  assert.equal(confirmed.operationId, 'message-1');
  const requestReceipt = await invoke(tools, 'invoke_capability', {
    capability: 'message.send',
    action: 'send_message',
    target: 'owner',
    operationRef: 'mail:owner:message:request',
    payloadJson: JSON.stringify({ mode: 'request' }),
  }) as Record<string, unknown>;
  assert.equal(requestReceipt.operationId, 'request-1');
  const accepted = await invoke(tools, 'invoke_capability', {
    capability: 'message.send',
    action: 'send_message',
    target: 'owner',
    operationRef: 'mail:owner:message:accepted',
    payloadJson: JSON.stringify({ mode: 'plain' }),
  }) as Record<string, unknown>;
  assert.equal(accepted.outcome, 'accepted');
  assert.equal(accepted.evidence, 'plain-result');
  const large = await invoke(tools, 'invoke_capability', {
    capability: 'message.send',
    action: 'send_message',
    target: 'owner',
    operationRef: 'mail:owner:message:large',
    payloadJson: JSON.stringify({ mode: 'large' }),
  }) as Record<string, unknown>;
  assert.equal(large.truncated, true);
  assert.ok(Number(large.originalBytes) > 32_000);
  assert.equal(requests.length, 4);
  assert.equal(observed.length, 4);
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

  const receipt = await invoke(createConnectorHostTools(manager), 'invoke_capability', {
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
    const selected = wrapped.find((tool) => tool.name === 'invoke_capability');
    assert.ok(selected && 'invoke' in selected);
    return selected.invoke(new RunContext({}), JSON.stringify({
      capability: 'fixture.write',
      action: 'mutate',
      target: 'fixture:1',
      operationRef: 'fixture:test:1:mutate',
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

test('stable Connector operationRef freezes an uncertain business action across temporary targets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connector-operation-ref-'));
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
  const selected = wrapped.find((tool) => tool.name === 'invoke_capability');
  assert.ok(selected && 'invoke' in selected);
  const invokeBrowser = (target: string, code: string, callId: string) => selected.invoke(
    new RunContext({}),
    JSON.stringify({
      capability: 'browser.page.execute',
      action: 'execute_javascript',
      target,
      operationRef: 'crane:test:inspection-period-switch-job:route',
      payloadJson: JSON.stringify({ code }),
    }),
    { toolCall: { callId } } as never,
  );

  const uncertain = await invokeBrowser('browser:first-session', 'submit()', 'first') as {
    mimiStatus?: string;
    frozenTargetRef?: string;
  };
  assert.equal(uncertain.mimiStatus, 'action_uncertain');
  assert.equal(uncertain.frozenTargetRef, 'crane:test:inspection-period-switch-job:route');

  const reopened = await invokeBrowser('browser:new-session', 'submitAgain()', 'second') as {
    mimiStatus?: string;
    frozenTargetRef?: string;
  };
  assert.equal(reopened.mimiStatus, 'action_uncertain');
  assert.equal(reopened.frozenTargetRef, 'crane:test:inspection-period-switch-job:route');
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
