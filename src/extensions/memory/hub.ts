import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type OpenAI from 'openai';
import type {
  CaptureInput,
  ForgetReceipt,
  EpisodeInput,
  MemoryCard,
  MemoryDocument,
  MemoryGovernanceReceipt,
  MemoryHit,
  MemoryHub,
  MemoryLink,
  MemoryPage,
  MemoryPageMetadata,
  MemoryRef,
  MemorySearchOptions,
  MemoryStatusSnapshot,
  RememberInput,
  RunMemoryContext,
  SourceRef,
  WikiLintReport,
} from '../../core/memory.js';
import {
  assertRefVisible,
  assertRememberAllowed,
  contentDigest,
  reciprocalRankFusion,
  stableDirectoryId,
  validateRunMemoryContext,
} from '../../core/memory.js';
import { DefaultWikiCompiler } from './wiki-compiler.js';
import { DocumentSource } from './document-source.js';
import {
  SqliteMemoryCatalog,
  type DocumentChunkEmbedding,
} from './sqlite-catalog.js';
import { WikiVault } from './wiki-vault.js';
import { parsePage, serializePage } from './wiki-vault.js';
import { canonicalTopicKey, resolveMemoryTopic } from './topic-resolver.js';
import { extractWikiContent, mergeSourceRefs, renderWikiPage, wikiLinks } from './wiki-renderer.js';
import { cutoverLegacyMemory } from './cutover.js';
import { MemoryCompilationCoordinator } from './compilation-coordinator.js';
import {
  preparePrivateMemoryLayout,
  type PrivateMemoryLayout,
} from './layout.js';
import { RawEvidenceStore } from './raw-evidence-store.js';

const AUTOMATIC_EMBEDDING_TIMEOUT_MS = 1_500;

export interface MemoryHubOptions {
  workspaceRoot: string;
  dataRoot: string;
  profileId: string;
  embeddingClient?: OpenAI;
  embeddingModel?: string;
  retrievalMode?: 'auto' | 'lexical';
  cutover?: boolean;
  userSoulFile?: string;
  packagedSoulFile?: string;
  privateLayout?: PrivateMemoryLayout;
}

function sourceFor(input: RememberInput, context: RunMemoryContext): SourceRef {
  const trust = context.cause?.trust ?? 'owner';
  const explicit = !input.autonomous && trust === 'owner';
  return {
    type: explicit ? 'user-explicit' : 'session',
    id: explicit ? `${context.sessionId}/${context.runId}` : `${context.sessionId}@${context.runId}`,
    digest: `sha256:${contentDigest(input.content)}`,
    occurredAt: new Date().toISOString(),
    trust,
  };
}

function mergeStatus(privateStatus: MemoryStatusSnapshot, workspaceStatus: MemoryStatusSnapshot): MemoryStatusSnapshot {
  return {
    pages: privateStatus.pages + workspaceStatus.pages,
    privatePages: privateStatus.privatePages,
    workspacePages: workspaceStatus.workspacePages,
    conflicted: privateStatus.conflicted + workspaceStatus.conflicted,
    stale: privateStatus.stale + workspaceStatus.stale,
    fts5: privateStatus.fts5 && workspaceStatus.fts5,
    degraded: privateStatus.degraded || workspaceStatus.degraded,
    embeddingModel: privateStatus.embeddingModel ?? workspaceStatus.embeddingModel,
    embeddingDimensions: privateStatus.embeddingDimensions ?? workspaceStatus.embeddingDimensions,
    pendingReceipts: (privateStatus.pendingReceipts ?? 0) + (workspaceStatus.pendingReceipts ?? 0),
    decisions: (privateStatus.decisions ?? 0) + (workspaceStatus.decisions ?? 0),
    pageLimitReached: Boolean(privateStatus.pageLimitReached || workspaceStatus.pageLimitReached),
    episodes: (privateStatus.episodes ?? 0) + (workspaceStatus.episodes ?? 0),
    candidates: (privateStatus.candidates ?? 0) + (workspaceStatus.candidates ?? 0),
    revisions: (privateStatus.revisions ?? 0) + (workspaceStatus.revisions ?? 0),
    pendingCompilations: (privateStatus.pendingCompilations ?? 0) + (workspaceStatus.pendingCompilations ?? 0),
    uncertainCompilations: (privateStatus.uncertainCompilations ?? 0)
      + (workspaceStatus.uncertainCompilations ?? 0),
  };
}

function estimatedTokens(value: string): number {
  const ascii = (value.match(/[\x00-\x7f]/g) ?? []).length;
  return Math.ceil(ascii / 4 + (value.length - ascii) / 1.5);
}

function boundCards(cards: MemoryHit[], tokenBudget: number, maxCards: number): MemoryHit[] {
  const bounded: MemoryHit[] = [];
  let remaining = tokenBudget;
  for (const card of cards.slice(0, maxCards)) {
    const fixed = `${card.title}\n${card.kind}/${card.status}\n`;
    const fixedTokens = estimatedTokens(fixed);
    if (fixedTokens >= remaining) break;
    const summaryBudget = remaining - fixedTokens;
    const statements = card.summary.split(/(?:\r?\n)+|(?<=[。！？.!?])\s+/u)
      .map((statement) => statement.trim())
      .filter(Boolean);
    const selected: string[] = [];
    for (const statement of statements) {
      if (estimatedTokens([...selected, statement].join(' ')) > summaryBudget) continue;
      selected.push(statement);
    }
    const summary = selected.join(' ');
    if (!summary) break;
    bounded.push({ ...card, summary });
    remaining -= fixedTokens + estimatedTokens(summary);
  }
  return bounded;
}

function tokenSet(value: string): Set<string> {
  const normalized = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const tokens = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    tokens.add(normalized.slice(index, index + 2));
  }
  return tokens;
}

function similarity(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

function diversify(hits: MemoryHit[], query: string, limit: number): MemoryHit[] {
  const relevance = new Map(hits.map((hit, index) => [
    `${hit.ref.scope}:${hit.ref.id}`,
    0.7 * (1 - index / Math.max(1, hits.length))
      + 0.3 * similarity(query, `${hit.title} ${hit.summary}`),
  ]));
  const selected: MemoryHit[] = [];
  const remaining = [...hits];
  while (remaining.length && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const [index, hit] of remaining.entries()) {
      const key = `${hit.ref.scope}:${hit.ref.id}`;
      const redundancy = selected.length
        ? Math.max(...selected.map((candidate) =>
          similarity(`${candidate.title} ${candidate.summary}`, `${hit.title} ${hit.summary}`)))
        : 0;
      if (redundancy >= 0.72) continue;
      const score = 0.7 * (relevance.get(key) ?? 0) - 0.3 * redundancy;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestScore === Number.NEGATIVE_INFINITY) break;
    selected.push(remaining.splice(bestIndex, 1)[0]!);
  }
  return selected;
}

function episodeDecay(hit: MemoryHit, now = Date.now()): number {
  if (hit.documentType !== 'episode') return 1;
  const occurredAt = hit.sourceRefs.map((source) => Date.parse(source.occurredAt)).filter(Number.isFinite);
  if (!occurredAt.length) return 1;
  const ageDays = Math.max(0, now - Math.max(...occurredAt)) / 86_400_000;
  return Math.exp(-ageDays / 90);
}

function latestOccurrence(hit: MemoryHit): number {
  const timestamps = hit.sourceRefs.map((source) => Date.parse(source.occurredAt)).filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : 0;
}

class DefaultMemoryHub implements MemoryHub {
  private readonly workspaceRoot: string;
  private readonly dataRoot: string;
  private readonly profileId: string;
  private readonly privateVault: WikiVault;
  private readonly workspaceVault: WikiVault;
  private readonly privateCatalog: SqliteMemoryCatalog;
  private readonly workspaceCatalog: SqliteMemoryCatalog;
  private readonly documents: DocumentSource;
  private readonly compiler: DefaultWikiCompiler;
  private readonly rawEvidence: RawEvidenceStore;
  private readonly privateCompilation: MemoryCompilationCoordinator;
  private readonly workspaceCompilation: MemoryCompilationCoordinator;
  private readonly embeddingModel: string;
  private readonly evidence = new Map<string, Awaited<ReturnType<DocumentSource['read']>>>();

  constructor(private readonly options: MemoryHubOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.dataRoot = path.resolve(options.dataRoot);
    this.profileId = options.profileId;
    const memoryRoot = path.join(this.dataRoot, 'memory');
    const privateLayout = options.privateLayout;
    if (!privateLayout) throw new Error('MemoryHub 缺少已准备的 private Vault layout');
    const workspaceCatalogRoot = path.join(memoryRoot, 'workspaces', stableDirectoryId(this.workspaceRoot));
    this.privateVault = new WikiVault(
      privateLayout.wikiRoot,
      'private',
      options.profileId,
      privateLayout.schemaFile,
    );
    this.workspaceVault = new WikiVault(
      path.join(this.workspaceRoot, 'knowledge', 'wiki'),
      'workspace',
      undefined,
      path.join(this.workspaceRoot, 'knowledge', 'WIKI.md'),
    );
    this.privateCatalog = new SqliteMemoryCatalog(privateLayout.databaseFile, 'private', options.profileId);
    this.rawEvidence = new RawEvidenceStore(privateLayout.rawRoot);
    this.workspaceCatalog = new SqliteMemoryCatalog(path.join(workspaceCatalogRoot, 'memory.db'), 'workspace');
    this.documents = new DocumentSource(this.workspaceRoot, this.dataRoot);
    const workspaceId = stableDirectoryId(this.workspaceRoot);
    this.privateCompilation = new MemoryCompilationCoordinator(
      this.privateCatalog,
      this.privateVault,
      workspaceId,
    );
    this.workspaceCompilation = new MemoryCompilationCoordinator(
      this.workspaceCatalog,
      this.workspaceVault,
      workspaceId,
    );
    this.compiler = new DefaultWikiCompiler(
      this.privateVault,
      this.workspaceVault,
      this.privateCatalog,
      this.workspaceCatalog,
      this.documents,
      workspaceId,
    );
    this.embeddingModel = options.embeddingModel ?? process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small';
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.privateVault.initialize(),
      this.workspaceVault.initialize(),
      this.rawEvidence.initialize(),
    ]);
    await this.compiler.recover();
    await this.syncIndexes();
  }

  async hotProfile(context: RunMemoryContext): Promise<MemoryCard[]> {
    this.validate(context);
    const cards = this.privateCatalog.list({ kind: 'profile', status: 'active', limit: 8 })
      .filter((hit) => hit.confidence !== 'inferred')
      .slice(0, 8);
    return boundCards(cards, 600, 8);
  }

  async search(query: string, context: RunMemoryContext, options: MemorySearchOptions = {}): Promise<MemoryHit[]> {
    this.validate(context);
    const normalized = query.trim();
    if (!normalized) throw new Error('Memory query 不能为空');
    const limit = Math.min(20, Math.max(1, options.limit ?? 5));
    const automatic = Object.keys(options).length === 0;
    const finish = (hits: MemoryHit[]) => automatic
      ? boundCards(diversify(hits, normalized, 3), 900, 3)
      : hits;
    const queryVector = await this.embed(normalized, automatic);
    const wikiChannels: Array<Array<{ item: MemoryHit; key: string }>> = [];
    const episodeChannels: Array<Array<{ item: MemoryHit; key: string }>> = [];
    if (!options.scope || options.scope === 'all' || options.scope === 'private') {
      const wikiHits = this.privateCatalog.search(normalized, {
        ...options, documentTypes: ['wiki'], limit,
      }, queryVector);
      wikiChannels.push(wikiHits.map((item) => ({ item, key: `private:${item.ref.id}` })));
      if ((context.cause?.trust ?? 'owner') === 'owner') {
        const episodeHits = this.privateCatalog.search(normalized, {
          ...options, documentTypes: ['episode'], limit,
        }, queryVector);
        episodeChannels.push(episodeHits.map((item) => ({ item, key: `episode:${item.ref.id}` })));
      }
    }
    if (!options.scope || options.scope === 'all' || options.scope === 'workspace') {
      const hits = this.workspaceCatalog.search(normalized, {
        ...options, documentTypes: ['wiki'], limit,
      }, queryVector);
      wikiChannels.push(hits.map((item) => ({ item, key: `workspace:${item.ref.id}` })));
    }
    const wikiHits = reciprocalRankFusion(wikiChannels.filter((channel) => channel.length), limit);
    const episodeHits = reciprocalRankFusion(episodeChannels.filter((channel) => channel.length), limit)
      .map((hit) => ({ ...hit, score: hit.score * episodeDecay(hit) }))
      .sort((left, right) => right.score - left.score);
    const memoryHits = reciprocalRankFusion([
      wikiHits.map((item) => ({ item, key: `${item.ref.scope}:${item.ref.id}` })),
      episodeHits.map((item) => ({ item, key: `episode:${item.ref.id}` })),
    ].filter((channel) => channel.length), limit);
    const needsEvidence = options.includeEvidence
      || memoryHits.length < limit
      || memoryHits.some((hit) => hit.stale || hit.status === 'conflicted');
    if (!needsEvidence) return finish(memoryHits);
    const missing = limit - memoryHits.length;
    const evidenceLimit = missing > 0 ? missing : Math.max(1, Math.floor(limit / 3));
    const sourceEvidence = (!options.scope || options.scope === 'all' || options.scope === 'workspace')
      ? await this.documents.search(normalized, evidenceLimit)
      : [];
    const sourceHits = sourceEvidence.map((document, index): MemoryHit => {
      const id = `source_${createHash('sha256').update(document.path).digest('hex').slice(0, 24)}`;
      this.evidence.set(id, document);
      return {
        ref: { scope: 'workspace', id }, title: document.title,
        summary: document.content.replace(/\s+/g, ' ').trim().slice(0, 600),
        kind: 'source-summary', status: 'active', confidence: 'source-grounded',
        score: 1 / (60 + index + 1), sourceRefs: [document.sourceRef], documentType: 'source',
      };
    });
    const evidenceHits = reciprocalRankFusion([
      sourceHits.map((item) => ({ item, key: `source:${item.ref.id}` })),
    ].filter((channel) => channel.length), evidenceLimit);
    if (evidenceHits.length === 0) return finish(memoryHits);
    return finish([...memoryHits.slice(0, Math.max(0, limit - evidenceHits.length)), ...evidenceHits]);
  }

  async read(ref: MemoryRef, context: RunMemoryContext): Promise<MemoryDocument> {
    this.validate(context);
    assertRefVisible(ref.scope, ref.profileId, context);
    const evidence = this.evidence.get(ref.id);
    if (ref.scope === 'workspace' && evidence) {
      const timestamp = evidence.sourceRef.occurredAt;
      return {
        ref, metadata: {
          schemaVersion: 1, id: ref.id, title: evidence.title, kind: 'source-summary', scope: 'workspace',
          profileId: null, status: 'active', confidence: 'source-grounded', aliases: [], tags: ['evidence'],
          sourceRefs: [evidence.sourceRef], validFrom: null, validUntil: null, supersedes: [],
          createdAt: timestamp, updatedAt: timestamp,
        }, body: evidence.content, digest: evidence.sourceRef.digest, path: evidence.path,
      };
    }
    if (ref.scope === 'private' && ref.id.startsWith('episode_')) {
      const episode = this.privateCatalog.readDocument(ref);
      if (!episode || episode.metadata.profileId !== context.profileId) throw new Error(`Episode 不存在：${ref.id}`);
      return episode;
    }
    return ref.scope === 'private' ? this.privateVault.read(ref) : this.workspaceVault.read(ref);
  }

  async links(ref: MemoryRef, context: RunMemoryContext): Promise<MemoryLink[]> {
    this.validate(context);
    assertRefVisible(ref.scope, ref.profileId, context);
    return ref.scope === 'private' ? this.privateCatalog.links(ref) : this.workspaceCatalog.links(ref);
  }

  async remember(input: RememberInput, context: RunMemoryContext): Promise<MemoryPage> {
    this.validate(context);
    const normalized: RememberInput = {
      ...input,
      title: input.title.trim(),
      content: input.content.trim(),
      scope: input.scope ?? 'private',
    };
    if (!normalized.title || !normalized.content) throw new Error('Memory 标题和正文不能为空');
    if (normalized.content.length > 120_000) throw new Error('Memory 正文过长');
    if (normalized.scope === 'workspace' && normalized.sourcePaths?.length) {
      normalized.sourceRefs = await Promise.all(normalized.sourcePaths.map(async (sourcePath) => (
        await this.documents.read(sourcePath)
      ).sourceRef));
    }
    assertRememberAllowed(normalized, context);
    if (normalized.supersedes?.length && normalized.autonomous) {
      throw new Error('只有 owner 明确纠正时，remember 才能 supersede 旧事实');
    }
    const scope = normalized.scope!;
    const vault = scope === 'private' ? this.privateVault : this.workspaceVault;
    const catalog = scope === 'private' ? this.privateCatalog : this.workspaceCatalog;
    const policy = await vault.loadSchema();
    const digest = contentDigest(`${normalized.title}\0${normalized.content}`);
    if (catalog.isSuppressed(digest)) {
      if (normalized.autonomous) throw new Error('该内容已被 owner 遗忘，自动维护不得恢复');
      catalog.clearSuppression(digest);
    }
    const resolution = await resolveMemoryTopic(vault, {
      scope,
      profileId: scope === 'private' ? context.profileId : undefined,
      title: normalized.title,
      aliases: normalized.aliases,
      targetRef: normalized.targetRef,
      canonicalKey: normalized.canonicalKey,
    });
    const { ref, existing } = resolution;
    const timestamp = new Date().toISOString();
    const supersededPages = new Map<string, MemoryDocument>();
    for (const supersededId of new Set(normalized.supersedes ?? [])) {
      if (supersededId === ref.id) continue;
      const supersededRef: MemoryRef = {
        scope, id: supersededId, ...(scope === 'private' ? { profileId: context.profileId } : {}),
      };
      supersededPages.set(supersededId, await vault.read(supersededRef));
    }
    const hasExplicitSources = Boolean(normalized.sourceRefs?.length);
    const incomingSources = hasExplicitSources ? normalized.sourceRefs! : [sourceFor(normalized, context)];
    if (scope === 'private' && !hasExplicitSources) {
      await Promise.all(incomingSources.map((source) => this.rawEvidence.preserve(source, normalized.content)));
    }
    if (scope === 'workspace') {
      for (const source of incomingSources) {
        const current = await this.documents.read(source.id);
        if (current.sourceRef.digest !== source.digest) throw new Error(`Workspace SourceRef digest 已变化：${source.id}`);
      }
    }
    const sources = mergeSourceRefs(existing?.metadata.sourceRefs ?? [], incomingSources);
    const aliases = [...new Set([
      ...existing?.metadata.aliases ?? [],
      ...(existing && existing.metadata.title !== normalized.title ? [existing.metadata.title] : []),
      ...normalized.aliases ?? [],
    ])].filter((alias) => alias !== normalized.title);
    const tags = [...new Set([...existing?.metadata.tags ?? [], ...normalized.tags ?? []])];
    const body = renderWikiPage({
      title: normalized.title,
      content: normalized.content,
      sources,
      links: [...new Set([...wikiLinks(existing?.body ?? ''), ...normalized.links ?? []])],
    });
    const metadata: MemoryPageMetadata = {
      schemaVersion: 1,
      id: ref.id,
      canonicalKey: resolution.canonicalKey,
      title: normalized.title,
      kind: normalized.kind,
      scope,
      profileId: scope === 'private' ? context.profileId : null,
      status: normalized.autonomous
        && (normalized.confidence ?? 'inferred') === 'inferred'
        && !policy.allowInferredActive
        ? 'proposed'
        : 'active',
      confidence: normalized.confidence ?? (normalized.autonomous ? 'inferred' : 'user-confirmed'),
      aliases,
      tags,
      sourceRefs: sources,
      validFrom: normalized.supersedes?.length ? timestamp : null,
      validUntil: null,
      lastVerifiedAt: sources.map((source) => source.occurredAt).sort().at(-1) ?? timestamp,
      refreshAfter: existing?.metadata.refreshAfter ?? null,
      mergedInto: null,
      supersedes: [...new Set(normalized.supersedes ?? [])],
      createdAt: existing?.metadata.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    const embedding = await this.embedDocument(`${metadata.title}\n${body}`);
    const coordinator = scope === 'private' ? this.privateCompilation : this.workspaceCompilation;
    const prepared = coordinator.prepare({
      operation: 'remember',
      scope,
      title: normalized.title,
      content: normalized.content,
      kind: normalized.kind,
      confidence: metadata.confidence,
      sourceRefs: sources,
      metadata,
      targetDigest: parsePage(serializePage(metadata, body)).digest,
      createdBy: normalized.autonomous ? 'runtime' : 'owner',
      reasonCode: normalized.autonomous ? 'autonomous_future_value' : 'owner_explicit',
      context,
    });
    let page;
    try {
      page = await vault.write(metadata, body, existing?.digest);
    } catch (error) {
      coordinator.fail(prepared, error);
      throw error;
    }
    if (resolution.duplicateRefs.length) {
      catalog.recordDecision(
        'duplicate-detected',
        `resolver_${resolution.matchedBy}_${resolution.duplicateRefs.length}_pending_merge`,
        ref.id,
      );
    }
    try {
      coordinator.commit(prepared, page, embedding);
    } catch (error) {
      coordinator.fail(prepared, error, true);
      throw error;
    }
    for (const [supersededId, previous] of supersededPages) {
      const supersededMetadata = {
        ...previous.metadata, status: 'superseded', validUntil: timestamp, updatedAt: timestamp,
      } as MemoryPageMetadata;
      const supersededPrepared = coordinator.prepare({
        operation: 'remember',
        scope,
        title: previous.metadata.title,
        content: previous.body,
        kind: previous.metadata.kind,
        confidence: previous.metadata.confidence,
        sourceRefs: previous.metadata.sourceRefs,
        metadata: supersededMetadata,
        targetDigest: parsePage(serializePage(supersededMetadata, previous.body)).digest,
        createdBy: 'owner',
        reasonCode: 'owner_superseded',
        context,
      });
      let updated;
      try {
        updated = await vault.write(supersededMetadata, previous.body, previous.digest);
      } catch (error) {
        coordinator.fail(supersededPrepared, error);
        throw error;
      }
      try {
        coordinator.commit(supersededPrepared, updated);
      } catch (error) {
        coordinator.fail(supersededPrepared, error, true);
        throw error;
      }
      catalog.recordDecision('correct', 'owner_superseded', supersededId);
    }
    catalog.recordDecision('remember', normalized.autonomous ? 'autonomous_future_value' : 'owner_explicit', ref.id);
    await vault.refreshNavigation('capture', digest, [ref]);
    return page;
  }

  async forget(ref: MemoryRef, context: RunMemoryContext): Promise<ForgetReceipt> {
    this.validate(context);
    assertRefVisible(ref.scope, ref.profileId, context);
    if (ref.scope === 'workspace' && (context.cause?.trust ?? 'owner') !== 'owner') {
      throw new Error('只有 owner 能删除 workspace Memory');
    }
    const vault = ref.scope === 'private' ? this.privateVault : this.workspaceVault;
    const catalog = ref.scope === 'private' ? this.privateCatalog : this.workspaceCatalog;
    let digest: string | undefined;
    try {
      const page = await vault.read(ref);
      digest = contentDigest(`${page.metadata.title}\0${extractWikiContent(page.body)}`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('不存在')) throw error;
    }
    const forgotten = await vault.remove(ref);
    catalog.remove(ref);
    const timestamp = new Date().toISOString();
    if (digest) catalog.suppress(digest, timestamp);
    catalog.recordDecision('forget', forgotten ? 'owner_forget' : 'already_absent', ref.id);
    if (forgotten) await vault.refreshNavigation('lint', digest ?? 'forgotten', []);
    return { ref, forgotten, ...(digest ? { suppressedDigest: digest } : {}), timestamp };
  }

  async ingest(sourcePath: string, context: RunMemoryContext) {
    this.validate(context);
    if ((context.cause?.trust ?? 'owner') !== 'owner' && context.cause?.trust !== 'system') {
      throw new Error('只有 owner/system 能 ingest workspace 来源');
    }
    const document = await this.documents.read(sourcePath);
    const receipt = await this.compiler.ingest(document.sourceRef, context);
    for (const ref of receipt.pageRefs) {
      const page = await this.workspaceVault.read(ref);
      const embedding = await this.embedDocument(`${page.metadata.title}\n${page.body}`);
      this.workspaceCatalog.index(page, embedding);
    }
    return receipt;
  }

  async capture(input: CaptureInput, context: RunMemoryContext) {
    this.validate(context);
    assertRememberAllowed({
      title: input.title, content: input.content, kind: input.kind ?? 'synthesis',
      scope: input.scope, confidence: input.confidence, sourceRefs: input.sourceRefs,
      supersedes: input.supersedes, autonomous: true,
    }, context);
    if ((context.cause?.trust ?? 'owner') === 'external' || context.cause?.trust === 'public') {
      throw new Error('外部来源不能直接 capture active Memory');
    }
    if (input.sourceRefs.length === 0 || input.sourceRefs.length > 20) {
      throw new Error('Capture 必须包含 1-20 个 SourceRef');
    }
    if ((input.scope ?? 'private') === 'workspace'
      && input.sourceRefs.some((source) => source.type !== 'file')) {
      throw new Error('Workspace capture 只接受明确文件来源');
    }
    if ((input.scope ?? 'private') === 'private' && input.rawEvidence?.length) {
      const allowed = new Set(input.sourceRefs.map((source) => `${source.type}\0${source.id}\0${source.digest}`));
      for (const evidence of input.rawEvidence) {
        const key = `${evidence.sourceRef.type}\0${evidence.sourceRef.id}\0${evidence.sourceRef.digest}`;
        if (!allowed.has(key)) throw new Error('Raw evidence 必须属于本次 Capture 的 SourceRef');
        await this.rawEvidence.preserve(evidence.sourceRef, evidence.content);
      }
    }
    return this.compiler.capture(input, context);
  }

  async merge(
    input: {
      targetRef: MemoryRef;
      mergedRefs: MemoryRef[];
      title: string;
      content: string;
      reasonCode: string;
    },
    context: RunMemoryContext,
  ): Promise<MemoryGovernanceReceipt> {
    this.validate(context);
    assertRefVisible(input.targetRef.scope, input.targetRef.profileId, context);
    const target = await this.read(input.targetRef, context);
    const merged = await Promise.all(input.mergedRefs
      .filter((ref) => ref.id !== input.targetRef.id)
      .map(async (ref) => {
        if (ref.scope !== input.targetRef.scope || ref.profileId !== input.targetRef.profileId) {
          throw new Error('Memory merge 只能处理同一 scope/profile 的页面');
        }
        return this.read(ref, context);
      }));
    if (!merged.length) throw new Error('Memory merge 至少需要一个不同的来源页面');
    const sourceRefs = mergeSourceRefs(
      target.metadata.sourceRefs,
      ...merged.map((page) => page.metadata.sourceRefs),
    );
    const aliases = [...new Set([
      ...target.metadata.aliases,
      target.metadata.title,
      ...merged.flatMap((page) => [page.metadata.title, ...page.metadata.aliases]),
    ])].filter((alias) => alias !== input.title.trim());
    const links = [...new Set([
      ...wikiLinks(target.body),
      ...merged.flatMap((page) => wikiLinks(page.body)),
    ])].filter((link) => link !== input.title.trim());
    assertRememberAllowed({
      title: input.title,
      content: input.content,
      kind: target.metadata.kind,
      scope: target.ref.scope,
      sourceRefs,
      autonomous: true,
    }, context);
    await this.compiler.capture({
      title: input.title,
      content: input.content,
      sourceRefs,
      scope: target.ref.scope,
      kind: target.metadata.kind,
      status: target.metadata.status === 'proposed' ? 'active' : target.metadata.status,
      confidence: target.metadata.confidence,
      aliases,
      tags: [...new Set([
        ...target.metadata.tags,
        ...merged.flatMap((page) => page.metadata.tags),
      ])],
      links,
      targetRef: target.ref,
      canonicalKey: target.metadata.canonicalKey,
      supersedes: merged.map((page) => page.ref.id),
      reasonCode: input.reasonCode,
    }, context);
    for (const page of merged) {
      await this.setPageLifecycle(page.ref, 'superseded', input.reasonCode, context, target.ref.id);
    }
    const timestamp = new Date().toISOString();
    return {
      action: 'merge',
      targetRef: target.ref,
      affectedRefs: [target.ref, ...merged.map((page) => page.ref)],
      timestamp,
    };
  }

  async supersede(
    ref: MemoryRef,
    replacementRef: MemoryRef | undefined,
    reasonCode: string,
    context: RunMemoryContext,
  ): Promise<MemoryGovernanceReceipt> {
    this.validate(context);
    assertRefVisible(ref.scope, ref.profileId, context);
    if (replacementRef
      && (replacementRef.scope !== ref.scope || replacementRef.profileId !== ref.profileId)) {
      throw new Error('replacementRef 必须与被 supersede 页面属于同一 scope/profile');
    }
    if (replacementRef) await this.read(replacementRef, context);
    await this.setPageLifecycle(ref, 'superseded', reasonCode, context, replacementRef?.id);
    return {
      action: 'supersede',
      targetRef: replacementRef ?? ref,
      affectedRefs: [ref],
      timestamp: new Date().toISOString(),
    };
  }

  async addLinks(
    ref: MemoryRef,
    links: string[],
    reasonCode: string,
    context: RunMemoryContext,
  ): Promise<MemoryGovernanceReceipt> {
    this.validate(context);
    const page = await this.read(ref, context);
    const normalizedLinks = [...new Set(links.map((link) => link.trim()).filter(Boolean))];
    if (!normalizedLinks.length) throw new Error('Memory link 至少需要一个目标标题');
    await this.compiler.capture({
      title: page.metadata.title,
      content: extractWikiContent(page.body),
      sourceRefs: page.metadata.sourceRefs,
      scope: page.ref.scope,
      kind: page.metadata.kind,
      status: page.metadata.status,
      confidence: page.metadata.confidence,
      aliases: page.metadata.aliases,
      tags: page.metadata.tags,
      links: [...new Set([...wikiLinks(page.body), ...normalizedLinks])],
      targetRef: page.ref,
      canonicalKey: page.metadata.canonicalKey,
      reasonCode,
    }, context);
    return {
      action: 'link',
      targetRef: page.ref,
      affectedRefs: [page.ref],
      timestamp: new Date().toISOString(),
    };
  }

  async move(
    ref: MemoryRef,
    targetScope: 'private' | 'workspace',
    reasonCode: string,
    context: RunMemoryContext,
  ): Promise<MemoryGovernanceReceipt> {
    this.validate(context);
    const page = await this.read(ref, context);
    if (page.ref.scope === targetScope) {
      return {
        action: 'move',
        targetRef: page.ref,
        affectedRefs: [page.ref],
        timestamp: new Date().toISOString(),
      };
    }
    if (targetScope === 'workspace' && page.metadata.sourceRefs.some((source) => source.type !== 'file')) {
      throw new Error('迁入 workspace 的 Memory 必须全部来自明确的 workspace 文件');
    }
    const receipt = await this.compiler.capture({
      title: page.metadata.title,
      content: extractWikiContent(page.body),
      sourceRefs: page.metadata.sourceRefs,
      scope: targetScope,
      kind: page.metadata.kind,
      status: page.metadata.status,
      confidence: page.metadata.confidence,
      aliases: page.metadata.aliases,
      tags: page.metadata.tags,
      links: wikiLinks(page.body),
      reasonCode,
    }, context);
    const targetRef = receipt.pageRefs[0];
    if (!targetRef) throw new Error('Memory move 未产生目标页面');
    await this.setPageLifecycle(page.ref, 'superseded', reasonCode, context, targetRef.id);
    return {
      action: 'move',
      targetRef,
      affectedRefs: [page.ref, targetRef],
      timestamp: new Date().toISOString(),
    };
  }

  async refreshStale(limit: number, context: RunMemoryContext) {
    this.validate(context);
    if ((context.cause?.trust ?? 'owner') !== 'owner' && context.cause?.trust !== 'system') {
      throw new Error('只有 owner/system 能 refresh stale Memory');
    }
    const bounded = Math.max(1, Math.min(50, Math.trunc(limit)));
    await this.syncIndexes();
    const sourcePaths = [...new Set(
      this.workspaceCatalog.staleDocuments(bounded)
        .flatMap((page) => page.metadata.sourceRefs)
        .filter((source) => source.type === 'file')
        .map((source) => source.id),
    )].slice(0, bounded);
    const receipts = [];
    for (const sourcePath of sourcePaths) {
      const current = await this.documents.read(sourcePath);
      receipts.push(await this.compiler.ingest(current.sourceRef, context));
    }
    return receipts;
  }

  async reject(sourceRefs: SourceRef[], reasonCode: string, context: RunMemoryContext) {
    this.validate(context);
    return this.compiler.reject(sourceRefs, reasonCode, context);
  }

  async recordEpisode(input: EpisodeInput, context: RunMemoryContext): Promise<MemoryRef> {
    this.validate(context);
    if (input.sessionId !== context.sessionId || input.runId !== context.runId) {
      throw new Error('Episode 必须属于当前 immutable Session/Run');
    }
    const content = `用户：${input.input.trim().slice(0, 8_000)}\n\n助手：${input.answer.trim().slice(0, 8_000)}`;
    const digest = contentDigest(content);
    const id = `episode_${createHash('sha256').update(`${input.sessionId}\0${input.runId}`).digest('hex').slice(0, 24)}`;
    const sourceRef = input.sourceRef ?? {
      type: 'session' as const,
      id: `${input.sessionId}@${input.runId}`,
      digest: `sha256:${digest}`,
      occurredAt: input.occurredAt,
      trust: context.cause?.trust ?? 'owner',
    };
    const ref: MemoryRef = { scope: 'private', profileId: context.profileId, id };
    const document: MemoryDocument = {
      ref,
      metadata: {
        schemaVersion: 1, id, title: input.input.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Session episode',
        kind: 'source-summary', scope: 'private', profileId: context.profileId, status: 'active',
        confidence: 'source-grounded', aliases: [], tags: ['episode'], sourceRefs: [sourceRef],
        validFrom: null, validUntil: null, supersedes: [], createdAt: input.occurredAt, updatedAt: input.occurredAt,
      },
      body: content,
      digest,
    };
    await this.rawEvidence.commit(sourceRef, content, () => {
      this.privateCatalog.index(document, undefined, 'episode');
    });
    this.privateCatalog.pruneEpisodes();
    return ref;
  }

  async conflicts(context: RunMemoryContext, limit = 50): Promise<MemoryHit[]> {
    return this.list(context, { status: 'conflicted', limit });
  }

  async audit(context: RunMemoryContext, limit = 50) {
    this.validate(context);
    return [...this.privateCatalog.decisions(limit), ...this.workspaceCatalog.decisions(limit)]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, Math.min(200, limit)));
  }

  async list(context: RunMemoryContext, options: MemorySearchOptions = {}): Promise<MemoryHit[]> {
    this.validate(context);
    const hits = [
      ...(!options.scope || options.scope === 'all' || options.scope === 'private' ? this.privateCatalog.list(options) : []),
      ...(!options.scope || options.scope === 'all' || options.scope === 'workspace' ? this.workspaceCatalog.list(options) : []),
    ];
    return hits.sort(options.order === 'recent'
      ? (left, right) => latestOccurrence(right) - latestOccurrence(left)
      : (left, right) => right.summary.localeCompare(left.summary))
      .slice(0, options.limit ?? 100);
  }

  async lint(context: RunMemoryContext): Promise<WikiLintReport> {
    this.validate(context);
    return this.compiler.lint(context);
  }

  async reindex(context: RunMemoryContext): Promise<MemoryStatusSnapshot> {
    this.validate(context);
    await this.rebuildIndexes();
    return this.status(context);
  }

  async status(context: RunMemoryContext): Promise<MemoryStatusSnapshot> {
    this.validate(context);
    const status = mergeStatus(this.privateCatalog.status(), this.workspaceCatalog.status());
    return {
      ...status,
      retrievalMode: this.options.retrievalMode !== 'lexical' && this.options.embeddingClient
        ? 'hybrid'
        : 'lexical-only',
    };
  }

  private async setPageLifecycle(
    ref: MemoryRef,
    status: 'superseded' | 'expired',
    reasonCode: string,
    context: RunMemoryContext,
    mergedInto?: string,
  ): Promise<MemoryPage> {
    const vault = ref.scope === 'private' ? this.privateVault : this.workspaceVault;
    const catalog = ref.scope === 'private' ? this.privateCatalog : this.workspaceCatalog;
    const coordinator = ref.scope === 'private' ? this.privateCompilation : this.workspaceCompilation;
    const existing = await vault.read(ref);
    if (existing.metadata.status === status && existing.metadata.mergedInto === (mergedInto ?? null)) return existing;
    const timestamp = new Date().toISOString();
    const metadata: MemoryPageMetadata = {
      ...existing.metadata,
      canonicalKey: existing.metadata.canonicalKey ?? canonicalTopicKey(ref.scope, existing.metadata.title),
      status,
      validUntil: timestamp,
      mergedInto: mergedInto ?? null,
      updatedAt: timestamp,
    };
    const body = renderWikiPage({
      title: metadata.title,
      content: extractWikiContent(existing.body),
      sources: metadata.sourceRefs,
      links: wikiLinks(existing.body),
    });
    const prepared = coordinator.prepare({
      operation: 'lint-repair',
      scope: ref.scope,
      title: metadata.title,
      content: body,
      kind: metadata.kind,
      confidence: metadata.confidence,
      sourceRefs: metadata.sourceRefs,
      metadata,
      targetDigest: parsePage(serializePage(metadata, body)).digest,
      createdBy: context.cause?.source === 'memory-maintenance' ? 'maintenance' : 'owner',
      reasonCode,
      context,
    });
    let page: MemoryPage;
    try {
      page = await vault.write(metadata, body, existing.digest);
    } catch (error) {
      coordinator.fail(prepared, error);
      throw error;
    }
    try {
      coordinator.commit(prepared, page);
    } catch (error) {
      coordinator.fail(prepared, error, true);
      throw error;
    }
    catalog.recordDecision(status, reasonCode, ref.id);
    await vault.refreshNavigation('lint', contentDigest(`${status}\0${ref.id}\0${reasonCode}`), [ref]);
    return page;
  }

  private async rebuildIndexes(): Promise<void> {
    const [privatePages, workspacePages] = await this.loadPages();
    this.privateCatalog.rebuild(privatePages, this.embeddingModel);
    this.workspaceCatalog.rebuild(workspacePages, this.embeddingModel);
    await this.ensureEmbeddings(privatePages, workspacePages);
  }

  private async syncIndexes(): Promise<void> {
    const [privatePages, workspacePages] = await this.loadPages();
    this.privateCatalog.sync(privatePages);
    this.workspaceCatalog.sync(workspacePages);
    await this.ensureEmbeddings(privatePages, workspacePages);
  }

  private async loadPages(): Promise<[MemoryDocument[], MemoryDocument[]]> {
    const [privatePages, workspacePages] = await Promise.all([this.privateVault.list(), this.workspaceVault.list()]);
    await Promise.all(workspacePages.map(async (page) => {
      const sources = page.metadata.sourceRefs.filter((source) => source.type === 'file');
      for (const source of sources) {
        try {
          if ((await this.documents.read(source.id)).sourceRef.digest !== source.digest) page.stale = true;
        } catch {
          page.stale = true;
        }
      }
    }));
    return [privatePages, workspacePages];
  }

  private async ensureEmbeddings(privatePages: MemoryDocument[], workspacePages: MemoryDocument[]): Promise<void> {
    if (this.options.retrievalMode !== 'lexical' && this.options.embeddingClient) {
      for (const page of privatePages) {
        if (!this.privateCatalog.needsEmbedding(page, this.embeddingModel)) continue;
        this.privateCatalog.index(page, await this.embedDocument(`${page.metadata.title}\n${page.body}`));
      }
      for (const page of workspacePages) {
        if (!this.workspaceCatalog.needsEmbedding(page, this.embeddingModel)) continue;
        this.workspaceCatalog.index(page, await this.embedDocument(`${page.metadata.title}\n${page.body}`));
      }
    }
  }

  private validate(context: RunMemoryContext): void {
    validateRunMemoryContext(context, this.workspaceRoot, this.profileId);
  }

  private async embed(query: string, automatic = false): Promise<number[] | undefined> {
    if (this.options.retrievalMode === 'lexical' || !this.options.embeddingClient) return undefined;
    try {
      const response = await this.options.embeddingClient.embeddings.create(
        { model: this.embeddingModel, input: query },
        automatic ? { maxRetries: 0, timeout: AUTOMATIC_EMBEDDING_TIMEOUT_MS } : undefined,
      );
      return response.data[0]?.embedding;
    } catch {
      return undefined;
    }
  }

  private async embedDocument(content: string): Promise<DocumentChunkEmbedding | undefined> {
    if (this.options.retrievalMode === 'lexical' || !this.options.embeddingClient) return undefined;
    const chunks = this.embeddingChunks(content);
    try {
      const response = await this.options.embeddingClient.embeddings.create({
        model: this.embeddingModel,
        input: chunks,
      });
      const vectors = response.data.map((item) => item.embedding).filter((vector) => vector.length > 0);
      const dimensions = vectors[0]?.length ?? 0;
      if (vectors.length !== chunks.length
        || !dimensions
        || vectors.some((vector) => vector.length !== dimensions)) return undefined;
      return {
        model: this.embeddingModel,
        chunks: chunks.map((chunk, index) => ({
          index,
          digest: createHash('sha256').update(chunk).digest('hex'),
          vector: vectors[index]!,
        })),
      };
    } catch {
      return undefined;
    }
  }

  private embeddingChunks(content: string): string[] {
    const units = [...content];
    const chunks: string[] = [];
    let start = 0;
    while (start < units.length) {
      let end = start;
      while (end < units.length && estimatedTokens(units.slice(start, end + 1).join('')) <= 400) end += 1;
      if (end === start) end += 1;
      chunks.push(units.slice(start, end).join(''));
      if (end >= units.length) break;
      let overlapStart = end;
      while (overlapStart > start
        && estimatedTokens(units.slice(overlapStart - 1, end).join('')) <= 80) {
        overlapStart -= 1;
      }
      start = Math.max(start + 1, overlapStart);
    }
    return chunks;
  }
}

export async function createMemoryHub(options: MemoryHubOptions): Promise<MemoryHub> {
  const privateLayout = options.privateLayout
    ?? await preparePrivateMemoryLayout(options.dataRoot, options.profileId);
  const hub = new DefaultMemoryHub({ ...options, privateLayout });
  await hub.initialize();
  if (options.cutover !== false) {
    await cutoverLegacyMemory(hub, options.workspaceRoot, options.dataRoot, {
      profileId: options.profileId,
      workspaceRoot: options.workspaceRoot,
      sessionId: 'memory-cutover',
      runId: 'memory-cutover-v1',
      cause: { trust: 'owner', source: 'local-cutover' },
    }, { userSoulFile: options.userSoulFile, packagedSoulFile: options.packagedSoulFile });
  }
  return hub;
}

class RoutedMemoryHub implements MemoryHub {
  private readonly hubs = new Map<string, Promise<MemoryHub>>();

  constructor(private readonly options: Omit<MemoryHubOptions, 'profileId' | 'cutover'>) {}

  hotProfile(context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.hotProfile(context)); }
  search(query: string, context: RunMemoryContext, options?: MemorySearchOptions) { return this.forContext(context).then((hub) => hub.search(query, context, options)); }
  read(ref: MemoryRef, context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.read(ref, context)); }
  links(ref: MemoryRef, context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.links(ref, context)); }
  remember(input: RememberInput, context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.remember(input, context)); }
  forget(ref: MemoryRef, context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.forget(ref, context)); }
  ingest(sourcePath: string, context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.ingest(sourcePath, context)); }
  capture(input: CaptureInput, context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.capture(input, context)); }
  merge(input: Parameters<MemoryHub['merge']>[0], context: RunMemoryContext) {
    return this.forContext(context).then((hub) => hub.merge(input, context));
  }
  supersede(ref: MemoryRef, replacementRef: MemoryRef | undefined, reasonCode: string, context: RunMemoryContext) {
    return this.forContext(context).then((hub) => hub.supersede(ref, replacementRef, reasonCode, context));
  }
  addLinks(ref: MemoryRef, links: string[], reasonCode: string, context: RunMemoryContext) {
    return this.forContext(context).then((hub) => hub.addLinks(ref, links, reasonCode, context));
  }
  move(ref: MemoryRef, targetScope: 'private' | 'workspace', reasonCode: string, context: RunMemoryContext) {
    return this.forContext(context).then((hub) => hub.move(ref, targetScope, reasonCode, context));
  }
  refreshStale(limit: number, context: RunMemoryContext) {
    return this.forContext(context).then((hub) => hub.refreshStale(limit, context));
  }
  reject(sourceRefs: SourceRef[], reasonCode: string, context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.reject(sourceRefs, reasonCode, context)); }
  recordEpisode(input: EpisodeInput, context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.recordEpisode(input, context)); }
  conflicts(context: RunMemoryContext, limit?: number) { return this.forContext(context).then((hub) => hub.conflicts(context, limit)); }
  audit(context: RunMemoryContext, limit?: number) { return this.forContext(context).then((hub) => hub.audit(context, limit)); }
  list(context: RunMemoryContext, options?: MemorySearchOptions) { return this.forContext(context).then((hub) => hub.list(context, options)); }
  lint(context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.lint(context)); }
  reindex(context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.reindex(context)); }
  status(context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.status(context)); }

  private forContext(context: RunMemoryContext): Promise<MemoryHub> {
    let hub = this.hubs.get(context.profileId);
    if (!hub) {
      hub = createMemoryHub({ ...this.options, profileId: context.profileId, cutover: context.profileId === 'owner' });
      this.hubs.set(context.profileId, hub);
    }
    return hub;
  }
}

export function createRoutedMemoryHub(options: Omit<MemoryHubOptions, 'profileId' | 'cutover'>): MemoryHub {
  return new RoutedMemoryHub(options);
}
