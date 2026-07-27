import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createConnectorCapabilityRuntimeTool,
  type ConnectorCapabilitySnapshot,
} from '../src/daemon/connector-action-tool.js';
import { BASE_INSTRUCTIONS } from '../src/runtime/instructions.js';

function snapshot(connectors: ConnectorCapabilitySnapshot['connectors']): ConnectorCapabilitySnapshot {
  return {
    configFile: '/tmp/connectors.json',
    total: connectors.length,
    enabled: connectors.filter((connector) => connector.enabled).length,
    online: connectors.filter((connector) => connector.online).length,
    inboundReady: connectors.filter((connector) => connector.readiness.inbound === 'ready').length,
    outboundReady: connectors.filter((connector) => connector.readiness.outbound === 'ready').length,
    stale: 0,
    actions: connectors.reduce((total, connector) => total + connector.actions.length, 0),
    truncated: false,
    connectors,
  };
}

async function invoke(tool: { invoke: Function }, input: unknown): Promise<unknown> {
  return tool.invoke(undefined, JSON.stringify(input));
}

test('an unknown exact Connector ID is not reported as offline', async () => {
  const tool = createConnectorCapabilityRuntimeTool(async () => snapshot([])) as {
    invoke: Function;
  };
  const result = await invoke(tool, { connector: 'daxiang' });
  assert.match(JSON.stringify(result), /不是 Connector 离线证据/);
  assert.match(JSON.stringify(result), /query/);
  assert.match(JSON.stringify(result), /不得据此自动降级/);
});

test('personal messaging instructions prefer the registered Connector over CUA', () => {
  assert.match(BASE_INSTRUCTIONS, /personal-\* Connector/);
  assert.match(BASE_INSTRUCTIONS, /未命中不代表离线/);
  assert.match(BASE_INSTRUCTIONS, /不得自动改用 Computer\/CUA/);
});
