import { createHash } from 'node:crypto';
import type { SecurityProfile } from '../../config.js';
import type { ComputerAccess } from '../../extensions/computer/types.js';
import type { ToolCapability } from '../tool-policy.js';
import type { RunScope } from './run-scope.js';

export interface CapabilityPolicy {
  allowedCapabilities: readonly ToolCapability[];
  allowedTools?: readonly string[];
  allowSessionContext?: boolean;
  computerAccess?: ComputerAccess;
}

export interface CapabilityResolverInput {
  scope: RunScope;
  runtimeAccess: RuntimeAccess;
  policy?: CapabilityPolicy;
  requestedComputerAccess?: ComputerAccess;
  defaultComputerAccess?: ComputerAccess;
}

export interface RuntimeAccess {
  workspaceWrite: boolean;
  computer: boolean;
  mcp: boolean;
  ephemeralSensitiveModelAccess: boolean;
  policyRevision: string;
}

export function runtimeAccessForSecurity(
  runtime: RuntimeAccess,
  securityProfile: SecurityProfile,
): Readonly<RuntimeAccess> {
  return Object.freeze({
    workspaceWrite: runtime.workspaceWrite && securityProfile !== 'safe',
    computer: runtime.computer && securityProfile === 'full-owner',
    mcp: runtime.mcp && securityProfile === 'full-owner',
    ephemeralSensitiveModelAccess: runtime.ephemeralSensitiveModelAccess
      && securityProfile === 'full-owner',
    policyRevision: `${runtime.policyRevision}:${securityProfile}`,
  });
}

export interface ResolvedCapabilities {
  canReadLocal: boolean;
  canReadMemory: boolean;
  canReadState: boolean;
  canReadSessionContext: boolean;
  completionToolsAllowed: boolean;
  computerAccess: ComputerAccess;
}

export type CapabilityAvailability = 'available' | 'degraded' | 'unavailable';
export type CapabilityReadiness = 'ready' | 'unavailable' | 'unknown';
export type CapabilityFreshness = 'fresh' | 'stale' | 'unknown';
export type CapabilityCoverage =
  | 'complete'
  | 'bounded'
  | 'notification_only'
  | 'metadata_only'
  | 'unavailable'
  | 'unknown';
export type CapabilitySource = 'builtin' | 'mcp' | 'browser' | 'computer' | 'memory' | 'goal' | 'skill' | 'connector';

export interface ProgressiveCapabilityGroup {
  source: CapabilitySource;
  count: number;
  names: readonly string[];
  truncated: boolean;
}

export interface EffectiveCapabilityItem {
  id: string;
  kind: 'tool' | 'skill' | 'connector' | 'computer';
  availability: CapabilityAvailability;
  readiness: CapabilityReadiness;
  freshness: CapabilityFreshness;
  coverage: CapabilityCoverage;
  permissionSource: string;
  selectedRoute?: string;
  routeOwner?: string;
  capabilities?: readonly string[];
  actionCount?: number;
  operations?: readonly Readonly<{
    capability: string;
    action: string;
    effect: 'read' | 'write' | 'unknown';
    usage?: string;
  }>[];
  safeFallback?: 'not_started_or_failed_safe' | 'none';
}

export interface EffectiveCapabilitySnapshot {
  schemaVersion: 1;
  runId: string;
  policyRevision: string;
  toolSetDigest: string;
  snapshotDigest: string;
  observedAt: string;
  tools: readonly string[];
  hiddenToolCount: number;
  hiddenTools: readonly Readonly<ProgressiveCapabilityGroup>[];
  skills: readonly string[];
  items: readonly Readonly<EffectiveCapabilityItem>[];
}

export interface EffectiveCapabilitySnapshotInput {
  runId: string;
  policyRevision: string;
  toolNames: readonly string[];
  hiddenTools?: readonly ProgressiveCapabilityGroup[];
  skillNames?: readonly string[];
  observedAt?: string;
  items?: readonly EffectiveCapabilityItem[];
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function canonicalNames(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function createEffectiveCapabilitySnapshot(
  input: EffectiveCapabilitySnapshotInput,
): Readonly<EffectiveCapabilitySnapshot> {
  const tools = canonicalNames(input.toolNames);
  const hiddenTools = [...(input.hiddenTools ?? [])]
    .map((group) => ({
      source: group.source,
      count: group.count,
      names: Object.freeze(canonicalNames(group.names)),
      truncated: group.truncated,
    }))
    .filter((group) => group.count > 0)
    .sort((left, right) => left.source.localeCompare(right.source));
  const hiddenToolCount = hiddenTools.reduce((total, group) => total + group.count, 0);
  const skills = canonicalNames(input.skillNames ?? []);
  const explicit = new Map((input.items ?? []).map((item) => [`${item.kind}:${item.id}`, item]));
  const generated: EffectiveCapabilityItem[] = [
    ...tools.map((id): EffectiveCapabilityItem => explicit.get(`tool:${id}`) ?? {
      id,
      kind: 'tool',
      availability: 'available',
      readiness: 'ready',
      freshness: 'fresh',
      coverage: 'complete',
      permissionSource: input.policyRevision,
      safeFallback: 'not_started_or_failed_safe',
    }),
    ...skills.map((id): EffectiveCapabilityItem => explicit.get(`skill:${id}`) ?? {
      id,
      kind: 'skill',
      availability: 'available',
      readiness: 'ready',
      freshness: 'fresh',
      coverage: 'bounded',
      permissionSource: input.policyRevision,
      safeFallback: 'not_started_or_failed_safe',
    }),
    ...(input.items ?? []).filter((item) =>
      item.kind !== 'tool' && item.kind !== 'skill'),
  ].sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  const toolSetDigest = digest(tools);
  const snapshotCore = {
    schemaVersion: 1 as const,
    runId: input.runId,
    policyRevision: input.policyRevision,
    toolSetDigest,
    observedAt: input.observedAt ?? new Date().toISOString(),
    tools,
    hiddenToolCount,
    hiddenTools,
    skills,
    items: generated,
  };
  const snapshot = {
    ...snapshotCore,
    snapshotDigest: digest(snapshotCore),
    tools: Object.freeze(tools),
    hiddenTools: Object.freeze(hiddenTools.map((group) => Object.freeze(group))),
    skills: Object.freeze(skills),
    items: Object.freeze(generated.map((item) => Object.freeze({ ...item }))),
  };
  return Object.freeze(snapshot);
}

export function renderEffectiveCapabilitySnapshot(
  snapshot: Readonly<EffectiveCapabilitySnapshot>,
): string {
  const routedItems = snapshot.items
    .filter((item) => item.kind === 'connector' || item.kind === 'computer')
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      availability: item.availability,
      readiness: item.readiness,
      coverage: item.coverage,
      selectedRoute: item.selectedRoute,
      capabilities: item.capabilities,
      actionCount: item.actionCount,
    }));
  if (routedItems.length === 0 && snapshot.hiddenToolCount === 0) return '';
  return [
    '## Effective Capability Snapshot',
    '可信 Host 统一能力索引：hiddenTools 已授权、仅隐藏 schema；使用前以 inspect_capabilities 按 source/name/query 查询，再由 invoke_capability 调用。Connector 摘要只含公开 action，缺项不代表其他 Host 能力不存在；判定不可用或换路前必须查统一目录，unavailable/unknown 禁止猜替代路线。',
    JSON.stringify({
      schemaVersion: snapshot.schemaVersion,
      policyRevision: snapshot.policyRevision,
      snapshotDigest: snapshot.snapshotDigest,
      ...(snapshot.hiddenToolCount > 0 ? { progressiveDisclosure: {
        visibleToolCount: snapshot.tools.length,
        hiddenToolCount: snapshot.hiddenToolCount,
        hiddenTools: snapshot.hiddenTools,
      } } : {}),
      routedItems,
    }),
  ].join('\n');
}

export class CapabilityResolver {
  resolve(input: CapabilityResolverInput): Readonly<ResolvedCapabilities> {
    const allowed = new Set(input.policy?.allowedCapabilities ?? []);
    const canReadLocal = !input.policy || allowed.has('read');
    const executableCompletion = input.scope.mode !== 'plan'
      && input.runtimeAccess.workspaceWrite;
    const completionToolsAllowed = executableCompletion
      && (!input.policy || allowed.has('state-read'))
      && (!input.policy?.allowedTools
        || (input.policy.allowedTools.includes('prepare_task')
          && input.policy.allowedTools.includes('finish_task')));
    return Object.freeze({
      canReadLocal,
      canReadMemory: !input.policy || allowed.has('memory-read'),
      canReadState: !input.policy || allowed.has('state-read'),
      canReadSessionContext: input.policy?.allowSessionContext !== false,
      completionToolsAllowed,
      computerAccess: input.runtimeAccess.computer
        && (!input.scope.cause || input.scope.cause.trust === 'owner')
        ? input.requestedComputerAccess
          ?? input.policy?.computerAccess
          ?? input.defaultComputerAccess
          ?? 'none'
        : 'none',
    });
  }
}
