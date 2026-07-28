import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  ConnectorManager,
  ConnectorReadProbeReceipt,
} from './connectors.js';
import type { ComputerReadProbeReceipt } from '../extensions/computer/manager.js';

export const readOnlyProbeProfileSchema = z.enum([
  'browser-tabs',
  'shortcuts-catalog',
  'computer-window',
  'screen-window',
]);
export type ReadOnlyProbeProfile = z.infer<typeof readOnlyProbeProfileSchema>;

export const readOnlyProbeRequestSchema = z.object({
  profile: readOnlyProbeProfileSchema,
}).strict();

export interface ReadOnlyProbeReceipt {
  receiptId: string;
  observedAt: string;
  profile: ReadOnlyProbeProfile;
  evidence: ({ kind: 'live_action' } & Omit<ConnectorReadProbeReceipt, 'result'>)
    | ({ kind: 'live_action' } & Omit<ComputerReadProbeReceipt, 'target'>);
  classification: 'readonly-probe-ok';
  metadata: {
    itemCount?: number;
    total?: number;
    unavailableCount?: number;
    truncated?: boolean;
    charCount?: number;
    lineCount?: number;
    capturedBytes?: number;
  };
}

interface StableWindowTarget {
  bundleId: string;
  pid: number;
  windowId: number;
}

export interface ReadOnlyProbeDependencies {
  connectors: ConnectorManager;
  computerWindow: (
    expectedTarget?: StableWindowTarget,
    signal?: AbortSignal,
  ) => Promise<ComputerReadProbeReceipt>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function connectorEvidence(
  receipt: ConnectorReadProbeReceipt,
): { kind: 'live_action' } & Omit<ConnectorReadProbeReceipt, 'result'> {
  const { result: _, ...evidence } = receipt;
  return { kind: 'live_action', ...evidence };
}

function browserMetadata(result: unknown): ReadOnlyProbeReceipt['metadata'] {
  const value = object(result);
  return {
    itemCount: Array.isArray(value.tabs) ? value.tabs.length : 0,
    ...(number(value.total) !== undefined ? { total: number(value.total) } : {}),
    unavailableCount: Array.isArray(value.unavailable) ? value.unavailable.length : 0,
    truncated: value.truncated === true,
  };
}

function shortcutsMetadata(result: unknown): ReadOnlyProbeReceipt['metadata'] {
  const value = object(result);
  return {
    itemCount: Array.isArray(value.items) ? value.items.length : 0,
    truncated: value.truncated === true,
  };
}

function screenMetadata(result: unknown): ReadOnlyProbeReceipt['metadata'] {
  const value = object(result);
  const text = typeof value.text === 'string' ? value.text : '';
  return {
    charCount: number(value.charCount) ?? text.length,
    lineCount: number(value.lineCount) ?? (text ? text.split(/\r?\n/u).length : 0),
    capturedBytes: number(value.capturedBytes) ?? number(value.imageBytes) ?? 0,
    truncated: value.truncated === true,
  };
}

export async function executeReadOnlyProbe(
  rawRequest: unknown,
  dependencies: ReadOnlyProbeDependencies,
  signal?: AbortSignal,
): Promise<ReadOnlyProbeReceipt> {
  const request = readOnlyProbeRequestSchema.parse(rawRequest);
  if (request.profile === 'computer-window') {
    const receipt = await dependencies.computerWindow(undefined, signal);
    const { target: _, ...computerEvidence } = receipt;
    return {
      receiptId: randomUUID(),
      observedAt: new Date().toISOString(),
      profile: request.profile,
      evidence: { kind: 'live_action', ...computerEvidence },
      classification: 'readonly-probe-ok',
      metadata: {},
    };
  }
  if (request.profile === 'browser-tabs') {
    const receipt = await dependencies.connectors.executeReadProbe({
      connector: 'macos-browser',
      action: 'list_tabs',
      capability: 'browser.tabs.read',
      target: 'all',
      payload: { limit: 5 },
    });
    return {
      receiptId: randomUUID(),
      observedAt: new Date().toISOString(),
      profile: request.profile,
      evidence: connectorEvidence(receipt),
      classification: 'readonly-probe-ok',
      metadata: browserMetadata(receipt.result),
    };
  }
  if (request.profile === 'shortcuts-catalog') {
    const receipt = await dependencies.connectors.executeReadProbe({
      connector: 'macos-shortcuts',
      action: 'list_folders',
      capability: 'shortcuts.catalog.read',
      target: 'all',
      payload: { limit: 5 },
    });
    return {
      receiptId: randomUUID(),
      observedAt: new Date().toISOString(),
      profile: request.profile,
      evidence: connectorEvidence(receipt),
      classification: 'readonly-probe-ok',
      metadata: shortcutsMetadata(receipt.result),
    };
  }
  const before = await dependencies.computerWindow(undefined, signal);
  const receipt = await dependencies.connectors.executeReadProbe({
    connector: 'macos-screen',
    action: 'read_screen',
    capability: 'screen.content.read',
    target: `window:${before.target.windowId}`,
    payload: {
      maxChars: 2_000,
      maxLines: 50,
      recognitionLevel: 'fast',
    },
  });
  await dependencies.computerWindow(before.target, signal);
  return {
    receiptId: randomUUID(),
    observedAt: new Date().toISOString(),
    profile: request.profile,
    evidence: connectorEvidence(receipt),
    classification: 'readonly-probe-ok',
    metadata: screenMetadata(receipt.result),
  };
}

export function assertReadOnlyProbeIdle(status: {
  activeEventCount?: number;
  activeTaskCount?: number;
  activeHostMutations?: number;
  tasks?: { running?: number };
  outbox?: { pending?: number; sending?: number };
}): void {
  if (status.activeEventCount !== 0
    || status.activeTaskCount !== 0
    || status.activeHostMutations !== 0
    || status.tasks?.running !== 0
    || status.outbox?.pending !== 0
    || status.outbox?.sending !== 0) {
    throw new Error('read-only probe gate blocked: daemon/Event/Task/Outbox/host mutation is not idle');
  }
}
