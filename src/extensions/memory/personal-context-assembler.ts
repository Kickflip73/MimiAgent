import { estimateTokens } from '../../core/context.js';
import type {
  MemoryCard,
  PersonalContext,
  PersonalContextItem,
} from '../../core/memory.js';

export interface PersonalContextAssemblyOptions {
  tokenBudget: number;
  now?: Date;
  timeZone: string;
}

const SECTION_ORDER: PersonalContextItem['section'][] = [
  'today-focus',
  'recent-commitments',
  'waiting-on-others',
  'project-risks',
];

const SECTION_LABELS: Record<PersonalContextItem['section'], string> = {
  'today-focus': 'Today focus',
  'recent-commitments': 'Recent commitments',
  'waiting-on-others': 'Waiting on others',
  'project-risks': 'Project risks',
};

function key(card: MemoryCard): string {
  return `${card.ref.scope}:${card.ref.profileId ?? ''}:${card.ref.id}`;
}

function ownerDate(date: Date, timeZone: string): string | undefined {
  if (!Number.isFinite(date.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = new Map(parts.map((part) => [part.type, part.value]));
  const year = value.get('year');
  const month = value.get('month');
  const day = value.get('day');
  return year && month && day ? `${year}-${month}-${day}` : undefined;
}

function sameOwnerDay(timestamp: string | null | undefined, now: Date, timeZone: string): boolean {
  if (!timestamp) return false;
  const date = new Date(timestamp);
  return ownerDate(date, timeZone) === ownerDate(now, timeZone);
}

function recent(timestamp: string | null | undefined, now: Date): boolean {
  if (!timestamp) return true;
  const occurredAt = Date.parse(timestamp);
  if (!Number.isFinite(occurredAt)) return false;
  const age = now.getTime() - occurredAt;
  return age >= -86_400_000 && age <= 31 * 86_400_000;
}

function isCurrentlyValid(card: MemoryCard, now: Date): boolean {
  const validFrom = card.facets?.time.validFrom;
  if (validFrom) {
    const timestamp = Date.parse(validFrom);
    if (!Number.isFinite(timestamp) || timestamp > now.getTime()) return false;
  }
  const validUntil = card.facets?.time.validUntil;
  if (validUntil) {
    const timestamp = Date.parse(validUntil);
    if (!Number.isFinite(timestamp) || timestamp < now.getTime()) return false;
  }
  return true;
}

export function personalContextSection(
  card: MemoryCard,
  options: Pick<PersonalContextAssemblyOptions, 'now' | 'timeZone'>,
): PersonalContextItem['section'] | undefined {
  const now = options.now ?? new Date();
  if ((card.status !== 'active' && card.status !== 'conflicted') || !isCurrentlyValid(card, now)) {
    return undefined;
  }
  const relations = new Set(card.facets?.relations.map((relation) => relation.kind.toLowerCase()) ?? []);
  if (relations.has('waiting-on') || relations.has('blocked-by')) return 'waiting-on-others';
  if (relations.has('project-risk') || relations.has('risk') || card.status === 'conflicted' || card.stale) {
    return 'project-risks';
  }
  const occurredAt = card.facets?.time.validFrom
    ?? card.facets?.time.occurredAt
    ?? card.sourceRefs.at(-1)?.occurredAt;
  if ((relations.has('commitment') || relations.has('committed-to')) && recent(occurredAt, now)) {
    return 'recent-commitments';
  }
  if ((relations.has('today-focus') || relations.has('focus'))
    && sameOwnerDay(occurredAt, now, options.timeZone)) return 'today-focus';
  return undefined;
}

function itemText(item: PersonalContextItem): string {
  const card = item.card;
  return `${SECTION_LABELS[item.section]}\n[${card.ref.scope}:${card.ref.id}] ${card.title}: ${card.summary}`;
}

export class PersonalContextAssembler {
  assemble(cards: readonly MemoryCard[], options: PersonalContextAssemblyOptions): PersonalContext {
    const tokenBudget = Math.max(0, Math.trunc(options.tokenBudget));
    const now = options.now ?? new Date();
    const unique = cards.filter((card, index, all) => all.findIndex((candidate) => key(candidate) === key(card)) === index);
    const groups = new Map(SECTION_ORDER.map((section) => [section, [] as MemoryCard[]]));
    let eligible = 0;
    for (const card of unique) {
      const section = personalContextSection(card, { now, timeZone: options.timeZone });
      if (!section) continue;
      groups.get(section)!.push(card);
      eligible += 1;
    }

    const items: PersonalContextItem[] = [];
    const chargedSections = new Set<PersonalContextItem['section']>();
    let estimatedTokens = 0;
    const longest = Math.max(0, ...SECTION_ORDER.map((section) => groups.get(section)!.length));
    for (let index = 0; index < longest; index += 1) {
      for (const section of SECTION_ORDER) {
        const card = groups.get(section)![index];
        if (!card) continue;
        const item: PersonalContextItem = { section, card, derivedFrom: [{ ...card.ref }] };
        const sectionTokens = chargedSections.has(section) ? 0 : estimateTokens(SECTION_LABELS[section]);
        const itemTokens = estimateTokens(itemText(item));
        if (estimatedTokens + sectionTokens + itemTokens > tokenBudget) continue;
        chargedSections.add(section);
        estimatedTokens += sectionTokens + itemTokens;
        items.push(item);
      }
    }
    const complete = items.length === eligible;
    return {
      layer: 'L3',
      items,
      derivedFrom: items.map((item) => ({ ...item.card.ref })),
      estimatedTokens,
      status: complete ? 'complete' : items.length === 0 ? 'blocked' : 'partial',
      complete,
    };
  }
}
