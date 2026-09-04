import type { AgentInputItem } from '@openai/agents';
import { estimateTokens } from '../../core/context.js';
import type { GuidanceSnapshot } from '../../core/guidance.js';
import type {
  MemoryCard,
  MemoryHub,
  MemoryRef,
  PersonalContext,
  PersonalContextItem,
  RunMemoryContext,
} from '../../core/memory.js';
import {
  personalContextSection,
  PersonalContextAssembler,
} from '../../extensions/memory/personal-context-assembler.js';
import type { Goal, PlanStep } from '../../core/plan.js';
import type { ActivatedSkill, ContextArchive } from '../../core/session.js';
import type { ResolvedCapabilities } from './capability-resolver.js';

export interface RunStateLoaderDependencies {
  hotProfile: () => Promise<MemoryCard[]>;
  searchMemories: (state: {
    goal?: Readonly<Goal>;
    history: readonly AgentInputItem[];
  }) => Promise<MemoryCard[]>;
  loadPersonalContextCandidates: () => Promise<MemoryCard[]>;
  loadPlan: () => Promise<PlanStep[]>;
  loadGoal: () => Promise<Goal | undefined>;
  loadTeamSummary: () => Promise<string>;
  loadHistory: () => Promise<AgentInputItem[]>;
  loadSoul: () => Promise<GuidanceSnapshot>;
  loadPreferences: () => Promise<GuidanceSnapshot>;
  loadProjectGuidance: () => Promise<GuidanceSnapshot>;
  loadArchive: () => Promise<ContextArchive | undefined>;
  loadActiveSkills: () => Promise<ActivatedSkill[]>;
}

export interface RunStateSnapshot {
  readonly memories: readonly MemoryCard[];
  readonly personalContext: Readonly<Omit<PersonalContext, 'items' | 'derivedFrom'>> & {
    readonly items: readonly PersonalContextItem[];
    readonly derivedFrom: readonly MemoryRef[];
  };
  readonly plan: readonly PlanStep[];
  readonly storedGoal?: Readonly<Goal>;
  readonly teamSummary: string;
  readonly history: readonly AgentInputItem[];
  readonly soul: Readonly<GuidanceSnapshot>;
  readonly preferences: Readonly<GuidanceSnapshot>;
  readonly projectGuidance: Readonly<GuidanceSnapshot>;
  readonly storedArchive?: Readonly<ContextArchive>;
  readonly activeSkills: readonly Readonly<ActivatedSkill>[];
}

const EMPTY_GUIDANCE: GuidanceSnapshot = Object.freeze({ instructions: '', files: [] });

export interface PersonalContextCandidateOptions {
  now?: Date;
  timeZone: string;
  limit?: number;
}

function memoryKey(card: MemoryCard): string {
  return `${card.ref.scope}:${card.ref.profileId ?? ''}:${card.ref.id}`;
}

function uniqueCards(cards: readonly MemoryCard[]): MemoryCard[] {
  const seen = new Set<string>();
  return cards.filter((card) => {
    const key = memoryKey(card);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function loadPersonalContextCandidates(
  hub: Pick<MemoryHub, 'list'>,
  context: RunMemoryContext,
  options: PersonalContextCandidateOptions,
): Promise<MemoryCard[]> {
  const now = options.now ?? new Date();
  // Validate the injected IANA zone before using it to classify owner-local dates.
  new Intl.DateTimeFormat('en-US', { timeZone: options.timeZone }).format(now);
  const limit = Math.min(200, Math.max(4, Math.trunc(options.limit ?? 96)));
  const [related, conflicted, stale] = await Promise.all([
    hub.list(context, {
      status: 'active',
      order: 'recent',
      relationKinds: [
        'today-focus',
        'focus',
        'commitment',
        'committed-to',
        'waiting-on',
        'blocked-by',
        'project-risk',
        'risk',
      ],
      limit,
    }),
    hub.list(context, { status: 'conflicted', order: 'recent', limit: Math.min(32, limit) }),
    hub.list(context, { status: 'active', stale: true, order: 'recent', limit: Math.min(32, limit) }),
  ]);
  return uniqueCards([...related, ...conflicted, ...stale])
    .filter((card) => personalContextSection(card, { now, timeZone: options.timeZone }) !== undefined)
    .slice(0, limit);
}

function takeCardsWithinBudget(cards: readonly MemoryCard[], tokenBudget: number): {
  cards: MemoryCard[];
  estimatedTokens: number;
} {
  const selected: MemoryCard[] = [];
  let estimatedTokens = 0;
  for (const card of cards) {
    const tokens = estimateTokens(`${card.title}\n${card.summary}`);
    if (estimatedTokens + tokens > tokenBudget) continue;
    selected.push(card);
    estimatedTokens += tokens;
  }
  return { cards: selected, estimatedTokens };
}

export class RunStateLoader {
  constructor(private readonly dependencies: RunStateLoaderDependencies) {}

  async load(
    capabilities: ResolvedCapabilities,
    options: {
      loadOwnerSoul?: boolean;
      loadOwnerPreferences?: boolean;
      memoryTokenBudget?: number;
      now?: Date;
      ownerTimeZone?: string;
      includePersonalContext?: boolean;
      loadTaskDetails?: boolean;
    } = {},
  ): Promise<RunStateSnapshot> {
    const [
      plan,
      storedGoal,
      teamSummary,
      history,
      soul,
      preferences,
      projectGuidance,
      storedArchive,
      activeSkills,
    ] = await Promise.all([
      capabilities.canReadState && options.loadTaskDetails !== false
        ? this.dependencies.loadPlan()
        : Promise.resolve([]),
      capabilities.canReadState ? this.dependencies.loadGoal() : Promise.resolve(undefined),
      capabilities.canReadState && options.loadTaskDetails !== false
        ? this.dependencies.loadTeamSummary()
        : Promise.resolve(''),
      capabilities.canReadSessionContext ? this.dependencies.loadHistory() : Promise.resolve([]),
      capabilities.canReadLocal || options.loadOwnerSoul === true
        ? this.dependencies.loadSoul()
        : Promise.resolve(EMPTY_GUIDANCE),
      options.loadOwnerPreferences === true
        ? this.dependencies.loadPreferences()
        : Promise.resolve(EMPTY_GUIDANCE),
      capabilities.canReadLocal
        ? this.dependencies.loadProjectGuidance()
        : Promise.resolve(EMPTY_GUIDANCE),
      capabilities.canReadSessionContext ? this.dependencies.loadArchive() : Promise.resolve(undefined),
      capabilities.canReadSessionContext ? this.dependencies.loadActiveSkills() : Promise.resolve([]),
    ]);
    const [memoryCards, personalContextCandidates] = capabilities.canReadMemory
      ? await Promise.all([
        this.dependencies.searchMemories({ goal: storedGoal, history }),
        options.includePersonalContext !== false
          ? this.dependencies.loadPersonalContextCandidates()
          : Promise.resolve([]),
      ])
      : [[], []];
    const uniqueMemories = uniqueCards(memoryCards);
    const tokenBudget = Math.max(0, Math.trunc(options.memoryTokenBudget ?? 900));
    const now = options.now ?? new Date();
    const ownerTimeZone = options.ownerTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const personalBudget = uniqueMemories.length === 0
      ? tokenBudget
      : Math.min(tokenBudget, Math.max(360, Math.floor(tokenBudget * 0.6)));
    const assembledPersonalContext = new PersonalContextAssembler().assemble(personalContextCandidates, {
      tokenBudget: personalBudget,
      now,
      timeZone: ownerTimeZone,
    });
    const personalRefs = new Set(assembledPersonalContext.items.map((item) => memoryKey(item.card)));
    const querySelection = takeCardsWithinBudget(
      uniqueMemories.filter((card) => !personalRefs.has(memoryKey(card))),
      Math.max(0, tokenBudget - assembledPersonalContext.estimatedTokens),
    );
    const personalContext = {
      ...assembledPersonalContext,
      estimatedTokens: assembledPersonalContext.estimatedTokens + querySelection.estimatedTokens,
    };
    const memories = [...querySelection.cards, ...personalContext.items.map((item) => ({
      ...item.card,
      summary: `[${item.section}] ${item.card.summary}`,
    }))];
    return Object.freeze({
      memories: Object.freeze(memories),
      personalContext: Object.freeze({
        ...personalContext,
        items: Object.freeze(personalContext.items),
        derivedFrom: Object.freeze(personalContext.derivedFrom),
      }),
      plan: Object.freeze(plan),
      storedGoal: storedGoal ? Object.freeze({ ...storedGoal }) : undefined,
      teamSummary,
      history: Object.freeze(history),
      soul: Object.freeze(soul),
      preferences: Object.freeze(preferences),
      projectGuidance: Object.freeze(projectGuidance),
      storedArchive: storedArchive ? Object.freeze({ ...storedArchive }) : undefined,
      activeSkills: Object.freeze(activeSkills.map((skill) => Object.freeze({ ...skill }))),
    });
  }
}
