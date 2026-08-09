import { tool, type RunContext, type Tool } from '@openai/agents';
import { z } from 'zod';
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

/** Immutable per-Run authority plus the only mutable, in-memory discovery cache. */
export class HostCapabilityRegistry {
  private readonly byName: ReadonlyMap<string, Tool>;
  private readonly entries: readonly RegistryEntry[];
  private readonly discoveredNames = new Set<string>();
  private readonly discoveredConnectorActions = new Set<string>();
  private readonly discoveryCache = new Map<string, unknown>();
  private catalogRevision?: string;

  constructor(
    authorizedTools: readonly Tool[],
    private readonly catalogAccess?: CapabilityCatalogAccess,
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

  gatewayTools(deferredTools: readonly Tool[]): Tool[] {
    if (deferredTools.length === 0) return [];
    const deferredNames = new Set(deferredTools.map((candidate) => candidate.name));
    for (const name of deferredNames) {
      if (!this.byName.has(name)) throw new Error(`Deferred capability 不属于当前 Host registry：${name}`);
    }
    const entries = this.entries.filter((entry) => deferredNames.has(entry.name));
    const connectorInvokerEntry = entries.find((entry) => (
      entry.name === 'connector_capability' || entry.name === 'connector_action'
    ));
    return [
      tool({
        name: 'inspect_capabilities',
        description: '查询本轮 Host 已授权的 deferred 能力目录；首轮已可见的 direct tools 不会在此重复。Tool 用精确 name，Connector action 用精确 capability；精确结果会返回调用 schema。',
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
          if (toolName && !deferredNames.has(toolName)) {
            throw new Error(`能力未授权、不是 deferred capability 或不存在：${toolName}`);
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
      items: input.items,
    });
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
