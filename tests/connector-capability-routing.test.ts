import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  connectorEffectiveCapabilityItems,
  createConnectorCapabilityRuntimeTool,
  type ConnectorCapabilitySnapshot,
} from '../src/daemon/connector-action-tool.js';
import type { ConnectorManager } from '../src/daemon/connectors.js';
import { BASE_INSTRUCTIONS } from '../src/runtime/instructions.js';

function snapshot(connectors: ConnectorCapabilitySnapshot['connectors']): ConnectorCapabilitySnapshot {
  return {
    configFile: '/tmp/connectors.json',
    catalogTotal: connectors.length,
    catalogActions: connectors.reduce((total, connector) => total + connector.actions.length, 0),
    total: connectors.length,
    enabled: connectors.filter((connector) => connector.enabled).length,
    online: connectors.filter((connector) => connector.online).length,
    inboundReady: connectors.filter((connector) => connector.readiness.inbound === 'ready').length,
    outboundReady: connectors.filter((connector) => connector.readiness.outbound === 'ready').length,
    stale: 0,
    actions: connectors.reduce((total, connector) => total + connector.actions.length, 0),
    filterMatched: connectors.length > 0,
    availableCapabilities: [...new Set(
      connectors.flatMap((connector) => connector.actions.map((action) => action.capability)),
    )],
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
  assert.match(JSON.stringify(result), /routeOwner/);
  assert.match(JSON.stringify(result), /不得据此自动降级/);
});

test('capability routing instructions use stable declarations instead of business wording', () => {
  assert.match(BASE_INSTRUCTIONS, /精确 capability\/action/);
  assert.match(BASE_INSTRUCTIONS, /直接调用 invoke_capability/);
  assert.match(BASE_INSTRUCTIONS, /不要.*启停或重载 Connector/);
  assert.match(BASE_INSTRUCTIONS, /uncertain 禁止重放/);
  assert.match(BASE_INSTRUCTIONS, /Connector 已声明并持有的资源只能走该 Connector/);
  assert.match(BASE_INSTRUCTIONS, /不得调用、建议或声称可改走 Browser、Computer\/CUA、MCP 或 Shell/);
  assert.match(BASE_INSTRUCTIONS, /CuaDriver.*绝不能通过 run_shell/);
  assert.match(BASE_INSTRUCTIONS, /个人消息的查看、读取或汇总只使用 effect=read/);
  assert.match(BASE_INSTRUCTIONS, /事件同步属于 effect=write/);
  assert.match(BASE_INSTRUCTIONS, /Shell 沙箱.*不是 SIP/);
  assert.match(BASE_INSTRUCTIONS, /只读诊断能力/);
  assert.doesNotMatch(BASE_INSTRUCTIONS, /大象|QQ|微信/);
});

test('effective capability items preserve Connector availability, readiness, freshness and coverage', () => {
  const manager = {
    listCapabilities: () => [
      {
        id: 'ready',
        enabled: true,
        online: true,
        readiness: {
          inbound: 'ready',
          outbound: 'ready',
          reportedAt: '2026-07-28T00:00:00.000Z',
          coverage: 'bounded',
        },
      },
      {
        id: 'stale',
        enabled: true,
        online: true,
        readiness: {
          inbound: 'unknown',
          outbound: 'unknown',
          reportedAt: '2026-07-27T00:00:00.000Z',
          stale: true,
        },
      },
      {
        id: 'disabled',
        enabled: false,
        online: false,
        readiness: { inbound: 'unknown', outbound: 'unknown' },
      },
    ],
  } as ConnectorManager;
  const items = connectorEffectiveCapabilityItems(manager);
  assert.deepEqual(items.map((item) => ({
    id: item.id,
    availability: item.availability,
    readiness: item.readiness,
    freshness: item.freshness,
    coverage: item.coverage,
  })), [
    {
      id: 'ready',
      availability: 'available',
      readiness: 'ready',
      freshness: 'fresh',
      coverage: 'bounded',
    },
    {
      id: 'stale',
      availability: 'degraded',
      readiness: 'unknown',
      freshness: 'stale',
      coverage: 'unknown',
    },
    {
      id: 'disabled',
      availability: 'unavailable',
      readiness: 'unavailable',
      freshness: 'unknown',
      coverage: 'unknown',
    },
  ]);
});
