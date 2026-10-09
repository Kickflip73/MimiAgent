import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ContextManifest } from './context.js';
import { assertSessionId } from './session-id.js';
import { AtomicJsonStore } from './state-file.js';

const count = z.number().nonnegative().finite();
const manifestSchema = z.object({
  requestId: z.string(), sessionId: z.string(), runId: z.string(),
  provider: z.string(), model: z.string(), estimator: z.string(),
  contextWindow: count, outputReserve: count, availableInputBudget: count,
  estimatedInputTokens: count, createdAt: z.iso.datetime(),
  sections: z.array(z.object({
    id: z.enum(['base-instructions', 'session-state', 'soul', 'behavior-preferences',
      'runtime-context', 'project-guidance', 'goal-plan-team', 'recovery', 'memory-cards',
      'skill-catalog', 'active-skills', 'work-snapshot', 'archive', 'recent-history',
      'current-input', 'tool-schemas', 'protocol-reserve']),
    estimatedTokens: count, itemCount: count.optional(), truncated: z.boolean(),
  })).max(100),
  compression: z.array(z.object({
    strategy: z.enum(['microcompact', 'collapse', 'full-compact', 'turn-truncation', 'input-fit', 'semantic-summary', 'tool-result-summary']),
    affectedItems: count, beforeTokens: count, afterTokens: count,
  })).max(500),
  actual: z.object({
    inputTokens: count, outputTokens: count, totalTokens: count,
    runInputTokens: count.optional(), runOutputTokens: count.optional(), runTotalTokens: count.optional(),
    receivedAt: z.iso.datetime(),
  }).optional(),
});

/** A small derived snapshot, separate from authoritative transcripts and execution receipts. */
export class ContextManifestStore {
  private file(sessionId: string) {
    assertSessionId(sessionId);
    return path.join(this.directory, `${sessionId}.json`);
  }
  constructor(private readonly directory: string) {}

  async read(sessionId: string): Promise<ContextManifest | undefined> {
    let handle;
    try {
      handle = await open(this.file(sessionId), constants.O_RDONLY | constants.O_NOFOLLOW);
      if ((await handle.stat()).size > 128 * 1024) return undefined;
      const state = JSON.parse(await handle.readFile('utf8'));
      const parsed = manifestSchema.safeParse(state.manifest);
      return parsed.success && parsed.data.sessionId === sessionId ? parsed.data : undefined;
    } catch { return undefined; } finally { await handle?.close(); }
  }

  private store(sessionId: string) {
    return new AtomicJsonStore<{ manifest?: ContextManifest }>(this.file(sessionId), {
      defaultValue: () => ({}), recoverCorrupt: true,
      decode: (value) => z.object({ manifest: manifestSchema.optional() }).parse(value),
    });
  }

  async clear(sessionId: string): Promise<void> {
    await this.store(sessionId).update((state) => { delete state.manifest; }, AbortSignal.timeout(250));
  }

  async save(manifest: ContextManifest): Promise<void> {
    const validated = manifestSchema.parse(manifest);
    await this.store(validated.sessionId).updateWhen((state) => {
      const previous = state.manifest;
      if (previous && (previous.createdAt > validated.createdAt
        || (previous.requestId === validated.requestId && previous.actual && !validated.actual))) {
        return { result: undefined, changed: false };
      }
      state.manifest = validated;
      return { result: undefined, changed: true };
    }, AbortSignal.timeout(250));
  }
}
