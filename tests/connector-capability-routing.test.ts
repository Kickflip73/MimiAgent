import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  connectorEffectiveCapabilityItems,
  createConnectorCapabilityRuntimeTool,
  type ConnectorCapabilitySnapshot,
} from '../src/daemon/connector-action-tool.js';
import type { ConnectorManager } from '../src/daemon/connectors.js';
import { estimateTokens } from '../src/core/context.js';
import { BASE_INSTRUCTIONS } from '../src/runtime/instructions.js';
import {
  createEffectiveCapabilitySnapshot,
  renderEffectiveCapabilitySnapshot,
} from '../src/runtime/pipeline/capability-resolver.js';

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

test('model instructions drive verified business outcomes through discoverable capabilities', () => {
  assert.match(BASE_INSTRUCTIONS, /经过验证的结果/);
  assert.match(BASE_INSTRUCTIONS, /高层业务工具/);
  assert.match(BASE_INSTRUCTIONS, /只提供业务参数/);
  assert.match(BASE_INSTRUCTIONS, /inspect_runtime_capabilities/);
  assert.match(BASE_INSTRUCTIONS, /invoke_runtime_capability/);
  assert.match(BASE_INSTRUCTIONS, /不猜工具名、内部字段、action 或替代路线/);
  assert.doesNotMatch(BASE_INSTRUCTIONS, /operationRef/);
  assert.doesNotMatch(BASE_INSTRUCTIONS, /observationId|candidateToken|routeOwner/);
  assert.doesNotMatch(BASE_INSTRUCTIONS, /探活|health_check/);
  assert.doesNotMatch(BASE_INSTRUCTIONS, /PersonalMessageHub/);
  assert.match(BASE_INSTRUCTIONS, /深度测评.*相关源码、测试、架构文档和当前 Git\/运行状态/);
  assert.match(BASE_INSTRUCTIONS, /不重叠集合/);
  assert.match(BASE_INSTRUCTIONS, /源码验证、测试结果、已安装版本与真实运行证据/);
  assert.match(BASE_INSTRUCTIONS, /Shell 沙箱边界.*不等于 SIP/);
  assert.match(BASE_INSTRUCTIONS, /只读诊断能力/);
  assert.match(BASE_INSTRUCTIONS, /结果 uncertain 时先做只读核对/);
  assert.match(BASE_INSTRUCTIONS, /不跨 Connector、Browser、Computer、Shell 或其他路径重复同一业务动作/);
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

test('initial capability summary exposes groups and counts without action descriptions', () => {
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

  const item = connectorEffectiveCapabilityItems(manager)[0];
  assert.deepEqual(item?.capabilities, ['personal-message.context.read']);
  assert.equal(item?.actionCount, 1);
  assert.equal(item?.operations, undefined);
  assert.doesNotMatch(JSON.stringify(item), /先使用 list_targets/);
});

test('17-Connector initial summary stays below 1K tokens and hides disabled action descriptions', () => {
  const manager = {
    listCapabilities: () => Array.from({ length: 17 }, (_, connectorIndex) => ({
      id: `connector-${connectorIndex}`,
      enabled: connectorIndex !== 16,
      online: connectorIndex !== 16,
      readiness: {
        inbound: connectorIndex !== 16 ? 'ready' : 'unavailable',
        outbound: connectorIndex !== 16 ? 'ready' : 'unavailable',
        coverage: 'bounded',
      },
      actions: Array.from({ length: 7 }, (_, actionIndex) => ({
        name: `action-${actionIndex}`,
        description: connectorIndex === 16
          ? `DISABLED_ACTION_DESCRIPTION_${actionIndex}`
          : `available action ${actionIndex}`,
        capability: `group-${actionIndex % 2}.read`,
        effect: 'read',
        routeOwner: `connector-${connectorIndex}`,
      })),
    })),
  } as ConnectorManager;
  const items = connectorEffectiveCapabilityItems(manager);
  const rendered = renderEffectiveCapabilitySnapshot(createEffectiveCapabilitySnapshot({
    runId: 'summary-run',
    policyRevision: 'owner',
    toolNames: ['inspect_mimi_capabilities', 'invoke_capability'],
    items,
  }));
  assert.ok(estimateTokens(rendered) <= 1_000);
  assert.doesNotMatch(rendered, /available action|DISABLED_ACTION_DESCRIPTION/);
  assert.equal(items.at(-1)?.actionCount, 0);
});
