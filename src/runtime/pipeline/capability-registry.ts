import type { RunContext, Tool } from '@openai/agents';
import { z } from 'zod';
import { tool } from '../../tool-factory.js';
import { toolDescriptor } from '../tool-policy.js';
import {
  createEffectiveCapabilitySnapshot,
  type CapabilitySource,
  type EffectiveCapabilityItem,
  type EffectiveCapabilitySnapshot,
  type ProgressiveCapabilityGroup,
} from './capability-resolver.js';

type InvokableTool = Tool & {
  invoke: (
    context: RunContext<unknown>,
    input: string,
    details: unknown,
  ) => Promise<unknown>;
};

export interface CapabilityCatalogAccess {
  inspectConnector(
    filter: { connector?: string; capability?: string; query?: string },
    signal?: AbortSignal,
  ): unknown | Promise<unknown>;
  revision?: () => string;
}

export interface DeferredMcpCatalog {
  statuses(): readonly { name: string; state: string; tools: number; error?: string }[];
  load(): Promise<readonly Tool[]>;
  changed?(): void;
}

const MAX_INDEXED_NAMES_PER_SOURCE = 12;
const INTERNAL_COMPATIBILITY_TOOLS = new Set([
  'inspect_mimi_capabilities',
  'inspect_runtime_capabilities',
  'invoke_runtime_capability',
]);
const CAPABILITY_QUERY_STOP_WORDS = new Set([
  'a', 'an', 'and', 'for', 'in', 'of', 'or', 'the', 'to', 'with',
]);

function normalizeCapabilityQuery(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function capabilityQueryTerms(value: string): string[] {
  return [...new Set(normalizeCapabilityQuery(value).split(/\s+/u)
    .filter((term) => term.length > 1 && !CAPABILITY_QUERY_STOP_WORDS.has(term)))];
}

function capabilityQueryOverlap(query: string, searchable: string): number {
  const normalizedQuery = normalizeCapabilityQuery(query);
  const normalizedSearchable = normalizeCapabilityQuery(searchable);
  if (!normalizedQuery || !normalizedSearchable) return 0;
  if (normalizedSearchable.includes(normalizedQuery)) return 1_000;
  return capabilityQueryTerms(query)
    .filter((term) => normalizedSearchable.includes(term))
    .length;
}

function matchesCapabilityQuery(query: string, searchable: string): number {
  const overlap = capabilityQueryOverlap(query, searchable);
  if (overlap >= 1_000) return overlap;
  const termCount = capabilityQueryTerms(query).length;
  return overlap >= Math.min(2, termCount) ? overlap : 0;
}

function connectorActionKey(capability: string, action: string): string {
  return `${capability}\u0000${action}`;
}

function connectorActionKeys(catalog: unknown): string[] {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return [];
  const connectors = (catalog as Record<string, unknown>).connectors;
  if (!Array.isArray(connectors)) return [];
  const keys: string[] = [];
  for (const connector of connectors) {
    if (!connector || typeof connector !== 'object' || Array.isArray(connector)) continue;
    const actions = (connector as Record<string, unknown>).actions;
    if (!Array.isArray(actions)) continue;
    for (const action of actions) {
      if (!action || typeof action !== 'object' || Array.isArray(action)) continue;
      const value = action as Record<string, unknown>;
      if (typeof value.capability !== 'string' || typeof value.name !== 'string') continue;
      keys.push(connectorActionKey(value.capability, value.name));
    }
  }
  return keys;
}

function requestedConnectorAction(argumentsJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  if (typeof value.capability !== 'string' || typeof value.action !== 'string') return undefined;
  return connectorActionKey(value.capability, value.action);
}

function capabilitySource(name: string): CapabilitySource {
  if (name.startsWith('browser_')) return 'browser';
  if (name.startsWith('computer_')) return 'computer';
  if (name.startsWith('memory_') || ['remember', 'forget'].includes(name)) return 'memory';
  if (name.includes('goal') || name.includes('plan') || ['prepare_task', 'finish_task'].includes(name)) return 'goal';
  if (name.includes('skill')) return 'skill';
  if (['connector_capability', 'connector_action', 'send_owner_message'].includes(name)) return 'connector';
  if (!toolDescriptor(name)) return 'mcp';
  return 'builtin';
}

interface RegistryEntry {
  name: string;
  source: CapabilitySource;
  effect: 'read' | 'side-effect';
  description: string;
  parameters: unknown;
}

/** Per-Run authority; a preauthorized MCP provider may materialize deferred tools. */
export class HostCapabilityRegistry {
  private readonly byName: Map<string, Tool>;
  private entries: readonly RegistryEntry[];
  private mcpPending?: Promise<void>;
  private mcpLoaded = false;
  private loadedMcpNames = new Set<string>();
  private deferredNames = new Set<string>();
  private readonly discoveredNames = new Set<string>();
  private readonly discoveredConnectorActions = new Set<string>();
  private readonly discoveryCache = new Map<string, unknown>();
  private catalogRevision?: string;

  constructor(
    authorizedTools: readonly Tool[],
    private readonly catalogAccess?: CapabilityCatalogAccess,
    private readonly skillCatalog?: (filter: { name?: string; query?: string }) => unknown | Promise<unknown>,
    private readonly mcpCatalog?: DeferredMcpCatalog,
  ) {
    const duplicates = authorizedTools
      .map((candidate) => candidate.name)
      .filter((name, index, names) => names.indexOf(name) !== index);
    if (duplicates.length) {
      throw new Error(`Host capability registry 包含重复 Tool：${[...new Set(duplicates)].sort().join(', ')}`);
    }
    const tools = authorizedTools.filter((candidate) => !INTERNAL_COMPATIBILITY_TOOLS.has(candidate.name));
    this.byName = new Map(tools.map((candidate) => [candidate.name, candidate]));
    this.entries = Object.freeze(tools.map((candidate) => {
      const value = candidate as unknown as Record<string, unknown>;
      const descriptor = toolDescriptor(candidate.name);
      return Object.freeze({
        name: candidate.name,
        source: capabilitySource(candidate.name),
        effect: descriptor?.sideEffect ? 'side-effect' as const : 'read' as const,
        description: typeof value.description === 'string' ? value.description : '',
        parameters: value.parameters,
      });
    }));
    this.catalogRevision = catalogAccess?.revision?.();
  }

  authorizedTools(): readonly Tool[] {
    return [...this.byName.values()];
  }

  async prepareMcp(): Promise<void> { await this.loadMcp(this.deferredNames); }

  gatewayTools(deferredTools: readonly Tool[]): Tool[] {
    const deferredNames = new Set([...deferredTools.map((candidate) => candidate.name), ...this.loadedMcpNames]);
    this.deferredNames = deferredNames;
    for (const name of deferredNames) {
      if (!this.byName.has(name)) throw new Error(`Deferred capability 不属于当前 Host registry：${name}`);
    }
    let entries = this.entries.filter((entry) => deferredNames.has(entry.name));
    const connectorInvokerEntry = entries.find((entry) => (
      entry.name === 'connector_capability' || entry.name === 'connector_action'
    ));
    return [
      tool({
        name: 'inspect_capabilities',
        description: '查询本轮能力状态。Tool 用精确 name；Skill 实例用 source=skill 加技能 name/query；Connector action 用 capability。返回 resolution 和调用 schema。',
        parameters: z.object({
          source: z.enum(['builtin', 'mcp', 'browser', 'computer', 'memory', 'goal', 'skill', 'connector']).optional(),
          name: z.string().trim().min(1).max(200).optional()
            .describe('deferred Tool 的精确名称；Connector action 请使用 capability'),
          capability: z.string().trim()
            .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/)
            .max(120)
            .optional()
            .describe('Connector action 的稳定 capability 精确名称'),
          query: z.string().trim().min(1).max(100).optional(),
        }).strict(),
        execute: async ({ source, name, capability, query }, _context, details) => {
          const inspectMcp = source === 'mcp' || (!source && name?.startsWith('mcp_'));
          if (inspectMcp && this.mcpCatalog) {
            await this.loadMcp(deferredNames);
            entries = this.entries.filter(entry => deferredNames.has(entry.name));
          }
          this.refreshCatalogRevision(connectorInvokerEntry);
          // Older model turns used source=connector + name for an action capability.
          // Keep that input non-throwing while making the schema unambiguous going forward.
          const connectorCapability = capability ?? (
            source === 'connector' && name && !deferredNames.has(name) ? name : undefined
          );
          const toolName = connectorCapability ? undefined : name;
          const signature = JSON.stringify({
            source, name: toolName, capability: connectorCapability, query, revision: this.catalogRevision,
          });
          const cached = this.discoveryCache.get(signature);
          if (cached !== undefined) return cached;
          // Skill names are catalog entries, not tool names. Discovery never grants new tools.
          if (source === 'skill' && this.skillCatalog && this.byName.has('list_skills')
            && (!toolName || !this.byName.has(toolName))) {
            const catalog = await this.skillCatalog({ ...(toolName ? { name: toolName } : {}), ...(query ? { query } : {}) });
            const skills = catalog && typeof catalog === 'object' && 'skills' in catalog && Array.isArray(catalog.skills) ? catalog.skills : [];
            const navigators = entries.filter(entry => ['use_skill', 'read_skill_resource', 'list_skills'].includes(entry.name));
            for (const entry of navigators) this.discoveredNames.add(entry.name);
            return {
              authorizedCount: this.entries.length,
              ...(inspectMcp && this.mcpCatalog ? { mcpCatalog: this.mcpCatalog.statuses() } : {}), deferredCount: entries.length, matchedCount: skills.length,
              skillCatalog: catalog,
              capabilities: navigators.map(entry => ({ ...entry, invokeWith: 'invoke_capability' })),
              resolution: { name: toolName, status: skills.length ? 'skill' : 'not_found', instruction: skills.length
                ? '这是已安装 Skill。检查 available；通过返回的 use_skill schema 传入技能 name 激活，不要把技能名当作工具名。'
                : '当前技能目录未匹配；可通过 list_skills 分页查看，不能据此判断同名 Tool 的状态。' },
              truncated: !!catalog && typeof catalog === 'object' && 'nextOffset' in catalog,
            };
          }
          const authorizedEntry = toolName
            ? this.entries.find((entry) => entry.name === toolName)
            : undefined;
          if (toolName && (!authorizedEntry || (source && authorizedEntry.source !== source))) {
            const result = {
              authorizedCount: this.entries.length,
              ...(inspectMcp && this.mcpCatalog ? { mcpCatalog: this.mcpCatalog.statuses() } : {}),
              deferredCount: entries.length,
              matchedCount: 0,
              capabilities: [],
              resolution: authorizedEntry
                ? {
                    name: toolName,
                    status: 'source_mismatch',
                    requestedSource: source,
                    actualSource: authorizedEntry.source,
                    instruction: `改用 source=${authorizedEntry.source} 查询；不要调用当前 source 下不存在的能力。`,
                  }
                : {
                    name: toolName,
                    status: 'unavailable',
                    requestedSource: source,
                    instruction: '该能力未在本轮 Host 授权工具集中注册；不要调用或猜测替代工具。',
                  },
              truncated: false,
            };
            this.discoveryCache.set(signature, result);
            return result;
          }
          if (toolName && authorizedEntry && !deferredNames.has(toolName)) {
            const result = {
              authorizedCount: this.entries.length,
              ...(inspectMcp && this.mcpCatalog ? { mcpCatalog: this.mcpCatalog.statuses() } : {}),
              deferredCount: entries.length,
              matchedCount: 1,
              capabilities: [{
                name: authorizedEntry.name,
                source: authorizedEntry.source,
                effect: authorizedEntry.effect,
                availability: 'direct',
                invokeWith: authorizedEntry.name,
              }],
              resolution: {
                name: toolName,
                status: 'direct',
                instruction: `该工具已直接可见；立即调用 ${toolName}，不要通过 invoke_capability。`,
              },
              truncated: false,
            };
            this.discoveryCache.set(signature, result);
            return result;
          }
          const eligibleEntries = entries.filter((entry) =>
            (!source || entry.source === source)
            && (!toolName || entry.name === toolName));
          const directMatches = connectorCapability
            ? []
            : eligibleEntries
              .map((entry) => ({
                entry,
                score: query ? matchesCapabilityQuery(query, `${entry.name} ${entry.description}`) : 1,
              }))
              .filter(({ score }) => score > 0)
              .sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))
              .map(({ entry }) => entry);
          const connectorCatalog = (connectorCapability || query)
            && !toolName
            && (!source || source === 'connector')
            && connectorInvokerEntry
            && this.catalogAccess
            ? await this.catalogAccess.inspectConnector({
                ...(connectorCapability ? { capability: connectorCapability } : {}),
                ...(query ? { query } : {}),
              }, details?.signal)
            : undefined;
          const connectorMatched = connectorCatalog !== undefined
            && connectorCatalog !== null
            && typeof connectorCatalog === 'object'
            && !Array.isArray(connectorCatalog)
            && (connectorCatalog as Record<string, unknown>).filterMatched === true
            && Number((connectorCatalog as Record<string, unknown>).actions) > 0;
          const matches = connectorMatched
            && connectorInvokerEntry
            && !directMatches.some((entry) => entry.name === connectorInvokerEntry.name)
            ? [...directMatches, connectorInvokerEntry]
            : directMatches;
          if (toolName) {
            for (const match of matches) this.discoveredNames.add(match.name);
          }
          if (connectorMatched && connectorInvokerEntry) {
            this.discoveredNames.add(connectorInvokerEntry.name);
            for (const key of connectorActionKeys(connectorCatalog)) {
              this.discoveredConnectorActions.add(key);
            }
          }
          const result = {
            authorizedCount: this.entries.length,
              ...(inspectMcp && this.mcpCatalog ? { mcpCatalog: this.mcpCatalog.statuses() } : {}),
            deferredCount: entries.length,
            matchedCount: matches.length,
            capabilities: matches.slice(0, 100).map((entry) => ({
              name: entry.name,
              source: entry.source,
              effect: entry.effect,
              ...(toolName || (connectorMatched && entry.name === connectorInvokerEntry?.name) ? {
                description: entry.description,
                parameters: entry.parameters,
                invokeWith: 'invoke_capability',
              } : {}),
            })),
            ...(toolName ? {
              resolution: {
                name: toolName,
                status: matches.length > 0 ? 'deferred' : 'unavailable',
                instruction: matches.length > 0
                  ? '按返回的 parameters 通过 invoke_capability 调用。'
                  : '该能力未在指定 source 下匹配；不要调用或猜测替代工具。',
              },
            } : {}),
            ...(connectorCatalog === undefined ? {} : { connectorCatalog }),
            ...(query && matches.length === 0 ? {
              suggestions: eligibleEntries
                .map((entry) => ({
                  name: entry.name,
                  score: capabilityQueryOverlap(query, `${entry.name} ${entry.description}`),
                }))
                .filter(({ score }) => score > 0)
                .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
                .slice(0, 5)
                .map(({ name: suggestedName }) => suggestedName),
            } : {}),
            truncated: matches.length > 100,
          };
          this.discoveryCache.set(signature, result);
          return result;
        },
      }),
      tool({
        name: 'invoke_capability',
        description: '调用 inspect_capabilities 精确返回的一项本轮授权能力；实际工具仍执行原 Host Policy、参数 schema 与 ExecutionLedger。',
        parameters: z.object({
          name: z.string().trim().min(1).max(200),
          argumentsJson: z.string().min(1).max(100_000),
        }).strict(),
        execute: async ({ name, argumentsJson }, context, details) => {
          this.refreshCatalogRevision(connectorInvokerEntry);
          const selected = deferredNames.has(name)
            ? this.byName.get(name) as InvokableTool | undefined
            : undefined;
          if (!selected?.invoke) throw new Error(`能力未授权、不可调用或不存在：${name}`);
          if (!this.discoveredNames.has(name)) {
            throw new Error(
              `能力 ${name} 尚未通过 inspect_capabilities 精确发现；`
              + '先按精确 name 查询并取得调用 schema，再调用。',
            );
          }
          if (name === connectorInvokerEntry?.name) {
            const actionKey = requestedConnectorAction(argumentsJson);
            if (!actionKey || !this.discoveredConnectorActions.has(actionKey)) {
              throw new Error(
                'Connector action 尚未通过能力目录精确发现；'
                + '先用 inspect_capabilities 的 connector query 取得精确 capability/action 和参数示例。',
              );
            }
          }
          return selected.invoke(context as RunContext<unknown>, argumentsJson, details);
        },
      }),
    ];
  }

  hiddenCapabilityGroups(modelTools: readonly Tool[]): ProgressiveCapabilityGroup[] {
    const visible = new Set(modelTools.map((candidate) => candidate.name));
    const grouped = new Map<CapabilitySource, string[]>();
    for (const candidate of this.byName.values()) {
      if (visible.has(candidate.name)) continue;
      const source = capabilitySource(candidate.name);
      const names = grouped.get(source) ?? [];
      names.push(candidate.name);
      grouped.set(source, names);
    }
    return [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([source, values]) => {
        const names = [...new Set(values)].sort();
        return {
          source,
          count: names.length,
          names: names.slice(0, MAX_INDEXED_NAMES_PER_SOURCE),
          truncated: names.length > MAX_INDEXED_NAMES_PER_SOURCE,
        };
      });
  }

  snapshot(input: {
    runId: string;
    policyRevision: string;
    modelTools: readonly Tool[];
    skills?: readonly string[];
    observedAt?: string;
    items?: readonly EffectiveCapabilityItem[];
  }): Readonly<EffectiveCapabilitySnapshot> {
    return createEffectiveCapabilitySnapshot({
      runId: input.runId,
      policyRevision: input.policyRevision,
      toolNames: input.modelTools.map((candidate) => candidate.name),
      hiddenTools: this.hiddenCapabilityGroups(input.modelTools),
      skillNames: input.skills,
      observedAt: input.observedAt,
      items: [
        ...(input.items ?? []).filter(item => !item.id.startsWith('mcp-server:')),
        ...(this.mcpCatalog?.statuses() ?? []).map(status => ({
          id: `mcp-server:${status.name}`, kind: 'mcp' as const,
          availability: ['failed', 'disabled'].includes(status.state) ? 'unavailable' as const : 'available' as const,
          readiness: status.state === 'connected' ? 'ready' as const : status.state === 'configured' ? 'unknown' as const : 'unavailable' as const,
          freshness: 'fresh' as const, coverage: 'metadata_only' as const,
          permissionSource: input.policyRevision, selectedRoute: 'inspect_capabilities(source=mcp)',
          routeOwner: status.state, actionCount: status.tools, safeFallback: 'none' as const,
        })),
      ],
    });
  }

  private async loadMcp(deferredNames: Set<string>): Promise<void> {
    if (!this.mcpCatalog || this.mcpLoaded) return;
    if (this.mcpPending) return this.mcpPending;
    this.mcpPending = (async () => {
      const loaded = await this.mcpCatalog!.load();
      const existingMcp = this.loadedMcpNames;
      if (new Set(loaded.map(candidate => candidate.name)).size !== loaded.length) throw new Error('MCP Tool 名称重复');
      for (const candidate of loaded) {
        if (this.byName.has(candidate.name) && !existingMcp.has(candidate.name)) throw new Error(`MCP Tool 名称与 Host 冲突：${candidate.name}`);
      }
      for (const name of existingMcp) { this.byName.delete(name); deferredNames.delete(name); this.discoveredNames.delete(name); }
      const next = this.entries.filter(entry => !existingMcp.has(entry.name));
      for (const candidate of loaded) {
        this.byName.set(candidate.name, candidate); deferredNames.add(candidate.name);
        const value = candidate as unknown as Record<string, unknown>;
        next.push({ name: candidate.name, source: 'mcp', effect: 'side-effect', description: String(value.description ?? ''), parameters: value.parameters });
      }
      this.loadedMcpNames = new Set(loaded.map(candidate => candidate.name));
      this.entries = Object.freeze(next); this.discoveryCache.clear();
      this.mcpLoaded = this.mcpCatalog!.statuses().every(status => ['connected', 'disabled'].includes(status.state));
      this.mcpCatalog!.changed?.();
    })();
    try { await this.mcpPending; } finally { this.mcpPending = undefined; }
  }

  private refreshCatalogRevision(connectorInvokerEntry?: RegistryEntry): void {
    const currentRevision = this.catalogAccess?.revision?.();
    if (currentRevision === this.catalogRevision) return;
    this.catalogRevision = currentRevision;
    this.discoveryCache.clear();
    this.discoveredConnectorActions.clear();
    if (connectorInvokerEntry) this.discoveredNames.delete(connectorInvokerEntry.name);
  }
}
