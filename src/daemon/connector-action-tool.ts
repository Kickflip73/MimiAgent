import { tool, type Tool } from '@openai/agents';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  TOOL_ACTION_INTENT,
  type ToolActionIntentMetadata,
} from '../core/tool-metadata.js';
import { ActionFailedSafeError } from '../core/action-intent.js';
import type { EffectiveCapabilityItem } from '../runtime/pipeline/capability-resolver.js';
import { isUncertainDeliveryError, UncertainDeliveryError } from './notifier.js';
import type {
  ConnectorActionRequest,
  ConnectorCapabilityRequest,
  ConnectorManager,
} from './connectors.js';

const identifier = z.string().regex(/^[a-zA-Z0-9._-]+$/);
const MAX_CONNECTORS = 50;
const MAX_ACTIONS = 100;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_ACTION_RESULT_BYTES = 32_000;
const OWNER_MESSAGE_CHANNELS = ['daxiang', 'qq', 'wechat'] as const;
type OwnerMessageChannel = typeof OWNER_MESSAGE_CHANNELS[number];

function modelVisibleCapabilities(
  connectors: ConnectorManager,
): ReturnType<ConnectorManager['listCapabilities']> {
  return connectors.listCapabilities().map((connector) => ({
    ...connector,
    actions: (connector.actions ?? []).filter((action) => action.modelVisible !== false),
  }));
}

function ownerMessageChannels(connectors: ConnectorManager): OwnerMessageChannel[] {
  return connectors.listCapabilities().flatMap((connector) => {
    if (!connector.enabled || !connector.id.startsWith('personal-')) return [];
    const channel = connector.id.slice('personal-'.length);
    if (!OWNER_MESSAGE_CHANNELS.includes(channel as OwnerMessageChannel)) return [];
    const declared = connector.actions.some((action) => (
      action.name === 'send_to_owner'
      && action.capability === 'personal-message.owner.send'
      && action.effect === 'write'
      && action.modelVisible === false
    ));
    return declared ? [channel as OwnerMessageChannel] : [];
  });
}

export interface ConnectorCapabilitySnapshot {
  configFile: string;
  catalogTotal: number;
  catalogActions: number;
  total: number;
  enabled: number;
  online: number;
  inboundReady: number;
  outboundReady: number;
  stale: number;
  actions: number;
  filterMatched: boolean;
  availableCapabilities: string[];
  truncated: boolean;
  connectors: Array<{
    id: string;
    enabled: boolean;
    online: boolean;
    readiness: {
      inbound: 'ready' | 'unavailable' | 'unknown';
      outbound: 'ready' | 'unavailable' | 'unknown';
      deliveryConfirmed?: boolean;
      reportedAt?: string;
      freshUntil?: string;
      stale?: boolean;
      coverage?: 'complete' | 'bounded' | 'notification_only' | 'metadata_only' | 'unavailable';
      accountVerified?: boolean;
      backgroundSafe?: boolean;
      changesReadState?: boolean | 'unknown';
      stableConversationId?: boolean;
      stableMessageId?: boolean;
      contextRead?: 'stable' | 'bounded' | 'unavailable';
      lastObservedAt?: string;
      targetBound?: boolean;
      targetBindingStatus?: 'bound' | 'target_not_bound';
      reasonCode?: string;
    };
    source: string;
    routeOwner: string;
    claimedComputerApps: string[];
    actions: Array<{
      name: string;
      description: string;
      capability: string;
      effect: 'read' | 'write' | 'unknown';
      routeOwner: string;
    }>;
  }>;
}

export interface ConnectorCapabilityFilter {
  connector?: string;
  capability?: string;
  query?: string;
}

export function connectorEffectiveCapabilityItems(
  connectors: ConnectorManager,
): EffectiveCapabilityItem[] {
  return modelVisibleCapabilities(connectors).map((connector) => {
    const readiness = connector.readiness;
    const actions = connector.actions ?? [];
    const stale = readiness.stale === true;
    const anyReady = readiness.inbound === 'ready' || readiness.outbound === 'ready';
    const bothUnavailable = readiness.inbound === 'unavailable' && readiness.outbound === 'unavailable';
    const ready = connector.enabled && connector.online && !stale && anyReady;
    return {
      id: connector.id,
      kind: 'connector' as const,
      availability: ready
        ? 'available' as const
        : connector.enabled && connector.online ? 'degraded' as const : 'unavailable' as const,
      readiness: ready
        ? 'ready' as const
        : !connector.enabled || !connector.online || bothUnavailable
          ? 'unavailable' as const
          : 'unknown' as const,
      freshness: stale ? 'stale' as const : readiness.reportedAt ? 'fresh' as const : 'unknown' as const,
      coverage: readiness.coverage ?? (bothUnavailable ? 'unavailable' as const : 'unknown' as const),
      permissionSource: connector.enabled ? 'connector-manager:enabled' : 'connector-manager:disabled',
      selectedRoute: connector.id,
      routeOwner: connector.id,
      capabilities: [...new Set(actions.map((action) => action.capability))].sort(),
      operations: actions
        .map((action) => ({
          capability: action.capability,
          action: action.name,
          effect: action.effect,
          usage: action.description.slice(0, MAX_DESCRIPTION_CHARS),
        }))
        .sort((left, right) =>
          left.capability.localeCompare(right.capability)
          || left.action.localeCompare(right.action)),
      safeFallback: 'none' as const,
    };
  });
}

/** Minimum Connector control-plane surface available inside a Task worker. */
export interface ConnectorTaskRuntime {
  inspectCapabilities(
    filter: ConnectorCapabilityFilter,
    signal?: AbortSignal,
  ): ConnectorCapabilitySnapshot | Promise<ConnectorCapabilitySnapshot>;
  executeAction(request: ConnectorActionRequest, signal?: AbortSignal): Promise<unknown>;
}

type InspectCapabilities = ConnectorTaskRuntime['inspectCapabilities'];
type ExecuteConnectorAction = ConnectorTaskRuntime['executeAction'];
type ConnectorActionReceipt = Record<string, unknown> & {
  tool: 'connector_action' | 'invoke_capability' | 'send_owner_message';
  connector: string;
  action: string;
  target: string;
  outcome: 'confirmed' | 'accepted';
};
type OnConnectorAction = (request: ConnectorActionRequest, receipt: ConnectorActionReceipt) => void;

function connectorActionErrorResult(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  if (error instanceof ActionFailedSafeError) {
    return JSON.stringify({
      mimiStatus: 'action_failed_safe',
      retryable: true,
      sideEffectsFrozen: false,
      message,
    });
  }
  return JSON.stringify({
    mimiStatus: 'action_uncertain',
    retryable: false,
    sideEffectsFrozen: true,
    message: isUncertainDeliveryError(error)
      ? message
      : `${message}；无法确认 Connector 是否越过副作用提交点`,
  });
}

function connectorActionOutcome(result: unknown): 'confirmed' | 'failed_safe' | 'uncertain' {
  let value = result;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return 'uncertain';
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'uncertain';
  const record = value as Record<string, unknown>;
  if (record.mimiStatus === 'action_failed_safe') return 'failed_safe';
  return record.outcome === 'confirmed' ? 'confirmed' : 'uncertain';
}

function boundedActionResult(result: unknown): unknown {
  const serialized = JSON.stringify(result);
  if (serialized === undefined) return result;
  const bytes = Buffer.from(serialized);
  if (bytes.byteLength <= MAX_ACTION_RESULT_BYTES) return result;
  return {
    truncated: true,
    originalBytes: bytes.byteLength,
    preview: bytes.subarray(0, MAX_ACTION_RESULT_BYTES).toString('utf8'),
  };
}

export function connectorCapabilitySnapshot(
  connectors: ConnectorManager,
  filter: ConnectorCapabilityFilter = {},
): ConnectorCapabilitySnapshot {
  const exact = filter.connector
    ? modelVisibleCapabilities(connectors).filter((connector) => connector.id === filter.connector)
    : modelVisibleCapabilities(connectors);
  const capability = filter.capability?.trim();
  const capabilityFiltered = capability
    ? exact.flatMap((connector) => {
      const actions = connector.actions.filter((action) => action.capability === capability);
      return actions.length ? [{ ...connector, actions }] : [];
    })
    : exact;
  const query = filter.query?.trim().toLowerCase();
  const all = query
    ? capabilityFiltered.flatMap((connector) => {
      const connectorMatches = `${connector.id}\n${connector.source}`.toLowerCase().includes(query);
      if (connectorMatches) return [connector];
      const actions = connector.actions.filter((action) => (
        `${action.name}\n${action.description}\n${action.capability}`.toLowerCase().includes(query)
      ));
      return actions.length ? [{ ...connector, actions }] : [];
    })
    : capabilityFiltered;
  const catalogActions = exact.reduce((total, connector) => total + connector.actions.length, 0);
  const availableCapabilities = [...new Set(
    exact.flatMap((connector) => connector.actions.map((action) => action.capability)),
  )].sort().slice(0, MAX_ACTIONS);
  const actionCount = all.reduce((total, connector) => total + connector.actions.length, 0);
  let remainingActions = MAX_ACTIONS;
  let truncatedDescription = false;
  const visible = all.slice(0, MAX_CONNECTORS).map((connector) => {
    const actions = connector.actions.slice(0, remainingActions).map((action) => {
      if (action.description.length > MAX_DESCRIPTION_CHARS) truncatedDescription = true;
      return {
        name: action.name,
        description: action.description.slice(0, MAX_DESCRIPTION_CHARS),
        capability: action.capability,
        effect: action.effect,
        routeOwner: action.routeOwner,
      };
    });
    remainingActions -= actions.length;
    return {
      id: connector.id,
      enabled: connector.enabled,
      online: connector.online,
      readiness: connector.readiness,
      source: connector.source.slice(0, 300),
      routeOwner: connector.id,
      claimedComputerApps: connector.claimedComputerApps,
      actions,
    };
  });
  const visibleActions = visible.reduce((total, connector) => total + connector.actions.length, 0);
  return {
    configFile: connectors.configPath,
    catalogTotal: exact.length,
    catalogActions,
    total: all.length,
    enabled: all.filter((connector) => connector.enabled).length,
    online: all.filter((connector) => connector.online).length,
    inboundReady: all.filter((connector) => connector.online
      && connector.readiness.stale !== true && connector.readiness.inbound === 'ready').length,
    outboundReady: all.filter((connector) => connector.online
      && connector.readiness.stale !== true && connector.readiness.outbound === 'ready').length,
    stale: all.filter((connector) => connector.online && connector.readiness.stale === true).length,
    actions: actionCount,
    filterMatched: all.length > 0,
    availableCapabilities,
    truncated: all.length > visible.length
      || actionCount > visibleActions
      || availableCapabilities.length < new Set(
        exact.flatMap((connector) => connector.actions.map((action) => action.capability)),
      ).size
      || truncatedDescription,
    connectors: visible,
  };
}

export function createConnectorCapabilityTool(connectors: ConnectorManager): Tool {
  return createConnectorCapabilityRuntimeTool((filter) => connectorCapabilitySnapshot(connectors, filter));
}

export function createConnectorCapabilityRuntimeTool(inspect: InspectCapabilities): Tool {
  return tool({
    name: 'inspect_mimi_capabilities',
    description: '读取当前可供模型使用的 Connector 业务能力目录及结构化就绪状态。Host 内部动作不会出现在目录中。',
    parameters: z.object({
      connector: identifier.optional().describe('可选完整 Connector ID 精确过滤，例如 personal-daxiang 或 openclaw-weixin；不要填 daxiang、qq 等渠道简称'),
      capability: z.string()
        .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/)
        .max(120)
        .optional()
        .describe('可选稳定 capability 精确过滤，例如 browser.page.read'),
      query: z.string().trim().min(1).max(100).optional().describe('可选目录关键词，仅匹配展示元数据；零命中不能作为能力不存在或降级依据'),
    }).strict(),
    execute: async (filter, _context, details) => {
      const snapshot = await inspect(filter, details?.signal);
      if (filter.connector && snapshot.catalogTotal === 0) {
        throw new ActionFailedSafeError(`Connector ID "${filter.connector}" 未注册`);
      }
      return snapshot;
    },
  });
}

export function createConnectorReloadTool(connectors: ConnectorManager): Tool {
  return tool({
    name: 'reload_mimi_connectors',
    description: '重新读取并热切换 MimiAgent Connector 配置。用于应用 owner 在配置文件中完成的命令、凭证白名单或 action 目录修改；无效配置或存在进行中的 delivery/action 时旧 Connector 保持在线并返回错误。单纯启停已有渠道请使用 set_mimi_connector_enabled。',
    parameters: z.object({}),
    execute: async () => {
      await connectors.reload();
      return connectorCapabilitySnapshot(connectors);
    },
  });
}

export function createConnectorEnabledTool(connectors: ConnectorManager): Tool {
  return tool({
    name: 'set_mimi_connector_enabled',
    description: '原子启用或停用一个已经配置的 MimiAgent Connector，并立即热切换进程。不会读取或修改凭证、命令、环境白名单和 action 目录；存在进行中的 delivery/action 时保持原状态并返回错误。',
    parameters: z.object({
      connector: identifier.describe('已配置的 Connector ID'),
      enabled: z.boolean().describe('true 启用，false 停用'),
    }).strict(),
    execute: async ({ connector, enabled }) => connectors.setEnabled(connector, enabled),
  });
}

export function createConnectorHostTools(
  connectors: ConnectorManager,
  onAction?: OnConnectorAction,
  options: { allowOwnerMessage?: boolean } = {},
): Tool[] {
  const ownerChannels = options.allowOwnerMessage ? ownerMessageChannels(connectors) : [];
  return [
    createConnectorCapabilityTool(connectors),
    createInvokeCapabilityTool(connectors, onAction),
    ...(ownerChannels.length
      ? [createOwnerMessageTool(connectors, ownerChannels, onAction)]
      : []),
  ];
}

/** Task workers can inspect and invoke Connectors, but cannot mutate the kernel Connector registry. */
export function createConnectorTaskHostTools(runtime: ConnectorTaskRuntime): Tool[] {
  return [
    createConnectorCapabilityRuntimeTool(runtime.inspectCapabilities.bind(runtime)),
    createConnectorActionRuntimeTool(runtime.executeAction.bind(runtime)),
  ];
}

export function createConnectorActionTool(
  connectors: ConnectorManager,
  onAction?: OnConnectorAction,
): Tool {
  return createConnectorActionRuntimeTool((request) => connectors.executeAction(request), onAction);
}

export function createInvokeCapabilityTool(
  connectors: ConnectorManager,
  onAction?: OnConnectorAction,
): Tool {
  const capabilityTool = tool({
    name: 'invoke_capability',
    description: '调用当前目录中的一项 Connector 业务能力。',
    parameters: z.object({
      capability: z.string()
        .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/)
        .max(120),
      action: identifier.describe('能力目录中返回的精确 action 名称'),
      target: z.string().min(1).max(2_000),
      payloadJson: z.string().min(1).max(50_000),
    }).strict(),
    errorFunction: (_context, error) => connectorActionErrorResult(error),
    execute: async ({ capability, action, target, payloadJson }, _context, details) => {
      let payload: unknown;
      try {
        payload = JSON.parse(payloadJson) as unknown;
      } catch {
        throw new ActionFailedSafeError('payloadJson 不是有效 JSON');
      }
      const selected = await connectors.executeCapability({
        capability,
        action,
        target,
        payload,
      } satisfies ConnectorCapabilityRequest);
      const request: ConnectorActionRequest = {
        connector: selected.connector,
        action,
        target,
        payload,
      };
      const receipt = connectorReceipt(
        'invoke_capability',
        request,
        selected.result,
        selected.effect,
      );
      onAction?.(request, receipt);
      return receipt;
    },
  }) as Tool & {
    [TOOL_ACTION_INTENT]?: (rawInput: string) => ToolActionIntentMetadata;
  };
  capabilityTool[TOOL_ACTION_INTENT] = (rawInput) => {
    const input = JSON.parse(rawInput) as Record<string, unknown>;
    const capability = String(input.capability ?? '');
    const action = String(input.action ?? '');
    const target = String(input.target ?? '');
    const declarations = modelVisibleCapabilities(connectors).flatMap((connector) => connector.actions
      .filter((candidate) => candidate.name === action && candidate.capability === capability));
    const effect = declarations.length === 1 ? declarations[0]!.effect : 'unknown';
    return {
      actionFamily: `connector.${capability}.${action}`,
      targetRef: target,
      payload: {
        capability,
        action,
        target,
        payloadJson: String(input.payloadJson ?? ''),
      },
      selectedRoute: 'capability-router',
      effect,
      guarded: {
        exactTarget: target.length > 0,
        lowRisk: false,
        reversible: false,
      },
      outcome: connectorActionOutcome,
    };
  };
  return capabilityTool;
}

export function createOwnerMessageTool(
  connectors: ConnectorManager,
  channels: readonly OwnerMessageChannel[],
  onAction?: OnConnectorAction,
): Tool {
  const channelSchema = z.enum(channels as [OwnerMessageChannel, ...OwnerMessageChannel[]]);
  const ownerMessageTool = tool({
    name: 'send_owner_message',
    description: '向 owner 自己在指定个人消息渠道发送一条文本。',
    parameters: z.object({
      channel: channelSchema,
      text: z.string().trim().min(1).max(4_000),
    }).strict(),
    errorFunction: (_context, error) => connectorActionErrorResult(error),
    execute: async ({ channel, text }) => {
      const request: ConnectorActionRequest = {
        connector: `personal-${channel}`,
        action: 'send_to_owner',
        target: 'owner',
        payload: { text },
      };
      const result = await connectors.executePersonalMessageAction(request);
      const value = result !== null && typeof result === 'object' && !Array.isArray(result)
        ? result as Record<string, unknown>
        : undefined;
      if (value?.status === 'failed') {
        throw new ActionFailedSafeError(String(value.error ?? '个人消息未执行'));
      }
      if (value?.status === 'uncertain') {
        throw new UncertainDeliveryError(String(value.error ?? '个人消息发送结果不确定'));
      }
      const receipt = connectorReceipt('send_owner_message', request, result, 'write');
      onAction?.(request, receipt);
      return receipt;
    },
  }) as Tool & {
    [TOOL_ACTION_INTENT]?: (rawInput: string) => ToolActionIntentMetadata;
  };
  ownerMessageTool[TOOL_ACTION_INTENT] = (rawInput) => {
    const input = JSON.parse(rawInput) as Record<string, unknown>;
    const channel = String(input.channel ?? '');
    return {
      actionFamily: 'personal-message.owner.send',
      targetRef: `personal-${channel}:owner`,
      payload: {
        channel,
        text: String(input.text ?? ''),
      },
      selectedRoute: `personal-${channel}`,
      effect: 'write',
      guarded: {
        exactTarget: true,
        lowRisk: false,
        reversible: false,
      },
      outcome: connectorActionOutcome,
    };
  };
  return ownerMessageTool;
}

function connectorReceipt(
  toolName: ConnectorActionReceipt['tool'],
  request: ConnectorActionRequest,
  result: unknown,
  effect: 'read' | 'write' | 'unknown' = 'unknown',
): ConnectorActionReceipt {
  const boundedResult = boundedActionResult(result);
  const value = boundedResult !== null && typeof boundedResult === 'object' && !Array.isArray(boundedResult)
    ? boundedResult as Record<string, unknown>
    : undefined;
  const declaredOutcome = value?.outcome;
  const outcome = effect === 'read'
    ? 'confirmed'
    : declaredOutcome === 'confirmed' || declaredOutcome === 'accepted'
    ? declaredOutcome
    : value?.deliveryConfirmed === true
      || typeof value?.messageId === 'string'
      || typeof value?.requestId === 'string'
      ? 'confirmed'
      : 'accepted';
  return {
    ...(value ?? {}),
    operationId: typeof value?.operationId === 'string'
      ? value.operationId
      : typeof value?.messageId === 'string' ? value.messageId
        : typeof value?.requestId === 'string' ? value.requestId : randomUUID(),
    tool: toolName,
    connector: request.connector,
    action: request.action,
    target: request.target,
    effect,
    outcome,
    ...(value ? {} : { evidence: boundedResult }),
    occurredAt: new Date().toISOString(),
  };
}

function createConnectorActionRuntimeTool(
  executeAction: ExecuteConnectorAction,
  onAction?: OnConnectorAction,
): Tool {
  return tool({
    name: 'connector_action',
    description: '调用任务 Host 已提供的一项 Connector 业务能力。',
    parameters: z.object({
      connector: identifier.describe('Connector ID，例如 macos-mail'),
      action: identifier.describe('Connector 声明的 action 名称，例如 send_message'),
      target: z.string().min(1).max(2_000).describe('主要操作对象，例如 single:zhangsan 或 group:123'),
      payloadJson: z.string().min(1).max(50_000).describe('要传给 Connector 的 JSON 载荷'),
    }).strict(),
    errorFunction: (_context, error) => connectorActionErrorResult(error),
    execute: async ({ connector, action, target, payloadJson }, _context, details) => {
      let payload: unknown;
      try {
        payload = JSON.parse(payloadJson) as unknown;
      } catch {
        throw new ActionFailedSafeError('payloadJson 不是有效 JSON');
      }
      const result = await executeAction({ connector, action, target, payload }, details?.signal);
      const request = { connector, action, target, payload };
      const receipt = connectorReceipt('connector_action', request, result);
      onAction?.(request, receipt);
      return receipt;
    },
  });
}
