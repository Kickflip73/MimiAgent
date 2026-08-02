import { createHash } from 'node:crypto';
import type { MimiHost } from '../runtime/mimi-host.js';
import type { MimiChatSnapshot, MimiHistoryChunk } from './types.js';

const CHAT_SNAPSHOT_MAX_BYTES = 512 * 1024;
const HISTORY_CHUNK_CHARACTERS = 256 * 1024;

function boundedChatItems(
  items: MimiChatSnapshot['items'],
  itemLimit: number,
): MimiChatSnapshot['items'] {
  const limit = Math.max(1, Math.min(200, Math.trunc(itemLimit)));
  const selected = items.filter((item) => (
    'role' in item && (item.role === 'user' || item.role === 'assistant')
  )).slice(-limit);
  while (selected.length > 1
    && Buffer.byteLength(JSON.stringify(selected), 'utf8') > CHAT_SNAPSHOT_MAX_BYTES) {
    selected.shift();
  }
  if (Buffer.byteLength(JSON.stringify(selected), 'utf8') <= CHAT_SNAPSHOT_MAX_BYTES) return selected;
  const last = selected.at(-1);
  if (!last || !('role' in last) || (last.role !== 'user' && last.role !== 'assistant')) return [];
  return [{
    role: last.role,
    content: '[最近一条对话超过 CLI 快照上限；请使用 /history 分块读取完整权威历史。]',
  } as MimiChatSnapshot['items'][number]];
}

export async function createMimiChatSnapshot(
  host: Pick<MimiHost, 'snapshot'>,
  sessionId: string,
  workspaceRoot: string,
  itemLimit = 30,
): Promise<MimiChatSnapshot> {
  const snapshot = await host.snapshot(sessionId);
  return {
    sessionId: snapshot.sessionId,
    workspaceRoot,
    provider: snapshot.runtime.provider,
    model: snapshot.runtime.model,
    mode: snapshot.runtime.mode.label,
    outputLevel: snapshot.runtime.outputLevel,
    permissionMode: snapshot.runtime.permissionMode,
    securityProfile: snapshot.runtime.securityProfile,
    contextUsed: snapshot.context.status.value,
    contextWindow: snapshot.context.contextWindow,
    contextStatus: snapshot.context.status,
    items: boundedChatItems(snapshot.items, itemLimit),
    plan: snapshot.plan.slice(0, 20).map((step) => ({
      ...step,
      id: step.id.slice(0, 100),
      description: step.description.slice(0, 1_000),
    })),
    recovery: snapshot.recovery,
  };
}

export async function createMimiHistoryChunk(
  host: Pick<MimiHost, 'snapshot'>,
  sessionId: string,
  offset = 0,
  expectedRevision?: string,
): Promise<MimiHistoryChunk> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('history offset 必须是非负安全整数');
  const snapshot = await host.snapshot(sessionId);
  const source = JSON.stringify(snapshot.items);
  const revision = createHash('sha256').update(source).digest('hex');
  if (expectedRevision && expectedRevision !== revision) {
    throw new Error('Session 历史在读取期间发生变化，请重试 /history');
  }
  if (offset > source.length) throw new Error('history offset 超出当前 Session 历史');
  const end = Math.min(source.length, offset + HISTORY_CHUNK_CHARACTERS);
  return {
    chunk: source.slice(offset, end),
    nextOffset: end < source.length ? end : undefined,
    revision,
    totalCharacters: source.length,
  };
}
