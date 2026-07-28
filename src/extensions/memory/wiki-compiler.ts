import { createHash, randomUUID } from 'node:crypto';
import type {
  CaptureInput,
  CompilationPlan,
  CompilationReceipt,
  MemoryDocument,
  MemoryKind,
  MemoryPageMetadata,
  RunMemoryContext,
  SourceRef,
  WikiCompiler,
  WikiLintReport,
} from '../../core/memory.js';
import { contentDigest, sourceDigest } from '../../core/memory.js';
import { DocumentSource } from './document-source.js';
import { SqliteMemoryCatalog } from './sqlite-catalog.js';
import { lintWiki } from './wiki-lint.js';
import { parsePage, serializePage, WikiVault } from './wiki-vault.js';
import { MemoryCompilationCoordinator } from './compilation-coordinator.js';
import { canonicalTopicKey, resolveMemoryTopic } from './topic-resolver.js';
import { extractWikiContent, mergeSourceRefs, renderWikiPage, wikiLinks } from './wiki-renderer.js';
import type { WikiSchemaPolicy } from './wiki-schema.js';

const COMPILER_VERSION = 'memory-hub-v1';

function pageId(seed: string): string {
  return `mem_${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
}

function sectionKind(title: string): MemoryKind {
  if (/(?:decision|决定|决策|adr)/i.test(title)) return 'decision';
  if (/(?:lesson|gotcha|经验|教训|陷阱)/i.test(title)) return 'lesson';
  if (/(?:people|person|team|组织|人物|实体)/i.test(title)) return 'entity';
  return 'concept';
}

function ingestUnits(title: string, content: string, source: SourceRef): Array<{
  ref: { scope: 'workspace'; id: string };
  title: string;
  content: string;
  kind: MemoryKind;
  links: string[];
}> {
  const headings = [...content.matchAll(/^#{2,3}\s+(.+)$/gm)].slice(0, 14);
  const seenHeadings = new Set<string>();
  const sections = headings.map((heading, index) => {
    const sectionTitle = heading[1]!.trim().slice(0, 160);
    const start = heading.index! + heading[0].length;
    const end = headings[index + 1]?.index ?? content.length;
    return { title: `${title}: ${sectionTitle}`, content: content.slice(start, end).trim(), heading: sectionTitle };
  }).filter((section) => {
    const key = section.heading.toLowerCase();
    if (section.content.length < 40 || seenHeadings.has(key)) return false;
    seenHeadings.add(key);
    return true;
  });
  const summaryContent = sections.length
    ? `${content.slice(0, 8_000).trim()}\n\n本来源另编译为 ${sections.length} 个主题页面。`
    : content;
  const summary = {
    ref: { scope: 'workspace' as const, id: pageId(`file:${source.id}`) },
    title, content: summaryContent, kind: 'source-summary' as const,
    links: sections.map((section) => section.title),
  };
  return [summary, ...sections.map((section) => ({
    ref: { scope: 'workspace' as const, id: pageId(`file:${source.id}#${section.heading.toLowerCase()}`) },
    title: section.title, content: section.content, kind: sectionKind(section.heading), links: [title],
  }))].slice(0, 15);
}

export class DefaultWikiCompiler implements WikiCompiler {
  private readonly privateCoordinator: MemoryCompilationCoordinator;
  private readonly workspaceCoordinator: MemoryCompilationCoordinator;

  constructor(
    private readonly privateVault: WikiVault,
    private readonly workspaceVault: WikiVault,
    private readonly privateCatalog: SqliteMemoryCatalog,
    private readonly workspaceCatalog: SqliteMemoryCatalog,
    private readonly documents: DocumentSource,
    workspaceId: string,
  ) {
    this.privateCoordinator = new MemoryCompilationCoordinator(
      privateCatalog,
      privateVault,
      workspaceId,
    );
    this.workspaceCoordinator = new MemoryCompilationCoordinator(
      workspaceCatalog,
      workspaceVault,
      workspaceId,
    );
  }

  async recover(): Promise<void> {
    await Promise.all([
      this.privateCoordinator.recover(),
      this.workspaceCoordinator.recover(),
    ]);
  }

  async ingest(source: SourceRef, context: RunMemoryContext): Promise<CompilationReceipt> {
    if (source.type !== 'file') throw new Error('Ingest 只接受明确的 workspace 文件 SourceRef');
    const policy = await this.workspaceVault.loadSchema();
    const document = await this.documents.read(source.id);
    if (document.sourceRef.digest !== source.digest) throw new Error('Document Source digest 已变化，请重新发起 ingest');
    const digest = sourceDigest(source);
    const previous = this.workspaceCatalog.getReceipt(digest, 'ingest');
    if (previous?.status === 'applied') return previous;
    const units = ingestUnits(document.title, document.content, source);
    const refs = units.map((unit) => unit.ref);
    const plan: CompilationPlan = {
      operation: 'ingest', digest, compilerVersion: COMPILER_VERSION,
      plannedPageRefs: refs, appliedPageRefs: previous?.pageRefs ?? [],
    };
    const pending: CompilationReceipt = {
      id: previous?.id ?? `receipt_${randomUUID()}`, operation: 'ingest', status: 'pending', digest,
      pageRefs: [...plan.appliedPageRefs],
    };
    this.workspaceCatalog.saveReceipt(pending, plan);
    const timestamp = new Date().toISOString();
    const existingPages = new Map((await this.workspaceVault.list()).map((page) => [page.ref.id, page]));
    for (const unit of units) {
      const existing = existingPages.get(unit.ref.id);
      const alreadyApplied = plan.appliedPageRefs.some((ref) => ref.id === unit.ref.id)
        && existing?.metadata.sourceRefs.some((candidate) => sourceDigest(candidate) === sourceDigest(source));
      if (alreadyApplied) continue;
      const metadata: MemoryPageMetadata = {
        schemaVersion: 1, id: unit.ref.id,
        canonicalKey: existing?.metadata.canonicalKey ?? canonicalTopicKey('workspace', unit.title),
        title: unit.title, kind: unit.kind, scope: 'workspace', profileId: null,
        status: 'active', confidence: 'source-grounded', aliases: [], tags: ['source'], sourceRefs: [source],
        validFrom: null, validUntil: null, lastVerifiedAt: source.occurredAt, refreshAfter: null, mergedInto: null,
        supersedes: existing?.metadata.supersedes ?? [],
        createdAt: existing?.metadata.createdAt ?? timestamp, updatedAt: timestamp,
      };
      const body = renderWikiPage({ title: unit.title, content: unit.content, sources: [source], links: unit.links });
      const prepared = this.workspaceCoordinator.prepare({
        operation: 'ingest',
        scope: 'workspace',
        title: unit.title,
        content: unit.content,
        kind: unit.kind,
        confidence: 'source-grounded',
        sourceRefs: [source],
        metadata,
        targetDigest: parsePage(serializePage(metadata, body)).digest,
        createdBy: context.cause?.source === 'memory-maintenance' ? 'maintenance' : 'owner',
        reasonCode: 'workspace_source_ingest',
        context,
      });
      let page;
      try {
        page = await this.workspaceVault.write(metadata, body, existing?.digest);
      } catch (error) {
        this.workspaceCoordinator.fail(prepared, error);
        throw error;
      }
      try {
        this.workspaceCoordinator.commit(prepared, { ...page, path: existing?.path });
      } catch (error) {
        this.workspaceCoordinator.fail(prepared, error, true);
        throw error;
      }
      if (!plan.appliedPageRefs.some((ref) => ref.id === unit.ref.id)) plan.appliedPageRefs.push(unit.ref);
      this.workspaceCatalog.saveReceipt({ ...pending, pageRefs: [...plan.appliedPageRefs] }, plan);
    }
    const inspection = await this.workspaceVault.inspect();
    const deterministic = lintWiki(inspection.pages, policy);
    const errors = [...inspection.issues, ...deterministic.issues].filter((issue) => issue.severity === 'error');
    if (errors.length) throw new Error(`Ingest 后确定性 Lint 失败：${errors[0]!.message}`);
    await this.workspaceVault.refreshNavigation('ingest', digest, refs);
    const applied: CompilationReceipt = { ...pending, status: 'applied', pageRefs: refs };
    this.workspaceCatalog.saveReceipt(applied, plan);
    return applied;
  }

  async capture(input: CaptureInput, context: RunMemoryContext): Promise<CompilationReceipt> {
    const scope = input.scope ?? 'private';
    const vault = scope === 'private' ? this.privateVault : this.workspaceVault;
    const catalog = scope === 'private' ? this.privateCatalog : this.workspaceCatalog;
    const policy = await vault.loadSchema();
    if (!input.title.trim() || !input.content.trim()) throw new Error('Capture 标题和内容不能为空');
    if (input.content.length > 120_000) throw new Error('Capture 内容过长');
    const digest = contentDigest(JSON.stringify({
      title: input.title.trim(),
      content: input.content.trim(),
      sourceRefs: input.sourceRefs.map(sourceDigest).sort(),
      scope,
      kind: input.kind,
      status: input.status,
      confidence: input.confidence,
      aliases: [...input.aliases ?? []].sort(),
      tags: [...input.tags ?? []].sort(),
      links: [...input.links ?? []].sort(),
      targetRef: input.targetRef,
      canonicalKey: input.canonicalKey,
      supersedes: [...input.supersedes ?? []].sort(),
    }));
    const previous = catalog.getReceipt(digest, 'capture');
    if (previous?.status === 'applied') return previous;
    const resolution = await resolveMemoryTopic(vault, {
      scope,
      profileId: scope === 'private' ? context.profileId : undefined,
      title: input.title,
      aliases: input.aliases,
      targetRef: input.targetRef,
      canonicalKey: input.canonicalKey,
    });
    const { ref, existing } = resolution;
    const timestamp = new Date().toISOString();
    if (!existing && context.cause?.source === 'memory-maintenance' && catalog.status().pageLimitReached) {
      throw new Error('Vault 已达到 10,000 页上限；maintenance 只能合并或更新现有页面');
    }
    const plan: CompilationPlan = {
      operation: 'capture', digest, compilerVersion: COMPILER_VERSION,
      plannedPageRefs: [ref], appliedPageRefs: [],
    };
    const pending: CompilationReceipt = {
      id: previous?.id ?? `receipt_${randomUUID()}`, operation: 'capture', status: 'pending', digest, pageRefs: [],
    };
    catalog.saveReceipt(pending, plan);
    const sourceRefs = mergeSourceRefs(existing?.metadata.sourceRefs ?? [], input.sourceRefs);
    const aliases = [...new Set([
      ...(existing?.metadata.aliases ?? []),
      ...(existing && existing.metadata.title !== input.title.trim() ? [existing.metadata.title] : []),
      ...(input.aliases ?? []),
    ])].filter((alias) => alias !== input.title.trim());
    const tags = [...new Set([...(existing?.metadata.tags ?? []), ...(input.tags ?? [])])];
    const links = [...new Set([...wikiLinks(existing?.body ?? ''), ...(input.links ?? [])])];
    const confidence = input.confidence ?? existing?.metadata.confidence ?? 'inferred';
    const requestedStatus = input.status ?? existing?.metadata.status ?? 'active';
    const independentSources = new Set(sourceRefs.map((source) => `${source.type}:${source.id}`)).size;
    const status = requestedStatus === 'active'
      && confidence === 'inferred'
      && !policy.allowInferredActive
      && independentSources < 2
      ? 'proposed'
      : requestedStatus;
    const metadata: MemoryPageMetadata = {
      schemaVersion: 1, id: ref.id, canonicalKey: resolution.canonicalKey,
      title: input.title.trim(), kind: input.kind ?? existing?.metadata.kind ?? 'synthesis', scope,
      profileId: scope === 'private' ? context.profileId : null,
      status,
      confidence,
      aliases, tags, sourceRefs,
      validFrom: existing?.metadata.validFrom ?? (input.supersedes?.length ? timestamp : null), validUntil: null,
      lastVerifiedAt: sourceRefs.map((source) => source.occurredAt).sort().at(-1) ?? timestamp,
      refreshAfter: existing?.metadata.refreshAfter ?? null, mergedInto: null,
      supersedes: [...new Set([...(existing?.metadata.supersedes ?? []), ...(input.supersedes ?? [])])],
      createdAt: existing?.metadata.createdAt ?? timestamp, updatedAt: timestamp,
    };
    const body = renderWikiPage({ title: input.title, content: input.content, sources: sourceRefs, links });
    const coordinator = scope === 'private' ? this.privateCoordinator : this.workspaceCoordinator;
    const prepared = coordinator.prepare({
      operation: 'capture',
      scope,
      title: input.title.trim(),
      content: input.content,
      kind: input.kind ?? 'synthesis',
      confidence: input.confidence ?? 'inferred',
      sourceRefs,
      metadata,
      targetDigest: parsePage(serializePage(metadata, body)).digest,
      createdBy: context.cause?.source === 'memory-maintenance' ? 'maintenance' : 'runtime',
      reasonCode: input.reasonCode,
      context,
    });
    let page;
    try {
      page = await vault.write(metadata, body, existing?.digest);
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
    plan.appliedPageRefs.push(ref);
    catalog.saveReceipt({ ...pending, pageRefs: [ref] }, plan);
    const inspection = await vault.inspect();
    const deterministic = lintWiki(inspection.pages, policy);
    const errors = [...inspection.issues, ...deterministic.issues].filter((issue) => issue.severity === 'error');
    if (errors.length) throw new Error(`Capture 后确定性 Lint 失败：${errors[0]!.message}`);
    await vault.refreshNavigation('capture', digest, [ref]);
    const receipt: CompilationReceipt = { ...pending, status: 'applied', pageRefs: [ref] };
    catalog.saveReceipt(receipt, plan);
    catalog.recordDecision('capture', input.reasonCode ?? 'captured_for_future_value', ref.id);
    if (resolution.duplicateRefs.length) {
      catalog.recordDecision(
        'duplicate-detected',
        `resolver_${resolution.matchedBy}_${resolution.duplicateRefs.length}_pending_merge`,
        ref.id,
      );
    }
    return receipt;
  }

  async reject(sourceRefs: SourceRef[], reasonCode: string, _context: RunMemoryContext): Promise<CompilationReceipt> {
    if (sourceRefs.length === 0 || sourceRefs.length > 20) throw new Error('Rejected receipt 必须引用 1-20 个来源');
    const normalizedReason = reasonCode.trim().slice(0, 200);
    if (!normalizedReason) throw new Error('Rejected receipt 缺少 reasonCode');
    const digest = contentDigest(sourceRefs.map(sourceDigest).join(':'));
    const previous = this.privateCatalog.getReceipt(digest, 'capture');
    if (previous?.status === 'rejected') return previous;
    const plan: CompilationPlan = {
      operation: 'capture', digest, compilerVersion: COMPILER_VERSION,
      plannedPageRefs: [], appliedPageRefs: [],
    };
    const receipt: CompilationReceipt = {
      id: previous?.id ?? `receipt_${randomUUID()}`, operation: 'capture', status: 'rejected',
      digest, pageRefs: [], reasonCode: normalizedReason,
    };
    this.privateCoordinator.reject(sourceRefs, normalizedReason, _context);
    this.privateCatalog.saveReceipt(receipt, plan);
    this.privateCatalog.recordDecision('capture', normalizedReason);
    return receipt;
  }

  async lint(context: RunMemoryContext): Promise<WikiLintReport> {
    const [privatePolicy, workspacePolicy] = await Promise.all([
      this.privateVault.loadSchema(),
      this.workspaceVault.loadSchema(),
    ]);
    await Promise.all([
      this.repairDeterministic(
        this.privateVault,
        this.privateCatalog,
        this.privateCoordinator,
        privatePolicy,
        context,
      ),
      this.repairDeterministic(
        this.workspaceVault,
        this.workspaceCatalog,
        this.workspaceCoordinator,
        workspacePolicy,
        context,
      ),
    ]);
    const [privateInspection, workspaceInspection] = await Promise.all([
      this.privateVault.inspect(), this.workspaceVault.inspect(),
    ]);
    const privateLint = lintWiki(privateInspection.pages, privatePolicy);
    const workspaceLint = lintWiki(workspaceInspection.pages, workspacePolicy);
    const privateIssues = [...privateInspection.issues, ...privateLint.issues];
    const workspaceIssues = [...workspaceInspection.issues, ...workspaceLint.issues];
    const [privateRules, workspaceRules] = [
      this.privateCatalog.recordLintIssues(privateIssues),
      this.workspaceCatalog.recordLintIssues(workspaceIssues),
    ];
    await Promise.all([
      this.privateVault.refreshErrorBook(privateRules),
      this.workspaceVault.refreshErrorBook(workspaceRules),
      this.privateVault.refreshNavigation('lint', contentDigest(JSON.stringify(privateIssues)), []),
      this.workspaceVault.refreshNavigation('lint', contentDigest(JSON.stringify(workspaceIssues)), []),
    ]);
    const issues = [...privateIssues, ...workspaceIssues];
    return {
      valid: !issues.some((issue) => issue.severity === 'error'),
      checked: privateLint.checked + workspaceLint.checked,
      issues,
    };
  }

  private async repairDeterministic(
    vault: WikiVault,
    catalog: SqliteMemoryCatalog,
    coordinator: MemoryCompilationCoordinator,
    policy: WikiSchemaPolicy,
    context: RunMemoryContext,
  ): Promise<void> {
    const pages = await vault.list();
    for (const existing of pages) {
      const h1Count = (existing.body.match(/^#\s+.+$/gm) ?? []).length;
      const sourceHeadingCount = (existing.body.match(/^##\s+来源\s*$/gm) ?? []).length;
      const inferredActive = existing.metadata.status === 'active'
        && existing.metadata.confidence === 'inferred'
        && !policy.allowInferredActive
        && new Set(existing.metadata.sourceRefs.map((source) => `${source.type}:${source.id}`)).size < 2;
      const missingCanonicalKey = policy.requireCanonicalKey && !existing.metadata.canonicalKey;
      if (!missingCanonicalKey && h1Count === 1 && sourceHeadingCount === 1 && !inferredActive) continue;
      const timestamp = new Date().toISOString();
      const metadata: MemoryPageMetadata = {
        ...existing.metadata,
        canonicalKey: existing.metadata.canonicalKey
          ?? canonicalTopicKey(existing.ref.scope, existing.metadata.title),
        status: inferredActive ? 'proposed' : existing.metadata.status,
        lastVerifiedAt: existing.metadata.lastVerifiedAt
          ?? existing.metadata.sourceRefs.map((source) => source.occurredAt).sort().at(-1)
          ?? timestamp,
        refreshAfter: existing.metadata.refreshAfter ?? null,
        mergedInto: existing.metadata.mergedInto ?? null,
        updatedAt: timestamp,
      };
      const body = renderWikiPage({
        title: metadata.title,
        content: extractWikiContent(existing.body),
        sources: metadata.sourceRefs,
        links: wikiLinks(existing.body),
      });
      const targetDigest = parsePage(serializePage(metadata, body)).digest;
      if (targetDigest === existing.digest) continue;
      const prepared = coordinator.prepare({
        operation: 'lint-repair',
        scope: existing.ref.scope,
        title: metadata.title,
        content: body,
        kind: metadata.kind,
        confidence: metadata.confidence,
        sourceRefs: metadata.sourceRefs,
        metadata,
        targetDigest,
        createdBy: 'maintenance',
        reasonCode: 'deterministic_schema_repair',
        context,
      });
      let page: MemoryDocument;
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
      catalog.recordDecision('lint-repair', 'deterministic_schema_repair', existing.ref.id);
    }
  }
}
