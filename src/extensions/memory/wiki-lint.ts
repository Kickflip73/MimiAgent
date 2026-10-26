import type { MemoryDocument, MemoryRef, WikiLintIssue, WikiLintReport } from '../../core/memory.js';
import { DEFAULT_WIKI_SCHEMA_POLICY, type WikiSchemaPolicy } from './wiki-schema.js';

function key(ref: MemoryRef): string {
  return `${ref.scope}:${ref.profileId ?? '-'}:${ref.id}`;
}

export function lintWiki(
  pages: readonly MemoryDocument[],
  policy: WikiSchemaPolicy = DEFAULT_WIKI_SCHEMA_POLICY,
): WikiLintReport {
  const issues: WikiLintIssue[] = [];
  const titles = new Map<string, MemoryDocument[]>();
  const currentPages = pages.filter((page) => page.metadata.status !== 'superseded' && page.metadata.status !== 'expired');
  const linkTargets = new Map<string, Set<string>>();
  for (const page of currentPages) {
    const canonicalTitle = page.metadata.title.toLowerCase();
    for (const candidate of [page.metadata.title, ...page.metadata.aliases, page.ref.id]) {
      const normalized = candidate.trim().toLowerCase();
      if (!normalized) continue;
      const targets = linkTargets.get(normalized) ?? new Set<string>();
      targets.add(canonicalTitle);
      linkTargets.set(normalized, targets);
    }
  }
  const linked = new Set<string>();
  for (const page of pages) {
    if (page.metadata.status !== 'superseded' && page.metadata.status !== 'expired') {
      const candidates = [page.metadata.title, ...page.metadata.aliases];
      for (const candidate of candidates) {
        const normalized = candidate.toLowerCase();
        titles.set(normalized, [...titles.get(normalized) ?? [], page]);
      }
    }
    if (page.metadata.status !== 'superseded' && page.metadata.status !== 'expired') {
      for (const match of page.body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g)) {
        const title = match[1]!.trim().toLowerCase();
        const targets = linkTargets.get(title);
        if (!targets) issues.push({ code: 'broken-link', severity: 'warning', ref: page.ref, message: `断链：${match[1]}` });
        else for (const target of targets) linked.add(target);
      }
    }
    if (!page.metadata.sourceRefs.length) issues.push({ code: 'missing-source', severity: 'error', ref: page.ref, message: '页面缺少 SourceRef' });
    if (policy.requireCanonicalKey && !page.metadata.canonicalKey) {
      issues.push({ code: 'missing-canonical-key', severity: 'warning', ref: page.ref, message: '页面缺少 canonicalKey' });
    }
    if ((page.body.match(/^#\s+.+$/gm) ?? []).length !== 1) {
      issues.push({ code: 'invalid-heading-envelope', severity: 'warning', ref: page.ref, message: '页面必须且只能包含一个 H1' });
    }
    if ((page.body.match(/^##\s+来源\s*$/gm) ?? []).length !== 1) {
      issues.push({ code: 'invalid-source-envelope', severity: 'warning', ref: page.ref, message: '页面必须且只能包含一个来源章节' });
    }
    if (page.metadata.status === 'active'
      && page.metadata.confidence === 'inferred'
      && !policy.allowInferredActive
      && new Set(page.metadata.sourceRefs.map((source) => `${source.type}:${source.id}`)).size < 2) {
      issues.push({ code: 'inferred-active', severity: 'warning', ref: page.ref, message: 'inferred 页面未经晋级不能保持 active' });
    }
    if (page.stale && page.metadata.kind === 'source-summary') {
      issues.push({ code: 'stale-summary', severity: 'warning', ref: page.ref, message: '来源摘要已陈旧，需要重新编译' });
    }
  }
  for (const [title, matches] of titles) {
    const distinct = new Set(matches.map((page) => key(page.ref)));
    if (distinct.size > 1) {
      issues.push({ code: 'duplicate-title', severity: 'warning', message: `重复标题或别名：${title}` });
      const conclusions = new Set(matches.map((page) => page.body.replace(/\s+/g, ' ').trim().toLowerCase()));
      if (conclusions.size > 1) {
        issues.push({ code: 'cross-page-conflict', severity: 'warning', message: `同名主题存在不同结论：${title}` });
      }
    }
  }
  for (const page of currentPages) {
    if (currentPages.length > 1 && !linked.has(page.metadata.title.toLowerCase()) && !page.body.includes('[[')) {
      issues.push({ code: 'orphan', severity: 'warning', ref: page.ref, message: '页面没有入链或出链' });
    }
  }
  return { valid: !issues.some((issue) => issue.severity === 'error'), checked: pages.length, issues };
}
