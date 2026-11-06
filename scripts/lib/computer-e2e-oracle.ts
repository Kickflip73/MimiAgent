import type { BackendObservation, ComputerTargetSummary } from '../../src/extensions/computer/types.js';

export function computerOutputRecord(output: unknown): Record<string, unknown> | undefined {
  if (typeof output === 'string') {
    try { return computerOutputRecord(JSON.parse(output) as unknown); } catch { return undefined; }
  }
  if (Array.isArray(output)) return computerOutputRecord(output.find(item => item?.type === 'text')?.text);
  if (!output || typeof output !== 'object') return undefined;
  const record = output as Record<string, unknown>;
  return 'result' in record ? computerOutputRecord(record.result) : record;
}

// Tool receipts establish ownership only. They never establish the expected value.
export function launchedWindowRefs(items: readonly { type?: string; name?: string; callId?: string; arguments?: string; output?: unknown }[]): Set<string> {
  const launches = new Set(items.filter(item => {
    if (item.type !== 'function_call' || item.name !== 'computer_act') return false;
    try { return JSON.parse(item.arguments ?? '{}').action?.type === 'launch_app'; } catch { return false; }
  }).map(item => item.callId).filter((id): id is string => Boolean(id)));
  const refs = new Set<string>();
  for (const item of items) {
    if (item.type !== 'function_call_result' || !item.callId || !launches.has(item.callId)) continue;
    const result = computerOutputRecord(item.output);
    const state = result?.state as Record<string, unknown> | undefined;
    if (result?.ok === true && typeof state?.targetRef === 'string') refs.add(state.targetRef);
  }
  return refs;
}

export function verifyE2EObservation(
  observation: BackendObservation,
  owned: ComputerTargetSummary,
  role: string,
  expected: string,
): boolean {
  const target = observation.target;
  if (!target || target.bundleId !== owned.bundleId || target.pid !== owned.pid || target.windowId !== owned.windowId
    || observation.truncated) return false;
  // Titles, prompts, action payloads, semantic summaries and assistant claims are not evidence.
  const fields = observation.elements?.filter(element => element.role === role && !element.secure && element.value !== undefined) ?? [];
  return fields.length === 1 && !fields[0]!.valueTruncated && String(fields[0]!.value) === expected;
}
