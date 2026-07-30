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
  assert.match(JSON.stringify(result), /未注册/);
  assert.doesNotMatch(JSON.stringify(result), /routeOwner|自动降级/);
});

test('model instructions contain business usage rather than host safety workflows', () => {
  assert.match(BASE_INSTRUCTIONS, /高层业务工具/);
  assert.match(BASE_INSTRUCTIONS, /只提供业务参数/);
  assert.match(BASE_INSTRUCTIONS, /send_owner_message/);
  assert.doesNotMatch(BASE_INSTRUCTIONS, /operationRef/);
  assert.doesNotMatch(BASE_INSTRUCTIONS, /observationId|candidateToken|routeOwner/);
  assert.doesNotMatch(BASE_INSTRUCTIONS, /uncertain 禁止|禁止.*重放|副作用账本/);
  assert.doesNotMatch(BASE_INSTRUCTIONS, /探活|health_check/);
  assert.doesNotMatch(BASE_INSTRUCTIONS, /PersonalMessageHub/);
  assert.match(BASE_INSTRUCTIONS, /深度测评.*先读取相关源代码、测试、架构文档/);
  assert.match(BASE_INSTRUCTIONS, /不重叠文件集合/);
  assert.match(BASE_INSTRUCTIONS, /源码验证、测试结果、已安装版本和真实运行证据/);
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

test('effective capability operations carry bounded Connector-declared invocation usage', () => {
  const manager = {
    listCapabilities: () => [{
      id: 'messages',
      enabled: true,
      online: true,
      readiness: { inbound: 'ready', outbound: 'ready' },
      actions: [{
        name: 'get_context',
        description: '先使用 list_targets，再把返回的稳定 target 传入；payload 限制为有界条数',
        capability: 'personal-message.context.read',
        effect: 'read',
        routeOwner: 'messages',
      }],
    }],
  } as ConnectorManager;

  assert.deepEqual(connectorEffectiveCapabilityItems(manager)[0]?.operations, [{
    capability: 'personal-message.context.read',
    action: 'get_context',
    effect: 'read',
    usage: '先使用 list_targets，再把返回的稳定 target 传入；payload 限制为有界条数',
  }]);
});
