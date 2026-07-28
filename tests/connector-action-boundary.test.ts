import assert from 'node:assert/strict';
import { RunContext, type Tool } from '@openai/agents';
import test from 'node:test';
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
  ConnectorManager,
} from '../src/daemon/connectors.js';

async function invoke(tools: Tool[], name: string, input: unknown): Promise<unknown> {
  const selected = tools.find((candidate) => candidate.name === name);
  assert.ok(selected && 'invoke' in selected && typeof selected.invoke === 'function', `missing ${name}`);
  return selected.invoke(new RunContext({}), JSON.stringify(input));
}

function capability(
  id: string,
  actions: Array<{ name: string; description: string }> = [{ name: 'send_message', description: 'send a message' }],
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
    actions,
  };
}

test('capability snapshot filters exact ids and actions while bounding the catalog', () => {
  const capabilities = [
    capability('mail', [
      { name: 'list', description: 'list inbox' },
      { name: 'send', description: 'deliver owner mail' },
    ]),
    {
      ...capability('stale', [{ name: 'inspect', description: 'inspect stale channel' }]),
      readiness: { inbound: 'ready' as const, outbound: 'ready' as const, stale: true },
    },
  ];
  const manager = {
    configPath: '/fixture/connectors.json',
    listCapabilities: () => capabilities,
  } as ConnectorManager;
  const all = connectorCapabilitySnapshot(manager);
  assert.equal(all.total, 2);
  assert.equal(all.enabled, 2);
  assert.equal(all.online, 2);
  assert.equal(all.inboundReady, 1);
  assert.equal(all.outboundReady, 1);
  assert.equal(all.stale, 1);
  assert.equal(all.actions, 3);
  assert.equal(all.truncated, false);
  assert.deepEqual(connectorCapabilitySnapshot(manager, { connector: 'mail' }).connectors.map((item) => item.id), ['mail']);
  const actionMatch = connectorCapabilitySnapshot(manager, { query: 'deliver' });
  assert.equal(actionMatch.total, 1);
  assert.deepEqual(actionMatch.connectors[0]?.actions.map((action) => action.name), ['send']);
  assert.equal(connectorCapabilitySnapshot(manager, { query: 'stale' }).total, 1);

  const many = Array.from({ length: 51 }, (_, index) => capability(
    `connector-${index}`,
    Array.from({ length: index === 0 ? 101 : 1 }, (__, actionIndex) => ({
      name: `action-${actionIndex}`,
      description: actionIndex === 0 ? 'x'.repeat(400) : 'bounded',
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

test('host connector tools reload, toggle, inspect and return auditable bounded receipts', async () => {
  const capabilities = [capability('mail')];
  const requests: ConnectorActionRequest[] = [];
  let reloads = 0;
  const manager = {
    configPath: '/fixture/connectors.json',
    listCapabilities: () => capabilities,
    reload: async () => {
      reloads += 1;
      return capabilities;
    },
    setEnabled: async (connector: string, enabled: boolean) => ({ connector, enabled }),
    executeAction: async (request: ConnectorActionRequest) => {
      requests.push(request);
      if ((request.payload as { mode?: string }).mode === 'message') return { messageId: 'message-1' };
      if ((request.payload as { mode?: string }).mode === 'request') return { requestId: 'request-1' };
      if ((request.payload as { mode?: string }).mode === 'large') return { data: 'x'.repeat(40_000) };
      return 'plain-result';
    },
  } as unknown as ConnectorManager;
  const observed: Array<{ request: ConnectorActionRequest; outcome: string }> = [];
  const tools = createConnectorHostTools(manager, (request, receipt) => {
    observed.push({ request, outcome: receipt.outcome });
  });
  const snapshot = await invoke(tools, 'inspect_mimi_capabilities', { connector: 'mail' }) as ConnectorCapabilitySnapshot;
  assert.equal(snapshot.total, 1);
  assert.match(String(await invoke(tools, 'inspect_mimi_capabilities', { connector: 'missing' })), /未注册/);
  assert.deepEqual(await invoke(tools, 'set_mimi_connector_enabled', {
    connector: 'mail',
    enabled: false,
  }), { connector: 'mail', enabled: false });
  assert.equal((await invoke(tools, 'reload_mimi_connectors', {}) as ConnectorCapabilitySnapshot).total, 1);
  assert.equal(reloads, 1);
  assert.match(String(await invoke(tools, 'connector_action', {
    connector: 'mail',
    action: 'send_message',
    target: 'owner',
    payloadJson: '{',
  })), /有效 JSON/);
  const confirmed = await invoke(tools, 'connector_action', {
    connector: 'mail',
    action: 'send_message',
    target: 'owner',
    payloadJson: JSON.stringify({ mode: 'message' }),
  }) as Record<string, unknown>;
  assert.equal(confirmed.outcome, 'confirmed');
  assert.equal(confirmed.operationId, 'message-1');
  const requestReceipt = await invoke(tools, 'connector_action', {
    connector: 'mail',
    action: 'send_message',
    target: 'owner',
    payloadJson: JSON.stringify({ mode: 'request' }),
  }) as Record<string, unknown>;
  assert.equal(requestReceipt.operationId, 'request-1');
  const accepted = await invoke(tools, 'connector_action', {
    connector: 'mail',
    action: 'inspect',
    target: 'owner',
    payloadJson: JSON.stringify({ mode: 'plain' }),
  }) as Record<string, unknown>;
  assert.equal(accepted.outcome, 'accepted');
  assert.equal(accepted.evidence, 'plain-result');
  const large = await invoke(tools, 'connector_action', {
    connector: 'mail',
    action: 'inspect',
    target: 'owner',
    payloadJson: JSON.stringify({ mode: 'large' }),
  }) as Record<string, unknown>;
  assert.equal(large.truncated, true);
  assert.ok(Number(large.originalBytes) > 32_000);
  assert.equal(requests.length, 4);
  assert.equal(observed.length, 4);
});

test('task connector tools proxy only inspect and action with the exact signal and payload', async () => {
  const calls: Array<{ kind: string; value: unknown; aborted?: boolean }> = [];
  const snapshot: ConnectorCapabilitySnapshot = {
    configFile: '/fixture/connectors.json',
    total: 1,
    enabled: 1,
    online: 1,
    inboundReady: 1,
    outboundReady: 1,
    stale: 0,
    actions: 1,
    truncated: false,
    connectors: [{
      id: 'mail',
      enabled: true,
      online: true,
      readiness: { inbound: 'ready', outbound: 'ready' },
      source: 'fixture:mail',
      actions: [{ name: 'inspect', description: 'inspect' }],
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
