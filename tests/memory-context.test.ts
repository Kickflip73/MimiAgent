import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {
  MemoryCard,
  MemoryRelationFacet,
  RunMemoryContext,
  SourceRef,
} from '../src/core/memory.js';
import { createMemoryHub } from '../src/extensions/memory/hub.js';
import { PersonalContextAssembler } from '../src/extensions/memory/personal-context-assembler.js';
import {
  loadPersonalContextCandidates,
  RunStateLoader,
} from '../src/runtime/pipeline/state-loader.js';

function card(
  id: string,
  relation: MemoryRelationFacet['kind'],
  summary = `Context for ${id}.`,
): MemoryCard {
  return {
    ref: { scope: 'private', profileId: 'owner', id },
    title: id,
    summary,
    kind: relation === 'project-risk' ? 'decision' : 'fact',
    status: relation === 'project-risk' ? 'conflicted' : 'active',
    confidence: 'source-grounded',
    score: 1,
    sourceRefs: [{
      type: 'session', id: `session@${id}`, digest: `sha256:${'a'.repeat(64)}`,
      occurredAt: '2026-08-05T08:00:00.000Z', trust: 'owner',
    }],
    documentType: 'wiki',
    layer: 'L1',
    facets: {
      kind: relation === 'project-risk' ? 'decision' : 'fact',
      entities: ['owner'],
      relations: [{ kind: relation, target: { scope: 'private', profileId: 'owner', id } }],
      time: { occurredAt: '2026-08-05T08:00:00.000Z', validFrom: null, validUntil: null },
      sources: [`session:session@${id}:sha256:${'a'.repeat(64)}`],
    },
    derivedFrom: [],
  };
}

test('Personal Context is a token-budgeted read-only L3 view with four owner sections', () => {
  const cards = [
    card('focus-1', 'today-focus'),
    card('focus-2', 'today-focus'),
    card('commitment-1', 'commitment'),
    card('commitment-2', 'commitment'),
    card('waiting-1', 'waiting-on'),
    card('waiting-2', 'blocked-by'),
    card('risk-1', 'project-risk'),
    card('risk-2', 'project-risk'),
  ];
  const assembler = new PersonalContextAssembler();
  const context = assembler.assemble(cards, {
    tokenBudget: 1_000,
    now: new Date('2026-08-05T10:00:00.000Z'),
    timeZone: 'Asia/Shanghai',
  });

  assert.equal(context.layer, 'L3');
  assert.ok(context.items.length > 3);
  assert.deepEqual([...new Set(context.items.map((item) => item.section))], [
    'today-focus',
    'recent-commitments',
    'waiting-on-others',
    'project-risks',
  ]);
  assert.deepEqual(context.derivedFrom, context.items.map((item) => item.card.ref));
  assert.ok(context.estimatedTokens <= 1_000);
  assert.equal(context.complete, true);
  assert.equal(context.status, 'complete');

  const constrained = assembler.assemble(cards, {
    tokenBudget: 100,
    now: new Date('2026-08-05T10:00:00.000Z'),
    timeZone: 'Asia/Shanghai',
  });
  assert.ok(constrained.items.length < context.items.length);
  assert.ok(constrained.estimatedTokens <= 100);
  assert.equal(constrained.complete, false);
  assert.equal(constrained.status, 'partial');

  const blocked = assembler.assemble(cards, {
    tokenBudget: 0,
    now: new Date('2026-08-05T10:00:00.000Z'),
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.complete, false);
});

test('Personal Context uses owner local day and does not infer sections from generic kinds', () => {
  const now = new Date('2026-08-05T16:30:00.000Z');
  const currentLocalFocus = card('local-focus', 'today-focus');
  currentLocalFocus.facets!.time.occurredAt = '2026-08-05T16:05:00.000Z';
  const previousLocalFocus = card('previous-local-focus', 'today-focus');
  previousLocalFocus.facets!.time.occurredAt = '2026-08-05T15:55:00.000Z';
  const genericFact = card('generic-fact', 'unclassified');
  genericFact.facets!.relations = [];
  genericFact.facets!.time.occurredAt = '2026-08-05T16:10:00.000Z';
  const genericDecision = card('generic-decision', 'unclassified');
  genericDecision.kind = 'decision';
  genericDecision.facets!.kind = 'decision';
  genericDecision.facets!.relations = [];

  const context = new PersonalContextAssembler().assemble([
    currentLocalFocus,
    previousLocalFocus,
    genericFact,
    genericDecision,
  ], { tokenBudget: 1_000, now, timeZone: 'Asia/Shanghai' });

  assert.deepEqual(context.items.map((item) => item.card.ref.id), ['local-focus']);
  assert.deepEqual(context.items.map((item) => item.section), ['today-focus']);
  assert.equal(context.status, 'complete');
});

function source(id: string, occurredAt: string): SourceRef {
  return {
    type: 'session',
    id,
    digest: `sha256:${createHash('sha256').update(id).digest('hex')}`,
    occurredAt,
    trust: 'owner',
  };
}

test('StateLoader merges unrelated query recall with bounded MemoryHub Personal Context candidates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-personal-context-state-loader-'));
  const hub = await createMemoryHub({
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    profileId: 'owner',
    cutover: false,
  });
  const memoryContext: RunMemoryContext = {
    profileId: 'owner',
    workspaceRoot: root,
    sessionId: 'session-context',
    runId: 'run-context',
    cause: { trust: 'owner', source: 'test' },
  };
  const target = { scope: 'private' as const, profileId: 'owner', id: 'mem_owner00000001' };
  const focusEvidence = source('focus-evidence', '2026-08-05T16:05:00.000Z');
  const focusAtom = await hub.remember({
    title: 'Release verification evidence',
    content: 'The release verification checklist is ready for review.',
    kind: 'fact',
    confidence: 'source-grounded',
    layer: 'L1',
    sourceRefs: [focusEvidence],
    facets: { entities: ['MimiAgent'] },
  }, memoryContext);
  const focusScene = await hub.remember({
    title: 'Today release focus',
    content: 'Today the owner is focused on finishing release verification.',
    kind: 'synthesis',
    confidence: 'inferred',
    layer: 'L2',
    sourceRefs: [focusEvidence],
    derivedFrom: [focusAtom.ref],
    facets: {
      entities: ['MimiAgent'],
      relations: [{ kind: 'today-focus', target }],
      time: { occurredAt: focusEvidence.occurredAt },
    },
  }, memoryContext);
  const commitment = await hub.remember({
    title: 'Owner review commitment',
    content: 'The owner committed to reviewing the M2 evidence this week.',
    kind: 'fact',
    layer: 'L1',
    sourceRefs: [source('commitment-evidence', '2026-08-04T08:00:00.000Z')],
    facets: { relations: [{ kind: 'commitment', target }] },
  }, memoryContext);
  const waiting = await hub.remember({
    title: 'Waiting for package approval',
    content: 'The package verification is waiting for the reviewer response.',
    kind: 'fact',
    layer: 'L1',
    sourceRefs: [source('waiting-evidence', '2026-08-03T08:00:00.000Z')],
    facets: { relations: [{ kind: 'waiting-on', target }] },
  }, memoryContext);
  const risk = await hub.remember({
    title: 'M2 release provenance risk',
    content: 'Missing provenance would block the M2 release.',
    kind: 'fact',
    layer: 'L1',
    sourceRefs: [source('risk-evidence', '2026-08-02T08:00:00.000Z')],
    facets: { relations: [{ kind: 'project-risk', target }] },
  }, memoryContext);
  await hub.remember({
    title: 'Same-day generic observation',
    content: 'A generic fact happened today but is not an owner focus.',
    kind: 'fact',
    layer: 'L1',
    sourceRefs: [source('generic-evidence', '2026-08-05T16:10:00.000Z')],
  }, memoryContext);
  await hub.remember({
    title: 'Historical design decision',
    content: 'A design decision is not automatically an owner commitment.',
    kind: 'decision',
    layer: 'L1',
    sourceRefs: [source('decision-evidence', '2026-08-01T08:00:00.000Z')],
  }, memoryContext);

  const unrelatedQuery = '海王星甲烷光谱为何呈蓝色？';
  assert.deepEqual(await hub.search(unrelatedQuery, memoryContext), []);
  assert.equal((await hub.status(memoryContext)).retrievalMode, 'lexical-only');
  const now = new Date('2026-08-05T16:30:00.000Z');
  const candidateCards = await loadPersonalContextCandidates(hub, memoryContext, {
    now,
    timeZone: 'Asia/Shanghai',
    limit: 64,
  });
  assert.deepEqual(new Set(candidateCards.map((card) => card.ref.id)), new Set([
    focusScene.ref.id,
    commitment.ref.id,
    waiting.ref.id,
    risk.ref.id,
  ]));
  const loader = new RunStateLoader({
    hotProfile: async () => [],
    searchMemories: () => hub.search(unrelatedQuery, memoryContext),
    loadPersonalContextCandidates: async () => candidateCards,
    loadPlan: async () => [],
    loadGoal: async () => undefined,
    loadTeamSummary: async () => '',
    loadHistory: async () => [],
    loadSoul: async () => ({ files: [], instructions: '' }),
    loadPreferences: async () => ({ files: [], instructions: '' }),
    loadProjectGuidance: async () => ({ files: [], instructions: '' }),
    loadArchive: async () => undefined,
    loadActiveSkills: async () => [],
  });
  const state = await loader.load({
    canReadLocal: true,
    canReadMemory: true,
    canReadState: true,
    canReadSessionContext: true,
    completionToolsAllowed: true,
    computerAccess: 'none',
  }, { memoryTokenBudget: 1_200, now, ownerTimeZone: 'Asia/Shanghai' });

  assert.deepEqual(state.personalContext.items.map((item) => item.section), [
    'today-focus',
    'recent-commitments',
    'waiting-on-others',
    'project-risks',
  ]);
  assert.deepEqual(new Set(state.personalContext.derivedFrom.map((ref) => ref.id)), new Set([
    focusScene.ref.id,
    commitment.ref.id,
    waiting.ref.id,
    risk.ref.id,
  ]));
  assert.equal(state.personalContext.status, 'complete');
  assert.equal(state.personalContext.complete, true);
  assert.ok(state.personalContext.estimatedTokens <= 1_200);
  assert.ok(state.memories.every((item) => !item.title.startsWith('Same-day generic')));
  assert.ok(state.memories.every((item) => !item.title.startsWith('Historical design')));

  const explanation = await hub.explain(focusScene.ref, memoryContext);
  assert.deepEqual(explanation.conclusions.map((item) => item.layer), ['L2', 'L1']);
  assert.equal(explanation.evidence.length, 1);
  assert.equal(explanation.complete, true);
});
