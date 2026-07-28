import { createHash } from 'node:crypto';
import type { MemoryDocument, MemoryRef, MemoryScope } from '../../core/memory.js';
import type { WikiVault } from './wiki-vault.js';

export type TopicMatch = 'target-ref' | 'canonical-id' | 'title' | 'alias' | 'new-topic';

export interface TopicResolution {
  action: 'create' | 'update';
  ref: MemoryRef;
  canonicalKey: string;
  matchedBy: TopicMatch;
  existing?: MemoryDocument;
  duplicateRefs: MemoryRef[];
}

export function normalizeTopicName(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ');
}

export function canonicalTopicKey(scope: MemoryScope, title: string): string {
  return `${scope}:${normalizeTopicName(title)}`;
}

export function canonicalMemoryPageId(scope: MemoryScope, canonicalKey: string): string {
  return `mem_${createHash('sha256').update(`${scope}\0${canonicalKey}`).digest('hex').slice(0, 24)}`;
}

function refFor(scope: MemoryScope, id: string, profileId?: string): MemoryRef {
  return { scope, id, ...(scope === 'private' && profileId ? { profileId } : {}) };
}

function pageNames(page: MemoryDocument): Array<{ value: string; type: 'title' | 'alias' }> {
  return [
    { value: normalizeTopicName(page.metadata.title), type: 'title' },
    ...page.metadata.aliases.map((alias) => ({ value: normalizeTopicName(alias), type: 'alias' as const })),
  ];
}

function preferredPage(left: MemoryDocument, right: MemoryDocument, canonicalId: string): number {
  if (left.ref.id === canonicalId && right.ref.id !== canonicalId) return -1;
  if (right.ref.id === canonicalId && left.ref.id !== canonicalId) return 1;
  const statusOrder = { active: 0, conflicted: 1, proposed: 2, superseded: 3, expired: 4 } as const;
  const status = statusOrder[left.metadata.status] - statusOrder[right.metadata.status];
  if (status !== 0) return status;
  const created = left.metadata.createdAt.localeCompare(right.metadata.createdAt);
  return created || left.ref.id.localeCompare(right.ref.id);
}

export async function resolveMemoryTopic(
  vault: WikiVault,
  input: {
    scope: MemoryScope;
    profileId?: string;
    title: string;
    aliases?: string[];
    targetRef?: MemoryRef;
    canonicalKey?: string;
  },
): Promise<TopicResolution> {
  const canonicalKey = input.canonicalKey?.trim() || canonicalTopicKey(input.scope, input.title);
  const canonicalId = canonicalMemoryPageId(input.scope, canonicalKey);
  if (input.targetRef) {
    if (input.targetRef.scope !== input.scope
      || (input.scope === 'private' && input.targetRef.profileId !== input.profileId)) {
      throw new Error('Memory targetRef 与当前 scope/profile 不匹配');
    }
    const existing = await vault.read(input.targetRef);
    return {
      action: 'update',
      ref: existing.ref,
      canonicalKey: existing.metadata.canonicalKey ?? canonicalKey,
      matchedBy: 'target-ref',
      existing,
      duplicateRefs: [],
    };
  }

  const requestedNames = new Set([
    normalizeTopicName(input.title),
    ...(input.aliases ?? []).map(normalizeTopicName),
  ].filter(Boolean));
  const pages = await vault.list();
  const matches = pages.filter((page) => pageNames(page).some((name) => requestedNames.has(name.value)));
  const canonical = pages.find((page) => page.ref.id === canonicalId);
  if (canonical && !matches.some((page) => page.ref.id === canonical.ref.id)) matches.push(canonical);
  matches.sort((left, right) => preferredPage(left, right, canonicalId));
  const existing = matches[0];
  if (existing) {
    const matchedNames = pageNames(existing);
    const matchedBy: TopicMatch = existing.ref.id === canonicalId
      ? 'canonical-id'
      : matchedNames.some((name) => name.type === 'title' && requestedNames.has(name.value))
        ? 'title'
        : 'alias';
    return {
      action: 'update',
      ref: existing.ref,
      canonicalKey: existing.metadata.canonicalKey ?? canonicalKey,
      matchedBy,
      existing,
      duplicateRefs: matches.slice(1).map((page) => page.ref),
    };
  }

  return {
    action: 'create',
    ref: refFor(input.scope, canonicalId, input.profileId),
    canonicalKey,
    matchedBy: 'new-topic',
    duplicateRefs: [],
  };
}
