import { createHash } from 'node:crypto';
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
  policy?: CapabilityPolicy;
  requestedComputerAccess?: ComputerAccess;
  defaultComputerAccess?: ComputerAccess;
  developmentTask: boolean;
  expectedArtifactCompletion: boolean;
}

export interface ResolvedCapabilities {
  canReadLocal: boolean;
  canReadMemory: boolean;
  canReadState: boolean;
  canReadSessionContext: boolean;
  canInitializeProjectGuidance: boolean;
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

export interface EffectiveCapabilityItem {
  id: string;
  kind: 'tool' | 'skill' | 'connector' | 'computer';
  availability: CapabilityAvailability;
  readiness: CapabilityReadiness;
  freshness: CapabilityFreshness;
  coverage: CapabilityCoverage;
  permissionSource: string;
  selectedRoute?: string;
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
  skills: readonly string[];
  items: readonly Readonly<EffectiveCapabilityItem>[];
}

export interface EffectiveCapabilitySnapshotInput {
  runId: string;
  policyRevision: string;
  toolNames: readonly string[];
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
    skills,
    items: generated,
  };
  const snapshot = {
    ...snapshotCore,
    snapshotDigest: digest(snapshotCore),
    tools: Object.freeze(tools),
    skills: Object.freeze(skills),
    items: Object.freeze(generated.map((item) => Object.freeze({ ...item }))),
  };
  return Object.freeze(snapshot);
}

export class CapabilityResolver {
  resolve(input: CapabilityResolverInput): Readonly<ResolvedCapabilities> {
    const allowed = new Set(input.policy?.allowedCapabilities ?? []);
    const canReadLocal = !input.policy || allowed.has('read');
    const executableCompletion = input.scope.mode !== 'plan'
      && !(input.scope.permissionMode === 'read-only' && input.expectedArtifactCompletion);
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
      canInitializeProjectGuidance: canReadLocal
        && input.scope.mode !== 'plan'
        && input.scope.permissionMode !== 'read-only'
        && (!input.policy || allowed.has('write'))
        && input.developmentTask,
      completionToolsAllowed,
      computerAccess: input.requestedComputerAccess
        ?? input.policy?.computerAccess
        ?? (input.scope.cause ? 'none' : input.defaultComputerAccess ?? 'none'),
    });
  }
}
